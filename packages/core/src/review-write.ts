/**
 * LLM 근거 탐색·리뷰 (TICKET.md T-407, REVIEW_WRITE 단계, 1.5의 3번 용도)의 스키마.
 *
 * - `EvidenceReviewOutputSchema`: LLM 출력. 점수·판정 키(`score`·`points`·`earned`·`verdict`)가 없다 (G-01, T-401 금지 키).
 *   파일 위치(`sourceRefs`)와 재생 스텝(`stepIds`)은 형식만 느슨하게 받고, 스냅샷·timeline 대조는 워커 후처리가 한다.
 *   위치 하나가 틀렸다고 출력 전체를 버리지 않기 위해서다(무효 참조만 제거).
 * - `EvidenceDetailSchema`: `evidences.detail`. LLM이 제안한 위치·설계 의견의 출처와 제안 내용이다. 점수가 아니다.
 * - `ReviewWriteSummarySchema`: REVIEW_WRITE 단계 기록(`stage_log[].detail`). 명세 외 개선 제안도 여기에 둔다.
 */
import { z } from "zod";
import { IdSchema } from "./common";

export const REVIEW_CONFIDENCE = ["HIGH", "LOW", "UNKNOWN"] as const;
export const ReviewConfidenceSchema = z.enum(REVIEW_CONFIDENCE);
export type ReviewConfidence = z.infer<typeof ReviewConfidenceSchema>;

/** LLM이 제안한 코드 위치. 스냅샷에 있는 파일인지, 라인이 파일 길이 안인지는 후처리가 확인한다 */
export const ReviewSourceRefSchema = z.object({
  path: z.string().min(1).max(512),
  startLine: z.int(),
  endLine: z.int(),
});
export type ReviewSourceRef = z.infer<typeof ReviewSourceRefSchema>;

export const EvidenceReviewOutputSchema = z.object({
  /** FAIL 기준별 추정 원인. 관측(`observation`)이 아니라 해석이다 */
  failures: z
    .array(
      z.object({
        criterionId: z.string().min(1).max(64),
        interpretation: z.string().min(1).max(2000),
        confidence: ReviewConfidenceSchema,
        sourceRefs: z.array(ReviewSourceRefSchema).max(8),
        /** 입력으로 준 실패 재생 스텝(`stepId`)만 참조하는 최소 재현 설명 */
        minimalReproSummary: z.object({
          summary: z.string().min(1).max(1000),
          stepIds: z.array(z.string().min(1).max(64)).max(20),
        }),
      }),
    )
    .max(30),
  /** 사람 검토(HUMAN_REVIEW) 기준의 설계 평가 초안. 제안 점수는 근거로만 저장되고 판정 점수가 되지 않는다 */
  designReviews: z
    .array(
      z.object({
        criterionId: z.string().min(1).max(64),
        suggestedPoints: z.int().min(0),
        rationale: z.string().min(1).max(2000),
        sourceRefs: z.array(ReviewSourceRefSchema).max(8),
      }),
    )
    .max(10),
  /** 명세 밖의 개선 제안. 점수와 무관하다 */
  suggestions: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        detail: z.string().min(1).max(1000),
        outsideSpec: z.literal(true),
      }),
    )
    .max(8),
});
export type EvidenceReviewOutput = z.infer<typeof EvidenceReviewOutputSchema>;

/**
 * `evidences.detail` (kind `LLM_INTERPRETATION`). REVIEW_WRITE가 만든 근거의 출처와 내용.
 * - `FAILURE_CAUSE`: FAIL 기준의 추정 원인 위치 (`confidence`)
 * - `DESIGN_SUGGESTION`: 설계 평가 초안. 코드 위치가 없는 요약 근거 하나가 `suggestedPoints`·`rationale`을 갖고,
 *   코드 위치 근거는 출처만 갖는다. `suggestedPoints`는 사람에게 보이는 제안이며 `earned_points`로 옮기지 않는다
 */
