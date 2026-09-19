import { TEST_TIME_BUDGETS } from "@ohmyti/core/testing";
import {
  ExecutionContractSchema,
  REVIEW_WRITE_LLM_NOT_CONFIGURED_REASON,
  RubricSchema,
  type ExecutionContract,
} from "@ohmyti/core";
import { sampleRubric } from "@ohmyti/core/fixtures";
import {
  approveAssignmentVersion,
  claimJob,
  createAssignment,
  createAssignmentVersion,
  createTestDatabase,
  enqueueSubmissionEvaluation,
  createSubmission,
  findOpenEvaluation,
  getEvaluation,
  getJob,
  getSubmission,
  jobs,
  startAssignmentVersionValidation,
  type TestDatabase,
} from "@ohmyti/db";
import {
  DEFAULT_CASE_SET,
  getCaseSet,
  harnessVersionOf,
  type HarnessReport,
} from "@ohmyti/harness";
import { LOCAL_RUNNER_DEFAULTS, LocalProcessRunner } from "@ohmyti/runner";
import { FsArtifactStore } from "@ohmyti/storage";
import { readdir, readFile, stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logger";
import { createDefaultRegistry, NonRetryableJobError } from "../registry";
import { createGitHubClient, REPO_COLLECT_DEFAULTS } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import { loadWorkerConfig } from "../config";
import { createWorker } from "../worker";
import { PipelineEnvironmentError, StageTimeoutError, withStageTimeout } from "./errors";
import {
  MUTATION_STAGE_DISABLED_REASON,
  PRIOR_STAGE_FAILED_SKIP_REASON,
  REQUIREMENT_VERIFY_FAILED_SKIP_REASON,
  runEvaluationPipeline,
  type PipelineDeps,
} from "./evaluate";
import { createEvaluateSubmissionHandler, loadPipelineConfig } from "./handler";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SHA_A = "a".repeat(40);
const SHA_CRASH = "c".repeat(40);
const SHA_AXIOS = "d".repeat(40);

describe("withStageTimeout", () => {
  it("제한 시간 안에 끝나면 값을 돌려주고, 넘기면 StageTimeoutError(TIMEOUT)다", async () => {
    await expect(withStageTimeout("REPO_CHECK", 1000, Promise.resolve(1))).resolves.toBe(1);
    const never = new Promise<void>(() => {});
    const error = await withStageTimeout("ENV_PREP", 20, never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StageTimeoutError);
    expect(error).toBeInstanceOf(PipelineEnvironmentError);
    expect((error as StageTimeoutError).failureKind).toBe("TIMEOUT");
    expect((error as StageTimeoutError).message).toContain("ENV_PREP");
  });
});

describe("loadPipelineConfig", () => {
  it("TEMPLATE_ROOT가 필요하고 단계 제한 시간 기본값은 10분이다", () => {
    expect(() => loadPipelineConfig({})).toThrow(/TEMPLATE_ROOT/);
    const config = loadPipelineConfig({ TEMPLATE_ROOT: "./templates" });
    expect(config.stageTimeoutMs).toBe(600_000);
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.repoLimits).toEqual({
      maxFiles: REPO_COLLECT_DEFAULTS.maxFiles,
      maxBytes: REPO_COLLECT_DEFAULTS.maxBytes,
    });
    expect(
      loadPipelineConfig({ TEMPLATE_ROOT: "./templates", PIPELINE_STAGE_TIMEOUT_MS: "30000" })
        .stageTimeoutMs,
    ).toBe(30_000);
    expect(() =>
      loadPipelineConfig({ TEMPLATE_ROOT: "./templates", PIPELINE_STAGE_TIMEOUT_MS: "5" }),
    ).toThrow(/PIPELINE_STAGE_TIMEOUT_MS/);
    // 관련 함수 그래프 분석 자식 프로세스 제한 시간 (T-304): 없으면 undefined(패키지 기본 120초)
    expect(config.analysisTimeoutMs).toBeUndefined();
    expect(
      loadPipelineConfig({ TEMPLATE_ROOT: "./templates", ANALYSIS_TIMEOUT_MS: "45000" })
        .analysisTimeoutMs,
    ).toBe(45_000);
    expect(() =>
      loadPipelineConfig({ TEMPLATE_ROOT: "./templates", ANALYSIS_TIMEOUT_MS: "abc" }),
    ).toThrow(/ANALYSIS_TIMEOUT_MS/);
    // TEST_EFFECTIVENESS (T-403): 기본 켜짐·5분
    expect(config.mutation).toEqual({ enabled: true, timeoutMs: 300_000 });
    expect(
      loadPipelineConfig({
        TEMPLATE_ROOT: "./templates",
        MUTATION_STAGE_ENABLED: "false",
        MUTATION_STAGE_TIMEOUT_MS: "60000",
      }).mutation,
    ).toEqual({ enabled: false, timeoutMs: 60_000 });
    expect(() =>
      loadPipelineConfig({ TEMPLATE_ROOT: "./templates", MUTATION_STAGE_TIMEOUT_MS: "10" }),
    ).toThrow(/MUTATION_STAGE_TIMEOUT_MS/);
    expect(() =>
      loadPipelineConfig({ TEMPLATE_ROOT: "./templates", MUTATION_STAGE_ENABLED: "maybe" }),
    ).toThrow(/MUTATION_STAGE_ENABLED/);
  });
});

