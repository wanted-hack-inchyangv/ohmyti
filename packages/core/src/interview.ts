/**
 * 인터뷰 키트 계약 (TICKET.md T-701, PRD 14.2). 생성은 T-702(INTERVIEW_KIT 단계), 화면은 T-704가 맡는다.
 *
 * - 무엇을 물을지(슬롯·우선순위·시간)는 코드가 저장된 판정에서 정하고, LLM은 문장만 쓴다. `source`가 그 구분이다.
 * - 근거 참조(`refs`)는 저장된 기준·실행 기록·코드 위치·변이·맥락 연결 중 하나 이상이다. LLM 출력이 아니라 계획의 값을 쓴다.
 * - 점수·판정·등급·추천·순위를 담는 필드가 없다 (G-01, G-13, PRD 14.4). 평가 척도는 역량별 고정 앵커(`COMPETENCY_ANCHORS`)다.
 */
import { z } from "zod";
import { DigestSchema, IdSchema, NonNegativeIntSchema, SourceLocationSchema } from "./common";
import { CompetencySchema } from "./competency";
import { InterviewLintRuleSchema } from "./interview-lint";

/** 질문이 나온 곳 (PRD 14.2의 여섯 가지 출처) */
export const InterviewQuestionKindSchema = z.enum([
  "FAILURE_DEBRIEF",
  "TEST_DESIGN",
  "DESIGN_TRADEOFF",
  "STRENGTH_DEPTH",
  "EXTENSION",
  "RESUME_BRIDGE",
]);
export type InterviewQuestionKind = z.infer<typeof InterviewQuestionKindSchema>;

export const INTERVIEW_QUESTION_KIND_LABELS: Readonly<Record<InterviewQuestionKind, string>> = {
  FAILURE_DEBRIEF: "실패 디브리핑",
  TEST_DESIGN: "테스트 설계",
  DESIGN_TRADEOFF: "설계 트레이드오프",
  STRENGTH_DEPTH: "강점 확인",
  EXTENSION: "요구사항 확장",
  RESUME_BRIDGE: "이력서 연결",
};

export const InterviewPrioritySchema = z.enum(["MUST", "SHOULD", "OPTIONAL"]);
export type InterviewPriority = z.infer<typeof InterviewPrioritySchema>;

export const INTERVIEW_PRIORITY_LABELS: Readonly<Record<InterviewPriority, string>> = {
  MUST: "필수",
  SHOULD: "권장",
  OPTIONAL: "선택",
};

/** 문장을 LLM이 썼는지, 슬롯의 기본 질문인지 */
export const InterviewQuestionSourceSchema = z.enum(["LLM", "TEMPLATE"]);
export type InterviewQuestionSource = z.infer<typeof InterviewQuestionSourceSchema>;

/**
 * 저장된 근거 하나를 가리키는 참조. 키트 질문과 채용 리포트 항목이 같은 형태를 쓰며, 화면은 기존 워크벤치 딥링크로 바꾼다
 * (`?criterion=`, 재생, `?source=`, 변이 diff, 맥락 연결).
 */
export const ObservationRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("CRITERION"), criterionId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("EXECUTION_RECORD"),
    runId: IdSchema,
    /** 이 실행 기록을 근거로 쓰는 기준 (재생 딥링크에 쓴다) */
    criterionId: z.string().min(1).optional(),
  }),
  z.strictObject({ kind: z.literal("SOURCE"), location: SourceLocationSchema }),
  z.strictObject({
    kind: z.literal("MUTATION"),
    mutationId: z.string().min(1),
    experimentId: IdSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("CONTEXT_LINK"), contextLinkId: IdSchema }),
]);
export type ObservationRef = z.infer<typeof ObservationRefSchema>;

/** 질문 하나에 붙이는 근거 참조 상한 */
export const INTERVIEW_MAX_REFS = 8;
/** 한 키트의 질문 수 상한 (슬롯 상한의 합: 4 + 2 + 2 + 2 + 2 + 3) */
export const INTERVIEW_KIT_MAX_QUESTIONS = 15;
/** 의도·신호 한 항목의 길이 상한 */
export const INTERVIEW_TEXT_MAX_CHARS = 300;

