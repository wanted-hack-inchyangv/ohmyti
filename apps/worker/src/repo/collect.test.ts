import { TEST_TIME_BUDGETS } from "@ohmyti/core/testing";
import { sampleRubric } from "@ohmyti/core/fixtures";
import {
  approveAssignmentVersion,
  createAssignment,
  createAssignmentVersion,
  createSubmission,
  createTestDatabase,
  enqueue,
  getJob,
  getSubmission,
  startAssignmentVersionValidation,
  type TestDatabase,
} from "@ohmyti/db";
import { artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../config";
import { createLogger } from "../logger";
import { createDefaultRegistry } from "../registry";
import { createWorker, type Worker } from "../worker";
import {
  collectRepository,
  downloadLimitBytes,
  loadRepoCollectConfig,
  REPO_COLLECT_DEFAULTS,
  runRepoCheckStage,
  type CollectRepositoryDeps,
} from "./collect";
import {
  createGitHubClient,
  RepoEnvironmentError,
  RepoNotAccessibleError,
  TarballTooLargeError,
  type GitHubClient,
} from "./github";
import { SnapshotManifestSchema } from "./snapshot";
import {
  fakeGitHub,
  makeGitHubStyleTarball,
  SHA_A,
  SHA_B,
  SMALL_REPO_FILES,
  type FakeGitHubRepo,
} from "./test-support";

const LIMITS = {
  maxFiles: REPO_COLLECT_DEFAULTS.maxFiles,
  maxBytes: REPO_COLLECT_DEFAULTS.maxBytes,
};
const REPO_URL = "https://github.com/acme/order-api";

let workRoot: string;
let store: FsArtifactStore;
beforeEach(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-collect-test-"));
  store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
});
afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function publicRepo(overrides: Partial<FakeGitHubRepo> = {}): Promise<FakeGitHubRepo> {
  return {
    defaultBranch: "main",
    refs: { main: SHA_A, "v1.0": SHA_A, [SHA_A]: SHA_A },
    tarballs: {
      [SHA_A]: await makeGitHubStyleTarball(SMALL_REPO_FILES, SHA_A, { withGitDir: true }),
    },
    ...overrides,
  };
}

function deps(github: GitHubClient, extra: Partial<CollectRepositoryDeps> = {}) {
  return {
    github,
    store,
    limits: LIMITS,
    workRoot: path.join(workRoot, "work"),
    ...extra,
  } satisfies CollectRepositoryDeps;
}

async function tempDirsLeft(): Promise<string[]> {
  try {
    return await readdir(path.join(workRoot, "work"));
  } catch {
    return [];
  }
}

