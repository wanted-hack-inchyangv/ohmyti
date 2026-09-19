/**
 * 채용 리포트 계약 (TICKET.md T-701, PRD 14.3). 조립은 T-705, 화면과 내보내기는 T-706이 맡는다.
 *
 * - 리포트는 새 판단을 만들지 않는다. 저장된 점수·판정·근거·서술을 결정적으로 조립한다(새 LLM 호출 없음).
 * - 점수는 `StoredScoreSchema`를 그대로 쓴다(`summary.score`). 리포트용 총점·등급·레벨·합격 추천·순위 필드는 없다
 *   (G-01, G-13, PRD 14.4). 키 이름 검사(`findJudgementKeys`)로 고정한다.
 * - 역량별 관측은 판정 분포와 근거만 보이며 역량 점수를 만들지 않는다.
 * - 스코어카드 절은 사람이 기입하는 빈 양식이다. 시스템이 채우는 값 필드가 없다.
 */
import { z } from "zod";
import { DigestSchema, IdSchema, NonNegativeIntSchema, ShaSchema, TimestampSchema } from "./common";
import { CompetencyAnchorSchema, CompetencySchema } from "./competency";
import {
  ContextStatusSchema,
  EvaluationStageSchema,
  FailureKindSchema,
  MutationOutcomeSchema,
  ReviewStateSchema,
  RubricAreaSchema,
  VerdictSchema,
} from "./enums";
import { DesignSignalsSchema } from "./design-signals";
import {
  InterviewKitLlmStatusSchema,
  InterviewQuestionKindSchema,
  InterviewQuestionSourceSchema,
  ObservationRefSchema,
} from "./interview";
import { ApiErrorSchema, apiOkSchema, StoredScoreSchema } from "./report";

export const HIRING_REPORT_SCHEMA_VERSION = 1;
/** 핵심 관측의 강점·결함 각각의 상한 */
export const HIRING_REPORT_KEY_OBSERVATIONS_MAX = 3;

/** 저장된 자료가 있는지. 이전 평가에는 키트·맥락 연결·설계 신호가 없을 수 있다 (T-705: 해당 절만 "자료 없음") */
export const ReportSectionStatusSchema = z.enum(["AVAILABLE", "NO_DATA"]);
export type ReportSectionStatus = z.infer<typeof ReportSectionStatusSchema>;

export const VerdictCountsSchema = z.strictObject({
  PASS: NonNegativeIntSchema,
  FAIL: NonNegativeIntSchema,
  PARTIAL: NonNegativeIntSchema,
  INCONCLUSIVE: NonNegativeIntSchema,
});
export type VerdictCounts = z.infer<typeof VerdictCountsSchema>;

const CriterionLabelSchema = z.strictObject({
  criterionId: z.string().min(1),
  title: z.string().min(1),
});

/** 1. 한눈 요약 */
export const HiringReportSummarySchema = z.strictObject({
  /** `evaluations`에 저장된 점수 그대로 (부록 C 표기와 영역 소계 포함). 판정 저장 전이면 null */
  score: StoredScoreSchema.nullable(),
  verdictCounts: VerdictCountsSchema,
  /** 사람 확인을 기다리는 기준 */
  pendingReview: z.array(CriterionLabelSchema),
});

/** 2. 핵심 관측 한 항목 (확인된 강점 또는 확인된 결함) */
export const KeyObservationSchema = z.strictObject({
  criterionId: z.string().min(1),
  title: z.string().min(1),
  verdict: VerdictSchema,
  /** 같은 결함으로 묶인 기준의 issueId (결함에서 한 번만 보인다, G-12) */
  issueId: z.string().min(1).nullable(),
  /** 저장된 관측 문장 */
  observation: z.string().min(1),
  /** 리포트 프로필의 영향 문장. 프로필이 없으면 null이고 화면은 기준의 condition을 보인다 */
  impact: z.string().min(1).nullable(),
  /** REVIEW_WRITE 서술. 있으면 "AI 초안"으로 표시한다 */
  aiDraft: z.string().min(1).nullable(),
  refs: z.array(ObservationRefSchema).min(1),
});
export type KeyObservation = z.infer<typeof KeyObservationSchema>;