const KitTextSchema = z.string().min(1).max(INTERVIEW_TEXT_MAX_CHARS);

export const InterviewQuestionSchema = z.strictObject({
  /** 슬롯 ID. 키트 안에서 유일하다 (예: `FAILURE_DEBRIEF:R-06`) */
  id: z.string().min(1).max(64),
  kind: InterviewQuestionKindSchema,
  /** 이 질문으로 확인하는 역량 */
  competency: CompetencySchema,
  priority: InterviewPrioritySchema,
  /** 예상 시간 (분) */
  minutes: z.int().min(1).max(20),
  /** 주 질문. 한 문장에 질문 하나인 중립적 개방형 (`lintInterviewQuestion`) */
  question: KitTextSchema,
  /** 이 질문으로 무엇을 확인하려는지 */
  intent: KitTextSchema,
  /** 꼬리 질문 사다리. 사실 → 원리 → 트레이드오프 순서다 */
  probes: z.array(KitTextSchema).min(2).max(3),
  /** 좋은 답변의 신호. 관찰할 수 있는 행동으로 적는다 */
  positiveSignals: z.array(KitTextSchema).min(2).max(4),
  /** 우려 신호. 관찰할 수 있는 행동으로 적는다 */
  concernSignals: z.array(KitTextSchema).min(2).max(4),
  refs: z.array(ObservationRefSchema).min(1).max(INTERVIEW_MAX_REFS),
  source: InterviewQuestionSourceSchema,
});
export type InterviewQuestion = z.infer<typeof InterviewQuestionSchema>;

/**
 * 키트 안의 질문 번호 (Q1, Q2 …). 우선순위(필수 → 권장 → 선택) 순으로, 같은 우선순위 안에서는 저장된 순서대로 센다.
 * 화면(T-704)과 채용 리포트(T-706)가 같은 번호를 쓰도록 여기에 둔다. 슬롯 ID(`FAILURE_DEBRIEF:R-05`)는
 * 내부 식별자라 채용 담당자가 읽는 문서에는 이 번호와 주 질문 문장을 보인다.
 */
export function interviewQuestionNumbers(
  questions: readonly Pick<InterviewQuestion, "id" | "priority">[],
): Map<string, number> {
  const ordered = InterviewPrioritySchema.options.flatMap((priority) =>
    questions.filter((question) => question.priority === priority),
  );
  return new Map(ordered.map((question, index) => [question.id, index + 1]));
}

/** 진행안의 길이 (분). 도입 5분과 지원자 질문 5분을 포함한다 */
export const InterviewPlanDurationSchema = z.union([z.literal(45), z.literal(60)]);
export type InterviewPlanDuration = z.infer<typeof InterviewPlanDurationSchema>;

export const InterviewPlanSegmentSchema = z.strictObject({
  /** 구간 이름 (예: "도입", "실패 디브리핑", "지원자 질문") */
  name: z.string().min(1).max(60),
  minutes: z.int().min(1),
  /** 이 구간에서 묻는 질문 ID (도입·지원자 질문 구간은 비어 있다) */
  questionIds: z.array(z.string().min(1)),
});
export type InterviewPlanSegment = z.infer<typeof InterviewPlanSegmentSchema>;

