import { describe, expect, it } from "vitest";
import { CriterionResultSchema, type CriterionResult } from "./contracts";
import { sampleRubric } from "./fixtures";
import {
  DEFAULT_REVIEW_REASON,
  ReviewActionInputSchema,
  ReviewPlanError,
  planReviewAction,
  type ReviewActionInput,
} from "./review";
import { aggregateScore } from "./score";

const rubric = sampleRubric();

function criterionOf(id: string) {
  const criterion = rubric.criteria.find((c) => c.id === id);
  if (!criterion) throw new Error(`fixture에 없는 기준: ${id}`);
  return criterion;
}

function resultFor(id: string, overrides: Partial<CriterionResult> = {}): CriterionResult {
  const criterion = criterionOf(id);
  return CriterionResultSchema.parse({
    criterionId: id,
    rubricVersion: rubric.version,
    maxPoints: criterion.maxPoints,
    earnedPoints: criterion.maxPoints,
    verdict: "PASS",
    method: criterion.method,
    evidenceIds: ["ev-1"],
    observation: "관측",
    reviewState: "NOT_REQUIRED",
    ...overrides,
  });
}

function plan(input: ReviewActionInput, current: CriterionResult) {
  return planReviewAction(
    ReviewActionInputSchema.parse(input),
    current,
    criterionOf(current.criterionId),
    rubric,
  );
}

describe("ReviewActionInputSchema", () => {
  it("OVERRIDE는 사유·검토자가 필수이고 음수·소수 점수를 거부한다", () => {
    expect(
      ReviewActionInputSchema.safeParse({
        kind: "OVERRIDE",
        reviewer: "r",
        reason: "",
        earnedPoints: 1,
      }).success,
    ).toBe(false);
    expect(
      ReviewActionInputSchema.safeParse({
        kind: "OVERRIDE",
        reviewer: "  ",
        reason: "x",
        earnedPoints: 1,
      }).success,
    ).toBe(false);
    expect(
      ReviewActionInputSchema.safeParse({
        kind: "OVERRIDE",
        reviewer: "r",
        reason: "x",
        earnedPoints: -1,
      }).success,
    ).toBe(false);
    expect(
      ReviewActionInputSchema.safeParse({
        kind: "OVERRIDE",
        reviewer: "r",
        reason: "x",
        earnedPoints: 1.5,
      }).success,
    ).toBe(false);
    expect(
      ReviewActionInputSchema.safeParse({
        kind: "OVERRIDE",
        reviewer: "r",
        reason: "x",
        earnedPoints: 0,
      }).success,
    ).toBe(true);
  });

  it("DISPUTE는 메모가 필수, CONFIRM·APPROVE_DESIGN은 사유가 선택이다", () => {
    expect(
      ReviewActionInputSchema.safeParse({ kind: "DISPUTE", reviewer: "r", reason: "" }).success,
    ).toBe(false);
    expect(ReviewActionInputSchema.safeParse({ kind: "CONFIRM", reviewer: "r" }).success).toBe(
      true,
    );
    expect(
      ReviewActionInputSchema.safeParse({
        kind: "APPROVE_DESIGN",
        reviewer: "r",
        satisfiedSubCriterionIds: [],
      }).success,
    ).toBe(true);
  });
});

