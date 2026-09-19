import {
  ExecutionContractSchema,
  HarnessCaseActualSchema,
  RerunActualSchema,
  rerunExecutionDedupeKey,
  RubricSchema,
  type ExecutionContract,
  type HarnessCaseActual,
} from "@ohmyti/core";
import {
  approveAssignmentVersion,
  createAssignment,
  createAssignmentVersion,
  createSubmission,
  createTestDatabase,
  enqueue,
  getEvaluation,
  getEvaluationResults,
  getJob,
  jobs,
  listRerunJobs,
  startAssignmentVersionValidation,
  type EvaluationResults,
  type TestDatabase,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import {
  LOCAL_RUNNER_DEFAULTS,
  LocalProcessRunner,
  RunnerEnvironmentError,
  type SandboxRunner,
} from "@ohmyti/runner";
import { artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../config";
import { createLogger } from "../logger";
import { runEvaluationPipeline, type PipelineConfig, type PipelineDeps } from "../pipeline";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import { HandlerRegistry, NonRetryableJobError } from "../registry";
import { createWorker, type Worker } from "../worker";
import {
  compareWithOriginal,
  findOriginalRecord,
  runRerunExecution,
  type RerunDeps,
} from "./execute";
import { createRerunExecutionHandler, loadRerunLimit } from "./handler";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SHA_C = "c".repeat(40);
const CASE_R05 = "R-05-idempotent-resend";
const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/worker] DATABASE_URL_TEST가 없어 재실행 통합 테스트를 건너뜁니다");
}

function silentLogger() {
  return createLogger({ destination: { write: () => {} }, level: "silent" });
}

// ── 순수 함수 ────────────────────────────────────────────────────────────────

function actualOf(overrides: Partial<HarnessCaseActual> = {}): HarnessCaseActual {
  return HarnessCaseActualSchema.parse({
    caseId: CASE_R05,
    verdict: "FAIL",
    failureKind: "ASSERTION",
    reason: null,
    actual: { "p1After.stock": 0 },
    checks: [
      { name: "first.status", ok: true, expected: 201, actual: 201 },
      { name: "p1After.stock", ok: false, expected: 1, actual: 0 },
    ],
    ...overrides,
  });
}

describe("compareWithOriginal", () => {
  const ids = {
    originalRunId: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
  };

  it("verdict·관측값·검사 ok가 모두 같으면 same", () => {
    const c = compareWithOriginal(actualOf(), actualOf(), ids);
    expect(c).toEqual({
      ...ids,
      sameVerdict: true,
      sameActual: true,
      sameChecks: true,
      differingChecks: [],
      outcome: "same",
    });
  });

  it("관측값이 달라진 검사만 이름을 모으고 different", () => {
    const rerun = actualOf({
      verdict: "PASS",
      actual: {},
      checks: [
        { name: "first.status", ok: true, expected: 201, actual: 201 },
        { name: "p1After.stock", ok: true, expected: 1, actual: 1 },
      ],
    });
    const c = compareWithOriginal(actualOf(), rerun, ids);
    expect(c.sameVerdict).toBe(false);
    expect(c.sameActual).toBe(false);
    expect(c.differingChecks).toEqual(["p1After.stock"]);
    expect(c.outcome).toBe("different");
  });

  it("원본에만 있거나 재실행에만 있는 검사도 다른 것으로 센다", () => {
    const rerun = actualOf({
      checks: [{ name: "first.status", ok: true, expected: 201, actual: 201 }],
    });
    const c = compareWithOriginal(actualOf(), rerun, ids);
    expect(c.differingChecks).toEqual(["p1After.stock"]);
    expect(c.sameActual).toBe(true);
    expect(c.outcome).toBe("different");
  });
});

describe("loadRerunLimit", () => {
  it("기본 20, 환경변수로 바꾸며 잘못된 값은 거부한다", () => {
    expect(loadRerunLimit({})).toBe(20);
    expect(loadRerunLimit({ RERUN_LIMIT_PER_EVALUATION: "5" })).toBe(5);
    expect(() => loadRerunLimit({ RERUN_LIMIT_PER_EVALUATION: "0" })).toThrow(/1 이상/);
    expect(() => loadRerunLimit({ RERUN_LIMIT_PER_EVALUATION: "abc" })).toThrow(/1 이상/);
  });
});

