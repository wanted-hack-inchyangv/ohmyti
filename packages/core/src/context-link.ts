/**
 * 맥락 연결 (TICKET.md T-503, CONTEXT_LINK 단계). 이력서 주장 ↔ GitHub 근거 ↔ 과제 관측을 연결하고 후속 질문을 만든다.
 *
 * - 이 단계는 점수를 바꿀 권한이 없다. 출력 스키마에 점수·판정 필드가 없고, 입력에도 점수는 들어가지 않는다 (G-01).
 * - claim은 이력서 텍스트에서만 나온다. 후처리가 이력서 본문과 대조해 인용이 아닌 claim을 버린다 (G-06).
 * - 진위·AI 작성·기여율 같은 판단 표현이 들어간 항목은 저장하지 않는다 (G-13).
 */
import { z } from "zod";
import { IdSchema } from "./common";
import { ContextStatusSchema } from "./enums";

/** claim 한 줄 상한 (이력서 인용) */
export const CONTEXT_CLAIM_MAX_CHARS = 300;
/** 후속 질문·근거 요약 상한 */
export const CONTEXT_TEXT_MAX_CHARS = 600;
/** 한 제출에 저장하는 연결 수 상한 */
export const CONTEXT_MAX_LINKS = 12;
/** 미평가 영역 항목 수 상한 */
export const CONTEXT_MAX_UNASSESSED = 10;

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
  followUpQuestion: z.string().min(1),
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
 * LLM이 쓴 문장(근거 요약, 후속 질문, 미평가 영역)에만 적용한다. claim은 이력서 인용이라 검사하지 않는다.
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
  field: z.enum(["link", "evidence", "observedInAssignment", "unassessedArea", "status"]),
  reason: z.enum([
    "CLAIM_NOT_IN_RESUME",
    "DUPLICATE_CLAIM",
    "FORBIDDEN_EXPRESSION",
    "OVER_LIMIT",
    "UNKNOWN_EVIDENCE_URL",
    "UNKNOWN_CRITERION",
    "STATUS_WITHOUT_EVIDENCE",
  ]),
  /** 금지 표현 라벨 등 부가 설명. 이력서 본문은 담지 않는다 */
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
