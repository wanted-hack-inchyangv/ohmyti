/**
 * LLM 근거 탐색·리뷰 (TICKET.md T-407, REVIEW_WRITE 단계, 1.5의 3번 용도)의 스키마.
 *
 * - `EvidenceReviewOutputSchema`: LLM 출력. 점수·판정 키(`score`·`points`·`earned`·`verdict`)가 없다 (G-01, T-401 금지 키).
 *   파일 위치(`sourceRefs`)와 재생 스텝(`stepIds`)은 형식만 느슨하게 받고, 스냅샷·timeline 대조는 워커 후처리가 한다.
 *   위치 하나가 틀렸다고 출력 전체를 버리지 않기 위해서다(무효 참조만 제거).
 * - `EvidenceReviewLenientOutputSchema`: REVIEW_WRITE가 실제로 넘기는 스키마 (T-601). 항목 하나가 스키마에 맞지 않으면
 *   그 항목만 버리고(`splitEvidenceReviewOutput`) 나머지를 쓴다. LLM에 보이는 JSON Schema는 엄격 스키마와 같다.
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

/** FAIL 기준 하나의 추정 원인. 관측(`observation`)이 아니라 해석이다 */
export const ReviewFailureItemSchema = z.object({
  criterionId: z.string().min(1).max(64),
  interpretation: z.string().min(1).max(2000),
  confidence: ReviewConfidenceSchema,
  sourceRefs: z.array(ReviewSourceRefSchema).max(8),
  /**
   * 입력으로 준 실패 재생 스텝(`stepId`)만 참조하는 최소 재현 설명.
   * 실패 재생 스텝이 없는 기준(mutation, 서비스 기동 실패 등)은 생략한다 (T-601)
   */
  minimalReproSummary: z
    .object({
      summary: z.string().min(1).max(1000),
      stepIds: z.array(z.string().min(1).max(64)).max(20),
    })
    .optional(),
});

/** 사람 검토(HUMAN_REVIEW) 기준의 설계 평가 초안. 제안 점수는 근거로만 저장되고 판정 점수가 되지 않는다 */
export const ReviewDesignItemSchema = z.object({
  criterionId: z.string().min(1).max(64),
  suggestedPoints: z.int().min(0),
  rationale: z.string().min(1).max(2000),
  sourceRefs: z.array(ReviewSourceRefSchema).max(8),
});

/** 명세 밖의 개선 제안. 점수와 무관하다 */
export const ReviewSuggestionItemSchema = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(1000),
  outsideSpec: z.literal(true),
});

export const REVIEW_OUTPUT_LIMITS = { failures: 30, designReviews: 10, suggestions: 8 } as const;

export const EvidenceReviewOutputSchema = z.object({
  failures: z.array(ReviewFailureItemSchema).max(REVIEW_OUTPUT_LIMITS.failures),
  designReviews: z.array(ReviewDesignItemSchema).max(REVIEW_OUTPUT_LIMITS.designReviews),
  suggestions: z.array(ReviewSuggestionItemSchema).max(REVIEW_OUTPUT_LIMITS.suggestions),
});
export type EvidenceReviewOutput = z.infer<typeof EvidenceReviewOutputSchema>;

export const REVIEW_OUTPUT_SECTIONS = ["failures", "designReviews", "suggestions"] as const;
export type ReviewOutputSection = (typeof REVIEW_OUTPUT_SECTIONS)[number];

/**
 * 스키마에 맞지 않아 버린 출력 항목 하나 (T-601). 위치와 사유 코드만 두고 항목 본문은 남기지 않는다.
 * `criterionId`는 항목에 기준 ID 형식의 값이 있을 때만 옮긴다.
 */
export const ReviewInvalidItemSchema = z.strictObject({
  section: z.enum(REVIEW_OUTPUT_SECTIONS),
  index: z.int().min(0),
  criterionId: z.string().nullable(),
  /** zod 이슈 코드 (`too_small`, `invalid_type` 등) */
  issueCode: z.string().min(1),
  /** 항목 안에서 문제가 된 필드 경로 (`minimalReproSummary.summary`). 항목 자체면 빈 문자열 */
  path: z.string(),
});
export type ReviewInvalidItem = z.infer<typeof ReviewInvalidItemSchema>;