// ── DB 통합: 샘플 C를 평가한 뒤 R-05를 재실행한다 ────────────────────────────────

async function readTree(dir: string, base = dir): Promise<FakeRepoFiles> {
  const files: FakeRepoFiles = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      Object.assign(files, await readTree(full, base));
    } else if (entry.isFile()) {
      files[path.relative(base, full)] = await readFile(full);
    }
  }
  return files;
}

async function readJson(store: FsArtifactStore, key: string): Promise<unknown> {
  const object = await store.get(key);
  if (!object) throw new Error(`아티팩트 없음: ${key}`);
  return JSON.parse(Buffer.from(object.body).toString("utf8"));
}

/** 기록·근거·판정을 비교 가능한 문자열로 (원본이 바이트 단위로 같은지 대조) */
function snapshotOf(results: EvaluationResults) {
  return {
    records: new Map(results.executionRecords.map((r) => [r.id, JSON.stringify(r)])),
    evidences: new Map(results.evidences.map((e) => [e.id, JSON.stringify(e)])),
    criteria: new Map(
      results.criterionResults.map((c) => [
        c.criterionId,
        JSON.stringify({ ...c, evidenceIds: undefined, updatedAt: undefined }),
      ]),
    ),
  };
}

describe.skipIf(!hasTestDb)("재실행 (DB 통합, 실제 파이프라인·러너)", () => {
  let tdb: TestDatabase;
  let assignmentVersionId: string;
  let contract: ExecutionContract;
  let workRoot: string;
  let store: FsArtifactStore;
  let runner: LocalProcessRunner;
  let github: ReturnType<typeof fakeGitHub>;
  let evaluationId: string;
  const workers: Worker[] = [];
  const harnessVersion = harnessVersionOf(getCaseSet(DEFAULT_CASE_SET));

  const config = (): PipelineConfig => ({
    stageTimeoutMs: 120_000,
    requestTimeoutMs: 5000,
    templateRoot: TEMPLATE_ROOT,
    repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
    workRoot,
    // mutation 실험(T-403)은 `mutation/mutation.test.ts`가 검증한다
    mutation: { enabled: false },
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    const assignment = await createAssignment(tdb.db, { name: "T-307 테스트 과제" });
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
    assignmentVersionId = (
      await approveAssignmentVersion(tdb.db, {
        id: draft.id,
        approvedBy: "tester",
        validationResult: { ok: true },
      })
    ).id;
    const c = await readTree(path.join(SAMPLES_DIR, "impl-c"));
    github = fakeGitHub({
      "acme/order-api": {
        defaultBranch: "main",
        refs: { c: SHA_C },
        tarballs: { [SHA_C]: () => makeGitHubStyleTarball(c, SHA_C) },
      },
    });

    workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-rerun-"));
    store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
    runner = new LocalProcessRunner({
      config: { ...LOCAL_RUNNER_DEFAULTS, templateRoot: TEMPLATE_ROOT, workRoot },
      artifactStore: store,
    });
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: "https://github.com/acme/order-api",
      repoRef: "c",
    });
    const pipelineDeps: PipelineDeps = {
      db: tdb.db,
      store,
      runner,
      github: createGitHubClient({ fetch: github.fetch }),
      config: config(),
      logger: silentLogger(),
    };
    const result = await runEvaluationPipeline(
      { submissionId: submission.id, attempt: 1, maxAttempts: 3 },
      pipelineDeps,
    );
    expect(result.submissionStatus).toBe("COMPLETED");
    evaluationId = result.evaluationId!;
  }, 180_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await tdb.db.delete(jobs);
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });

  function rerunDeps(overrides: Partial<RerunDeps> = {}): RerunDeps {
    return {
      db: tdb.db,
      store,
      runner,
      config: config(),
      logger: silentLogger(),
      limit: 20,
      ...overrides,
    };
  }

  async function enqueueRerun(caseId = CASE_R05) {
    return enqueue(tdb.db, {
      type: "RERUN_EXECUTION",
      payload: { evaluationId, caseId },
      dedupeKey: rerunExecutionDedupeKey(evaluationId, caseId),
      maxAttempts: 2,
    });
  }

  it("R-05 재실행: 기록이 1건 늘고 원본 행·아티팩트는 바이트 단위로 같으며 actual(재고 0)이 원본과 같다", async () => {
    const before = await getEvaluationResults(tdb.db, evaluationId);
    const beforeSnapshot = snapshotOf(before);
    const original = findOriginalRecord(before, CASE_R05)!;
    expect(original.kind).toBe("HARNESS");
    const originalArtifacts = await Promise.all(
      [original.inputRef, original.expectedRef, original.actualRef].map((k) => readJson(store, k)),
    );
    const evaluationBefore = (await getEvaluation(tdb.db, evaluationId))!;

    const { id: jobId } = await enqueueRerun();
    const result = await runRerunExecution({ jobId, evaluationId, caseId: CASE_R05 }, rerunDeps());

    const after = await getEvaluationResults(tdb.db, evaluationId);
    expect(after.executionRecords.length).toBe(before.executionRecords.length + 1);
    expect(after.evidences.length).toBe(before.evidences.length + 1);
    // 원본 행은 그대로 (G-03)
    const afterSnapshot = snapshotOf(after);
    for (const [id, json] of beforeSnapshot.records)
      expect(afterSnapshot.records.get(id)).toBe(json);
    for (const [id, json] of beforeSnapshot.evidences)
      expect(afterSnapshot.evidences.get(id)).toBe(json);
    for (const [id, json] of beforeSnapshot.criteria)
      expect(afterSnapshot.criteria.get(id)).toBe(json);
    expect(
      await Promise.all(
        [original.inputRef, original.expectedRef, original.actualRef].map((k) =>
          readJson(store, k),
        ),
      ),
    ).toEqual(originalArtifacts);
    // 점수·판정은 바뀌지 않는다
    const evaluationAfter = (await getEvaluation(tdb.db, evaluationId))!;
    expect(evaluationAfter.scoreEarned).toBe(evaluationBefore.scoreEarned);
    expect(evaluationAfter.pendingPoints).toBe(evaluationBefore.pendingPoints);
    const r05Before = before.criterionResults.find((c) => c.criterionId === "R-05")!;
    const r05After = after.criterionResults.find((c) => c.criterionId === "R-05")!;
    expect(r05After.verdict).toBe("FAIL");
    expect(r05After.earnedPoints).toBe(r05Before.earnedPoints);

    // 새 기록: kind RERUN, 같은 SHA·기준·환경, 케이스 근거가 R-05 판정의 evidenceIds 뒤에 붙는다
    const rerunRecord = after.executionRecords.find((r) => r.id === result.runId)!;
    expect(rerunRecord.kind).toBe("RERUN");
    expect(rerunRecord.submissionSha).toBe(original.submissionSha);
    expect(rerunRecord.rubricVersion).toBe(original.rubricVersion);
    expect(rerunRecord.harnessVersion).toBe(original.harnessVersion);
    expect(rerunRecord.environmentDigest).toBe(original.environmentDigest);
    expect(rerunRecord.failureKind).toBe("ASSERTION");
    const rerunEvidence = after.evidences.find((e) => e.id === result.evidenceId)!;
    expect(rerunEvidence.runId).toBe(result.runId);
    expect(rerunEvidence.testId).toBe(CASE_R05);
    expect(rerunEvidence.artifactRefs).toContain(original.actualRef);
    expect(r05After.evidenceIds).toEqual([...r05Before.evidenceIds, result.evidenceId]);
    expect(result.updatedCriterionResultIds).toEqual([r05After.id]);

    // actual: 원본과 같은 관측(재고 0), 비교 결과 same
    const originalActual = HarnessCaseActualSchema.parse(await readJson(store, original.actualRef));
    const rerunActualRaw = await readJson(store, rerunRecord.actualRef);
    const rerunActual = HarnessCaseActualSchema.parse(rerunActualRaw);
    const rerun = RerunActualSchema.parse(rerunActualRaw).rerun;
    expect(originalActual.actual["p1After.stock"]).toBe(0);
    expect(rerunActual.actual["p1After.stock"]).toBe(0);
    expect(rerunActual.actual).toEqual(originalActual.actual);
    expect(rerunActual.verdict).toBe("FAIL");
    expect(rerun).toMatchObject({
      originalRunId: original.id,
      jobId,
      sameVerdict: true,
      sameActual: true,
      sameChecks: true,
      differingChecks: [],
      outcome: "same",
    });
    expect(result.comparison).toEqual(rerun);
    // 타임라인의 재고 관측 2 → 1 → 0이 원본과 같다
    const stocks = (timeline: unknown) =>
      (timeline as Array<{ stateAfter?: { stock?: number } }>)
        .filter((t) => t.stateAfter !== undefined)
        .map((t) => t.stateAfter!.stock);
    const originalTimeline = await readJson(
      store,
      artifactKeys.runRecord(evaluationId, original.id, "timeline"),
    );
    const rerunTimeline = await readJson(
      store,
      artifactKeys.runRecord(evaluationId, result.runId, "timeline"),
    );
    expect(stocks(originalTimeline)).toEqual([2, 1, 0]);
    expect(stocks(rerunTimeline)).toEqual([2, 1, 0]);
    // 러너 로그는 재실행 전용 접두사 아래에 있고 환경 디렉터리는 남지 않는다
    expect(rerunEvidence.artifactRefs.some((r) => r.includes(`/sandbox/rerun-${jobId}/`))).toBe(
      true,
    );
    expect((await readdir(workRoot)).filter((n) => n.startsWith("ohmyti-"))).toEqual([]);
  }, 120_000);

  it("워커 루프로 처리하면 job이 SUCCEEDED가 되고 두 번째 재실행도 기록만 더한다", async () => {
    const before = await getEvaluationResults(tdb.db, evaluationId);
    const registry = new HandlerRegistry().register(
      "RERUN_EXECUTION",
      createRerunExecutionHandler({ runner, config: config(), limit: 20 }),
    );
    const worker = createWorker({
      db: tdb.db,
      store,
      registry,
      config: loadWorkerConfig({
        WORKER_ID: "w-rerun",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_CONCURRENCY: "1",
        WORKER_STALE_MS: "30000",
        PORT: "0",
      }),
      logger: silentLogger(),
    });
    workers.push(worker);
    const { id, created } = await enqueueRerun();
    expect(created).toBe(true);
    // 활성 job이 있는 동안 같은 케이스는 중복 적재되지 않는다
    expect((await enqueueRerun()).created).toBe(false);
    worker.start();
    await worker.drain({ timeoutMs: 90_000 });
    const job = (await getJob(tdb.db, id))!;
    expect(job.status).toBe("SUCCEEDED");
    const after = await getEvaluationResults(tdb.db, evaluationId);
    expect(after.executionRecords.length).toBe(before.executionRecords.length + 1);
    expect(after.executionRecords.filter((r) => r.kind === "RERUN").length).toBeGreaterThanOrEqual(
      2,
    );
    expect((await listRerunJobs(tdb.db, evaluationId)).map((j) => j.id)).toEqual([id]);
  }, 120_000);

  it("러너가 환경 장애를 던지면 job은 FAILED(ENVIRONMENT)가 되고 기록은 늘지 않는다", async () => {
    const before = await getEvaluationResults(tdb.db, evaluationId);
    const broken: SandboxRunner = {
      ...runner,
      kind: runner.kind,
      prepare: () =>
        Promise.reject(new RunnerEnvironmentError("템플릿 node_modules를 열 수 없습니다")),
      startService: runner.startService.bind(runner),
      runCommand: runner.runCommand.bind(runner),
      destroy: runner.destroy.bind(runner),
    };
    const registry = new HandlerRegistry().register(
      "RERUN_EXECUTION",
      createRerunExecutionHandler({ runner: broken, config: config(), limit: 20 }),
    );
    const worker = createWorker({
      db: tdb.db,
      store,
      registry,
      config: loadWorkerConfig({
        WORKER_ID: "w-broken",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_CONCURRENCY: "1",
        WORKER_STALE_MS: "30000",
        PORT: "0",
      }),
      logger: silentLogger(),
    });
    workers.push(worker);
    const { id } = await enqueue(tdb.db, {
      type: "RERUN_EXECUTION",
      payload: { evaluationId, caseId: CASE_R05 },
      dedupeKey: rerunExecutionDedupeKey(evaluationId, CASE_R05),
      maxAttempts: 1,
    });
    worker.start();
    await worker.drain({ timeoutMs: 30_000 });
    const job = (await getJob(tdb.db, id))!;
    expect(job.status).toBe("FAILED");
    expect(job.lastError).toContain("RunnerEnvironmentError");
    expect(job.lastError).toContain("node_modules");
    const after = await getEvaluationResults(tdb.db, evaluationId);
    expect(after.executionRecords.length).toBe(before.executionRecords.length);
  }, 60_000);

  it("환경 digest가 다르면(템플릿 갱신) NonRetryable로 거부하고 사유에 두 digest가 있다", async () => {
    const before = await getEvaluationResults(tdb.db, evaluationId);
    const altRoot = path.join(workRoot, "alt-templates");
    await mkdir(path.join(altRoot, contract.templateName), { recursive: true });
    const manifest = JSON.parse(
      await readFile(path.join(TEMPLATE_ROOT, contract.templateName, "template.json"), "utf8"),
    ) as { environmentDigest: string };
    const changed = "0".repeat(64);
    await writeFile(
      path.join(altRoot, contract.templateName, "template.json"),
      JSON.stringify({ ...manifest, environmentDigest: changed }),
    );
    const { id } = await enqueueRerun();
    await expect(
      runRerunExecution(
        { jobId: id, evaluationId, caseId: CASE_R05 },
        rerunDeps({ config: { ...config(), templateRoot: altRoot } }),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(NonRetryableJobError);
      const message = (error as Error).message;
      expect(message).toMatch(/^ENVIRONMENT_DIGEST_MISMATCH: /);
      expect(message).toContain(before.executionRecords[0]!.environmentDigest);
      expect(message).toContain(changed);
      return true;
    });
    const after = await getEvaluationResults(tdb.db, evaluationId);
    expect(after.executionRecords.length).toBe(before.executionRecords.length);
  });

  it("상한을 넘기면 RERUN_LIMIT_EXCEEDED로 거부하고, 없는 케이스·판정 없는 케이스도 거부한다", async () => {
    const first = await enqueueRerun("R-01-normal-order");
    const second = await enqueue(tdb.db, {
      type: "RERUN_EXECUTION",
      payload: { evaluationId, caseId: CASE_R05 },
      dedupeKey: rerunExecutionDedupeKey(evaluationId, CASE_R05),
    });
    await expect(
      runRerunExecution(
        { jobId: second.id, evaluationId, caseId: CASE_R05 },
        rerunDeps({ limit: 1 }),
      ),
    ).rejects.toThrow(/^RERUN_LIMIT_EXCEEDED: .*상한 1회/);
    await expect(
      runRerunExecution({ jobId: first.id, evaluationId, caseId: "R-99-nope" }, rerunDeps()),
    ).rejects.toThrow(/^CASE_NOT_FOUND: /);
    await expect(
      runRerunExecution(
        { jobId: first.id, evaluationId: "00000000-0000-4000-8000-000000000000", caseId: CASE_R05 },
        rerunDeps(),
      ),
    ).rejects.toThrow(/^EVALUATION_NOT_FOUND: /);
  });
});
