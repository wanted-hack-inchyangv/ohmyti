import { z } from "zod";
import {
  DigestSchema,
  IdSchema,
  NonNegativeIntSchema,
  ShaSchema,
  SourceLocationSchema,
  TimestampSchema,
} from "./common";
import {
  AiReviewKindSchema,
  AssignmentVersionStatusSchema,
  ContextStatusSchema,
  EvaluationStageSchema,
  JobStatusSchema,
  JobTypeSchema,
  MutationOutcomeSchema,
  ReviewStateSchema,
  StageStateSchema,
  SubmissionStatusSchema,
  VerdictSchema,
} from "./enums";
import { RubricSchema } from "./rubric";

/** 제출물이 지켜야 할 실행 계약 (부록 A R-10). */
export const ExecutionContractSchema = z.strictObject({
  /** 예: `npm start` */
  startCommand: z.string().min(1),
  /** 포트를 전달하는 환경변수 이름. 예: `PORT` */
  portEnv: z.string().min(1),
  healthPath: z.string().startsWith("/"),
  healthTimeoutMs: z.int().min(1),
  resetPath: z.string().startsWith("/").optional(),
  /** 승인 템플릿 이름. 제출물은 이 템플릿의 고정 의존성만 쓸 수 있다 (1.4). */
  templateName: z.string().min(1),
  nodeVersion: z.string().min(1),
});
export type ExecutionContract = z.infer<typeof ExecutionContractSchema>;

/** 과제 명세 + 기준 + 실행 계약의 버전. 승인 전에는 채점하지 않는다 (T-201). */
export const AssignmentVersionSchema = z.strictObject({
  id: IdSchema,
  assignmentId: IdSchema,
  version: z.int().min(1),
  status: AssignmentVersionStatusSchema,
  title: z.string().min(1),
  /** 과제 명세 원문 참조 (artifact ref). 본문 자체는 스토어에 둔다. */
  specRef: z.string().min(1),
  specDigest: DigestSchema,
  rubric: RubricSchema,
  executionContract: ExecutionContractSchema,
  harnessVersion: z.string().min(1),
  createdAt: TimestampSchema,
  approvedAt: TimestampSchema.optional(),
  approvedBy: z.string().min(1).optional(),
  retiredAt: TimestampSchema.optional(),
});
export type AssignmentVersion = z.infer<typeof AssignmentVersionSchema>;

export const SubmissionSchema = z.strictObject({
  id: IdSchema,
  assignmentVersionId: IdSchema,
  repoUrl: z.url(),
  /** 사용자가 지정한 브랜치·태그·SHA. 없으면 기본 브랜치. */
  repoRef: z.string().min(1).optional(),
  /** 수집 시 고정한 커밋 SHA (T-202). */
  submissionSha: ShaSchema.optional(),
  snapshotRef: z.string().min(1).optional(),
  status: SubmissionStatusSchema,
  unsupportedReason: z.string().min(1).optional(),
  /** 이력서 원본 참조. 채점 입력(GradingInput)에는 절대 포함하지 않는다 (G-10). */
  resumeRef: z.string().min(1).optional(),
  githubLogin: z.string().min(1).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deletedAt: TimestampSchema.optional(),
});
export type Submission = z.infer<typeof SubmissionSchema>;

/**
 * 아직 구현되지 않은 단계(TEST_EFFECTIVENESS·REVIEW_WRITE·CONTEXT_LINK)를 워커가 SKIPPED로 남길 때의 reason.
 * 워크벤치는 이 값으로 "미구현"을 표시한다 (T-302). 4·5단계에서 단계가 구현되면 더 이상 쓰이지 않는다.
 */
export const STAGE_NOT_IMPLEMENTED_REASON = "not_implemented";

