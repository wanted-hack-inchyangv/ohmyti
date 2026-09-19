import { randomUUID } from "node:crypto";
import { rerunExecutionDedupeKey, RerunStatusReportSchema } from "@ohmyti/core";
import {
  createTestDatabase,
  enqueue,
  getJob,
  jobs,
  persistEvaluationResults,
  seedEvaluation,
  type EvaluationResultsInput,
  type TestDatabase,
} from "@ohmyti/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRerunStatus, readRerunStatus, requestRerun, rerunLimitFromEnv } from "./service";

/**
 * T-307 재실행 요청·상태 (통합). 원본 하네스 기록 하나(R-05 케이스)를 심고 요청·중복·상한·거부 규칙과
 * 상태 보고가 `jobs` 테이블 값을 그대로 옮기는지 본다. web은 job을 넣기만 하고 실행은 워커가 한다 (G-05).
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
const CASE_ID = "R-05-idempotent-resend";

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/web] DATABASE_URL_TEST가 없어 reruns 통합 테스트를 건너뜁니다");
}

function resultsInput(evaluationId: string, rubricVersion: string): EvaluationResultsInput {
  const runId = randomUUID();
  const evidenceId = randomUUID();
  const key = (part: string) => `evaluations/${evaluationId}/runs/${runId}/${part}.json`;
  return {
    evaluationId,
    executionRecords: [
      {
        id: runId,
        evaluationId,
        kind: "HARNESS",
        submissionSha: SHA,
        rubricVersion,
        harnessVersion: "harness-0",
        environmentDigest: DIGEST,
        inputRef: key("input"),
        expectedRef: key("expected"),
        actualRef: key("actual"),
        exitCode: null,
        failureKind: "ASSERTION",
      },
    ],
    evidences: [
      {
        id: evidenceId,
        evaluationId,
        submissionSha: SHA,
        runId,
        testId: CASE_ID,
        artifactRefs: [key("actual")],
      },
    ],
    criterionResults: [
      {
        evaluationId,
        criterionId: "R-01",
        rubricVersion,
        maxPoints: 100,
        earnedPoints: 0,
        verdict: "FAIL",
        method: "EXECUTION",
        evidenceIds: [evidenceId],
        issueId: `case:${CASE_ID}`,
        observation: "관측",
        reviewState: "NOT_REQUIRED",
      },
    ],
    score: { earned: 0, min: 0, max: 100, pendingPoints: 0 },
  };
}

describe("buildRerunStatus·rerunLimitFromEnv (순수)", () => {
  it("상한·사용 횟수·남은 횟수와 차단 사유를 만든다", () => {
    const status = buildRerunStatus("11111111-1111-4111-8111-111111111111", [], 20);
    expect(status).toMatchObject({
      limit: 20,
      used: 0,
      remaining: 20,
      canRequest: true,
      blockedReason: null,
    });
    expect(RerunStatusReportSchema.parse(status)).toEqual(status);
  });

  it("환경변수가 없거나 잘못되면 기본 20", () => {
    expect(rerunLimitFromEnv({})).toBe(20);
    expect(rerunLimitFromEnv({ RERUN_LIMIT_PER_EVALUATION: "0" })).toBe(20);
    expect(rerunLimitFromEnv({ RERUN_LIMIT_PER_EVALUATION: "7" })).toBe(7);
  });
});

describe.skipIf(!hasTestDb)("requestRerun·readRerunStatus (통합)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(async () => {
    await tdb?.destroy();
  });

  /** 워커가 시도 1회 뒤 FAILED로 닫은 것과 같은 상태로 만든다 (다른 테스트의 QUEUED job을 건드리지 않게 행을 직접 갱신) */
  async function markFailed(jobId: string, lastError: string) {
    await tdb.db
      .update(jobs)
      .set({ status: "FAILED", attempts: 1, lastError, lockedBy: null, lockedAt: null })
      .where(eq(jobs.id, jobId));
  }

  async function seed() {
    const version = `rerun-${randomUUID().slice(0, 8)}`;
    const s = await seedEvaluation(tdb.db, version);
    await persistEvaluationResults(tdb.db, resultsInput(s.evaluationId, version));
    return s;
  }

  it("요청하면 RERUN_EXECUTION job이 dedupeKey·payload와 함께 생기고 상태는 QUEUED(대기 중)다", async () => {
    const { evaluationId } = await seed();
    const result = await requestRerun({ db: tdb.db, limit: 20 }, evaluationId, CASE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(true);
    const job = (await getJob(tdb.db, result.data.jobId))!;
    expect(job.type).toBe("RERUN_EXECUTION");
    expect(job.status).toBe("QUEUED");
    expect(job.payload).toEqual({ evaluationId, caseId: CASE_ID });
    expect(job.dedupeKey).toBe(rerunExecutionDedupeKey(evaluationId, CASE_ID));
    expect(job.maxAttempts).toBe(2);
    expect(result.data.status).toMatchObject({ used: 1, remaining: 19, canRequest: true });
    expect(result.data.status.jobs[0]).toMatchObject({
      id: job.id,
      caseId: CASE_ID,
      status: "QUEUED",
      attempts: 0,
      lastError: null,
    });

    // 워커가 없어 QUEUED인 동안 같은 케이스를 다시 요청하면 새 job을 만들지 않는다
    const again = await requestRerun({ db: tdb.db, limit: 20 }, evaluationId, CASE_ID);
    expect(again.ok && again.data).toMatchObject({ jobId: job.id, created: false });
    expect(again.ok && again.data.status.used).toBe(1);

    const status = await readRerunStatus({ db: tdb.db, limit: 20 }, evaluationId);
    expect(status.ok && status.data.jobs.map((j) => j.id)).toEqual([job.id]);
  });

  it("job이 FAILED(ENVIRONMENT)가 되면 상태에 lastError가 그대로 오고 새 요청은 다시 받는다", async () => {
    const { evaluationId } = await seed();
    const first = await requestRerun({ db: tdb.db, limit: 20 }, evaluationId, CASE_ID);
    if (!first.ok) throw new Error(first.message);
    await markFailed(
      first.data.jobId,
      "RunnerEnvironmentError: 템플릿 node_modules를 열 수 없습니다",
    );
    const status = await readRerunStatus({ db: tdb.db, limit: 20 }, evaluationId);
    expect(status.ok && status.data.jobs[0]).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastError: "RunnerEnvironmentError: 템플릿 node_modules를 열 수 없습니다",
    });
    const second = await requestRerun({ db: tdb.db, limit: 20 }, evaluationId, CASE_ID);
    expect(second.ok && second.data.created).toBe(true);
    expect(second.ok && second.data.status.used).toBe(2);
  });

  it("상한을 다 쓰면 거부하고 사유를 돌려준다 (활성 job이 있으면 그 id를 돌려준다)", async () => {
    const { evaluationId } = await seed();
    // 상한 2: 첫 요청은 QUEUED로 남아 있으므로 두 번째 같은 케이스 요청은 기존 id, 다른 케이스는 상한 판단
    const first = await requestRerun({ db: tdb.db, limit: 2 }, evaluationId, CASE_ID);
    if (!first.ok) throw new Error(first.message);
    await enqueue(tdb.db, {
      type: "RERUN_EXECUTION",
      payload: { evaluationId, caseId: "R-01-normal-order" },
      dedupeKey: rerunExecutionDedupeKey(evaluationId, "R-01-normal-order"),
    });
    const status = await readRerunStatus({ db: tdb.db, limit: 2 }, evaluationId);
    expect(status.ok && status.data).toMatchObject({
      used: 2,
      remaining: 0,
      canRequest: false,
      blockedReason: "이 평가의 재실행 상한 2회를 모두 썼습니다 (2회)",
    });
    const same = await requestRerun({ db: tdb.db, limit: 2 }, evaluationId, CASE_ID);
    expect(same.ok && same.data).toMatchObject({ jobId: first.data.jobId, created: false });
    // 활성 job이 끝난 뒤에는 상한 때문에 거부된다
    await markFailed(first.data.jobId, "x");
    const blocked = await requestRerun({ db: tdb.db, limit: 2 }, evaluationId, CASE_ID);
    expect(blocked).toEqual({
      ok: false,
      code: "RERUN_REJECTED",
      message: "이 평가의 재실행 상한 2회를 모두 썼습니다 (2회)",
    });
  });

  it("원본 기록이 없는 케이스, 없는 평가, 잘못된 입력은 job을 만들지 않고 거부한다", async () => {
    const { evaluationId } = await seed();
    const noOriginal = await requestRerun({ db: tdb.db }, evaluationId, "R-09-cancel");
    expect(noOriginal.ok).toBe(false);
    expect(!noOriginal.ok && noOriginal.code).toBe("RERUN_REJECTED");
    expect(!noOriginal.ok && noOriginal.message).toContain("원본 실행 기록이 이 평가에 없어");
    const missing = await requestRerun({ db: tdb.db }, randomUUID(), CASE_ID);
    expect(!missing.ok && missing.code).toBe("EVALUATION_NOT_FOUND");
    const badId = await requestRerun({ db: tdb.db }, "nope", CASE_ID);
    expect(!badId.ok && badId.code).toBe("INVALID_INPUT");
    const badCase = await requestRerun({ db: tdb.db }, evaluationId, "R-05/../x");
    expect(!badCase.ok && badCase.code).toBe("INVALID_INPUT");
    const status = await readRerunStatus({ db: tdb.db }, evaluationId);
    expect(status.ok && status.data.jobs).toEqual([]);
    const missingStatus = await readRerunStatus({ db: tdb.db }, randomUUID());
    expect(!missingStatus.ok && missingStatus.code).toBe("EVALUATION_NOT_FOUND");
  });
});
