/**
 * 사람 검토 액션 (TICKET.md T-306, PRD 5장 규칙 7·9장, 부록 B·C). 서버 액션(`actions.ts`)이 이 함수를 부른다.
 *
 * 한 트랜잭션에서: 판정 행 잠금 → `planReviewAction`(core, 순수 규칙) → 감점인데 근거가 없으면 `HUMAN_REVIEW` 근거 생성(G-02)
 * → `criterion_results` 갱신 → `review_events`에 원래 값·새 값·사유·검토자 추가 → 평가 점수를 `aggregateScore`로 다시 저장.
 * 이 모듈은 쓰기 경로다. 화면·조회 API는 저장된 점수를 옮기기만 하고(T-207·T-301) 여기서만 집계 엔진을 부른다.
 * 점수 계산에 LLM은 없다 (G-01). 제출 코드는 어디서도 실행하지 않는다 (G-05).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  aggregateScore,
  planReviewAction,
  ReviewActionInputSchema,
  ReviewPlanError,
  ScoreAggregationError,
  type ReviewActionInput,
  type ReviewEvent,
  type ScoreSummary,
} from "@ohmyti/core";
import {
  applyCriterionReview,
  getAssignmentVersion,
  getEvaluation,
  insertEvidences,
  insertReviewEvent,
  listEvidences,
  listCriterionResults,
  lockCriterionResult,
  setEvaluationScore,
  toCriterionResult,
  toReviewEvent,
  type Database,
} from "@ohmyti/db";

export interface ReviewDeps {
  db: Database;
}

export type ReviewErrorCode =
  | "INVALID_INPUT"
  | "EVALUATION_NOT_FOUND"
  | "CRITERION_NOT_FOUND"
  | "RESULT_NOT_FOUND"
  | "REVIEW_REJECTED"
  | "INTERNAL";

export type ReviewActionResult<T> =
  { ok: true; data: T } | { ok: false; code: ReviewErrorCode; message: string; details?: unknown };

export interface ReviewApplied {
  event: ReviewEvent;
  /** 갱신된 판정 값 */
  criterion: { id: string; earnedPoints: number | null; verdict: string; reviewState: string };
  /** 다시 저장한 평가 점수 (부록 C 표기 포함) */
  score: { earned: number; min: number; max: number; pendingPoints: number; display: string };
}

const TargetSchema = z.strictObject({
  evaluationId: z.uuid("평가 ID 형식이 아닙니다"),
  criterionId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "기준 ID 형식이 아닙니다"),
});

function invalidInput(error: z.ZodError): ReviewActionResult<never> {
  return {
    ok: false,
    code: "INVALID_INPUT",
    message: error.issues.map((i) => `${i.path.join(".") || "입력"}: ${i.message}`).join("; "),
    details: error.issues,
  };
}

class ReviewRejectedError extends Error {
  readonly code: ReviewErrorCode;
  constructor(code: ReviewErrorCode, message: string) {
    super(message);
    this.name = "ReviewRejectedError";
    this.code = code;
  }
}

function scoreFieldsOf(summary: ScoreSummary) {
  return {
    earned: summary.earned,
    min: summary.min,
    max: summary.max,
    pendingPoints: summary.pendingPoints,
    byArea: summary.byArea,
  };
}

/**
 * 검토 액션을 적용한다. 입력은 여기서 다시 검증한다 (클라이언트 검사와 무관하게).
 * 거부 사유는 `ok: false`로 돌려주며 예외를 던지지 않는다 (G-09·G-14).
 */
