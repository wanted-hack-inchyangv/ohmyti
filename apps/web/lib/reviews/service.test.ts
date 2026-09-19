import { randomUUID } from "node:crypto";
import { aggregateScore, type CriterionResult } from "@ohmyti/core";
import { sampleRubric } from "@ohmyti/core/fixtures";
import {
  createTestDatabase,
  getEvaluation,
  insertEvidences,
  listCriterionResults,
  persistEvaluationResults,
  setCriterionInterpretation,
  seedEvaluation,
  type EvaluationResultsInput,
  type NewCriterionResult,
  type TestDatabase,
} from "@ohmyti/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEvaluationReport } from "@/lib/reports/service";
import { applyReviewAction } from "./service";

/**
 * T-306 사람 검토 액션 (통합). 부록 A의 2단계 시점 판정(R-05·R-06·R-07 FAIL, G1~G3·R-12 INCONCLUSIVE, 나머지 PASS)을 심고
 * 액션마다 `criterion_results`·`review_events`·`evaluations` 점수가 부록 C 규칙대로 바뀌는지 본다.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
const REVIEWER = "reviewer@example.com";

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/web] DATABASE_URL_TEST가 없어 reviews 통합 테스트를 건너뜁니다");
}

const FAILING = new Set(["R-05", "R-06", "R-07"]);
const INCONCLUSIVE = new Set(["G1", "G2", "G3", "R-12"]);

function defectiveSampleInput(evaluationId: string, rubricVersion: string): EvaluationResultsInput {
  const rubric = sampleRubric();
  const runId = randomUUID();
  const evidenceId = randomUUID();
  const criterionResults: NewCriterionResult[] = rubric.criteria.map((c) => {
    const inconclusive = INCONCLUSIVE.has(c.id);
    const fail = FAILING.has(c.id);
    return {
      evaluationId,
      criterionId: c.id,
      rubricVersion,
      maxPoints: c.maxPoints,
      earnedPoints: inconclusive ? null : fail ? 0 : c.maxPoints,
      verdict: inconclusive ? "INCONCLUSIVE" : fail ? "FAIL" : "PASS",
      method: c.method,
      evidenceIds: fail ? [evidenceId] : [],
      ...(fail ? { issueId: `case:${c.id}-case` } : {}),
      observation: `${c.id} 관측`,
      reviewState: inconclusive ? "PENDING" : "NOT_REQUIRED",
    };
  });
  const summary = aggregateScore(
    criterionResults.map((r): CriterionResult => ({
      criterionId: r.criterionId,
      rubricVersion: r.rubricVersion,
      maxPoints: r.maxPoints,
      earnedPoints: r.earnedPoints,
      verdict: r.verdict,
      method: r.method,
      evidenceIds: r.evidenceIds,
      ...(r.issueId !== undefined ? { issueId: r.issueId } : {}),
      observation: r.observation,
      reviewState: r.reviewState,
    })),
    { ...rubric, version: rubricVersion },
  );
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
    evidences: [
      {
        id: evidenceId,
        evaluationId,
        submissionSha: SHA,
        runId,
        testId: "R-05-case",
        artifactRefs: [`evaluations/${evaluationId}/runs/${runId}/actual.json`],
      },
    ],
    criterionResults,
    score: {
      earned: summary.earned,
      min: summary.min,
      max: summary.max,
      pendingPoints: summary.pendingPoints,
      byArea: summary.byArea,
    },
  };
}

describe.skipIf(!hasTestDb)("applyReviewAction (통합)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(async () => {
    await tdb?.destroy();
  });

  async function seedDefective() {
    const version = `review-${randomUUID().slice(0, 8)}`;
    const seed = await seedEvaluation(tdb.db, version, sampleRubric());
    await persistEvaluationResults(tdb.db, defectiveSampleInput(seed.evaluationId, version));
    return seed;
  }

  async function report(evaluationId: string) {
    const result = await readEvaluationReport({ db: tdb.db }, evaluationId);
    if (!result.ok) throw new Error(result.message);
    return result.data;
  }

  it("사유 없는 OVERRIDE, max 초과 값, 음수를 거부하고 아무것도 바꾸지 않는다", async () => {
    const seed = await seedDefective();
    const target = { evaluationId: seed.evaluationId, criterionId: "R-05" };
    const before = await report(seed.evaluationId);

    const noReason = await applyReviewAction({ db: tdb.db }, target, {
      kind: "OVERRIDE",
      reviewer: REVIEWER,
      reason: "   ",
      earnedPoints: 14,
    });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) {
      expect(noReason.code).toBe("INVALID_INPUT");
      expect(noReason.message).toMatch(/사유/);
    }

    const overMax = await applyReviewAction({ db: tdb.db }, target, {
      kind: "OVERRIDE",
      reviewer: REVIEWER,
      reason: "실수",
      earnedPoints: 15,
    });
    expect(overMax.ok).toBe(false);
    if (!overMax.ok) {
      expect(overMax.code).toBe("REVIEW_REJECTED");
      expect(overMax.message).toMatch(/배점\(14\)/);
    }

    const negative = await applyReviewAction({ db: tdb.db }, target, {
      kind: "OVERRIDE",
      reviewer: REVIEWER,
      reason: "실수",
      earnedPoints: -1,
    });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.message).toMatch(/음수/);

    const noReviewer = await applyReviewAction({ db: tdb.db }, target, {
      kind: "OVERRIDE",
      reviewer: "",
      reason: "실수",
      earnedPoints: 1,
    });
    expect(noReviewer.ok).toBe(false);

    const after = await report(seed.evaluationId);
    expect(after.reviewEvents).toEqual([]);
    expect(after.score).toEqual(before.score);
    expect(after.criterionResults).toEqual(before.criterionResults);
  });

  it("OVERRIDE 후 review_events에 원래 값·새 값·사유·검토자가 남고 저장된 점수가 갱신된다", async () => {
    const seed = await seedDefective();
    const before = await report(seed.evaluationId);
    expect(before.score?.display).toBe("49~74/100 · 25점 검토 대기");

    const result = await applyReviewAction(
      { db: tdb.db },
      { evaluationId: seed.evaluationId, criterionId: "R-05" },
      {
        kind: "OVERRIDE",
        reviewer: REVIEWER,
        reason: "재현 결과를 검토했고 정상 동작으로 판단",
        earnedPoints: 14,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.event).toMatchObject({
      kind: "OVERRIDE",
      criterionId: "R-05",
      reviewer: REVIEWER,
      previous: { earnedPoints: 0, verdict: "FAIL", reviewState: "NOT_REQUIRED" },
      next: { earnedPoints: 14, verdict: "PASS", reviewState: "CONFIRMED" },
      reason: "재현 결과를 검토했고 정상 동작으로 판단",
    });
    expect(result.data.score.display).toBe("63~88/100 · 25점 검토 대기");

    const after = await report(seed.evaluationId);
    expect(after.reviewEvents).toHaveLength(1);
    expect(after.reviewEvents[0]).toMatchObject({
      kind: "OVERRIDE",
      previous: { earnedPoints: 0 },
      next: { earnedPoints: 14 },
      reason: "재현 결과를 검토했고 정상 동작으로 판단",
      reviewer: REVIEWER,
    });
    const r05 = after.criterionResults.find((r) => r.criterionId === "R-05")!;
    expect(r05).toMatchObject({ earnedPoints: 14, verdict: "PASS", reviewState: "CONFIRMED" });
    // 헤더가 읽는 저장 점수: 확정 +14, 검토 대기 그대로
    expect(after.score?.display).toBe("63~88/100 · 25점 검토 대기");
    const row = (await getEvaluation(tdb.db, seed.evaluationId))!;
    expect(row.scoreEarned).toBe(63);
    expect(row.pendingPoints).toBe(25);
    // 저장값이 집계 엔진과 같다
    const summary = aggregateScore(after.criterionResults, after.rubric);
    expect(summary.display).toBe(after.score?.display);
    expect(after.score?.byArea).toEqual(summary.byArea);
  });

  it("R-12 APPROVE_DESIGN 후 검토 대기 배점이 10 줄고 확정 점수가 그만큼 는다", async () => {
    const seed = await seedDefective();
    const before = await report(seed.evaluationId);
    expect(before.score?.pendingPoints).toBe(25);

    const result = await applyReviewAction(
      { db: tdb.db },
      { evaluationId: seed.evaluationId, criterionId: "R-12" },
      {
        kind: "APPROVE_DESIGN",
        reviewer: REVIEWER,
        satisfiedSubCriterionIds: ["R-12a", "R-12b", "R-12c"],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = await report(seed.evaluationId);
    expect(after.score?.pendingPoints).toBe(before.score!.pendingPoints - 10);
    expect(after.score?.earned).toBe(before.score!.earned + 10);
    expect(after.score?.display).toBe("59~74/100 · 15점 검토 대기");
    const r12 = after.criterionResults.find((r) => r.criterionId === "R-12")!;
    expect(r12).toMatchObject({ earnedPoints: 10, verdict: "PASS", reviewState: "CONFIRMED" });
    expect(after.reviewEvents[0]).toMatchObject({
      kind: "APPROVE_DESIGN",
      previous: { earnedPoints: null, verdict: "INCONCLUSIVE", reviewState: "PENDING" },
      next: { earnedPoints: 10, verdict: "PASS", reviewState: "CONFIRMED" },
    });
  });

  it("R-12를 일부만 확정하면 PARTIAL + 하위 기준이 저장되고, 근거가 없던 감점에는 HUMAN_REVIEW 근거가 붙는다 (G-02)", async () => {
    const seed = await seedDefective();
    const result = await applyReviewAction(
      { db: tdb.db },
      { evaluationId: seed.evaluationId, criterionId: "R-12" },
      {
        kind: "APPROVE_DESIGN",
        reviewer: REVIEWER,
        reason: "멱등성 저장소가 주문 생성 로직에 섞여 있음",
        satisfiedSubCriterionIds: ["R-12a", "R-12c"],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = await report(seed.evaluationId);
    const r12 = after.criterionResults.find((r) => r.criterionId === "R-12")!;
    expect(r12).toMatchObject({
      earnedPoints: 7,
      verdict: "PARTIAL",
      reviewState: "CONFIRMED",
      satisfiedSubCriterionIds: ["R-12a", "R-12c"],
    });
    expect(r12.evidenceIds).toHaveLength(1);
    const evidence = after.evidences.find((e) => e.id === r12.evidenceIds[0])!;
    expect(evidence.kind).toBe("HUMAN_REVIEW");
    expect(evidence.source).toBeUndefined();
    expect(after.score?.display).toBe("56~71/100 · 15점 검토 대기");
    // 집계 엔진이 PARTIAL 하위 기준 합을 검산한다
    expect(aggregateScore(after.criterionResults, after.rubric).earned).toBe(56);

    // 감점인데 사유가 없으면 거부
    const noReason = await applyReviewAction(
      { db: tdb.db },
      { evaluationId: seed.evaluationId, criterionId: "R-12" },
      { kind: "APPROVE_DESIGN", reviewer: REVIEWER, satisfiedSubCriterionIds: ["R-12a"] },
    );
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.message).toMatch(/사유/);
    // EXECUTION 기준에는 APPROVE_DESIGN을 쓸 수 없다
    const wrongMethod = await applyReviewAction(
      { db: tdb.db },
      { evaluationId: seed.evaluationId, criterionId: "R-01" },
      { kind: "APPROVE_DESIGN", reviewer: REVIEWER, satisfiedSubCriterionIds: [] },
    );
    expect(wrongMethod.ok).toBe(false);
    if (!wrongMethod.ok) expect(wrongMethod.message).toMatch(/HUMAN_REVIEW/);
  });

  it("R-12에 LLM 설계 제안 근거(T-407)만 있어도 감점하면 HUMAN_REVIEW 근거가 붙는다 (추정은 감점 근거가 아니다)", async () => {
    const seed = await seedDefective();
    const llmEvidenceId = randomUUID();
    await insertEvidences(tdb.db, [
      {
        id: llmEvidenceId,
        evaluationId: seed.evaluationId,
        submissionSha: SHA,
        artifactRefs: [],
        kind: "LLM_INTERPRETATION",
        detail: {
          origin: "REVIEW_WRITE",
          role: "DESIGN_SUGGESTION",
          criterionId: "R-12",
          aiReviewId: null,
          aiReviewVersion: null,
          suggestedPoints: 3,
          maxPoints: 10,
          rationale: "멱등성 저장소 추상화가 없다",
        },
      },
    ]);
    const [row] = (await listCriterionResults(tdb.db, seed.evaluationId)).filter(
      (r) => r.criterionId === "R-12",
    );
    await setCriterionInterpretation(tdb.db, row!.id, {
      interpretation: null,
      evidenceIds: [llmEvidenceId],
    });
    const result = await applyReviewAction(
      { db: tdb.db },
      { evaluationId: seed.evaluationId, criterionId: "R-12" },
      {
        kind: "APPROVE_DESIGN",
        reviewer: REVIEWER,
        reason: "계층은 나뉘었지만 멱등성 저장소가 없다",
        satisfiedSubCriterionIds: ["R-12a", "R-12c"],
      },
    );
    expect(result.ok).toBe(true);
    const after = await report(seed.evaluationId);
    const r12 = after.criterionResults.find((r) => r.criterionId === "R-12")!;
    expect(r12.evidenceIds[0]).toBe(llmEvidenceId);
    expect(r12.evidenceIds).toHaveLength(2);
    expect(after.evidences.find((e) => e.id === r12.evidenceIds[1])!.kind).toBe("HUMAN_REVIEW");
    // LLM 제안 점수(3)는 판정 점수가 되지 않았다
    expect(r12.earnedPoints).toBe(7);
  });

  it("같은 기준을 두 번 수정하면 두 이벤트가 모두 시간순으로 남고 CONFIRM·DISPUTE는 점수를 바꾸지 않는다", async () => {
    const seed = await seedDefective();
    const target = { evaluationId: seed.evaluationId, criterionId: "R-06" };
    const first = await applyReviewAction({ db: tdb.db }, target, {
      kind: "OVERRIDE",
      reviewer: REVIEWER,
      reason: "부분 인정",
      earnedPoints: 3,
    });
    expect(first.ok).toBe(true);
    const second = await applyReviewAction({ db: tdb.db }, target, {
      kind: "OVERRIDE",
      reviewer: "other@example.com",
      reason: "다시 검토해 전부 인정",
      earnedPoints: 6,
    });
    expect(second.ok).toBe(true);
    const dispute = await applyReviewAction({ db: tdb.db }, target, {
      kind: "DISPUTE",
      reviewer: "third@example.com",
      reason: "환경 문제가 의심됨",
    });
    expect(dispute.ok).toBe(true);
    const confirm = await applyReviewAction({ db: tdb.db }, target, {
      kind: "CONFIRM",
      reviewer: REVIEWER,
    });
    expect(confirm.ok).toBe(true);

    const after = await report(seed.evaluationId);
    const events = after.reviewEvents.filter((e) => e.criterionId === "R-06");
    expect(events.map((e) => e.kind)).toEqual(["OVERRIDE", "OVERRIDE", "DISPUTE", "CONFIRM"]);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i - 1]!.createdAt <= events[i]!.createdAt).toBe(true);
    }
    expect(events[0]).toMatchObject({ previous: { earnedPoints: 0 }, next: { earnedPoints: 3 } });
    expect(events[1]).toMatchObject({ previous: { earnedPoints: 3 }, next: { earnedPoints: 6 } });
    expect(events[2]).toMatchObject({
      previous: { earnedPoints: 6, reviewState: "CONFIRMED" },
      next: { earnedPoints: 6, reviewState: "PENDING" },
      reason: "환경 문제가 의심됨",
    });
    expect(events[3]).toMatchObject({
      previous: { reviewState: "PENDING" },
      next: { earnedPoints: 6, reviewState: "CONFIRMED" },
    });
    const r06 = after.criterionResults.find((r) => r.criterionId === "R-06")!;
    expect(r06).toMatchObject({ earnedPoints: 6, verdict: "PASS", reviewState: "CONFIRMED" });
    expect(after.score?.display).toBe("55~80/100 · 25점 검토 대기");
  });

  it("없는 평가·rubric에 없는 기준·판정 저장 전 기준은 사유와 함께 거절한다", async () => {
    const seed = await seedEvaluation(tdb.db, `review-empty-${randomUUID().slice(0, 8)}`);
    const input = { kind: "CONFIRM", reviewer: REVIEWER };
    const missingEval = await applyReviewAction(
      { db: tdb.db },
      { evaluationId: randomUUID(), criterionId: "R-01" },
      input,
    );
    expect(missingEval).toMatchObject({ ok: false, code: "EVALUATION_NOT_FOUND" });
    const unknownCriterion = await applyReviewAction(
      { db: tdb.db },
      { evaluationId: seed.evaluationId, criterionId: "R-99" },
      input,
    );
    expect(unknownCriterion).toMatchObject({ ok: false, code: "CRITERION_NOT_FOUND" });
    const noResult = await applyReviewAction(
      { db: tdb.db },
      { evaluationId: seed.evaluationId, criterionId: "R-01" },
      input,
    );
    expect(noResult).toMatchObject({ ok: false, code: "RESULT_NOT_FOUND" });
    const badId = await applyReviewAction(
      { db: tdb.db },
      { evaluationId: "not-a-uuid", criterionId: "R-01" },
      input,
    );
    expect(badId).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});