export const EvidenceDetailSchema = z.strictObject({
  origin: z.literal("REVIEW_WRITE"),
  role: z.enum(["FAILURE_CAUSE", "DESIGN_SUGGESTION"]),
  criterionId: z.string().min(1),
  /** 이 근거를 만든 LLM 호출 기록 (`ai_reviews.id`) */
  aiReviewId: IdSchema.nullable(),
  aiReviewVersion: z.int().min(1).nullable(),
  confidence: ReviewConfidenceSchema.optional(),
  suggestedPoints: z.int().min(0).optional(),
  maxPoints: z.int().min(0).optional(),
  rationale: z.string().min(1).optional(),
});
export type EvidenceDetail = z.infer<typeof EvidenceDetailSchema>;

/** LLM 호출 결과 상태 (`@ohmyti/llm` `LlmStepOutcome`과 같은 값) */
export const ReviewWriteLlmStatusSchema = z.enum(["OK", "NOT_RUN", "INCONCLUSIVE"]);
export type ReviewWriteLlmStatus = z.infer<typeof ReviewWriteLlmStatusSchema>;

export const ReviewWriteDroppedSchema = z.strictObject({
  kind: z.enum(["SOURCE_REF", "STEP", "FAILURE", "DESIGN_REVIEW"]),
  criterionId: z.string().nullable(),
  /** 버린 값 (경로·스텝 ID 등) */
  value: z.string(),
  reason: z.string().min(1),
});
export type ReviewWriteDropped = z.infer<typeof ReviewWriteDroppedSchema>;

export const ReviewSuggestionSchema = z.strictObject({
  title: z.string().min(1),
  detail: z.string().min(1),
  outsideSpec: z.literal(true),
});
export type ReviewSuggestion = z.infer<typeof ReviewSuggestionSchema>;

/** REVIEW_WRITE 단계 기록의 `detail` */
export const ReviewWriteSummarySchema = z.strictObject({
  llm: ReviewWriteLlmStatusSchema,
  /** LLM 오류 이름 (`LlmBudgetExceededError` 등). OK면 null */
  llmError: z.string().nullable(),
  promptVersion: z.string().min(1),
  model: z.string().nullable(),
  aiReviewId: IdSchema.nullable(),
  aiReviewVersion: z.int().min(1).nullable(),
  /** 추정 원인을 요청한 FAIL 기준 */
  targets: z.array(z.string()),
  interpretations: z.array(
    z.strictObject({
      criterionId: z.string().min(1),
      confidence: ReviewConfidenceSchema,
      evidenceIds: z.array(IdSchema),
      minimalRepro: z.strictObject({
        summary: z.string().min(1),
        stepIds: z.array(z.string().min(1)),
      }),
    }),
  ),
  designSuggestions: z.array(
    z.strictObject({
      criterionId: z.string().min(1),
      suggestedPoints: z.int().min(0),
      maxPoints: z.int().min(0),
      rationale: z.string().min(1),
      evidenceIds: z.array(IdSchema),
    }),
  ),
  suggestions: z.array(ReviewSuggestionSchema),
  dropped: z.array(ReviewWriteDroppedSchema),
});
export type ReviewWriteSummary = z.infer<typeof ReviewWriteSummarySchema>;

/** 예산 초과로 LLM을 부르지 않았을 때 REVIEW_WRITE 단계(DONE)의 사유 (티켓 문구 그대로) */
export const REVIEW_WRITE_BUDGET_EXCEEDED_REASON = "LLM 미실행(예산 초과)";
/** LLM 설정 오류로 부르지 않았을 때의 사유 (단계 DONE) */
export const REVIEW_WRITE_LLM_CONFIG_REASON = "LLM 미실행(설정 오류)";
/** 워커에 LLM이 설정되지 않아 단계를 건너뛸 때의 사유 (단계 SKIPPED) */
export const REVIEW_WRITE_LLM_NOT_CONFIGURED_REASON = "LLM 미실행(설정 없음)";
/** 호출했지만 쓸 수 있는 출력이 없을 때의 사유 접두사 (단계 DONE, 점수 불변) */
export const REVIEW_WRITE_INCONCLUSIVE_REASON = "LLM 결과 미확정";