export const EvaluationStageRecordSchema = z.strictObject({
  stage: EvaluationStageSchema,
  state: StageStateSchema,
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  /** FAILED·UNSUPPORTED일 때의 사유. 마스킹된 문자열이어야 한다. */
  reason: z.string().optional(),
  /** 단계가 남긴 구조화 결과 (예: ENV_PREP의 SupportReport). 마스킹된 값만 넣는다. */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type EvaluationStageRecord = z.infer<typeof EvaluationStageRecordSchema>;

export const EvaluationSchema = z.strictObject({
  id: IdSchema,
  submissionId: IdSchema,
  assignmentVersionId: IdSchema,
  rubricVersion: z.string().min(1),
  submissionSha: ShaSchema,
  stages: z.array(EvaluationStageRecordSchema),
  createdAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

/**
 * 검토 액션 종류 (T-306).
 * - `CONFIRM`: 판정을 그대로 확인한다 (점수 불변, reviewState CONFIRMED)
 * - `OVERRIDE`: 사람이 점수를 바꾼다 (사유·검토자 필수, 0 ≤ earned ≤ max)
 * - `DISPUTE`: 이의를 메모로 남긴다 (점수 불변, reviewState PENDING으로 되돌린다)
 * - `APPROVE_DESIGN`: HUMAN_REVIEW 기준의 하위 기준 충족 여부로 점수를 확정한다 (R-12)
 */
export const ReviewEventKindSchema = z.enum(["CONFIRM", "OVERRIDE", "DISPUTE", "APPROVE_DESIGN"]);
export type ReviewEventKind = z.infer<typeof ReviewEventKindSchema>;

/** 사람이 점수를 수정한 기록. 원래 값·수정 값·이유·검토자를 함께 보존한다 (PRD 9장). 삭제·수정 없이 쌓이기만 한다. */
export const ReviewEventSchema = z.strictObject({
  id: IdSchema,
  evaluationId: IdSchema,
  criterionId: z.string().min(1),
  kind: ReviewEventKindSchema,
  reviewer: z.string().min(1),
  previous: z.strictObject({
    earnedPoints: NonNegativeIntSchema.nullable(),
    verdict: VerdictSchema,
    reviewState: ReviewStateSchema,
  }),
  next: z.strictObject({
    earnedPoints: NonNegativeIntSchema.nullable(),
    verdict: VerdictSchema,
    reviewState: ReviewStateSchema,
  }),
  reason: z.string().min(1),
  createdAt: TimestampSchema,
});
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;

/** 이력서 주장 ↔ GitHub 근거 ↔ 과제 관측 연결 (PRD 4장 B). 점수에 영향을 주지 않는다. */
export const ContextLinkSchema = z.strictObject({
  id: IdSchema,
  submissionId: IdSchema,
  /** 연결을 만든 평가 (T-503). 같은 제출을 다시 평가하면 제출의 연결 전체를 새로 만든다 */
  evaluationId: IdSchema.nullable(),
  /** 이력서에서 추출한 주장 한 줄. 이력서가 없으면 `SYSTEM` 출처의 "이력서 미제공" */
  claim: z.string().min(1),
  claimSource: z.enum(["RESUME", "SYSTEM"]),
  status: ContextStatusSchema,
  githubEvidence: z
    .array(
      z.strictObject({
        repo: z.string().min(1),
        url: z.url(),
        summary: z.string().min(1),
      }),
    )
    .optional(),
  assignmentObservation: z
    .strictObject({
      /** 관측이 나온 기준 (T-503). 저장된 판정에 있는 기준만 */
      criterionId: z.string().min(1).optional(),
      summary: z.string().min(1),
      source: SourceLocationSchema.optional(),
      evidenceId: IdSchema.optional(),
    })
    .optional(),
  followUpQuestion: z.string().min(1).optional(),
  aiReviewId: IdSchema.optional(),
  createdAt: TimestampSchema,
});
export type ContextLink = z.infer<typeof ContextLinkSchema>;

export const MutationExperimentSchema = z.strictObject({
  id: IdSchema,
  evaluationId: IdSchema,
  mutationId: z.string().min(1),
  groupId: z.string().min(1),
  /** 변형이 겨냥한 기준. */
  targetCriterionId: z.string().min(1),
  target: SourceLocationSchema.optional(),
  patchDigest: DigestSchema.optional(),
  patchRef: z.string().min(1).optional(),
  outcome: MutationOutcomeSchema,
  /** 변형 적용 후 하네스로 결함이 실제로 드러났는지 검증한 실행 기록. */
  validationRecordId: IdSchema.optional(),
  /** 변형 적용 후 제출 테스트를 돌린 실행 기록. */
  testRecordId: IdSchema.optional(),
  /** 유효성 검증(변형 위 하네스) 판정. KILLED·SURVIVED는 FAIL, EQUIVALENT는 PASS다 (T-403, DB CHECK). */
  validationVerdict: VerdictSchema.optional(),
  reason: z.string().optional(),
  createdAt: TimestampSchema,
});
export type MutationExperiment = z.infer<typeof MutationExperimentSchema>;

export const AiUsageSchema = z.strictObject({
  inputTokens: NonNegativeIntSchema,
  outputTokens: NonNegativeIntSchema,
  /** 입력 토큰 중 제공자 캐시에 적중한 수 (inputTokens에 포함). 캐시 단가가 다른 제공자(DeepSeek)만 채운다 */
  cachedInputTokens: NonNegativeIntSchema.optional(),
  costUsd: z.number().min(0),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;

/** LLM 호출 기록. 모델·프롬프트 버전·입력 다이제스트·사용량을 남긴다 (1.5). */
export const AiReviewSchema = z.strictObject({
  id: IdSchema,
  kind: AiReviewKindSchema,
  evaluationId: IdSchema.optional(),
  assignmentVersionId: IdSchema.optional(),
  submissionId: IdSchema.optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  inputDigest: DigestSchema,
  /** zod 검증을 통과한 출력. 구조는 kind마다 다르다. */
  output: z.json(),
  usage: AiUsageSchema,
  /** 같은 대상에 대해 다시 생성하면 version이 올라간다. */
  version: z.int().min(1),
  createdAt: TimestampSchema,
});
export type AiReview = z.infer<typeof AiReviewSchema>;

export const JobSchema = z.strictObject({
  id: IdSchema,
  type: JobTypeSchema,
  payload: z.json(),
  status: JobStatusSchema,
  attempts: NonNegativeIntSchema,
  maxAttempts: z.int().min(1),
  runAfter: TimestampSchema,
  lockedBy: z.string().min(1).optional(),
  lockedAt: TimestampSchema.optional(),
  /** 워커가 진행 중임을 알리는 마지막 시각. 끊기면 다른 워커가 회수한다 */
  heartbeatAt: TimestampSchema.optional(),
  lastError: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Job = z.infer<typeof JobSchema>;