export async function applyReviewAction(
  deps: ReviewDeps,
  target: { evaluationId: string; criterionId: string },
  rawInput: unknown,
): Promise<ReviewActionResult<ReviewApplied>> {
  const parsedTarget = TargetSchema.safeParse(target);
  if (!parsedTarget.success) return invalidInput(parsedTarget.error);
  const parsedInput = ReviewActionInputSchema.safeParse(rawInput);
  if (!parsedInput.success) return invalidInput(parsedInput.error);
  const { evaluationId, criterionId } = parsedTarget.data;
  const input: ReviewActionInput = parsedInput.data;

  // 평가·과제 버전은 승인 뒤 불변이라(T-201) 트랜잭션 밖에서 읽어도 된다
  const evaluation = await getEvaluation(deps.db, evaluationId);
  if (!evaluation) {
    return {
      ok: false,
      code: "EVALUATION_NOT_FOUND",
      message: `평가를 찾을 수 없습니다: ${evaluationId}`,
    };
  }
  const version = await getAssignmentVersion(deps.db, evaluation.assignmentVersionId);
  if (!version) {
    return {
      ok: false,
      code: "INTERNAL",
      message: `평가의 과제 버전이 없습니다: ${evaluation.assignmentVersionId}`,
    };
  }
  const rubric = version.rubric;
  const criterion = rubric.criteria.find((c) => c.id === criterionId);
  if (!criterion) {
    return {
      ok: false,
      code: "CRITERION_NOT_FOUND",
      message: `기준이 rubric에 없습니다: ${criterionId}`,
    };
  }

  try {
    const applied = await deps.db.transaction(async (tx) => {
      const locked = await lockCriterionResult(tx, evaluationId, criterionId);
      if (!locked) {
        throw new ReviewRejectedError(
          "RESULT_NOT_FOUND",
          `${criterionId}의 판정이 아직 저장되지 않아 검토할 수 없습니다`,
        );
      }
      const current = toCriterionResult(locked);
      // LLM 추정 근거(T-407)는 감점의 근거가 될 수 없다 (G-01·G-02). 관측·사람 검토 근거가 없으면 검토 기록을 근거로 남긴다
      const llmEvidenceIds = new Set(
        (await listEvidences(tx, evaluationId))
          .filter((e) => e.kind === "LLM_INTERPRETATION")
          .map((e) => e.id),
      );
      const plan = planReviewAction(
        input,
        { ...current, evidenceIds: current.evidenceIds.filter((id) => !llmEvidenceIds.has(id)) },
        criterion,
        rubric,
      );

      // 감점인데 근거가 없으면 검토 기록 자체를 근거로 남긴다 (G-02). 코드 위치·실행 기록은 없고 화면은 `사람 검토`로 표시한다
      const evidenceIds = [...locked.evidenceIds];
      if (plan.needsHumanReviewEvidence) {
        const id = randomUUID();
        await insertEvidences(tx, [
          {
            id,
            evaluationId,
            submissionSha: evaluation.submissionSha,
            artifactRefs: [],
            kind: "HUMAN_REVIEW",
          },
        ]);
        evidenceIds.push(id);
      }

      const updated = await applyCriterionReview(tx, locked.id, {
        earnedPoints: plan.next.earnedPoints,
        verdict: plan.next.verdict,
        reviewState: plan.next.reviewState,
        satisfiedSubCriterionIds: plan.satisfiedSubCriterionIds,
        evidenceIds,
      });
      const eventRow = await insertReviewEvent(tx, {
        evaluationId,
        criterionResultId: locked.id,
        criterionId,
        kind: plan.kind,
        reviewer: plan.reviewer,
        previous: plan.previous,
        next: plan.next,
        reason: plan.reason,
      });

      // 점수는 항상 다시 집계한다 (점수가 안 바뀌어도 저장값이 판정과 어긋나지 않게)
      const rows = await listCriterionResults(tx, evaluationId);
      const summary = aggregateScore(rows.map(toCriterionResult), rubric);
      await setEvaluationScore(tx, evaluationId, scoreFieldsOf(summary));

      return {
        event: toReviewEvent(eventRow),
        criterion: {
          id: criterionId,
          earnedPoints: updated.earnedPoints,
          verdict: updated.verdict,
          reviewState: updated.reviewState,
        },
        score: {
          earned: summary.earned,
          min: summary.min,
          max: summary.max,
          pendingPoints: summary.pendingPoints,
          display: summary.display,
        },
      } satisfies ReviewApplied;
    });
    return { ok: true, data: applied };
  } catch (error) {
    if (error instanceof ReviewRejectedError) {
      return { ok: false, code: error.code, message: error.message };
    }
    if (error instanceof ReviewPlanError) {
      return {
        ok: false,
        code: "REVIEW_REJECTED",
        message: error.message,
        details: { code: error.code },
      };
    }
    if (error instanceof ScoreAggregationError) {
      return {
        ok: false,
        code: "REVIEW_REJECTED",
        message: `점수를 다시 집계할 수 없어 되돌렸습니다: ${error.message}`,
        details: { code: error.code, ref: error.ref },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "INTERNAL", message: `검토를 저장하지 못했습니다: ${message}` };
  }
}
