import { z } from "zod";
import type { CriterionResult } from "./contracts";
import type { ReviewEventKind } from "./entities";
import type { ReviewState, Verdict } from "./enums";
import type { Criterion, Rubric } from "./rubric";

/**
 * 사람 검토 액션의 계획 (TICKET.md T-306, 부록 B·C).
 * 순수 함수다. 현재 판정(`CriterionResult`)·rubric·입력에서 다음 판정 값과 이력(`review_events`)에 남길 previous/next를 만든다.
 * DB·UI에 의존하지 않으며 점수 재계산은 호출자가 `aggregateScore`로 한다 (G-01: LLM 없음).
 *
 * 판정 규칙
 * - CONFIRM: 점수·verdict 불변, reviewState → CONFIRMED. 사유는 선택(없으면 기본 문구).
 * - OVERRIDE: `earnedPoints`(0 ≤ n ≤ max)를 사람 값으로 바꾼다. 사유·검토자 필수. verdict는 max면 PASS, 아니면 FAIL
 *   (PARTIAL은 rubric 하위 기준 합으로만 계산하므로 임의 점수에 쓰지 않는다). reviewState → CONFIRMED.
 * - DISPUTE: 점수·verdict 불변, 메모(사유) 필수, reviewState → PENDING (이의가 있으면 다시 검토 대기다).
 * - APPROVE_DESIGN: HUMAN_REVIEW 기준만. 충족한 하위 기준 ID로 rubric `partialRules`의 배점 합을 점수로 확정한다.
 *   전부면 PASS, 없으면 FAIL, 일부면 PARTIAL(+`satisfiedSubCriterionIds`). reviewState → CONFIRMED. 감점이면 사유 필수.
 * - 감점(earned < max)인데 기준에 근거가 없으면 호출자가 `HUMAN_REVIEW` 근거를 만들어 연결해야 한다 (G-02, `needsHumanReviewEvidence`).
 */

export const REVIEWER_MAX_LENGTH = 100;
export const REVIEW_REASON_MAX_LENGTH = 2000;

const ReviewerSchema = z
  .string()
  .trim()
  .min(1, "검토자를 입력하세요")
  .max(REVIEWER_MAX_LENGTH, `검토자는 ${REVIEWER_MAX_LENGTH}자 이하여야 합니다`);
const ReasonSchema = z
  .string()
  .trim()
  .max(REVIEW_REASON_MAX_LENGTH, `사유는 ${REVIEW_REASON_MAX_LENGTH}자 이하여야 합니다`);
const RequiredReasonSchema = ReasonSchema.min(1, "사유를 입력하세요");

export const ReviewActionInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("CONFIRM"),
    reviewer: ReviewerSchema,
    reason: ReasonSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("OVERRIDE"),
    reviewer: ReviewerSchema,
    reason: RequiredReasonSchema,
    earnedPoints: z.int("점수는 정수여야 합니다").min(0, "점수는 음수일 수 없습니다"),
  }),
  z.strictObject({
    kind: z.literal("DISPUTE"),
    reviewer: ReviewerSchema,
    reason: RequiredReasonSchema,
  }),
  z.strictObject({
    kind: z.literal("APPROVE_DESIGN"),
    reviewer: ReviewerSchema,
    reason: ReasonSchema.optional(),
    /** 충족한 하위 기준 ID (rubric `partialRules[].subCriteria[].id`). 중복은 무시한다 */
    satisfiedSubCriterionIds: z.array(z.string().min(1)),
  }),
]);
export type ReviewActionInput = z.infer<typeof ReviewActionInputSchema>;

export const DEFAULT_REVIEW_REASON: Record<ReviewEventKind, string> = {
  CONFIRM: "판정을 확인했습니다",
  OVERRIDE: "",
  DISPUTE: "",
  APPROVE_DESIGN: "설계 점수를 확정했습니다",
};

export type ReviewPlanErrorCode =
  | "REASON_REQUIRED"
  | "POINTS_EXCEED_MAX"
  | "POINTS_NEGATIVE"
  | "NOT_HUMAN_REVIEW"
  | "NO_PARTIAL_RULE"
  | "UNKNOWN_SUB_CRITERION";

export class ReviewPlanError extends Error {
  readonly code: ReviewPlanErrorCode;

  constructor(code: ReviewPlanErrorCode, message: string) {
    super(message);
    this.name = "ReviewPlanError";
    this.code = code;
  }
}

/** `review_events.previous`·`next`에 남는 값 */
export interface ReviewSnapshot {
  earnedPoints: number | null;
  verdict: Verdict;
  reviewState: ReviewState;
}

export interface ReviewPlan {
  kind: ReviewEventKind;
  reviewer: string;
  reason: string;
  previous: ReviewSnapshot;
  next: ReviewSnapshot;
  /** `criterion_results.satisfied_sub_criterion_ids`의 다음 값. PARTIAL이 아니면 null */
  satisfiedSubCriterionIds: string[] | null;
  /** 감점(earned < max)인데 기준이 참조하는 근거가 없다. 호출자가 `HUMAN_REVIEW` 근거를 만들어야 한다 (G-02) */
  needsHumanReviewEvidence: boolean;
  /** 점수(earnedPoints)가 바뀌었다. 바뀌면 평가 점수를 `aggregateScore`로 다시 저장해야 한다 */
  pointsChanged: boolean;
}