export const HiringReportKeyObservationsSchema = z.strictObject({
  strengths: z.array(KeyObservationSchema).max(HIRING_REPORT_KEY_OBSERVATIONS_MAX),
  defects: z.array(KeyObservationSchema).max(HIRING_REPORT_KEY_OBSERVATIONS_MAX),
});

/**
 * 인터뷰 키트 질문의 참조. 슬롯 ID(`FAILURE_DEBRIEF:R-05`)는 내부 식별자라 리포트에는 키트와 같은 질문 번호(Q1, Q2 …)와
 * 주 질문 문장을 함께 싣는다 (T-706). 번호는 `interviewQuestionNumbers`가 정한다.
 */
export const HiringReportQuestionRefSchema = z.strictObject({
  questionId: z.string().min(1),
  /** 키트 안의 질문 번호 (Q1, Q2 …) */
  number: z.int().min(1),
  question: z.string().min(1),
});
export type HiringReportQuestionRef = z.infer<typeof HiringReportQuestionRefSchema>;

/** 3. 역량별 관측 한 항목. 역량 점수를 만들지 않고 매핑된 기준의 판정과 근거만 보인다 */
export const CompetencyObservationSchema = z.strictObject({
  competency: CompetencySchema,
  name: z.string().min(1),
  interviewOnly: z.boolean(),
  criteria: z.array(
    z.strictObject({
      criterionId: z.string().min(1),
      title: z.string().min(1),
      verdict: VerdictSchema,
      reviewState: ReviewStateSchema,
      refs: z.array(ObservationRefSchema),
    }),
  ),
  verdictCounts: VerdictCountsSchema,
  /** 이 역량을 확인하는 인터뷰 키트 질문 (`interviewOnly` 역량의 "면접에서 확인") */
  kitQuestions: z.array(HiringReportQuestionRefSchema),
});
export type CompetencyObservation = z.infer<typeof CompetencyObservationSchema>;

/** 4. 요구사항별 결과, 테스트 실효성, 설계 검토 */
export const HiringReportRequirementsSchema = z.strictObject({
  /** 저장된 기준별 결과 그대로 (기준 ID 순) */
  criteria: z.array(
    z.strictObject({
      criterionId: z.string().min(1),
      area: RubricAreaSchema,
      title: z.string().min(1),
      maxPoints: NonNegativeIntSchema,
      earnedPoints: NonNegativeIntSchema.nullable(),
      verdict: VerdictSchema,
      reviewState: ReviewStateSchema,
      observation: z.string().nullable(),
      refs: z.array(ObservationRefSchema),
    }),
  ),
  /** 그룹별 mutation 결과 개수 (T-404 그룹 판정의 원문) */
  testEffectiveness: z.array(
    z.strictObject({
      groupId: z.string().min(1),
      name: z.string().min(1),
      criterionId: z.string().min(1).nullable(),
      verdict: VerdictSchema.nullable(),
      outcomes: z.record(MutationOutcomeSchema, NonNegativeIntSchema),
    }),
  ),
  /** REVIEW_WRITE의 설계 검토 초안. 제안 점수는 옮기지 않는다 */
  designReview: z.strictObject({
    status: ReportSectionStatusSchema,
    /** 항상 초안임을 표시한다 */
    draft: z.literal(true),
    items: z.array(
      z.strictObject({
        criterionId: z.string().min(1),
        rationale: z.string().min(1),
        refs: z.array(ObservationRefSchema),
      }),
    ),
    /** 설계 신호 (T-605). 이전 평가는 null */
    signals: DesignSignalsSchema.nullable(),
  }),
});

/** 5. 이력서 주장과 근거의 연결표 */
export const HiringReportResumeLinksSchema = z.strictObject({
  status: z.enum(["AVAILABLE", "NO_RESUME", "NO_DATA"]),
  links: z.array(
    z.strictObject({
      contextLinkId: IdSchema,
      claim: z.string().min(1),
      status: ContextStatusSchema,
      evidence: z.array(z.strictObject({ url: z.url(), summary: z.string().min(1) })),
      observation: z
        .strictObject({ criterionId: z.string().min(1).nullable(), summary: z.string().min(1) })
        .nullable(),
      question: z.string().min(1).nullable(),
    }),
  ),
});