describe("createGitHubClient (fetch 모킹)", () => {
  it("저장소·커밋을 해석하고 tarball을 파일로 내려받는다", async () => {
    const fake = fakeGitHub({ "acme/order-api": await publicRepo() });
    const github = createGitHubClient({ fetch: fake.fetch, token: "ghp_test" });

    await expect(github.getRepository("acme", "order-api")).resolves.toEqual({
      owner: "acme",
      repo: "order-api",
      fullName: "acme/order-api",
      defaultBranch: "main",
      isPrivate: false,
    });
    await expect(github.resolveCommit("acme", "order-api", "main")).resolves.toEqual({
      sha: SHA_A,
    });
    await expect(github.resolveCommit("acme", "order-api", SHA_A)).resolves.toEqual({ sha: SHA_A });

    const dest = path.join(workRoot, "dl.tar.gz");
    const result = await github.downloadTarball("acme", "order-api", SHA_A, dest, 1024 * 1024);
    expect(result.bytes).toBeGreaterThan(0);
    expect(fake.state.calls).toEqual([
      "/repos/acme/order-api",
      `/repos/acme/order-api/commits/main`,
      `/repos/acme/order-api/commits/${SHA_A}`,
      `/repos/acme/order-api/tarball/${SHA_A}`,
    ]);
  });

  it("404·422는 RepoNotAccessibleError, 403 속도 제한·429·5xx·네트워크 오류는 RepoEnvironmentError", async () => {
    const fake = fakeGitHub({ "acme/order-api": await publicRepo() });
    const github = createGitHubClient({ fetch: fake.fetch });

    await expect(github.getRepository("acme", "missing")).rejects.toBeInstanceOf(
      RepoNotAccessibleError,
    );
    await expect(github.resolveCommit("acme", "order-api", "no-such-branch")).rejects.toMatchObject(
      { name: "RepoNotAccessibleError", status: 404 },
    );
    await expect(github.resolveCommit("acme", "order-api", SHA_B)).rejects.toMatchObject({
      name: "RepoNotAccessibleError",
      status: 422,
    });

    fake.state.nextFailure = { status: 403, headers: { "x-ratelimit-remaining": "0" } };
    await expect(github.getRepository("acme", "order-api")).rejects.toMatchObject({
      name: "RepoEnvironmentError",
      status: 403,
    });
    fake.state.nextFailure = { status: 429, headers: { "retry-after": "7" } };
    await expect(github.getRepository("acme", "order-api")).rejects.toMatchObject({
      name: "RepoEnvironmentError",
      status: 429,
      retryAfterMs: 7000,
    });
    fake.state.nextFailure = { status: 502 };
    await expect(github.getRepository("acme", "order-api")).rejects.toBeInstanceOf(
      RepoEnvironmentError,
    );

    const broken = createGitHubClient({
      fetch: () => Promise.reject(new Error("ECONNRESET")),
    });
    await expect(broken.getRepository("acme", "order-api")).rejects.toThrow(/^ENVIRONMENT: /);
  });

  it("다운로드 상한을 넘으면 TarballTooLargeError다", async () => {
    const fake = fakeGitHub({ "acme/order-api": await publicRepo() });
    const github = createGitHubClient({ fetch: fake.fetch });
    await expect(
      github.downloadTarball("acme", "order-api", SHA_A, path.join(workRoot, "x.tar.gz"), 10),
    ).rejects.toBeInstanceOf(TarballTooLargeError);
  });
});

