import { pgEnum } from "drizzle-orm/pg-core";
import {
  AiReviewKindSchema,
  AssignmentVersionStatusSchema,
  ContextStatusSchema,
  ExecutionRecordKindSchema,
  FailureKindSchema,
  JobStatusSchema,
  JobTypeSchema,
  MethodSchema,
  MutationOutcomeSchema,
  ResumeTextStatusSchema,
  ReviewStateSchema,
  ValidationSampleKindSchema,
  SubmissionStatusSchema,
  VerdictSchema,
} from "@ohmyti/core";

/** zod enum의 값 목록을 pgEnum이 요구하는 비어 있지 않은 튜플로 만든다. */
function values<T extends string>(schema: { options: readonly T[] }): [T, ...T[]] {
  const [first, ...rest] = schema.options;
  if (first === undefined) throw new Error("enum 값이 비어 있습니다");
  return [first, ...rest];
}

// PostgreSQL enum 타입. 값 목록은 @ohmyti/core의 zod enum에서 가져와 한 곳에서만 관리한다.
export const verdictEnum = pgEnum("verdict", values(VerdictSchema));
export const methodEnum = pgEnum("method", values(MethodSchema));
export const reviewStateEnum = pgEnum("review_state", values(ReviewStateSchema));
export const failureKindEnum = pgEnum("failure_kind", values(FailureKindSchema));
export const submissionStatusEnum = pgEnum("submission_status", values(SubmissionStatusSchema));
export const jobStatusEnum = pgEnum("job_status", values(JobStatusSchema));
export const jobTypeEnum = pgEnum("job_type", values(JobTypeSchema));
export const assignmentVersionStatusEnum = pgEnum(
  "assignment_version_status",
  values(AssignmentVersionStatusSchema),
);
export const mutationOutcomeEnum = pgEnum("mutation_outcome", values(MutationOutcomeSchema));
export const contextStatusEnum = pgEnum("context_status", values(ContextStatusSchema));
export const resumeTextStatusEnum = pgEnum("resume_text_status", values(ResumeTextStatusSchema));
export const executionRecordKindEnum = pgEnum(
  "execution_record_kind",
  values(ExecutionRecordKindSchema),
);
export const aiReviewKindEnum = pgEnum("ai_review_kind", values(AiReviewKindSchema));

/** 검증용 샘플 종류 (PRD 2장 W3: 정답·대안·결함·적대적). */
export const validationSampleKindEnum = pgEnum(
  "validation_sample_kind",
  values(ValidationSampleKindSchema),
);