/** 6. 면접 안내: 인터뷰 키트의 필수 질문 요약 */
export const HiringReportInterviewGuideSchema = z.strictObject({
  status: ReportSectionStatusSchema,
  llm: InterviewKitLlmStatusSchema.nullable(),
  llmReason: z.string().nullable(),
  mustQuestions: z.array(
    z.strictObject({
      questionId: z.string().min(1),
      /** 키트 안의 질문 번호 (Q1, Q2 …) */
      number: z.int().min(1),
      kind: InterviewQuestionKindSchema,
      competency: CompetencySchema,
      minutes: z.int().min(1),
      question: z.string().min(1),
      source: InterviewQuestionSourceSchema,
    }),
  ),
});

/** 7. 평가 범위와 한계 */
export const HiringReportScopeSchema = z.strictObject({
  unassessedAreas: z.array(z.string().min(1)),
  inconclusive: z.array(
    z.strictObject({
      criterionId: z.string().min(1),
      title: z.string().min(1),
      failureKind: FailureKindSchema.nullable(),
      /** ENVIRONMENT·TIMEOUT: 환경 장애이며 제출 코드의 결함이 아니다 (G-11) */
      environmental: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  pendingReview: z.array(CriterionLabelSchema),
  /** LLM을 쓴 단계와 상태 (점수·판정에는 쓰지 않았다) */
  llmUsage: z.array(
    z.strictObject({
      stage: EvaluationStageSchema,
      state: z.string().min(1),
      model: z.string().nullable(),
      promptVersion: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  supportScope: z.array(z.string().min(1)),
});

/** 8. 면접관 스코어카드: 사람이 기입하는 빈 양식. 값 필드가 없다 */
export const HiringReportScorecardSchema = z.strictObject({
  humanOnly: z.literal(true),
  competencies: z.array(
    z.strictObject({
      competency: CompetencySchema,
      name: z.string().min(1),
      definition: z.string().min(1),
      interviewOnly: z.boolean(),
      anchors: z.array(CompetencyAnchorSchema).length(4),
    }),
  ),
});

/** 9. 감사 정보 */
export const HiringReportAuditSchema = z.strictObject({
  evaluationId: IdSchema,
  submissionId: IdSchema,
  rubricVersion: z.string().min(1),
  harnessVersion: z.string().min(1),
  environmentDigest: DigestSchema,
  submissionSha: ShaSchema,
  repoUrl: z.url(),
  isSample: z.boolean(),
  finishedAt: TimestampSchema.nullable(),
  llmStages: z.array(
    z.strictObject({
      stage: EvaluationStageSchema,
      model: z.string().nullable(),
      promptVersion: z.string().nullable(),
      aiReviewId: IdSchema.nullable(),
    }),
  ),
  humanEdits: z.strictObject({
    count: NonNegativeIntSchema,
    lastAt: TimestampSchema.nullable(),
  }),
});

/** 채용 리포트 (PRD 14.3의 9개 절) */
export const HiringReportSchema = z.strictObject({
  schemaVersion: z.literal(HIRING_REPORT_SCHEMA_VERSION),
  evaluationId: IdSchema,
  assignment: z.strictObject({
    name: z.string().min(1),
    version: z.int().min(1),
    title: z.string().min(1),
  }),
  isSample: z.boolean(),
  summary: HiringReportSummarySchema,
  keyObservations: HiringReportKeyObservationsSchema,
  competencies: z.array(CompetencyObservationSchema),
  requirements: HiringReportRequirementsSchema,
  resumeLinks: HiringReportResumeLinksSchema,
  interviewGuide: HiringReportInterviewGuideSchema,
  scope: HiringReportScopeSchema,
  scorecard: HiringReportScorecardSchema,
  audit: HiringReportAuditSchema,
});
export type HiringReport = z.infer<typeof HiringReportSchema>;

/**
 * `GET /api/evaluations/[id]/hiring-report` (T-705)의 응답 봉투. 조립은 저장된 값만 옮기므로 평가가 있으면 항상 만들어지고,
 * 키트·맥락 연결·설계 신호가 없는 이전 평가도 해당 절만 "자료 없음"으로 채운다.
 */
export const HiringReportResponseSchema = z.union([
  apiOkSchema(HiringReportSchema),
  ApiErrorSchema,
]);

// ---------------------------------------------------------------------------
// 키 이름 검사

/**
 * 판단을 담는 키 이름: 점수·등급·레벨·추천·순위·합격 여부·평점. 키트와 리포트 스키마 어디에도 없어야 한다.
 * 판정 분포의 `PASS`는 저장된 기준 판정의 개수이므로 대상이 아니다(합격 여부는 `accept`·`reject`·`hire`로 잡는다).
 * 예외는 `JUDGEMENT_KEY_ALLOWED_PATHS`(저장된 점수 그대로인 `summary.score`, 사람 기입 양식 `scorecard`)뿐이다.
 */
export const JUDGEMENT_KEY_PATTERN =
  /score|grade|rank|recommend|hire|hiring|level|rating|percentile|decision|seniority|overall|accept|reject|^fit$/i;

export const JUDGEMENT_KEY_ALLOWED_PATHS: readonly string[] = ["summary.score", "scorecard"];

// ---------------------------------------------------------------------------
// 금지 표현 검사 (본문)

/**
 * 리포트 본문에 쓸 수 없는 표현 (PRD 14.4, G-13): 합격·탈락 추천, 채용 등급·레벨 추정, 지원자 간 순위.
 * 조립(T-705)은 LLM이 쓴 문장(REVIEW_WRITE 설계 검토 초안)에 이 표현이 있으면 그 문장을 버리고, 테스트는 출력 전체
 * (JSON·Markdown)를 이 목록으로 검사한다.
 */
export const FORBIDDEN_REPORT_EXPRESSIONS: readonly string[] = [
  "합격",
  "불합격",
  "탈락",
  "추천",
  "순위",
  "등급",
  "레벨",
  "주니어",
  "시니어",
  "서열",
];

/**
 * 금지 표현 검사에서 빼는 문구. 검사 전에 이 문구를 지운 뒤 나머지를 본다.
 * - `우선순위`: 스코어카드의 테스트 설계 앵커 문장("테스트의 우선순위를 정하는 기준")에 있는 단어이며 지원자 간 순위가 아니다.
 * 스코어카드의 빈 칸 라벨도 금지 표현과 겹치면 여기에 더한다 (사람이 적을 칸의 이름이며 시스템의 판단이 아니다).
 */
export const FORBIDDEN_EXPRESSION_ALLOWED_LABELS: readonly string[] = ["우선순위"];

/** 본문에 남은 금지 표현 (중복 제거, 목록 순서) */
export function findForbiddenReportExpressions(
  text: string,
  allowedLabels: readonly string[] = FORBIDDEN_EXPRESSION_ALLOWED_LABELS,
): string[] {
  let scanned = text;
  for (const label of allowedLabels) scanned = scanned.split(label).join(" ");
  return FORBIDDEN_REPORT_EXPRESSIONS.filter((term) => scanned.includes(term));
}

/** zod 스키마 트리의 모든 키 경로 (배열은 `[]`, 유니온은 모든 선택지) */
export function collectSchemaKeyPaths(schema: z.ZodType, path: string[] = []): string[] {
  const found: string[] = [];
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = schema.shape;
    for (const [key, child] of Object.entries(shape)) {
      const childPath = [...path, key];
      found.push(childPath.join("."));
      found.push(...collectSchemaKeyPaths(child, childPath));
    }
  } else if (schema instanceof z.ZodArray) {
    found.push(...collectSchemaKeyPaths(schema.element as z.ZodType, [...path, "[]"]));
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    found.push(...collectSchemaKeyPaths(schema.unwrap() as z.ZodType, path));
  } else if (schema instanceof z.ZodUnion) {
    for (const option of schema.options as readonly z.ZodType[]) {
      found.push(...collectSchemaKeyPaths(option, path));
    }
  } else if (schema instanceof z.ZodRecord) {
    found.push(...collectSchemaKeyPaths(schema.valueType as z.ZodType, [...path, "{}"]));
  }
  return [...new Set(found)];
}

/** 판단을 담는 키 경로. 허용 경로 자체는 제외한다 (그 하위 키는 계속 검사한다) */
export function findJudgementKeys(
  schema: z.ZodType,
  allowedPaths: readonly string[] = JUDGEMENT_KEY_ALLOWED_PATHS,
): string[] {
  return collectSchemaKeyPaths(schema).filter((keyPath) => {
    if (allowedPaths.includes(keyPath)) return false;
    const key = keyPath.split(".").at(-1)!;
    return JUDGEMENT_KEY_PATTERN.test(key);
  });
}