/** 디렉터리를 파일 맵으로 읽는다 (node_modules 심볼릭 링크 제외) */
async function readTree(dir: string, base = dir): Promise<FakeRepoFiles> {
  const out: FakeRepoFiles = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) Object.assign(out, await readTree(full, base));
    else out[path.relative(base, full)] = await readFile(full);
  }
  return out;
}

/**
 * 하네스 실행 중 죽는 픽스처: 샘플 A의 서버가 세 번째 `/admin/reset` 요청에서 `process.exit(1)`한다.
 * 케이스 순서상 R-01·R-02는 끝난 뒤이고 R-05부터는 응답을 받지 못한다.
 */
async function crashFixtureFiles(): Promise<FakeRepoFiles> {
  const files = await readTree(path.join(SAMPLES_DIR, "impl-a"));
  files["src/server.ts"] = `import { createServer } from "node:http";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const app = createApp();
let resets = 0;
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/admin/reset") {
    resets += 1;
    if (resets === 3) {
      console.error("simulated crash on third reset");
      process.exit(1);
    }
  }
  app(req, res);
});
server.listen(port, () => {
  console.log(\`order-api listening on port \${port}\`);
});
`;
  return files;
}

async function sampleAFiles(
  mutate?: (pkg: Record<string, unknown>) => void,
): Promise<FakeRepoFiles> {
  const files = await readTree(path.join(SAMPLES_DIR, "impl-a"));
  if (mutate) {
    const pkg = JSON.parse(files["package.json"]!.toString()) as Record<string, unknown>;
    mutate(pkg);
    files["package.json"] = JSON.stringify(pkg, null, 2);
  }
  return files;
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** 러너·수집기가 남긴 임시 디렉터리 목록 (`ohmyti-sandbox-*`, `ohmyti-repo-*`) */
async function leftoverDirs(workRoot: string): Promise<string[]> {
  try {
    return (await readdir(workRoot)).filter((name) => name.startsWith("ohmyti-"));
  } catch {
    return [];
  }
}

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn(
    "[@ohmyti/worker] DATABASE_URL_TEST가 없어 평가 파이프라인 통합 테스트를 건너뜁니다",
  );
}

