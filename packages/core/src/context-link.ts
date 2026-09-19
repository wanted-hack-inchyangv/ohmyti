/**
 * 맥락 연결 (TICKET.md T-503, CONTEXT_LINK 단계). 이력서 주장 ↔ GitHub 근거 ↔ 과제 관측을 연결하고 후속 질문을 만든다.
 *
 * - 이 단계는 점수를 바꿀 권한이 없다. 출력 스키마에 점수·판정 필드가 없고, 입력에도 점수는 들어가지 않는다 (G-01).
 * - claim은 이력서 텍스트에서만 나온다. 후처리가 이력서 본문과 대조해 인용이 아닌 claim을 버린다 (G-06).
 * - 진위·AI 작성·기여율 같은 판단 표현이 들어간 항목은 저장하지 않는다 (G-13).
 */
import { z } from "zod";
import { IdSchema } from "./common";
import { CompetencySchema } from "./competency";
import { ContextStatusSchema } from "./enums";

/** claim 한 줄 상한 (이력서 인용) */
export const CONTEXT_CLAIM_MAX_CHARS = 300;
/** 후속 질문·근거 요약 상한 */
export const CONTEXT_TEXT_MAX_CHARS = 600;
/** 한 제출에 저장하는 연결 수 상한 */
export const CONTEXT_MAX_LINKS = 12;
/** 미평가 영역 항목 수 상한 */
export const CONTEXT_MAX_UNASSESSED = 10;

/** 이력서 연결 질문의 한 항목 길이 상한 (인터뷰 키트의 `INTERVIEW_TEXT_MAX_CHARS`와 같다) */
export const CONTEXT_QUESTION_TEXT_MAX_CHARS = 300;

const ContextQuestionTextSchema = z.string().min(1).max(CONTEXT_QUESTION_TEXT_MAX_CHARS);

/**
 * 이력서 연결 질문 (T-703). 인터뷰 키트 질문(`InterviewQuestionSchema`)과 같은 구성이며, 근거 참조는 연결 자체라 두지 않는다.
 * `context_links.question` JSON 열에 저장하고, 주 질문은 이전 화면·게이트와의 호환을 위해 `follow_up_question`에도 넣는다.
 */
export const ContextQuestionSchema = z.strictObject({
  /** 주 질문. 한 문장에 질문 하나 (`lintInterviewQuestion`) */
  question: ContextQuestionTextSchema,
  /** 이 질문으로 무엇을 확인하려는지 */
  intent: ContextQuestionTextSchema,
  /** 꼬리 질문 사다리. 사실 → 원리 → 트레이드오프 순서다 */
  probes: z.array(ContextQuestionTextSchema).min(2).max(3),
  positiveSignals: z.array(ContextQuestionTextSchema).min(2).max(4),
  concernSignals: z.array(ContextQuestionTextSchema).min(2).max(4),
  /** 이 질문으로 확인하는 역량 (T-701) */
  competency: CompetencySchema,
  /** LLM이 쓴 질문인지, 검사에 걸려 바꾼 기본 질문인지 */
  source: z.enum(["LLM", "TEMPLATE"]),
});
export type ContextQuestion = z.infer<typeof ContextQuestionSchema>;

/**
 * LLM 출력의 질문 구조. 개수·역량 값은 여기서 강제하지 않고 후처리가 `ContextQuestionSchema`로 검증한다.
 * 한 항목의 형식 오류가 출력 전체를 버리게 하지 않으려는 것이다.
 */
export const ContextQuestionDraftSchema = z.strictObject({
  question: z.string().min(1),
  intent: z.string(),
  probes: z.array(z.string()),
  positiveSignals: z.array(z.string()),
  concernSignals: z.array(z.string()),
  competency: z.string(),
});
export type ContextQuestionDraft = z.infer<typeof ContextQuestionDraftSchema>;

/**
 * LLM 질문이 검사에 걸리거나 형식이 맞지 않을 때 쓰는 기본 질문 (티켓 문구 그대로). 연결은 유지하고 질문만 바꾼다.
 * 특정 경험을 전제하지 않으므로 어느 주장에나 쓸 수 있다.
 */