describe("collectRepository", () => {
  it("브랜치 URL은 HEAD SHA로 고정하고 스냅샷·manifest를 저장한다", async () => {
    const fake = fakeGitHub({ "acme/order-api": await publicRepo() });
    const github = createGitHubClient({ fetch: fake.fetch });
    const result = await collectRepository(
      { submissionId: "sub-1", repoUrl: `${REPO_URL}/tree/main` },
      deps(github),
    );
    expect(result.outcome).toBe("PINNED");
    if (result.outcome !== "PINNED") throw new Error("unreachable");
    expect(result.submissionSha).toBe(SHA_A);
    expect(result.reused).toBe(false);
    expect(result.snapshotRef).toBe(artifactKeys.snapshot("sub-1"));
    expect(await store.exists(artifactKeys.snapshot("sub-1"))).toBe(true);

    const stored = await store.get(artifactKeys.snapshotManifest("sub-1"));
    const manifest = SnapshotManifestSchema.parse(
      JSON.parse(Buffer.from(stored!.body).toString("utf8")),
    );
    expect(manifest).toMatchObject({
      submissionSha: SHA_A,
      requestedRef: "main",
      repo: { owner: "acme", name: "order-api" },
      fileCount: 4,
    });
    expect(manifest.files.map((f) => f.path)).toEqual([
      "README.md",
      "package.json",
      "src/routes/orders.ts",
      "src/server.ts",
    ]);
    expect(manifest.dropped.gitEntries).toBeGreaterThan(0);
    expect(await tempDirsLeft()).toEqual([]);
  });

  it("이름이 바뀐 저장소는 옛 URL로 수집해도 manifest에 정식 이름을 남긴다 (T-603)", async () => {
    // GitHub는 옛 이름을 새 이름으로 리디렉션하고 응답의 full_name은 새 이름이다
    const fake = fakeGitHub({
      "acme/order-api-old": await publicRepo({ fullName: "acme/order-api-renamed" }),
    });
    const github = createGitHubClient({ fetch: fake.fetch });
    const result = await collectRepository(
      { submissionId: "s-renamed", repoUrl: "https://github.com/acme/order-api-old" },
      deps(github),
    );
    if (result.outcome !== "PINNED") throw new Error("PINNED 아님");
    expect(result.manifest.repo).toEqual({
      owner: "acme",
      name: "order-api-old",
      fullName: "acme/order-api-renamed",
    });
    const stored = await store.get(artifactKeys.snapshotManifest("s-renamed"));
    const manifest = SnapshotManifestSchema.parse(
      JSON.parse(Buffer.from(stored!.body).toString("utf8")),
    );
    expect(manifest.repo.fullName).toBe("acme/order-api-renamed");
    // T-603 이전 manifest(정식 이름 없음)도 그대로 읽힌다
    expect(
      SnapshotManifestSchema.safeParse({ ...manifest, repo: { owner: "acme", name: "x" } }).success,
    ).toBe(true);
  });

  it("ref가 없으면 기본 브랜치, repoRef가 있으면 URL의 ref보다 우선한다", async () => {
    const repo = await publicRepo({
      refs: { main: SHA_A, develop: SHA_B, [SHA_A]: SHA_A, [SHA_B]: SHA_B },
      tarballs: {
        [SHA_A]: await makeGitHubStyleTarball(SMALL_REPO_FILES, SHA_A),
        [SHA_B]: await makeGitHubStyleTarball({ "b.txt": "b" }, SHA_B),
      },
    });
    const fake = fakeGitHub({ "acme/order-api": repo });
    const github = createGitHubClient({ fetch: fake.fetch });

    const byDefault = await collectRepository(
      { submissionId: "s1", repoUrl: REPO_URL },
      deps(github),
    );
    expect(byDefault).toMatchObject({ outcome: "PINNED", submissionSha: SHA_A });

    const byRepoRef = await collectRepository(
      { submissionId: "s2", repoUrl: `${REPO_URL}/tree/main`, repoRef: "develop" },
      deps(github),
    );
    expect(byRepoRef).toMatchObject({ outcome: "PINNED", submissionSha: SHA_B });
  });

  it("사용자가 준 SHA는 존재를 확인하고, 없는 SHA는 REPO_NOT_ACCESSIBLE이다", async () => {
    const fake = fakeGitHub({ "acme/order-api": await publicRepo() });
    const github = createGitHubClient({ fetch: fake.fetch });
    const ok = await collectRepository(
      { submissionId: "s1", repoUrl: REPO_URL, repoRef: SHA_A.toUpperCase() },
      deps(github),
    );
    expect(ok).toMatchObject({ outcome: "PINNED", submissionSha: SHA_A });

    const missing = await collectRepository(
      { submissionId: "s2", repoUrl: REPO_URL, repoRef: SHA_B },
      deps(github),
    );
    expect(missing).toMatchObject({ outcome: "UNSUPPORTED", reason: "REPO_NOT_ACCESSIBLE" });
  });

  it("비공개·미존재 저장소, 없는 브랜치, 잘못된 URL은 REPO_NOT_ACCESSIBLE이다", async () => {
    const fake = fakeGitHub({
      "acme/order-api": await publicRepo(),
      "acme/secret": await publicRepo({ isPrivate: true }),
    });
    const github = createGitHubClient({ fetch: fake.fetch });

    for (const [url, hint] of [
      ["https://github.com/acme/secret", "404"],
      ["https://github.com/acme/does-not-exist", "404"],
      [`${REPO_URL}/tree/no-such-branch`, "404"],
      ["https://gitlab.com/acme/order-api", "github.com"],
    ]) {
      const result = await collectRepository({ submissionId: "s", repoUrl: url! }, deps(github));
      expect(result, url).toMatchObject({ outcome: "UNSUPPORTED", reason: "REPO_NOT_ACCESSIBLE" });
      if (result.outcome === "UNSUPPORTED") expect(result.detail, url).toContain(hint);
    }
    expect(await store.exists(artifactKeys.snapshot("s"))).toBe(false);
  });

  it("파일 501개·20MB 초과는 LIMIT_EXCEEDED다", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 501; i += 1) many[`f/${i}.txt`] = "x";
    const repo = await publicRepo({
      refs: { main: SHA_A, big: SHA_B, [SHA_A]: SHA_A, [SHA_B]: SHA_B },
      tarballs: {
        [SHA_A]: await makeGitHubStyleTarball(many, SHA_A),
        [SHA_B]: () =>
          makeGitHubStyleTarball({ "big.bin": Buffer.alloc(20 * 1024 * 1024 + 1, 0x42) }, SHA_B),
      },
    });
    const fake = fakeGitHub({ "acme/order-api": repo });
    const github = createGitHubClient({ fetch: fake.fetch });

    const files = await collectRepository({ submissionId: "s1", repoUrl: REPO_URL }, deps(github));
    expect(files).toMatchObject({ outcome: "UNSUPPORTED", reason: "LIMIT_EXCEEDED" });
    if (files.outcome === "UNSUPPORTED") expect(files.detail).toContain("500");

    const bytes = await collectRepository(
      { submissionId: "s2", repoUrl: REPO_URL, repoRef: "big" },
      deps(github),
    );
    expect(bytes).toMatchObject({ outcome: "UNSUPPORTED", reason: "LIMIT_EXCEEDED" });
    expect(await store.exists(artifactKeys.snapshot("s1"))).toBe(false);
    expect(await store.exists(artifactKeys.snapshot("s2"))).toBe(false);
    expect(await tempDirsLeft()).toEqual([]);
  }, 60_000);

  it("압축 tarball이 다운로드 상한을 넘어도 LIMIT_EXCEEDED다", async () => {
    const github: GitHubClient = {
      getRepository: () =>
        Promise.resolve({
          owner: "acme",
          repo: "order-api",
          defaultBranch: "main",
          isPrivate: false,
        }),
      resolveCommit: () => Promise.resolve({ sha: SHA_A }),
      downloadTarball: (_o, _r, _s, _dest, maxBytes) => {
        expect(maxBytes).toBe(downloadLimitBytes(LIMITS));
        return Promise.reject(new TarballTooLargeError(maxBytes));
      },
    };
    const result = await collectRepository({ submissionId: "s", repoUrl: REPO_URL }, deps(github));
    expect(result).toMatchObject({ outcome: "UNSUPPORTED", reason: "LIMIT_EXCEEDED" });
  });

  it("같은 SHA를 두 번 수집하면 스냅샷 digest가 같다 (다른 제출 id, 다른 tarball 바이트)", async () => {
    const repo = await publicRepo();
    const fake = fakeGitHub({ "acme/order-api": repo });
    const github = createGitHubClient({ fetch: fake.fetch });
    const first = await collectRepository({ submissionId: "s1", repoUrl: REPO_URL }, deps(github));
    // GitHub가 같은 SHA에 다른 바이트(gzip 시각, 최상위 디렉터리 이름)를 줘도 결과는 같아야 한다
    repo.tarballs[SHA_A] = await makeGitHubStyleTarball(SMALL_REPO_FILES, SHA_A, {
      withGitDir: true,
      topDir: "acme-order-api-0000000",
      mtime: new Date("2030-01-01T00:00:00Z"),
    });
    const second = await collectRepository({ submissionId: "s2", repoUrl: REPO_URL }, deps(github));
    if (first.outcome !== "PINNED" || second.outcome !== "PINNED") throw new Error("PINNED 아님");
    expect(first.manifest.snapshotDigest).toBe(second.manifest.snapshotDigest);
    const a = await store.get(artifactKeys.snapshot("s1"));
    const b = await store.get(artifactKeys.snapshot("s2"));
    expect(Buffer.from(a!.body).equals(Buffer.from(b!.body))).toBe(true);
  });

  it("환경 오류(속도 제한)는 UNSUPPORTED가 아니라 예외이며 임시 디렉터리를 남기지 않는다", async () => {
    const fake = fakeGitHub({ "acme/order-api": await publicRepo() });
    const github = createGitHubClient({ fetch: fake.fetch });
    fake.state.nextFailure = { status: 403, headers: { "x-ratelimit-remaining": "0" } };
    await expect(
      collectRepository({ submissionId: "s", repoUrl: REPO_URL }, deps(github)),
    ).rejects.toBeInstanceOf(RepoEnvironmentError);
    expect(await tempDirsLeft()).toEqual([]);
  });

  it("마스킹: 사유 문자열에서 비밀값을 가린다", async () => {
    const github: GitHubClient = {
      getRepository: () =>
        Promise.reject(new RepoNotAccessibleError("token ghp_secret123 rejected")),
      resolveCommit: () => Promise.resolve({ sha: SHA_A }),
      downloadTarball: () => Promise.resolve({ bytes: 0 }),
    };
    const result = await collectRepository(
      { submissionId: "s", repoUrl: REPO_URL },
      deps(github, { secrets: ["ghp_secret123"] }),
    );
    expect(result).toMatchObject({ outcome: "UNSUPPORTED" });
    if (result.outcome === "UNSUPPORTED") expect(result.detail).not.toContain("ghp_secret123");
  });
});

