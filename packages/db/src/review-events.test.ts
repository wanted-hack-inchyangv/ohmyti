import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistEvaluationResults, type EvaluationResultsInput } from "./results";
import {
  applyCriterionReview,
  insertReviewEvent,
  listReviewEvents,
  lockCriterionResult,
  toReviewEvent,
} from "./review-events";
import { evaluations, evidences, executionRecords, reviewEvents } from "./schema";
import { DIGEST, seedEvaluation, SHA } from "./test-fixtures";
import { createTestDatabase, type TestDatabase } from "./testing";

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

/** drizzle이 원인 오류를 `cause`에 감싸므로 둘을 합쳐 대조한다 */
async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "쿼리가 실패해야 합니다").toBeInstanceOf(Error);
  const err = caught as Error & { cause?: unknown };
  const cause = err.cause instanceof Error ? err.cause.message : "";
  expect(`${err.message}\n${cause}`).toMatch(pattern);
}
if (!hasTestDb) {
  console.warn("[@ohmyti/db] DATABASE_URL_TEST가 없어 review-events 통합 테스트를 건너뜁니다");
}

function resultsInput(evaluationId: string, rubricVersion: string): EvaluationResultsInput {
  const runId = randomUUID();
  const evidenceId = randomUUID();
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
        inputRef: `evaluations/${evaluationId}/runs/${runId}/input.json`,
        expectedRef: `evaluations/${evaluationId}/runs/${runId}/expected.json`,
        actualRef: `evaluations/${evaluationId}/runs/${runId}/actual.json`,
        exitCode: null,
        failureKind: "ASSERTION",
      },
    ],
    evidences: [{ id: evidenceId, evaluationId, submissionSha: SHA, runId, artifactRefs: [] }],
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
        observation: "관측",
        reviewState: "NOT_REQUIRED",
      },
    ],
    score: { earned: 0, min: 0, max: 0, pendingPoints: 0 },
  };
}

describe.skipIf(!hasTestDb)("@ohmyti/db review_events (통합)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(async () => {
    await tdb?.destroy();
  });

  it("판정 행을 잠가 읽고, 검토 결과를 쓰고, 이력을 시각순으로 되읽는다", async () => {
    const seed = await seedEvaluation(tdb.db);
    await persistEvaluationResults(tdb.db, resultsInput(seed.evaluationId, seed.rubricVersion));

    const row = await tdb.db.transaction(async (tx) => {
      const locked = await lockCriterionResult(tx, seed.evaluationId, "R-01");
      expect(locked?.criterionId).toBe("R-01");
      await insertReviewEvent(tx, {
        evaluationId: seed.evaluationId,
        criterionResultId: locked!.id,
        criterionId: "R-01",
        kind: "OVERRIDE",
        reviewer: "reviewer@example.com",
        previous: { earnedPoints: 0, verdict: "FAIL", reviewState: "NOT_REQUIRED" },
        next: { earnedPoints: 100, verdict: "PASS", reviewState: "CONFIRMED" },
        reason: "재현되지 않음",
      });
      return applyCriterionReview(tx, locked!.id, {
        earnedPoints: 100,
        verdict: "PASS",
        reviewState: "CONFIRMED",
        satisfiedSubCriterionIds: null,
        evidenceIds: locked!.evidenceIds,
      });
    });
    expect(row.earnedPoints).toBe(100);
    expect(row.reviewState).toBe("CONFIRMED");
    expect(await lockCriterionResult(tdb.db, seed.evaluationId, "R-99")).toBeNull();

    const second = await insertReviewEvent(tdb.db, {
      evaluationId: seed.evaluationId,
      criterionResultId: row.id,
      criterionId: "R-01",
      kind: "DISPUTE",
      reviewer: "other@example.com",
      previous: { earnedPoints: 100, verdict: "PASS", reviewState: "CONFIRMED" },
      next: { earnedPoints: 100, verdict: "PASS", reviewState: "PENDING" },
      reason: "환경 문제 의심",
    });
    const events = (await listReviewEvents(tdb.db, seed.evaluationId)).map(toReviewEvent);
    expect(events.map((e) => e.kind)).toEqual(["OVERRIDE", "DISPUTE"]);
    expect(events[1]!.id).toBe(second.id);
    expect(events[0]!.createdAt <= events[1]!.createdAt).toBe(true);
  });

  it("검토 이력은 UPDATE·직접 DELETE를 거부하고 평가 삭제 cascade로만 지워진다", async () => {
    const seed = await seedEvaluation(tdb.db);
    await persistEvaluationResults(tdb.db, resultsInput(seed.evaluationId, seed.rubricVersion));
    const locked = await lockCriterionResult(tdb.db, seed.evaluationId, "R-01");
    const event = await insertReviewEvent(tdb.db, {
      evaluationId: seed.evaluationId,
      criterionResultId: locked!.id,
      criterionId: "R-01",
      kind: "CONFIRM",
      reviewer: "reviewer@example.com",
      previous: { earnedPoints: 0, verdict: "FAIL", reviewState: "NOT_REQUIRED" },
      next: { earnedPoints: 0, verdict: "FAIL", reviewState: "CONFIRMED" },
      reason: "확인",
    });

    await expectDbError(
      tdb.db.update(reviewEvents).set({ reason: "수정" }).where(eq(reviewEvents.id, event.id)),
      /append-only/,
    );
    await expectDbError(
      tdb.db.delete(reviewEvents).where(eq(reviewEvents.id, event.id)),
      /append-only/,
    );
    expect(await listReviewEvents(tdb.db, seed.evaluationId)).toHaveLength(1);

    // kind 값은 check 제약이 지킨다
    await expectDbError(
      tdb.db.insert(reviewEvents).values({
        evaluationId: seed.evaluationId,
        criterionResultId: locked!.id,
        criterionId: "R-01",
        kind: "DELETE" as never,
        reviewer: "x",
        previous: { earnedPoints: 0, verdict: "FAIL", reviewState: "NOT_REQUIRED" },
        next: { earnedPoints: 0, verdict: "FAIL", reviewState: "NOT_REQUIRED" },
        reason: "x",
      }),
      /review_events_kind_check/,
    );

    // 평가 삭제 cascade(T-506 경로)는 허용된다. execution_records는 전용 플래그로 먼저 지운다
    await tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ohmyti.allow_execution_record_delete = 'on'`);
      await tx.delete(evidences).where(eq(evidences.evaluationId, seed.evaluationId));
      await tx.delete(executionRecords).where(eq(executionRecords.evaluationId, seed.evaluationId));
      await tx.delete(evaluations).where(eq(evaluations.id, seed.evaluationId));
    });
    expect(await listReviewEvents(tdb.db, seed.evaluationId)).toHaveLength(0);
  });
});