describe.skipIf(!hasTestDb)("runEvaluationPipeline (DB 통합)", () => {
  let tdb: TestDatabase;
  let assignmentVersionId: string;
  let rubricVersion: string;
  let contract: ExecutionContract;
  let workRoot: string;
  let store: FsArtifactStore;
  let runner: LocalProcessRunner;
  let github: ReturnType<typeof fakeGitHub>;
  const harnessVersion = harnessVersionOf(getCaseSet(DEFAULT_CASE_SET));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    const assignment = await createAssignment(tdb.db, { name: "T-204 테스트 과제" });
    const draft = await createAssignmentVersion(tdb.db, {
      assignmentId: assignment.id,
      title: "v1",
      specRef: "assignments/x/specs/spec.md",
      specDigest: "a".repeat(64),
      rubric,
      executionContract: contract,
      harnessVersion,
    });
    await startAssignmentVersionValidation(tdb.db, draft.id);
    const approved = await approveAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "tester",
      validationResult: { ok: true },
    });
    assignmentVersionId = approved.id;
    rubricVersion = approved.rubricVersion;

    const [a, crash, axios] = await Promise.all([
      sampleAFiles(),
      crashFixtureFiles(),
      sampleAFiles((pkg) => {
        (pkg.dependencies as Record<string, string>).axios = "1.7.0";
      }),
    ]);
    github = fakeGitHub({
      "acme/order-api": {
        defaultBranch: "main",
        refs: { main: SHA_A, crash: SHA_CRASH, axios: SHA_AXIOS },
        tarballs: {
          [SHA_A]: () => makeGitHubStyleTarball(a, SHA_A),
          [SHA_CRASH]: () => makeGitHubStyleTarball(crash, SHA_CRASH),
          [SHA_AXIOS]: () => makeGitHubStyleTarball(axios, SHA_AXIOS),
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
  });

  beforeEach(async () => {
    await tdb.db.delete(jobs);
    workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-pipeline-"));
    store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
    runner = new LocalProcessRunner({
      config: { ...LOCAL_RUNNER_DEFAULTS, templateRoot: TEMPLATE_ROOT, workRoot },
      artifactStore: store,
      secrets: ["hunter2-secret"],
    });
    github.state.calls.length = 0;
  });
  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
    return {
      db: tdb.db,
      store,
      runner,
      github: createGitHubClient({ fetch: github.fetch }),
      config: {
        stageTimeoutMs: TEST_TIME_BUDGETS.stageMs,
        requestTimeoutMs: TEST_TIME_BUDGETS.harnessRequestMs,
        templateRoot: TEMPLATE_ROOT,
        repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
        workRoot,
        // mutation 실험(T-403)은 `mutation/mutation.test.ts`가 검증한다. 여기서는 오케스트레이션만 본다
        mutation: { enabled: false },
      },
      logger: createLogger({ destination: { write: () => {} }, level: "silent" }),
      secrets: ["hunter2-secret"],
      ...overrides,
    };
  }

  async function submit(repoRef: string | null = null) {
    return createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: "https://github.com/acme/order-api",
      ...(repoRef ? { repoRef } : {}),
    });
  }

  it("A 제출: REPO_CHECK·ENV_PREP·REQUIREMENT_VERIFY DONE, 나머지 셋은 SKIPPED(not_implemented), 제출 COMPLETED", async () => {
    const submission = await submit();
    const { id: jobId } = await enqueueSubmissionEvaluation(tdb.db, submission.id);
    expect((await getSubmission(tdb.db, submission.id))?.status).toBe("QUEUED");
    const job = await getJob(tdb.db, jobId);
    expect(job?.payload).toEqual({ submissionId: submission.id });
    expect(job?.dedupeKey).toBe(`EVALUATE_SUBMISSION:${submission.id}`);
    // 같은 제출을 다시 넣어도 활성 job은 하나다
    expect((await enqueueSubmissionEvaluation(tdb.db, submission.id)).created).toBe(false);

    const d = deps();
    const registry = createDefaultRegistry().register(
      "EVALUATE_SUBMISSION",
      createEvaluateSubmissionHandler({
        runner: d.runner,
        github: d.github,
        config: d.config,
        secrets: d.secrets,
      }),
    );
    const worker = createWorker({
      db: tdb.db,
      store,
      registry,
      config: loadWorkerConfig({
        WORKER_ID: "w-pipeline",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_STALE_MS: "60000",
        PORT: "0",
      }),
      logger: d.logger,
    });
    worker.start();
    try {
      await worker.drain({ timeoutMs: TEST_TIME_BUDGETS.drainMs });
    } finally {
      await worker.stop();
    }

    expect((await getJob(tdb.db, jobId))?.status).toBe("SUCCEEDED");
    const updated = await getSubmission(tdb.db, submission.id);
    expect(updated?.status).toBe("COMPLETED");
    expect(updated?.submissionSha).toBe(SHA_A);

    const evaluation = (await tdb.db.query.evaluations.findFirst({
      where: (t, { eq }) => eq(t.submissionId, submission.id),
    }))!;
    expect(evaluation.finishedAt).not.toBeNull();
    expect(evaluation.rubricVersion).toBe(rubricVersion);
    expect(evaluation.harnessVersion).toBe(harnessVersion);
    expect(evaluation.submissionSha).toBe(SHA_A);
    expect(evaluation.environmentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluation.isSample).toBe(false);
    // 점수는 T-205가 채운다 (부록 A: 2단계 시점 A `75~100/100 · 25점 검토 대기`)
    expect(evaluation.scoreEarned).toBe(75);
    expect(evaluation.pendingPoints).toBe(25);

    const stages = evaluation.stageLog;
    expect(stages.map((s) => [s.stage, s.state])).toEqual([
      ["REPO_CHECK", "DONE"],
      ["ENV_PREP", "DONE"],
      ["REQUIREMENT_VERIFY", "DONE"],
      ["TEST_EFFECTIVENESS", "SKIPPED"],
      ["REVIEW_WRITE", "SKIPPED"],
      ["CONTEXT_LINK", "DONE"],
      ["INTERVIEW_KIT", "DONE"],
    ]);
    for (const record of stages) {
      expect(record.startedAt).toBeTruthy();
      expect(record.finishedAt).toBeTruthy();
    }
    expect(stages[3]!.reason).toBe(MUTATION_STAGE_DISABLED_REASON);
    // LLM이 없으면 REVIEW_WRITE는 SKIPPED(설정 없음, T-407). CONTEXT_LINK는 이력서가 없어 "이력서 미제공" 하나로 DONE (T-503)
    expect(stages[4]!.reason).toBe(REVIEW_WRITE_LLM_NOT_CONFIGURED_REASON);
    expect(stages[5]!.reason).toBeUndefined();
    expect(stages[5]!.detail?.contextLink).toMatchObject({ llm: "NOT_NEEDED", linkCount: 1 });
    // INTERVIEW_KIT(T-702): LLM이 없어도 기본 질문으로 키트를 저장하고 DONE + 사유다
    expect(stages[6]!.reason).toBe("LLM 미실행(설정 없음)");
    expect(stages[6]!.detail).toMatchObject({ llm: "NOT_CONFIGURED", dropped: [] });
    expect(stages[6]!.detail!.templateCount).toBe(stages[6]!.detail!.slotCount);
    expect(stages[0]!.detail).toMatchObject({ submissionSha: SHA_A, reused: false });
    expect(stages[1]!.detail).toMatchObject({
      supported: true,
      framework: "express",
      sandbox: { kind: "local", environmentDigest: evaluation.environmentDigest },
    });
    const verify = stages[2]!.detail!;
    expect(verify.failureKind).toBe("NONE");
    expect(verify.startup).toMatchObject({ outcome: "HEALTHY" });
    expect(verify.service).toMatchObject({ stoppedByCaller: true, timedOut: false });
    expect(verify.harness).toMatchObject({
      harnessVersion,
      summary: { total: 10, pass: 10, fail: 0, inconclusive: 0 },
    });
    expect(verify.tests).toMatchObject({ status: "PASSED", framework: "vitest" });
    const criteria = verify.criteria as Array<{ criterionId: string; verdict: string }>;
    expect(criteria).toHaveLength(10);
    expect(criteria.every((c) => c.verdict === "PASS")).toBe(true);

    // 관측 원문은 스토어에 있다
    const artifacts = verify.artifacts as Record<string, string>;
    expect(Object.keys(artifacts).sort()).toEqual(["harness", "serviceExit", "startup", "tests"]);
    const harnessObj = await store.get(artifacts.harness!);
    const report = JSON.parse(Buffer.from(harnessObj!.body).toString("utf8")) as HarnessReport;
    expect(report.results).toHaveLength(10);
    expect(report.results[0]?.timeline.length).toBeGreaterThan(0);
    // 러너 로그도 평가 아래에 있다
    const serviceLogs = (verify.service as { logs: { stdout: string } }).logs.stdout;
    expect(serviceLogs).toMatch(new RegExp(`^evaluations/${evaluation.id}/sandbox/attempt-1/`));
    expect(await store.exists(serviceLogs)).toBe(true);

    // 임시 디렉터리가 남지 않는다
    expect(await leftoverDirs(workRoot)).toEqual([]);
  }, 120_000);

  it("ENV_PREP에서 unsupported면 이후 단계 SKIPPED, 제출 UNSUPPORTED, 점수 null이며 아무것도 실행하지 않는다", async () => {
    const submission = await submit("axios");
    const result = await runEvaluationPipeline(
      { submissionId: submission.id, attempt: 1, maxAttempts: 3 },
      deps(),
    );
    expect(result.submissionStatus).toBe("UNSUPPORTED");
    expect(result.stageLog.map((s) => [s.stage, s.state])).toEqual([
      ["REPO_CHECK", "DONE"],
      ["ENV_PREP", "UNSUPPORTED"],
      ["REQUIREMENT_VERIFY", "SKIPPED"],
      ["TEST_EFFECTIVENESS", "SKIPPED"],
      ["REVIEW_WRITE", "SKIPPED"],
      ["CONTEXT_LINK", "SKIPPED"],
      ["INTERVIEW_KIT", "SKIPPED"],
    ]);
    expect(result.stageLog[1]!.reason).toMatch(/^DISALLOWED_DEPENDENCY: .*axios/);
    const evaluation = await getEvaluation(tdb.db, result.evaluationId!);
    expect(evaluation?.finishedAt).not.toBeNull();
    expect(evaluation?.scoreEarned).toBeNull();
    expect(evaluation?.scoreMin).toBeNull();
    expect(evaluation?.scoreMax).toBeNull();
    expect(evaluation?.pendingPoints).toBeNull();
    const updated = await getSubmission(tdb.db, submission.id);
    expect(updated?.status).toBe("UNSUPPORTED");
    expect(updated?.unsupportedReason).toContain("axios");
    // 러너 환경을 만들지 않았고(로그 객체 없음) 임시 디렉터리도 없다
    expect(
      await readdirSafe(path.join(workRoot, "artifacts/objects/evaluations", result.evaluationId!)),
    ).not.toContain("sandbox");
    expect(await leftoverDirs(workRoot)).toEqual([]);
  }, 60_000);

  it("하네스 실행 중 서비스가 죽으면 REQUIREMENT_VERIFY는 FAILED(SUBMISSION), 끝난 케이스는 보존, 나머지 기준은 INCONCLUSIVE", async () => {
    const submission = await submit("crash");
    const result = await runEvaluationPipeline(
      { submissionId: submission.id, attempt: 1, maxAttempts: 3 },
      deps(),
    );
    expect(result.submissionStatus).toBe("FAILED");
    expect(result.stageLog.map((s) => [s.stage, s.state])).toEqual([
      ["REPO_CHECK", "DONE"],
      ["ENV_PREP", "DONE"],
      ["REQUIREMENT_VERIFY", "FAILED"],
      ["TEST_EFFECTIVENESS", "SKIPPED"],
      ["REVIEW_WRITE", "SKIPPED"],
      ["CONTEXT_LINK", "DONE"],
      ["INTERVIEW_KIT", "DONE"],
    ]);
    const verify = result.stageLog[2]!;
    expect(verify.reason).toMatch(/서비스가 하네스 실행 중 스스로 종료/);
    expect(verify.detail?.failureKind).toBe("SUBMISSION");
    expect(verify.detail?.service).toMatchObject({ stoppedByCaller: false, exitCode: 1 });
    const cases = (verify.detail?.harness as { cases: Array<{ caseId: string; verdict: string }> })
      .cases;
    expect(cases.slice(0, 2)).toEqual([
      { caseId: "R-01-normal-order", verdict: "PASS", failureKind: "NONE" },
      { caseId: "R-02-lookups", verdict: "PASS", failureKind: "NONE" },
    ]);
    expect(cases.slice(2).every((c) => c.verdict === "INCONCLUSIVE")).toBe(true);
    const criteria = verify.detail?.criteria as Array<{ criterionId: string; verdict: string }>;
    const byId = Object.fromEntries(criteria.map((c) => [c.criterionId, c.verdict]));
    expect(byId["R-01"]).toBe("PASS");
    expect(byId["R-02"]).toBe("PASS");
    for (const id of ["R-03", "R-04", "R-05", "R-06", "R-07", "R-08", "R-09", "R-10"]) {
      expect(byId[id]).toBe("INCONCLUSIVE");
    }
    // 제출 테스트는 그래도 실행됐다 (실행 코드는 A와 같으므로 통과)
    expect(verify.detail?.tests).toMatchObject({ status: "PASSED" });
    // TEST_EFFECTIVENESS는 원본 검증이 실패해 건너뛴다(T-403). REVIEW_WRITE는 LLM이 없어 건너뛰고 CONTEXT_LINK는 미구현 사유
    // (부록 B: REQUIREMENT_VERIFY가 FAILED여도 REVIEW_WRITE·CONTEXT_LINK·INTERVIEW_KIT은 가능한 범위에서 진행)
    expect(result.stageLog[3]!.reason).toBe(REQUIREMENT_VERIFY_FAILED_SKIP_REASON);
    expect(result.stageLog[3]!.detail).toMatchObject({ requirementVerify: "FAILED" });
    // 테스트 실효성 점수(T-404): 건너뛴 단계의 사유로 세 그룹 모두 검토 대기
    const scoring = result.stageLog[3]!.detail!.scoring as {
      groups: Array<{ criterionId: string; verdict: string; basis: string }>;
    };
    expect(scoring.groups.map((g) => [g.criterionId, g.verdict, g.basis])).toEqual([
      ["G1", "INCONCLUSIVE", "STAGE_SKIPPED"],
      ["G2", "INCONCLUSIVE", "STAGE_SKIPPED"],
      ["G3", "INCONCLUSIVE", "STAGE_SKIPPED"],
    ]);
    expect(result.stageLog[4]!.reason).toBe(REVIEW_WRITE_LLM_NOT_CONFIGURED_REASON);
    // 부록 B: REQUIREMENT_VERIFY가 FAILED여도 맥락 연결은 실행한다 (T-503)
    expect(result.stageLog[5]!.state).toBe("DONE");
    expect((await getEvaluation(tdb.db, result.evaluationId!))?.finishedAt).not.toBeNull();
    expect(await leftoverDirs(workRoot)).toEqual([]);
  }, 120_000);

  it("워커가 중간에 죽어 job이 회수되면 이어받은 워커는 DONE 단계를 반복하지 않는다", async () => {
    const submission = await submit();
    const { id: jobId } = await enqueueSubmissionEvaluation(tdb.db, submission.id);
    // 죽은 워커를 흉내 낸다: job을 잡은 뒤 REQUIREMENT_VERIFY 직전에 프로세스가 사라졌다고 가정한다
    const claimed = await claimJob(tdb.db, { workerId: "w-dead", types: ["EVALUATE_SUBMISSION"] });
    expect(claimed?.id).toBe(jobId);
    class SimulatedCrash extends Error {}
    await expect(
      runEvaluationPipeline(
        { submissionId: submission.id, attempt: 1, maxAttempts: 3 },
        deps({
          hooks: {
            beforeStage: (stage) => {
              if (stage === "REQUIREMENT_VERIFY") throw new SimulatedCrash("kill -9");
            },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    const before = (await findOpenEvaluation(tdb.db, submission.id))!;
    // 프로세스 안에서 던진 예외라 REQUIREMENT_VERIFY는 RUNNING + lastError로 남는다 (실제 kill이면 기록 없음)
    expect(before.stageLog.map((s) => [s.stage, s.state])).toEqual([
      ["REPO_CHECK", "DONE"],
      ["ENV_PREP", "DONE"],
      ["REQUIREMENT_VERIFY", "RUNNING"],
    ]);
    expect(before.stageLog[2]!.detail?.lastError).toMatchObject({
      kind: "ENVIRONMENT",
      attempt: 1,
    });
    const githubCallsBefore = github.state.calls.length;
    expect(githubCallsBefore).toBeGreaterThan(0);
    expect(await leftoverDirs(workRoot)).toEqual([]);

    const d = deps();
    const registry = createDefaultRegistry().register(
      "EVALUATE_SUBMISSION",
      createEvaluateSubmissionHandler({
        runner: d.runner,
        github: d.github,
        config: d.config,
        secrets: d.secrets,
      }),
    );
    const lines: string[] = [];
    const worker = createWorker({
      db: tdb.db,
      store,
      registry,
      config: loadWorkerConfig({
        WORKER_ID: "w-alive",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_STALE_MS: "300",
        WORKER_HEARTBEAT_INTERVAL_MS: "100",
        WORKER_RECLAIM_INTERVAL_MS: "100",
        PORT: "0",
      }),
      logger: createLogger({ destination: { write: (m: string) => void lines.push(m) } }),
    });
    worker.start();
    try {
      const deadline = Date.now() + 110_000;
      while (Date.now() < deadline) {
        const row = await getJob(tdb.db, jobId);
        if (row?.status === "SUCCEEDED" || row?.status === "FAILED") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await worker.stop();
    }
    const job = await getJob(tdb.db, jobId);
    expect(job?.status).toBe("SUCCEEDED");
    expect(job?.attempts).toBe(2);
    expect(lines.join("")).toContain("heartbeat가 끊긴 job을 회수했습니다");

    const after = (await getEvaluation(tdb.db, before.id))!;
    expect(after.stageLog.map((s) => [s.stage, s.state])).toEqual([
      ["REPO_CHECK", "DONE"],
      ["ENV_PREP", "DONE"],
      ["REQUIREMENT_VERIFY", "DONE"],
      ["TEST_EFFECTIVENESS", "SKIPPED"],
      ["REVIEW_WRITE", "SKIPPED"],
      ["CONTEXT_LINK", "DONE"],
      ["INTERVIEW_KIT", "DONE"],
    ]);
    // DONE 단계의 기록이 그대로다 (다시 실행하지 않았다)
    expect(after.stageLog[0]).toEqual(before.stageLog[0]);
    expect(after.stageLog[1]).toEqual(before.stageLog[1]);
    // GitHub를 다시 부르지 않았다 (스냅샷 재사용)
    expect(github.state.calls.length).toBe(githubCallsBefore);
    // 러너 로그는 2번째 시도 접두사 아래에 있다
    const verify = after.stageLog[2]!.detail as { service: { logs: { stdout: string } } };
    expect(verify.service.logs.stdout).toContain("/sandbox/attempt-2/");
    expect((await getSubmission(tdb.db, submission.id))?.status).toBe("COMPLETED");
    expect(await leftoverDirs(workRoot)).toEqual([]);
  }, 120_000);

  it("REPO_CHECK가 UNSUPPORTED면 평가 행 없이 제출만 UNSUPPORTED다", async () => {
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: "https://github.com/acme/missing",
    });
    const result = await runEvaluationPipeline(
      { submissionId: submission.id, attempt: 1, maxAttempts: 3 },
      deps(),
    );
    expect(result.evaluationId).toBeNull();
    expect(result.submissionStatus).toBe("UNSUPPORTED");
    const updated = await getSubmission(tdb.db, submission.id);
    expect(updated?.unsupportedReason).toMatch(/^REPO_NOT_ACCESSIBLE: /);
    expect(await findOpenEvaluation(tdb.db, submission.id)).toBeNull();
  });

  it("환경 장애: 시도가 남았으면 단계를 RUNNING으로 두고 lastError만 남기며, 마지막 시도면 FAILED(ENVIRONMENT)로 닫는다", async () => {
    const submission = await submit();
    const boom = new PipelineEnvironmentError("템플릿 디스크가 잠시 응답하지 않음 hunter2-secret");
    const failing = deps({
      hooks: {
        beforeStage: (stage) => {
          if (stage === "ENV_PREP") throw boom;
        },
      },
    });
    await expect(
      runEvaluationPipeline({ submissionId: submission.id, attempt: 1, maxAttempts: 3 }, failing),
    ).rejects.toBe(boom);
    let evaluation = (await findOpenEvaluation(tdb.db, submission.id))!;
    expect(evaluation.finishedAt).toBeNull();
    expect(evaluation.stageLog.map((s) => [s.stage, s.state])).toEqual([
      ["REPO_CHECK", "DONE"],
      ["ENV_PREP", "RUNNING"],
    ]);
    const lastError = evaluation.stageLog[1]!.detail?.lastError as {
      kind: string;
      message: string;
    };
    expect(lastError.kind).toBe("ENVIRONMENT");
    expect(lastError.message).toContain("템플릿 디스크");
    expect(lastError.message).not.toContain("hunter2-secret");
    expect((await getSubmission(tdb.db, submission.id))?.status).toBe("RUNNING");

    // 마지막 시도
    await expect(
      runEvaluationPipeline({ submissionId: submission.id, attempt: 3, maxAttempts: 3 }, failing),
    ).rejects.toBe(boom);
    evaluation = (await getEvaluation(tdb.db, evaluation.id))!;
    expect(evaluation.finishedAt).not.toBeNull();
    expect(evaluation.stageLog.map((s) => [s.stage, s.state])).toEqual([
      ["REPO_CHECK", "DONE"],
      ["ENV_PREP", "FAILED"],
      ["REQUIREMENT_VERIFY", "SKIPPED"],
      ["TEST_EFFECTIVENESS", "SKIPPED"],
      ["REVIEW_WRITE", "SKIPPED"],
      ["CONTEXT_LINK", "SKIPPED"],
      ["INTERVIEW_KIT", "SKIPPED"],
    ]);
    expect(evaluation.stageLog[1]!.reason).toMatch(/^ENVIRONMENT: /);
    expect(evaluation.stageLog[1]!.detail?.failureKind).toBe("ENVIRONMENT");
    for (const skipped of evaluation.stageLog.slice(2)) {
      expect(skipped.reason).toBe(PRIOR_STAGE_FAILED_SKIP_REASON);
    }
    expect((await getSubmission(tdb.db, submission.id))?.status).toBe("FAILED");
    // 끝난 제출은 다시 평가하지 않는다
    await expect(
      runEvaluationPipeline({ submissionId: submission.id, attempt: 1, maxAttempts: 3 }, deps()),
    ).rejects.toBeInstanceOf(NonRetryableJobError);
    expect(await leftoverDirs(workRoot)).toEqual([]);
  });

  it("단계 제한 시간을 넘기면 TIMEOUT으로 분류한다", async () => {
    const submission = await submit();
    const slow = deps({
      config: {
        stageTimeoutMs: 1000,
        requestTimeoutMs: TEST_TIME_BUDGETS.harnessRequestMs,
        templateRoot: TEMPLATE_ROOT,
        repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
        workRoot,
        // mutation 실험(T-403)은 `mutation/mutation.test.ts`가 검증한다. 여기서는 오케스트레이션만 본다
        mutation: { enabled: false },
      },
      github: {
        getRepository: () => new Promise<never>(() => {}),
        resolveCommit: () => new Promise<never>(() => {}),
        downloadTarball: () => new Promise<never>(() => {}),
      },
    });
    const error = await runEvaluationPipeline(
      { submissionId: submission.id, attempt: 3, maxAttempts: 3 },
      slow,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StageTimeoutError);
    // REPO_CHECK 전이라 평가 행은 없고 제출만 FAILED
    expect(await findOpenEvaluation(tdb.db, submission.id)).toBeNull();
    expect((await getSubmission(tdb.db, submission.id))?.status).toBe("FAILED");
  });

  it("승인되지 않은 버전이나 다른 하네스 버전으로 승인된 버전은 NonRetryable로 실패하고 제출은 FAILED다", async () => {
    const assignment = await createAssignment(tdb.db, { name: "하네스 불일치" });
    const draft = await createAssignmentVersion(tdb.db, {
      assignmentId: assignment.id,
      title: "v1",
      specRef: "assignments/x/specs/spec.md",
      specDigest: "b".repeat(64),
      // 내용이 다른 rubric이어야 rubric_version이 겹치지 않는다
      rubric: sampleRubric(),
      executionContract: contract,
      harnessVersion: "0.0.0+deadbeefdeadbeef",
    });
    await startAssignmentVersionValidation(tdb.db, draft.id);
    const approved = await approveAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "tester",
      validationResult: { ok: true },
    });
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId: approved.id,
      repoUrl: "https://github.com/acme/order-api",
    });
    const error = await runEvaluationPipeline(
      { submissionId: submission.id, attempt: 1, maxAttempts: 3 },
      deps(),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableJobError);
    expect((error as Error).message).toContain("HARNESS_VERSION_MISMATCH");
    expect((await getSubmission(tdb.db, submission.id))?.status).toBe("FAILED");
    expect(github.state.calls).toEqual([]);
  });

  it("template.json의 환경 digest는 러너 prepare 결과와 같다", async () => {
    const { expectedEnvironmentDigest } = await import("./evaluate");
    const manifest = JSON.parse(
      await readFile(path.join(TEMPLATE_ROOT, "order-api-ts/template.json"), "utf8"),
    ) as { environmentDigest: string };
    expect(await expectedEnvironmentDigest(TEMPLATE_ROOT, "order-api-ts", "local")).toBe(
      manifest.environmentDigest,
    );
    expect((await stat(path.join(TEMPLATE_ROOT, "order-api-ts/node_modules"))).isDirectory()).toBe(
      true,
    );
  });
});