describe("loadRepoCollectConfig", () => {
  it("기본값과 환경변수를 읽는다", () => {
    expect(loadRepoCollectConfig({})).toEqual({
      maxFiles: 500,
      maxBytes: 20971520,
      githubToken: undefined,
    });
    expect(
      loadRepoCollectConfig({
        MAX_SOURCE_FILES: "10",
        MAX_SOURCE_BYTES: "1024",
        GITHUB_TOKEN: " t ",
      }),
    ).toEqual({ maxFiles: 10, maxBytes: 1024, githubToken: "t" });
    expect(() => loadRepoCollectConfig({ MAX_SOURCE_FILES: "0" })).toThrow(/MAX_SOURCE_FILES/);
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn(
    "[@ohmyti/worker] DATABASE_URL_TEST가 없어 REPO_CHECK 단계 통합 테스트를 건너뜁니다",
  );
}

describe.skipIf(!hasTestDb)("runRepoCheckStage (DB 통합)", () => {
  let tdb: TestDatabase;
  let assignmentVersionId: string;
  const workers: Worker[] = [];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    // 제출은 APPROVED 버전에만 만들 수 있다 (T-201)
    const assignment = await createAssignment(tdb.db, { name: "T-202 테스트 과제" });
    const draft = await createAssignmentVersion(tdb.db, {
      assignmentId: assignment.id,
      title: "v1",
      specRef: "assignments/x/specs/spec.md",
      specDigest: "a".repeat(64),
      rubric: sampleRubric(),
      executionContract: {
        startCommand: "npm start",
        portEnv: "PORT",
        healthPath: "/health",
        healthTimeoutMs: 10_000,
        resetPath: "/admin/reset",
        templateName: "order-api-ts",
        nodeVersion: "22",
      },
      harnessVersion: "0.1.0+test",
    });
    await startAssignmentVersionValidation(tdb.db, draft.id);
    const approved = await approveAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "tester",
      validationResult: { ok: true },
    });
    assignmentVersionId = approved.id;
  }, 60_000);

  afterAll(async () => {
    for (const w of workers) await w.stop();
    await tdb.destroy();
  });

  it("브랜치 제출의 SHA가 고정되고, 브랜치가 움직여도 pinned SHA는 바뀌지 않는다", async () => {
    const repo = await publicRepo({
      refs: { main: SHA_A, [SHA_A]: SHA_A, [SHA_B]: SHA_B },
      tarballs: {
        [SHA_A]: await makeGitHubStyleTarball(SMALL_REPO_FILES, SHA_A),
        [SHA_B]: await makeGitHubStyleTarball({ "new.txt": "moved" }, SHA_B),
      },
    });
    const fake = fakeGitHub({ "acme/order-api": repo });
    const github = createGitHubClient({ fetch: fake.fetch });
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: `${REPO_URL}/tree/main`,
    });
    expect(submission.submissionSha).toBeNull();

    const first = await runRepoCheckStage(submission.id, { ...deps(github), db: tdb.db });
    expect(first.result).toMatchObject({ outcome: "PINNED", submissionSha: SHA_A });
    expect(first.submission.submissionSha).toBe(SHA_A);
    expect(first.submission.snapshotRef).toBe(artifactKeys.snapshot(submission.id));

    // 브랜치가 다른 커밋으로 움직인다
    repo.refs.main = SHA_B;
    const callsBefore = fake.state.calls.length;
    const second = await runRepoCheckStage(submission.id, { ...deps(github), db: tdb.db });
    expect(second.result).toMatchObject({ outcome: "PINNED", submissionSha: SHA_A, reused: true });
    expect((await getSubmission(tdb.db, submission.id))?.submissionSha).toBe(SHA_A);
    // 스토어에 스냅샷이 있으므로 GitHub를 다시 부르지 않는다
    expect(fake.state.calls.length).toBe(callsBefore);

    // 스냅샷이 사라졌다면 고정된 SHA로 다시 내려받는다 (브랜치 HEAD가 아니라)
    await store.delete(artifactKeys.snapshot(submission.id));
    const third = await runRepoCheckStage(submission.id, { ...deps(github), db: tdb.db });
    expect(third.result).toMatchObject({ outcome: "PINNED", submissionSha: SHA_A, reused: false });
    expect(fake.state.calls.at(-1)).toBe(`/repos/acme/order-api/tarball/${SHA_A}`);
    expect(fake.state.calls.slice(callsBefore)).not.toContain("/repos/acme/order-api/commits/main");
  });

  it("비공개·미존재 저장소는 UNSUPPORTED + REPO_NOT_ACCESSIBLE이고 job은 SUCCEEDED, 속도 제한은 재시도한다", async () => {
    const fake = fakeGitHub({ "acme/order-api": await publicRepo() });
    const github = createGitHubClient({ fetch: fake.fetch });
    const stageDeps = { ...deps(github), db: tdb.db };

    const registry = createDefaultRegistry().register("EVALUATE_SUBMISSION", async (job, ctx) => {
      const payload = job.payload as { submissionId: string };
      await runRepoCheckStage(payload.submissionId, { ...stageDeps, logger: ctx.logger });
    });
    const logger = createLogger({ level: "silent" });
    const worker = createWorker({
      db: tdb.db,
      store,
      registry,
      logger,
      config: loadWorkerConfig({
        WORKER_ID: "t202-worker",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_STALE_MS: "3000",
        PORT: "0",
      }),
    });
    workers.push(worker);

    const missing = await createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: "https://github.com/acme/does-not-exist",
    });
    const missingJob = await enqueue(tdb.db, {
      type: "EVALUATE_SUBMISSION",
      payload: { submissionId: missing.id },
    });

    const limited = await createSubmission(tdb.db, { assignmentVersionId, repoUrl: REPO_URL });
    fake.state.nextFailure = {
      status: 429,
      headers: { "retry-after": "1" },
      pathIncludes: "/repos/acme/order-api",
    };
    const limitedJob = await enqueue(tdb.db, {
      type: "EVALUATE_SUBMISSION",
      payload: { submissionId: limited.id },
      maxAttempts: 2,
    });

    worker.start();
    // 속도 제한 job은 첫 시도가 ENVIRONMENT 실패로 기록되고 백오프 후 다시 실행된다
    let sawRetry = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const job = await getJob(tdb.db, limitedJob.id);
      if (
        job?.status === "QUEUED" &&
        job.attempts === 1 &&
        job.lastError?.includes("ENVIRONMENT:")
      ) {
        sawRetry = true;
      }
      if (job?.status === "SUCCEEDED" || job?.status === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await worker.drain({ timeoutMs: TEST_TIME_BUDGETS.drainMs });
    await worker.stop();
    expect(sawRetry).toBe(true);

    const missingRow = await getSubmission(tdb.db, missing.id);
    expect(missingRow?.status).toBe("UNSUPPORTED");
    expect(missingRow?.unsupportedReason).toMatch(/^REPO_NOT_ACCESSIBLE: /);
    expect(missingRow?.submissionSha).toBeNull();
    expect((await getJob(tdb.db, missingJob.id))?.status).toBe("SUCCEEDED");

    const limitedJobRow = await getJob(tdb.db, limitedJob.id);
    expect(limitedJobRow?.status).toBe("SUCCEEDED");
    expect(limitedJobRow?.attempts).toBe(2);
    const limitedRow = await getSubmission(tdb.db, limited.id);
    expect(limitedRow?.submissionSha).toBe(SHA_A);
    expect(limitedRow?.status).not.toBe("UNSUPPORTED");
  }, 60_000);

  it("한도 초과 제출은 UNSUPPORTED + LIMIT_EXCEEDED다", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 501; i += 1) many[`f/${i}.txt`] = "x";
    const fake = fakeGitHub({
      "acme/order-api": await publicRepo({
        tarballs: { [SHA_A]: await makeGitHubStyleTarball(many, SHA_A) },
      }),
    });
    const github = createGitHubClient({ fetch: fake.fetch });
    const submission = await createSubmission(tdb.db, { assignmentVersionId, repoUrl: REPO_URL });
    const { result, submission: updated } = await runRepoCheckStage(submission.id, {
      ...deps(github),
      db: tdb.db,
    });
    expect(result).toMatchObject({ outcome: "UNSUPPORTED", reason: "LIMIT_EXCEEDED" });
    expect(updated.status).toBe("UNSUPPORTED");
    expect(updated.unsupportedReason).toMatch(/^LIMIT_EXCEEDED: /);
  });
});