export const CONTEXT_DEFAULT_QUESTION: ContextQuestion = {
  question: "이 경험에서 본인이 맡은 범위와 가장 어려웠던 기술적 결정을 설명해 주시겠어요?",
  intent: "이력서에 적힌 경험에서 지원자가 직접 맡은 범위와 기술적 판단의 근거를 확인한다.",
  probes: [
    "그 작업에서 본인이 직접 설계하거나 구현한 부분은 어디까지였나요?",
    "그 결정을 내릴 때 어떤 기준으로 대안을 비교하셨나요?",
    "지금 다시 한다면 어떤 부분을 다르게 선택하시겠어요?",
  ],
  positiveSignals: [
    "본인이 맡은 범위와 팀이 맡은 범위를 구분해 설명한다",
    "결정의 근거로 당시의 제약 조건과 비교한 대안을 구체적으로 든다",
  ],
  concernSignals: [
    "맡은 범위를 물어도 팀 전체의 결과만 설명한다",
    "결정의 이유를 물으면 기술 이름만 나열하고 적용 조건을 말하지 않는다",
  ],
  competency: "TRADEOFFS",
  source: "TEMPLATE",
};

/** LLM 출력의 연결 하나. 점수·판정 키가 없다 */
export const ContextLinkDraftSchema = z.strictObject({
  /** 이력서 문장을 그대로 인용한 주장 */
  claim: z.string().min(1),
  claimSource: z.literal("RESUME"),
  evidence: z
    .strictObject({
      /** 입력의 GitHub 근거 URL 목록에 있는 URL */
      url: z.string().min(1),
      summary: z.string().min(1),
    })
    .nullable()
    .optional(),
  observedInAssignment: z
    .strictObject({
      criterionId: z.string().min(1),
      observation: z.string().min(1),
    })
    .nullable()
    .optional(),
  status: ContextStatusSchema,
  /** 인터뷰 질문 구조 (v3). v2의 `followUpQuestion` 한 줄을 대신한다 */
  question: ContextQuestionDraftSchema,
});
export type ContextLinkDraft = z.infer<typeof ContextLinkDraftSchema>;

/** CONTEXT_LINK LLM 출력 (티켓 범위의 출력 스키마) */
export const ContextLinkOutputSchema = z.strictObject({
  links: z.array(ContextLinkDraftSchema),
  unassessedAreas: z.array(z.string().min(1)),
});
export type ContextLinkOutput = z.infer<typeof ContextLinkOutputSchema>;

/**
 * 저장하지 않는 판단 표현 (G-13: 이력서 진위·AI 작성률·기여율·합격 판정·순위를 만들지 않는다).
 * LLM이 쓴 문장(근거 요약, 질문 구조의 모든 문장, 미평가 영역)에만 적용한다. claim은 이력서 인용이라 검사하지 않는다.
 */
export const CONTEXT_FORBIDDEN_EXPRESSIONS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "거짓", pattern: /거짓/ },
  { label: "허위", pattern: /허위/ },
  { label: "과장", pattern: /과장(?:된|했|하|됐|이)/ },
  { label: "위조", pattern: /위조|조작된/ },
  { label: "진위", pattern: /진위|진실성|사실\s*여부/ },
  { label: "신뢰도", pattern: /신뢰도|신빙성/ },
  {
    label: "AI 작성",
    pattern:
      /(?:AI|인공지능|LLM|GPT|챗GPT|ChatGPT|Copilot)\s*(?:가|로|이|을|를)?\s*(?:작성|생성|대필)/i,
  },
  { label: "AI 작성", pattern: /AI[\s-]*(?:generated|written|authored)|written\s+by\s+AI/i },
  { label: "기여율", pattern: /기여율|기여\s*비율|기여도\s*\d|인간\s*기여/ },
  { label: "기여율", pattern: /contribution\s+(?:rate|ratio|percentage)/i },
  { label: "합격·탈락", pattern: /합격|탈락|불합격|채용\s*(?:추천|불가|권장)/ },
  { label: "순위", pattern: /순위|랭킹|상위\s*\d+\s*%/ },
  { label: "거짓", pattern: /\b(?:lie|lying|lied|fake|fabricat\w*|dishonest\w*)\b/i },
];

