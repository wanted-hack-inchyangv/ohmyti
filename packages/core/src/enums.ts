import { z } from "zod";

/** PRD 9장: 요구사항 판정 결과. INCONCLUSIVE는 0점이 아니라 미확정이다 (G-04). */
export const VerdictSchema = z.enum(["PASS", "FAIL", "PARTIAL", "INCONCLUSIVE"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** PRD 9장: 판정 방식. 점수 계산에 LLM은 쓰지 않는다 (G-01). */
export const MethodSchema = z.enum(["EXECUTION", "STATIC", "MUTATION", "HUMAN_REVIEW"]);
export type Method = z.infer<typeof MethodSchema>;

/** PRD 9장: 사람 확인 상태 (부록 B). */
export const ReviewStateSchema = z.enum(["NOT_REQUIRED", "PENDING", "CONFIRMED"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/** PRD 9장: 실행 실패 종류. 환경 장애와 제출 코드 오류를 구분한다 (G-11). */
export const FailureKindSchema = z.enum([
  "NONE",
  "ASSERTION",
  "SUBMISSION",
  "ENVIRONMENT",
  "TIMEOUT",
]);
export type FailureKind = z.infer<typeof FailureKindSchema>;

/** 평가 파이프라인 단계. 배열 순서가 실행 순서다 (부록 B). */
export const EvaluationStageSchema = z.enum([
  "REPO_CHECK",
  "ENV_PREP",
  "REQUIREMENT_VERIFY",
  "TEST_EFFECTIVENESS",
  "REVIEW_WRITE",
  "CONTEXT_LINK",
  /** 인터뷰 키트 (T-702, PRD 14.2). 저장된 판정에서 질문 슬롯을 정하고 LLM은 문장만 쓴다 */
  "INTERVIEW_KIT",
]);
export type EvaluationStage = z.infer<typeof EvaluationStageSchema>;
export const EVALUATION_STAGE_ORDER: readonly EvaluationStage[] = EvaluationStageSchema.options;

export const StageStateSchema = z.enum([
  "PENDING",
  "RUNNING",
  "DONE",
  "SKIPPED",
  "FAILED",
  "UNSUPPORTED",
]);
export type StageState = z.infer<typeof StageStateSchema>;

export const SubmissionStatusSchema = z.enum([
  "RECEIVED",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "UNSUPPORTED",
  "DELETED",
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;

export const JobStatusSchema = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const AssignmentVersionStatusSchema = z.enum(["DRAFT", "VALIDATING", "APPROVED", "RETIRED"]);
export type AssignmentVersionStatus = z.infer<typeof AssignmentVersionStatusSchema>;

/** mutation 실험 결과. NOT_APPLICABLE은 유효한 결함을 주입할 수 없어 검토 대기로 남기는 경우다 (PRD 5장). */
export const MutationOutcomeSchema = z.enum([
  "KILLED",
  "SURVIVED",
  "EQUIVALENT",
  "BUILD_FAIL",
  "ENV_ERROR",
  "TIMEOUT",
  "NOT_APPLICABLE",
]);
export type MutationOutcome = z.infer<typeof MutationOutcomeSchema>;

/** 이력서 주장 ↔ 근거 연결 상태. 진위 점수는 만들지 않는다 (G-13). */
export const ContextStatusSchema = z.enum(["EVIDENCE_FOUND", "NEEDS_CHECK", "NO_DATA"]);
export type ContextStatus = z.infer<typeof ContextStatusSchema>;

/**
 * 이력서 텍스트 상태 (T-501). NONE: 이력서가 없거나 추출할 수 없음(사유는 `resume_text_reason`),
 * EXTRACTED: PDF에서 텍스트를 추출함, IMAGE_ONLY: 텍스트 층이 없는 문서(OCR은 하지 않는다), MANUAL: 사람이 직접 입력함.
 */
export const ResumeTextStatusSchema = z.enum(["NONE", "EXTRACTED", "IMAGE_ONLY", "MANUAL"]);
export type ResumeTextStatus = z.infer<typeof ResumeTextStatusSchema>;

export const ExecutionRecordKindSchema = z.enum([
  "HARNESS",
  "SUBMITTED_TESTS",
  "MUTATION_VALIDATION",
  "MUTATION_TESTS",
  "RERUN",
]);
export type ExecutionRecordKind = z.infer<typeof ExecutionRecordKindSchema>;

/** 채점 기준 영역 (PRD 5장 기본 배점). */
export const RubricAreaSchema = z.enum([
  "REQUIRED_FEATURES",
  "EDGE_AND_FAILURE",
  "TEST_EFFECTIVENESS",
  "DESIGN",
  "REPRODUCIBILITY_AND_DOCS",
]);
export type RubricArea = z.infer<typeof RubricAreaSchema>;

/** LLM 호출 용도. 1.5의 다섯 곳 밖에서는 호출하지 않는다. */
export const AiReviewKindSchema = z.enum([
  "RUBRIC_DRAFT",
  "MUTATION_TARGETS",
  "EVIDENCE_REVIEW",
  "CONTEXT_LINK",
  /** 인터뷰 키트의 질문 문장 (T-702). 이력서·JD·GitHub 자료를 넣지 않는다 */
  "INTERVIEW_KIT",
]);
export type AiReviewKind = z.infer<typeof AiReviewKindSchema>;

/**
 * 작업 큐 job 종류 (TICKET.md T-006). mutation 실험과 맥락 연결은 별도 job이 아니라
 * EVALUATE_SUBMISSION 파이프라인의 단계(EvaluationStage)로 실행한다.
 */
export const JobTypeSchema = z.enum([
  "EVALUATE_SUBMISSION",
  "RERUN_EXECUTION",
  "VALIDATE_RUBRIC",
  "REEVALUATE_ASSIGNMENT_VERSION",
  "DELETE_SUBMISSION",
  /** T-406: 과제 명세로 AI 채점 기준 초안을 만든다 (LLM 호출은 워커만 한다) */
  "DRAFT_RUBRIC",
]);
export type JobType = z.infer<typeof JobTypeSchema>;