/** 관대한 외곽 스키마가 무효 항목 자리에 넣는 표지. 본문 대신 사유만 갖는다 */
interface InvalidItemMarker {
  invalidItem: { criterionId: string | null; issueCode: string; path: string };
}

const CRITERION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * 항목 스키마를 검증에 실패해도 전체를 실패시키지 않는 스키마로 감싼다. `catch`는 JSON Schema에 드러나지 않으므로
 * LLM에 보내는 출력 형식은 엄격 스키마와 같다. 무효 항목은 `InvalidItemMarker`로 바뀐다.
 */
function lenientItem<T>(schema: z.ZodType<T>): z.ZodType<T | InvalidItemMarker> {
  return schema.catch((ctx) => {
    const input = ctx.input as { criterionId?: unknown } | null;
    const rawId = input && typeof input === "object" ? input.criterionId : undefined;
    const issue = ctx.error.issues[0];
    const marker: InvalidItemMarker = {
      invalidItem: {
        criterionId: typeof rawId === "string" && CRITERION_ID_PATTERN.test(rawId) ? rawId : null,
        issueCode: issue?.code ?? "invalid",
        path: issue ? issue.path.map(String).join(".") : "",
      },
    };
    return marker as T;
  });
}

/**
 * REVIEW_WRITE가 LLM에 넘기는 관대한 외곽 스키마 (T-601). 외곽(배열 3개의 존재와 상한)은 엄격하게,
 * 항목은 하나씩 엄격 스키마로 검증한다. 외곽이 무효면 `@ohmyti/llm`의 재요청·실패 규칙이 그대로 적용된다.
 */
export const EvidenceReviewLenientOutputSchema = z.object({
  failures: z.array(lenientItem(ReviewFailureItemSchema)).max(REVIEW_OUTPUT_LIMITS.failures),
  designReviews: z
    .array(lenientItem(ReviewDesignItemSchema))
    .max(REVIEW_OUTPUT_LIMITS.designReviews),
  suggestions: z
    .array(lenientItem(ReviewSuggestionItemSchema))
    .max(REVIEW_OUTPUT_LIMITS.suggestions),
});
export type EvidenceReviewLenientOutput = z.infer<typeof EvidenceReviewLenientOutputSchema>;

function isInvalidItem(item: unknown): item is InvalidItemMarker {
  return typeof item === "object" && item !== null && "invalidItem" in item;
}

/** 관대한 출력을 유효 항목(엄격 스키마 타입)과 버린 항목 목록으로 나눈다 */
export function splitEvidenceReviewOutput(lenient: EvidenceReviewLenientOutput): {
  output: EvidenceReviewOutput;
  invalidItems: ReviewInvalidItem[];
} {
  const invalidItems: ReviewInvalidItem[] = [];
  const keep = <T>(section: ReviewOutputSection, items: readonly (T | InvalidItemMarker)[]): T[] =>
    items.flatMap((item, index) => {
      if (!isInvalidItem(item)) return [item];
      invalidItems.push({ section, index, ...item.invalidItem });
      return [];
    });
  const output: EvidenceReviewOutput = {
    failures: keep("failures", lenient.failures),
    designReviews: keep("designReviews", lenient.designReviews),
    suggestions: keep("suggestions", lenient.suggestions),
  };
  return { output, invalidItems };
}

/** 유효 항목 수 (세 배열 합) */
export function evidenceReviewItemCount(output: EvidenceReviewOutput): number {
  return output.failures.length + output.designReviews.length + output.suggestions.length;
}

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
      /** 실패 재생 스텝이 없는 기준이거나 설명이 비었으면 null (T-601) */
      minimalRepro: z
        .strictObject({
          summary: z.string().min(1),
          stepIds: z.array(z.string().min(1)),
        })
        .nullable(),
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
  /** 스키마에 맞지 않아 버린 출력 항목 수 (T-601). 이전 기록에는 없어서 0으로 읽는다 */
  droppedItems: z.int().min(0).default(0),
  /** 버린 항목의 위치와 사유 코드. 본문은 남기지 않는다 */
  invalidItems: z.array(ReviewInvalidItemSchema).default([]),
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