export const InterviewPlanSchema = z
  .strictObject({
    durationMinutes: InterviewPlanDurationSchema,
    segments: z.array(InterviewPlanSegmentSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const total = plan.segments.reduce((sum, segment) => sum + segment.minutes, 0);
    if (total > plan.durationMinutes) {
      ctx.addIssue({
        code: "custom",
        path: ["segments"],
        message: `구간 시간의 합(${total}분)이 진행안 길이(${plan.durationMinutes}분)를 넘습니다`,
      });
    }
  });
export type InterviewPlan = z.infer<typeof InterviewPlanSchema>;

/** INTERVIEW_KIT 단계의 LLM 상태. 사유 문구는 CONTEXT_LINK와 같은 체계를 쓴다 (T-702) */
export const InterviewKitLlmStatusSchema = z.enum([
  "OK",
  "NOT_RUN",
  "INCONCLUSIVE",
  "NOT_CONFIGURED",
]);
export type InterviewKitLlmStatus = z.infer<typeof InterviewKitLlmStatusSchema>;

/** 채점기 사전 검증 실행(T-405)에서 INTERVIEW_KIT을 건너뛸 때의 사유 (단계 SKIPPED) */
export const INTERVIEW_KIT_VALIDATION_RUN_SKIP_REASON = "검증 실행은 인터뷰 키트를 만들지 않음";

/** 후처리가 버린 LLM 출력 항목. 문장 본문은 남기지 않는다 */
export const InterviewKitDroppedSchema = z.strictObject({
  /** LLM 출력 배열의 위치 */
  index: z.int().min(0).nullable(),
  /** LLM이 돌려준 슬롯 ID (계획에 없는 ID도 그대로 적는다) */
  slotId: z.string().nullable(),
  reason: z.enum(["UNKNOWN_SLOT", "DUPLICATE_SLOT", "SCHEMA_INVALID", "LINT_VIOLATION"]),
  /** `LINT_VIOLATION`일 때 걸린 규칙 */
  rules: z.array(InterviewLintRuleSchema),
});
export type InterviewKitDropped = z.infer<typeof InterviewKitDroppedSchema>;

/** 생성 요약. 단계 기록(`stage_log[].detail`)에도 같은 값을 둔다 */
export const InterviewKitGenerationSchema = z.strictObject({
  /** 계획한 슬롯 수 (= 질문 수) */
  slotCount: NonNegativeIntSchema,
  /** 기본 질문으로 채운 슬롯 수 */
  templateCount: NonNegativeIntSchema,
  llm: InterviewKitLlmStatusSchema,
  /** LLM을 부르지 못했거나 결과가 미확정일 때의 사유. OK면 null */
  llmReason: z.string().nullable(),
  promptVersion: z.string().min(1),
  model: z.string().nullable(),
  aiReviewId: IdSchema.nullable(),
  /** LLM 입력 다이제스트. 이력서가 달라도 같아야 한다(PRD 14.5). 부르지 않았으면 null */
  inputDigest: DigestSchema.nullable(),
  dropped: z.array(InterviewKitDroppedSchema),
});
export type InterviewKitGeneration = z.infer<typeof InterviewKitGenerationSchema>;

export const INTERVIEW_KIT_SCHEMA_VERSION = 1;

/** 인터뷰 키트 (아티팩트 `evaluations/<id>/interview-kit.json`, T-702) */
export const InterviewKitSchema = z
  .strictObject({
    schemaVersion: z.literal(INTERVIEW_KIT_SCHEMA_VERSION),
    evaluationId: IdSchema,
    /** 우선순위(필수 → 권장 → 선택), 같은 우선순위 안에서는 유형 순서 */
    questions: z.array(InterviewQuestionSchema).max(INTERVIEW_KIT_MAX_QUESTIONS),
    /** 45분·60분 진행안 */
    plans: z.array(InterviewPlanSchema),
    generation: InterviewKitGenerationSchema,
  })
  .superRefine((kit, ctx) => {
    const ids = new Set<string>();
    kit.questions.forEach((question, index) => {
      if (ids.has(question.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", index, "id"],
          message: `질문 ID가 중복되었습니다: ${question.id}`,
        });
      }
      ids.add(question.id);
    });
    const durations = new Set<number>();
    kit.plans.forEach((plan, planIndex) => {
      if (durations.has(plan.durationMinutes)) {
        ctx.addIssue({
          code: "custom",
          path: ["plans", planIndex, "durationMinutes"],
          message: `${plan.durationMinutes}분 진행안이 중복되었습니다`,
        });
      }
      durations.add(plan.durationMinutes);
      plan.segments.forEach((segment, segmentIndex) => {
        segment.questionIds.forEach((questionId, idIndex) => {
          if (!ids.has(questionId)) {
            ctx.addIssue({
              code: "custom",
              path: ["plans", planIndex, "segments", segmentIndex, "questionIds", idIndex],
              message: `키트에 없는 질문 ID입니다: ${questionId}`,
            });
          }
        });
      });
    });
  });
export type InterviewKit = z.infer<typeof InterviewKitSchema>;
