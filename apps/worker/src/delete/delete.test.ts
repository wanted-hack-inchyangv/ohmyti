import { TEST_TIME_BUDGETS } from "@ohmyti/core/testing";
import { ExecutionContractSchema, RubricSchema, type ExecutionContract } from "@ohmyti/core";
import {
  aiReviews,
  approveAssignmentVersion,
  contextLinks,
  createAssignment,
  createAssignmentVersion,
  createSubmission,
  createTestDatabase,
  criterionResults,
  deletionLog,
  enqueue,
  enqueueSubmissionEvaluation,
  evaluations,
  evidences,
  executionRecords,
  findOpenEvaluation,
  findSubmissionDeletion,
  getDeletionLog,
  getJob,
  jobs,
  mutationExperiments,
  requestSubmissionDeletion,
  reviewEvents,
  seedEvaluation,
  startAssignmentVersionValidation,
  submissionContext,
  submissions,
  upsertSubmissionContext,
  type DeletionRemoved,
  type TestDatabase,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import {
  LOCAL_RUNNER_DEFAULTS,
  LocalProcessRunner,
  type PreparedEnv,
  type RunningService,
  type StartServiceOptions,
} from "@ohmyti/runner";
import { artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { eq, inArray, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../config";
import { createLogger } from "../logger";
import { createEvaluateSubmissionHandler } from "../pipeline";
import { createDefaultRegistry } from "../registry";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import { createWorker } from "../worker";
import { runSubmissionDeletion } from "./handler";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SHA_SLOW = "e".repeat(40);

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/worker] DATABASE_URL_TEST가 없어 제출 삭제 통합 테스트를 건너뜁니다");
}

const silent = createLogger({ destination: { write: () => {} }, level: "silent" });

async function readTree(dir: string, base = dir): Promise<FakeRepoFiles> {
  const out: FakeRepoFiles = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await readTree(full, base));
    else out[path.relative(base, full)] = await readFile(full);
  }
  return out;
}