describe("planReviewAction", () => {
  it("CONFIRM은 점수를 두고 reviewState만 CONFIRMED로 바꾼다", () => {
    const current = resultFor("R-05", { earnedPoints: 0, verdict: "FAIL" });
    const p = plan({ kind: "CONFIRM", reviewer: "reviewer@example.com" }, current);
    expect(p.previous).toEqual({ earnedPoints: 0, verdict: "FAIL", reviewState: "NOT_REQUIRED" });
    expect(p.next).toEqual({ earnedPoints: 0, verdict: "FAIL", reviewState: "CONFIRMED" });
    expect(p.reason).toBe(DEFAULT_REVIEW_REASON.CONFIRM);
    expect(p.pointsChanged).toBe(false);
    expect(p.needsHumanReviewEvidence).toBe(false);
  });

  it("OVERRIDE는 max 초과를 거부하고, max면 PASS·아니면 FAIL이며 원래 값을 previous에 남긴다", () => {
    const current = resultFor("R-05", { earnedPoints: 0, verdict: "FAIL", issueId: "case:x" });
    expect(() =>
      plan({ kind: "OVERRIDE", reviewer: "r", reason: "재현 불가", earnedPoints: 15 }, current),
    ).toThrow(ReviewPlanError);
    expect(() =>
      plan({ kind: "OVERRIDE", reviewer: "r", reason: "재현 불가", earnedPoints: 15 }, current),
    ).toThrow(/배점\(14\)/);

    const full = plan(
      { kind: "OVERRIDE", reviewer: "r", reason: "재현 불가", earnedPoints: 14 },
      current,
    );
    expect(full.next).toEqual({ earnedPoints: 14, verdict: "PASS", reviewState: "CONFIRMED" });
    expect(full.previous).toEqual({
      earnedPoints: 0,
      verdict: "FAIL",
      reviewState: "NOT_REQUIRED",
    });
    expect(full.pointsChanged).toBe(true);
    expect(full.kind).toBe("OVERRIDE");
    expect(full.reviewer).toBe("r");
    expect(full.reason).toBe("재현 불가");

    const partial = plan(
      { kind: "OVERRIDE", reviewer: "r", reason: "일부 인정", earnedPoints: 3 },
      current,
    );
    expect(partial.next).toEqual({ earnedPoints: 3, verdict: "FAIL", reviewState: "CONFIRMED" });
    expect(partial.satisfiedSubCriterionIds).toBeNull();
    // 근거가 있는 기준이라 새 근거는 필요 없다
    expect(partial.needsHumanReviewEvidence).toBe(false);
  });

  it("OVERRIDE로 INCONCLUSIVE를 확정하면 검토 대기 배점이 확정 점수로 옮겨 간다 (aggregateScore 검산)", () => {
    const before = [
      resultFor("R-01"),
      resultFor("R-12", {
        earnedPoints: null,
        verdict: "INCONCLUSIVE",
        reviewState: "PENDING",
        evidenceIds: [],
      }),
    ];
    const beforeScore = aggregateScore(before, rubric);
    const p = plan(
      { kind: "OVERRIDE", reviewer: "r", reason: "코드 검토 완료", earnedPoints: 10 },
      before[1]!,
    );
    const after = [before[0]!, { ...before[1]!, ...p.next }];
    const afterScore = aggregateScore(after, rubric);
    expect(afterScore.pendingPoints).toBe(beforeScore.pendingPoints - 10);
    expect(afterScore.earned).toBe(beforeScore.earned + 10);
  });

  it("감점인데 기준에 근거가 없으면 HUMAN_REVIEW 근거가 필요하다고 표시한다 (G-02)", () => {
    const current = resultFor("R-12", {
      earnedPoints: null,
      verdict: "INCONCLUSIVE",
      reviewState: "PENDING",
      evidenceIds: [],
    });
    const p = plan(
      { kind: "OVERRIDE", reviewer: "r", reason: "계층 분리 미흡", earnedPoints: 4 },
      current,
    );
    expect(p.needsHumanReviewEvidence).toBe(true);
    const full = plan(
      { kind: "OVERRIDE", reviewer: "r", reason: "충족", earnedPoints: 10 },
      current,
    );
    expect(full.needsHumanReviewEvidence).toBe(false);
  });

  it("DISPUTE는 점수를 두고 reviewState를 PENDING으로 되돌린다", () => {
    const current = resultFor("R-01", { reviewState: "CONFIRMED" });
    const p = plan({ kind: "DISPUTE", reviewer: "r", reason: "테스트 환경이 의심됨" }, current);
    expect(p.next).toEqual({ earnedPoints: 8, verdict: "PASS", reviewState: "PENDING" });
    expect(p.pointsChanged).toBe(false);
  });

  it("APPROVE_DESIGN은 하위 기준 합으로 점수를 정한다: 전부 PASS, 일부 PARTIAL, 없음 FAIL", () => {
    const current = resultFor("R-12", {
      earnedPoints: null,
      verdict: "INCONCLUSIVE",
      reviewState: "PENDING",
      evidenceIds: [],
    });
    const all = plan(
      {
        kind: "APPROVE_DESIGN",
        reviewer: "r",
        satisfiedSubCriterionIds: ["R-12c", "R-12a", "R-12b", "R-12a"],
      },
      current,
    );
    expect(all.next).toEqual({ earnedPoints: 10, verdict: "PASS", reviewState: "CONFIRMED" });
    expect(all.satisfiedSubCriterionIds).toBeNull();
    expect(all.reason).toBe(DEFAULT_REVIEW_REASON.APPROVE_DESIGN);

    const some = plan(
      {
        kind: "APPROVE_DESIGN",
        reviewer: "r",
        reason: "저장소 추상화 없음",
        satisfiedSubCriterionIds: ["R-12c", "R-12a"],
      },
      current,
    );
    expect(some.next).toEqual({ earnedPoints: 7, verdict: "PARTIAL", reviewState: "CONFIRMED" });
    // rubric 순서로 정렬된다
    expect(some.satisfiedSubCriterionIds).toEqual(["R-12a", "R-12c"]);
    expect(some.needsHumanReviewEvidence).toBe(true);
    // PARTIAL 결과가 집계 엔진의 하위 기준 검산을 통과한다
    const summary = aggregateScore(
      [
        {
          ...current,
          ...some.next,
          satisfiedSubCriterionIds: some.satisfiedSubCriterionIds!,
          evidenceIds: ["ev-h"],
        },
      ],
      rubric,
    );
    expect(summary.earned).toBe(7);

    const none = plan(
      {
        kind: "APPROVE_DESIGN",
        reviewer: "r",
        reason: "세 기준 모두 미충족",
        satisfiedSubCriterionIds: [],
      },
      current,
    );
    expect(none.next).toEqual({ earnedPoints: 0, verdict: "FAIL", reviewState: "CONFIRMED" });
  });

  it("APPROVE_DESIGN은 감점이면 사유가 필수이고, 모르는 하위 기준·HUMAN_REVIEW가 아닌 기준을 거부한다", () => {
    const design = resultFor("R-12", {
      earnedPoints: null,
      verdict: "INCONCLUSIVE",
      reviewState: "PENDING",
      evidenceIds: [],
    });
    expect(() =>
      plan({ kind: "APPROVE_DESIGN", reviewer: "r", satisfiedSubCriterionIds: ["R-12a"] }, design),
    ).toThrow(/사유/);
    expect(() =>
      plan({ kind: "APPROVE_DESIGN", reviewer: "r", satisfiedSubCriterionIds: ["R-99"] }, design),
    ).toThrow(/R-99/);
    expect(() =>
      plan(
        { kind: "APPROVE_DESIGN", reviewer: "r", satisfiedSubCriterionIds: [] },
        resultFor("R-01"),
      ),
    ).toThrow(/HUMAN_REVIEW/);
  });
});