export function snapshotOf(
  result: Pick<CriterionResult, "earnedPoints" | "verdict" | "reviewState">,
): ReviewSnapshot {
  return {
    earnedPoints: result.earnedPoints,
    verdict: result.verdict,
    reviewState: result.reviewState,
  };
}

function finish(
  input: ReviewActionInput,
  current: CriterionResult,
  next: ReviewSnapshot,
  satisfiedSubCriterionIds: string[] | null,
  reason: string,
): ReviewPlan {
  const deduction = next.earnedPoints !== null && next.earnedPoints < current.maxPoints;
  return {
    kind: input.kind,
    reviewer: input.reviewer,
    reason,
    previous: snapshotOf(current),
    next,
    satisfiedSubCriterionIds,
    needsHumanReviewEvidence: deduction && current.evidenceIds.length === 0,
    pointsChanged: next.earnedPoints !== current.earnedPoints,
  };
}

/**
 * 검토 액션을 현재 판정에 적용한 계획을 만든다. 규칙 위반은 `ReviewPlanError`를 던진다.
 * `criterion`은 `current.criterionId`의 rubric 항목, `rubric`은 APPROVE_DESIGN의 하위 기준 조회에 쓴다.
 */
export function planReviewAction(
  input: ReviewActionInput,
  current: CriterionResult,
  criterion: Criterion,
  rubric: Rubric,
): ReviewPlan {
  switch (input.kind) {
    case "CONFIRM": {
      const reason =
        input.reason && input.reason.length > 0 ? input.reason : DEFAULT_REVIEW_REASON.CONFIRM;
      return finish(
        input,
        current,
        { ...snapshotOf(current), reviewState: "CONFIRMED" },
        current.satisfiedSubCriterionIds ?? null,
        reason,
      );
    }
    case "DISPUTE": {
      return finish(
        input,
        current,
        { ...snapshotOf(current), reviewState: "PENDING" },
        current.satisfiedSubCriterionIds ?? null,
        input.reason,
      );
    }
    case "OVERRIDE": {
      if (input.earnedPoints < 0) {
        throw new ReviewPlanError("POINTS_NEGATIVE", "점수는 음수일 수 없습니다");
      }
      if (input.earnedPoints > current.maxPoints) {
        throw new ReviewPlanError(
          "POINTS_EXCEED_MAX",
          `점수(${input.earnedPoints})가 배점(${current.maxPoints})을 넘습니다`,
        );
      }
      const verdict: Verdict = input.earnedPoints === current.maxPoints ? "PASS" : "FAIL";
      return finish(
        input,
        current,
        { earnedPoints: input.earnedPoints, verdict, reviewState: "CONFIRMED" },
        null,
        input.reason,
      );
    }
    case "APPROVE_DESIGN": {
      if (criterion.method !== "HUMAN_REVIEW") {
        throw new ReviewPlanError(
          "NOT_HUMAN_REVIEW",
          `${criterion.id}은(는) 사람 검토(HUMAN_REVIEW) 기준이 아닙니다. 점수를 바꾸려면 OVERRIDE를 쓰세요`,
        );
      }
      const rule = rubric.partialRules.find((r) => r.criterionId === criterion.id);
      if (!criterion.allowPartial || !rule || rule.subCriteria.length === 0) {
        throw new ReviewPlanError(
          "NO_PARTIAL_RULE",
          `${criterion.id}에는 하위 기준 규칙이 없습니다. OVERRIDE로 확정하세요`,
        );
      }
      const pointsBySubId = new Map(rule.subCriteria.map((sub) => [sub.id, sub.points]));
      const satisfied: string[] = [];
      for (const subId of input.satisfiedSubCriterionIds) {
        if (!pointsBySubId.has(subId)) {
          throw new ReviewPlanError(
            "UNKNOWN_SUB_CRITERION",
            `rubric에 없는 하위 기준입니다: ${subId}`,
          );
        }
        if (!satisfied.includes(subId)) satisfied.push(subId);
      }
      // rubric 순서로 정렬해 저장한다
      const ordered = rule.subCriteria.map((sub) => sub.id).filter((id) => satisfied.includes(id));
      const sum = ordered.reduce((acc, id) => acc + (pointsBySubId.get(id) ?? 0), 0);
      const earnedPoints = Math.min(sum, criterion.maxPoints);
      const all = ordered.length === rule.subCriteria.length;
      const verdict: Verdict = all ? "PASS" : ordered.length === 0 ? "FAIL" : "PARTIAL";
      const reason = input.reason && input.reason.length > 0 ? input.reason : "";
      if (earnedPoints < criterion.maxPoints && reason.length === 0) {
        throw new ReviewPlanError("REASON_REQUIRED", "감점하려면 사유를 입력하세요");
      }
      return finish(
        input,
        current,
        { earnedPoints, verdict, reviewState: "CONFIRMED" },
        verdict === "PARTIAL" ? ordered : null,
        reason.length > 0 ? reason : DEFAULT_REVIEW_REASON.APPROVE_DESIGN,
      );
    }
  }
}