/** 요청마다 300ms 늦게 응답하는 샘플 A. 하네스가 오래 걸려 삭제 요청 시점에 서비스가 확실히 떠 있다 */
async function slowSampleFiles(): Promise<FakeRepoFiles> {
  const files = await readTree(path.join(SAMPLES_DIR, "impl-a"));
  files["src/server.ts"] = `import { createServer } from "node:http";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const app = createApp();
const server = createServer((req, res) => {
  if (req.url === "/health") return app(req, res);
  setTimeout(() => app(req, res), 300);
});
server.listen(port, () => {
  console.log(\`order-api listening on port \${port}\`);
});
`;
  return files;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${label}: 시간 초과`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!hasTestDb)("제출 삭제 cascade (T-506)", () => {
  let tdb: TestDatabase;
  let workRoot: string;
  let store: FsArtifactStore;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await tdb?.destroy();
  });
  beforeEach(async () => {
    workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-delete-"));
    store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
  });
  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  /** 한 평가에 모든 종류의 관련 행과 아티팩트를 만든다 */
  async function seedFullSubmission() {
    const seed = await seedEvaluation(tdb.db);
    const { submissionId, evaluationId } = seed;
    const snapshotRef = artifactKeys.snapshot(submissionId);
    const resumeRef = artifactKeys.resume(submissionId);
    const runPrefix = artifactKeys.runPrefix(evaluationId, "11111111-1111-4111-8111-111111111111");
    const diffRef = artifactKeys.mutationDiff(evaluationId, "M-01");
    const shared = artifactKeys.demoSampleSnapshot("A");
    for (const [key, type] of [
      [snapshotRef, "application/gzip"],
      [resumeRef, "application/pdf"],
      [`${runPrefix}input.json`, "application/json"],
      [`${runPrefix}expected.json`, "application/json"],
      [`${runPrefix}actual.json`, "application/json"],
      [diffRef, "text/x-patch"],
      [artifactKeys.stageResult(evaluationId, "REQUIREMENT_VERIFY", "harness"), "application/json"],
      // 인터뷰 키트 (T-702): 이력서 연결 질문이 들어 있으므로 제출 삭제가 함께 지워야 한다
      [artifactKeys.interviewKit(evaluationId), "application/json"],
      [shared, "application/gzip"],
    ] as const) {
      await store.put(key, "x", { contentType: type });
    }
    await tdb.db
      .update(submissions)
      .set({ snapshotRef, status: "COMPLETED" })
      .where(eq(submissions.id, submissionId));
    await upsertSubmissionContext(tdb.db, submissionId, { resumeRef, githubLogin: "octo" });

    const recordBase = {
      evaluationId,
      submissionSha: "0123456789abcdef0123456789abcdef01234567",
      rubricVersion: seed.rubricVersion,
      harnessVersion: "harness-0",
      environmentDigest: "a".repeat(64),
      inputRef: `${runPrefix}input.json`,
      expectedRef: `${runPrefix}expected.json`,
      actualRef: `${runPrefix}actual.json`,
      failureKind: "NONE" as const,
    };
    const [harness, validation, tests] = await tdb.db
      .insert(executionRecords)
      .values([
        { ...recordBase, kind: "HARNESS" as const },
        { ...recordBase, kind: "MUTATION_VALIDATION" as const },
        { ...recordBase, kind: "MUTATION_TESTS" as const },
      ])
      .returning({ id: executionRecords.id });
    const [evidence] = await tdb.db
      .insert(evidences)
      .values({
        evaluationId,
        submissionSha: recordBase.submissionSha,
        runId: harness!.id,
        artifactRefs: [recordBase.actualRef, shared],
      })
      .returning({ id: evidences.id });
    const [criterion] = await tdb.db
      .insert(criterionResults)
      .values({
        evaluationId,
        criterionId: "R-01",
        rubricVersion: seed.rubricVersion,
        maxPoints: 8,
        earnedPoints: 0,
        verdict: "FAIL",
        method: "EXECUTION",
        evidenceIds: [evidence!.id],
        observation: "201이 아니라 500",
        reviewState: "NOT_REQUIRED",
      })
      .returning({ id: criterionResults.id });
    await tdb.db.insert(reviewEvents).values({
      evaluationId,
      criterionResultId: criterion!.id,
      criterionId: "R-01",
      kind: "CONFIRM",
      reviewer: "검토자",
      previous: {},
      next: {},
      reason: "확인",
    });
    await tdb.db.insert(mutationExperiments).values({
      evaluationId,
      mutationId: "M-01",
      groupId: "G1",
      targetCriterionId: "R-03",
      patchRef: diffRef,
      outcome: "KILLED",
      validationVerdict: "FAIL",
      validationRecordId: validation!.id,
      testRecordId: tests!.id,
    });
    const aiBase = {
      provider: "fake",
      model: "fake",
      promptVersion: "p1",
      inputDigest: "b".repeat(64),
      output: {},
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
    await tdb.db.insert(aiReviews).values([
      { ...aiBase, kind: "EVIDENCE_REVIEW" as const, evaluationId },
      { ...aiBase, kind: "CONTEXT_LINK" as const, submissionId },
    ]);
    await tdb.db.insert(contextLinks).values({
      submissionId,
      evaluationId,
      claimSource: "SYSTEM",
      claim: "이력서 미제공",
      status: "NO_DATA",
    });
    const finishedJob = await enqueue(tdb.db, {
      type: "EVALUATE_SUBMISSION",
      payload: { submissionId },
    });
    await tdb.db.update(jobs).set({ status: "SUCCEEDED" }).where(eq(jobs.id, finishedJob.id));
    return { ...seed, shared, snapshotRef, resumeRef };
  }

  async function rowsFor(submissionId: string, evaluationIds: string[]) {
    const count = async (query: Promise<unknown[]>) => (await query).length;
    const inEval = (column: PgColumn) =>
      evaluationIds.length > 0 ? inArray(column, evaluationIds) : sql`false`;
    return {
      submissions: await count(
        tdb.db.select().from(submissions).where(eq(submissions.id, submissionId)),
      ),
      submissionContext: await count(
        tdb.db
          .select()
          .from(submissionContext)
          .where(eq(submissionContext.submissionId, submissionId)),
      ),
      evaluations: await count(
        tdb.db.select().from(evaluations).where(eq(evaluations.submissionId, submissionId)),
      ),
      executionRecords: await count(
        tdb.db.select().from(executionRecords).where(inEval(executionRecords.evaluationId)),
      ),
      evidences: await count(tdb.db.select().from(evidences).where(inEval(evidences.evaluationId))),
      criterionResults: await count(
        tdb.db.select().from(criterionResults).where(inEval(criterionResults.evaluationId)),
      ),
      reviewEvents: await count(
        tdb.db.select().from(reviewEvents).where(inEval(reviewEvents.evaluationId)),
      ),
      mutationExperiments: await count(
        tdb.db.select().from(mutationExperiments).where(inEval(mutationExperiments.evaluationId)),
      ),
      contextLinks: await count(
        tdb.db.select().from(contextLinks).where(eq(contextLinks.submissionId, submissionId)),
      ),
      aiReviews: await count(
        tdb.db
          .select()
          .from(aiReviews)
          .where(
            sql`${aiReviews.submissionId} = ${submissionId} OR ${inEval(aiReviews.evaluationId)}`,
          ),
      ),
      jobs: await count(
        tdb.db
          .select()
          .from(jobs)
          .where(
            sql`${jobs.payload}->>'submissionId' = ${submissionId} AND ${jobs.type} <> 'DELETE_SUBMISSION'`,
          ),
      ),
    };
  }

  const EMPTY = {
    submissions: 0,
    submissionContext: 0,
    evaluations: 0,
    executionRecords: 0,
    evidences: 0,
    criterionResults: 0,
    reviewEvents: 0,
    mutationExperiments: 0,
    contextLinks: 0,
    aiReviews: 0,
    jobs: 0,
  };

  it("삭제 후 아티팩트 접두사가 비어 있고 deletion_log 외 관련 행이 없다. 공유 아티팩트와 다른 제출은 남는다", async () => {
    const target = await seedFullSubmission();
    const other = await seedFullSubmission();
    const before = await rowsFor(target.submissionId, [target.evaluationId]);
    expect(before).toEqual({
      submissions: 1,
      submissionContext: 1,
      evaluations: 1,
      executionRecords: 3,
      evidences: 1,
      criterionResults: 1,
      reviewEvents: 1,
      mutationExperiments: 1,
      contextLinks: 1,
      aiReviews: 2,
      jobs: 1,
    });

    const request = await requestSubmissionDeletion(tdb.db, {
      submissionId: target.submissionId,
      requestedBy: "  김검토  ",
    });
    expect(request.kind).toBe("REQUESTED");
    // 요청 직후: 상태 DELETED + deleted_at, 화면은 "삭제 중"
    expect(await findSubmissionDeletion(tdb.db, target.submissionId)).toMatchObject({
      state: "PENDING",
    });
    const [marked] = await tdb.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, target.submissionId));
    expect(marked?.status).toBe("DELETED");

    const result = await runSubmissionDeletion(
      { submissionId: target.submissionId, requestedBy: "김검토" },
      { db: tdb.db, store, logger: silent, heartbeat: () => Promise.resolve() },
      { cancelWaitMs: 1000, verifyDelayMs: 10 },
    );
    expect(result.kind).toBe("DELETED");

    // 아티팩트: 두 접두사 모두 비었다 (다시 지워도 0개)
    expect(await store.deletePrefix(artifactKeys.submissionPrefix(target.submissionId))).toBe(0);
    expect(await store.deletePrefix(artifactKeys.evaluationPrefix(target.evaluationId))).toBe(0);
    expect(await store.exists(target.snapshotRef)).toBe(false);
    expect(await store.exists(target.resumeRef)).toBe(false);
    expect(await store.exists(artifactKeys.interviewKit(target.evaluationId))).toBe(false);
    expect(await store.exists(artifactKeys.interviewKit(other.evaluationId))).toBe(true);
    // 샘플 스냅샷처럼 접두사 밖 공유 아티팩트는 지우지 않는다
    expect(await store.exists(target.shared)).toBe(true);
    // 다른 제출은 그대로다
    expect(await store.exists(other.snapshotRef)).toBe(true);
    expect((await rowsFor(other.submissionId, [other.evaluationId])).executionRecords).toBe(3);

    // 행: deletion_log 외에는 없다
    expect(await rowsFor(target.submissionId, [target.evaluationId])).toEqual(EMPTY);
    const log = await getDeletionLog(tdb.db, target.submissionId);
    expect(log?.requestedBy).toBe("김검토");
    const removed = log?.removed as DeletionRemoved;
    expect(removed.counts).toEqual({
      jobs: 1,
      contextLinks: 1,
      aiReviews: 2,
      mutationExperiments: 1,
      evidences: 1,
      reviewEvents: 1,
      criterionResults: 1,
      executionRecords: 3,
      evaluations: 1,
      submissionContext: 1,
      submissions: 1,
    });
    expect(removed.artifacts.prefixes).toEqual([
      `submissions/${target.submissionId}/`,
      `evaluations/${target.evaluationId}/`,
    ]);
    expect(removed.artifacts.deletedObjects).toBe(8);
    expect(removed.artifacts.keptSharedRefs).toEqual([target.shared]);
    expect(await findSubmissionDeletion(tdb.db, target.submissionId)).toMatchObject({
      state: "DONE",
    });

    // 재시도 멱등: 이미 지운 제출은 로그만 돌려준다. 다시 요청해도 ALREADY_DELETED
    const again = await runSubmissionDeletion(
      { submissionId: target.submissionId, requestedBy: "김검토" },
      { db: tdb.db, store, logger: silent, heartbeat: () => Promise.resolve() },
      { cancelWaitMs: 1000 },
    );
    expect(again).toEqual({ kind: "ALREADY_DELETED", logId: log!.id });
    expect(
      (
        await requestSubmissionDeletion(tdb.db, {
          submissionId: target.submissionId,
          requestedBy: "x",
        })
      ).kind,
    ).toBe("ALREADY_DELETED");
    expect(
      await tdb.db
        .select()
        .from(deletionLog)
        .where(eq(deletionLog.submissionId, target.submissionId)),
    ).toHaveLength(1);
  });

  it("삭제 전용 함수 외의 경로로 execution_records를 지울 수 없다", async () => {
    const target = await seedFullSubmission();
    const deleteRecords = () =>
      tdb.db.delete(executionRecords).where(eq(executionRecords.evaluationId, target.evaluationId));
    const causeOf = (error: unknown) => String((error as { cause?: unknown }).cause ?? error);

    // 1. 직접 DELETE: 불변 트리거가 거부한다
    await expect(deleteRecords()).rejects.toSatisfy((e: unknown) =>
      causeOf(e).includes("execution_records is immutable"),
    );
    // 2. 평가 행 삭제의 cascade: restrict FK가 막는다
    await expect(
      tdb.db.delete(evaluations).where(eq(evaluations.id, target.evaluationId)),
    ).rejects.toThrow();
    // 3. 삭제 요청이 없는 제출에 전용 함수를 부르면 거부한다
    await expect(
      tdb.db.execute(
        sql`SELECT public.delete_submission_execution_records(${target.submissionId}::uuid)`,
      ),
    ).rejects.toSatisfy((e: unknown) => causeOf(e).includes("not marked for deletion"));
    // 4. 전용 함수가 끝나면 통로가 닫혀, 같은 트랜잭션 안에서도 다른 실행 기록을 직접 지울 수 없다
    const other = await seedFullSubmission();
    await requestSubmissionDeletion(tdb.db, {
      submissionId: target.submissionId,
      requestedBy: "검토자",
    });
    await expect(
      tdb.db.transaction(async (tx) => {
        await tx
          .delete(mutationExperiments)
          .where(eq(mutationExperiments.evaluationId, target.evaluationId));
        await tx.delete(evidences).where(eq(evidences.evaluationId, target.evaluationId));
        const [row] = await tx.execute<{ n: number }>(
          sql`SELECT public.delete_submission_execution_records(${target.submissionId}::uuid) AS n`,
        );
        expect(Number(row?.n)).toBe(3);
        await tx
          .delete(mutationExperiments)
          .where(eq(mutationExperiments.evaluationId, other.evaluationId));
        await tx.delete(evidences).where(eq(evidences.evaluationId, other.evaluationId));
        await tx
          .delete(executionRecords)
          .where(eq(executionRecords.evaluationId, other.evaluationId));
      }),
    ).rejects.toSatisfy((e: unknown) => causeOf(e).includes("execution_records is immutable"));
    // 트랜잭션이 되돌려졌으므로 두 제출의 기록이 모두 남아 있다
    expect((await rowsFor(target.submissionId, [target.evaluationId])).executionRecords).toBe(3);
    expect((await rowsFor(other.submissionId, [other.evaluationId])).executionRecords).toBe(3);
  });

  it("실행 중인 제출을 삭제하면 평가 job이 먼저 CANCELLED가 되고, 러너 프로세스·환경이 정리된 뒤 삭제된다", async () => {
    const rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    const contract: ExecutionContract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    const assignment = await createAssignment(tdb.db, { name: "T-506 삭제 테스트" });
    const draft = await createAssignmentVersion(tdb.db, {
      assignmentId: assignment.id,
      title: "v1",
      specRef: "assignments/x/specs/spec.md",
      specDigest: "a".repeat(64),
      rubric,
      executionContract: contract,
      harnessVersion: harnessVersionOf(getCaseSet(DEFAULT_CASE_SET)),
    });
    await startAssignmentVersionValidation(tdb.db, draft.id);
    const approved = await approveAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "tester",
      validationResult: { ok: true },
    });
    const slow = await slowSampleFiles();
    const github = fakeGitHub({
      "acme/order-api": {
        defaultBranch: "main",
        refs: { main: SHA_SLOW },
        tarballs: { [SHA_SLOW]: () => makeGitHubStyleTarball(slow, SHA_SLOW) },
      },
    });

    // 서비스 pid를 기록하는 러너
    const services: RunningService[] = [];
    class RecordingRunner extends LocalProcessRunner {
      override async startService(env: PreparedEnv, options?: StartServiceOptions) {
        const service = await super.startService(env, options);
        services.push(service);
        return service;
      }
    }
    const runner = new RecordingRunner({
      config: { ...LOCAL_RUNNER_DEFAULTS, templateRoot: TEMPLATE_ROOT, workRoot },
      artifactStore: store,
    });
    const config = loadWorkerConfig({
      WORKER_ID: "w-delete",
      WORKER_POLL_INTERVAL_MS: "20",
      WORKER_STALE_MS: "3000",
      WORKER_HEARTBEAT_INTERVAL_MS: "100",
      WORKER_RECLAIM_INTERVAL_MS: "1000",
      PORT: "0",
    });
    const registry = createDefaultRegistry().register(
      "EVALUATE_SUBMISSION",
      createEvaluateSubmissionHandler({
        runner,
        github: createGitHubClient({ fetch: github.fetch }),
        config: {
          stageTimeoutMs: TEST_TIME_BUDGETS.stageMs,
          requestTimeoutMs: TEST_TIME_BUDGETS.harnessRequestMs,
          templateRoot: TEMPLATE_ROOT,
          repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
          workRoot,
          mutation: { enabled: false },
        },
      }),
    );
    // 동시 실행 1: 평가 job이 취소돼 빠져나와야 삭제 job을 잡을 수 있다
    const { registerDeleteSubmission } = await import("./handler");
    registerDeleteSubmission(registry, { cancelWaitMs: config.staleMs });
    const lines: string[] = [];
    const worker = createWorker({
      db: tdb.db,
      store,
      registry,
      config,
      logger: createLogger({ destination: { write: (m: string) => void lines.push(m) } }),
    });

    const submission = await createSubmission(tdb.db, {
      assignmentVersionId: approved.id,
      repoUrl: "https://github.com/acme/order-api",
    });
    await store.put(artifactKeys.resume(submission.id), "%PDF-1.4", {
      contentType: "application/pdf",
    });
    await upsertSubmissionContext(tdb.db, submission.id, {
      resumeRef: artifactKeys.resume(submission.id),
    });
    const { id: evaluateJobId } = await enqueueSubmissionEvaluation(tdb.db, submission.id);

    worker.start();
    try {
      // 요구사항 검증 중이며 서비스 프로세스가 살아 있을 때 삭제를 요청한다
      const evaluation = await waitFor(
        () => findOpenEvaluation(tdb.db, submission.id),
        (e) =>
          e?.stageLog.some((s) => s.stage === "REQUIREMENT_VERIFY" && s.state === "RUNNING") ===
            true && services.some((s) => s.isRunning()),
        90_000,
        "REQUIREMENT_VERIFY 서비스 기동",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const service = services.find((s) => s.isRunning())!;
      expect(isAlive(service.pid)).toBe(true);
      expect((await getJob(tdb.db, evaluateJobId))?.status).toBe("RUNNING");

      const request = await requestSubmissionDeletion(tdb.db, {
        submissionId: submission.id,
        requestedBy: "김검토",
      });
      expect(request).toMatchObject({ kind: "REQUESTED", cancelledJobIds: [evaluateJobId] });
      if (request.kind !== "REQUESTED") throw new Error("unreachable");
      // 요청 직후 평가 job은 이미 CANCELLED이고, 삭제 job은 아직 끝나지 않았다
      const cancelled = await getJob(tdb.db, evaluateJobId);
      expect(cancelled?.status).toBe("CANCELLED");
      expect(cancelled?.lockedBy).toBe("w-delete");
      expect((await getJob(tdb.db, request.jobId))?.status).not.toBe("SUCCEEDED");

      const deleteJob = await waitFor(
        () => getJob(tdb.db, request.jobId),
        (j) => j?.status === "SUCCEEDED" || j?.status === "FAILED",
        60_000,
        "삭제 job",
      );
      expect(deleteJob?.status).toBe("SUCCEEDED");

      // 러너 정리: 서비스 프로세스가 죽었고 환경 디렉터리가 남지 않았다. 워커가 취소 확인을 남겼다
      expect(isAlive(service.pid)).toBe(false);
      expect((await readdir(workRoot)).filter((n) => n.startsWith("ohmyti-"))).toEqual([]);
      const out = lines.join("");
      expect(out).toContain("job 신호가 abort돼 서비스를 멈춥니다");
      expect(out).toContain("취소된 job의 실행을 정리하고 빠져나왔습니다");
      expect(out).toContain("제출을 삭제했습니다");

      // 삭제 결과: 행·아티팩트 없음, deletion_log에 취소한 job이 남는다
      expect(await rowsFor(submission.id, [evaluation!.id])).toEqual(EMPTY);
      expect(await getJob(tdb.db, evaluateJobId)).toBeNull();
      expect(await store.deletePrefix(artifactKeys.submissionPrefix(submission.id))).toBe(0);
      expect(await store.deletePrefix(artifactKeys.evaluationPrefix(evaluation!.id))).toBe(0);
      const log = await getDeletionLog(tdb.db, submission.id);
      const removed = log?.removed as DeletionRemoved;
      expect(removed.cancelledJobIds).toEqual([evaluateJobId]);
      expect(removed.counts.evaluations).toBe(1);
      expect(removed.counts.submissions).toBe(1);
      expect(removed.artifacts.deletedObjects).toBeGreaterThan(0);
    } finally {
      await worker.stop();
    }
  }, 180_000);

  it("삭제 요청 없이 들어온 DELETE_SUBMISSION job은 아무것도 지우지 않고 NonRetryable로 실패한다", async () => {
    const target = await seedFullSubmission();
    await expect(
      runSubmissionDeletion(
        { submissionId: target.submissionId, requestedBy: "누군가" },
        { db: tdb.db, store, logger: silent, heartbeat: () => Promise.resolve() },
        { cancelWaitMs: 100 },
      ),
    ).rejects.toMatchObject({ name: "NonRetryableJobError" });
    expect((await rowsFor(target.submissionId, [target.evaluationId])).submissions).toBe(1);
    expect(await store.exists(target.snapshotRef)).toBe(true);
  });
});