/** 금지 표현이 있으면 그 라벨, 없으면 null */
export function findForbiddenContextExpression(text: string): string | null {
  for (const { label, pattern } of CONTEXT_FORBIDDEN_EXPRESSIONS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/** 이력서가 없을 때 저장하는 단일 NO_DATA 연결의 claim (티켓 문구 그대로) */
export const CONTEXT_NO_RESUME_CLAIM = "이력서 미제공";
/** 이력서가 없을 때 미평가 영역 문구 */
export const CONTEXT_NO_RESUME_AREA =
  "이력서 미제공: 이력서 주장과 과제 관측의 연결을 만들지 않았습니다";

/** 예산 초과로 LLM을 부르지 않았을 때 CONTEXT_LINK 단계(DONE)의 사유 */
export const CONTEXT_LINK_BUDGET_EXCEEDED_REASON = "LLM 미실행(예산 초과)";
/** LLM 설정 오류로 부르지 않았을 때의 사유 (단계 DONE) */
export const CONTEXT_LINK_LLM_CONFIG_REASON = "LLM 미실행(설정 오류)";
/** 워커에 LLM이 없어 연결을 만들지 않았을 때의 사유 (단계 DONE) */
export const CONTEXT_LINK_LLM_NOT_CONFIGURED_REASON = "LLM 미실행(설정 없음)";
/** 호출했지만 쓸 수 있는 출력이 없을 때의 사유 접두사 (단계 DONE) */
export const CONTEXT_LINK_INCONCLUSIVE_REASON = "LLM 결과 미확정";
/** 채점기 사전 검증 실행(T-405)에서 단계를 건너뛸 때의 사유 */
export const CONTEXT_LINK_VALIDATION_RUN_SKIP_REASON = "검증 실행은 맥락을 연결하지 않음";

/** 후처리가 버리거나 고친 값 */
export const ContextLinkDroppedSchema = z.strictObject({
  /** LLM 출력 `links`의 위치 (미평가 영역이면 `unassessedAreas`의 위치) */
  index: z.int().min(0),
  field: z.enum([
    "link",
    "evidence",
    "observedInAssignment",
    "unassessedArea",
    "status",
    "question",
  ]),
  reason: z.enum([
    "CLAIM_NOT_IN_RESUME",
    "DUPLICATE_CLAIM",
    "FORBIDDEN_EXPRESSION",
    "OVER_LIMIT",
    "UNKNOWN_EVIDENCE_URL",
    "UNKNOWN_CRITERION",
    "STATUS_WITHOUT_EVIDENCE",
    /** 질문이 `lintInterviewQuestion`에 걸려 기본 질문으로 바꿨다 (T-703). `note`는 걸린 규칙 목록 */
    "QUESTION_LINT_VIOLATION",
    /** 질문 구조의 개수·역량 값이 계약과 달라 기본 질문으로 바꿨다 (T-703) */
    "QUESTION_SCHEMA_INVALID",
  ]),
  /** 금지 표현 라벨·검사 규칙 등 부가 설명. 이력서 본문과 질문 문장은 담지 않는다 */
  note: z.string().optional(),
});
export type ContextLinkDropped = z.infer<typeof ContextLinkDroppedSchema>;

export const ContextLinkLlmStatusSchema = z.enum([
  "OK",
  "NOT_RUN",
  "INCONCLUSIVE",
  "NOT_CONFIGURED",
  "NOT_NEEDED",
]);
export type ContextLinkLlmStatus = z.infer<typeof ContextLinkLlmStatusSchema>;

/** CONTEXT_LINK 단계 기록의 `detail.contextLink`. 이력서 본문과 claim 문장은 담지 않는다 */
export const ContextLinkSummarySchema = z.strictObject({
  llm: ContextLinkLlmStatusSchema,
  llmError: z.string().nullable(),
  promptVersion: z.string().min(1),
  model: z.string().nullable(),
  aiReviewId: IdSchema.nullable(),
  aiReviewVersion: z.int().min(1).nullable(),
  /** 입력 구성: 이력서 텍스트 유무, JD 유무, GitHub 저장소 수, 과제 관측 수 */
  inputs: z.strictObject({
    resume: z.boolean(),
    jd: z.boolean(),
    githubRepos: z.int().min(0),
    observations: z.int().min(0),
  }),
  linkCount: z.int().min(0),
  statusCounts: z.strictObject({
    EVIDENCE_FOUND: z.int().min(0),
    NEEDS_CHECK: z.int().min(0),
    NO_DATA: z.int().min(0),
  }),
  /** 미평가 영역 (T-504 하단 탭). 결정적 항목 + LLM이 제안한 항목(금지 표현 제외) */
  unassessedAreas: z.array(z.string().min(1)),
  dropped: z.array(ContextLinkDroppedSchema),
});
export type ContextLinkSummary = z.infer<typeof ContextLinkSummarySchema>;
