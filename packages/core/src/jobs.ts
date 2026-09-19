/**
 * job payload 계약 (TICKET.md T-204). web이 넣고 worker가 읽으므로 스키마를 한 곳에 둔다.
 * 다른 job 타입의 payload는 각 티켓(T-307 RERUN_EXECUTION 등)에서 여기에 추가한다.
 */
import { z } from "zod";
import { IdSchema } from "./common";

/**
 * `EVALUATE_SUBMISSION`: 제출 하나를 6단계 파이프라인으로 평가한다.
 * `assignmentVersionId`가 있으면 재평가(T-405)다: 제출이 받은 버전 대신 같은 과제의 새 승인 버전으로 새 evaluation을 만들고
 * 제출 상태는 바꾸지 않는다.
 */
export const EvaluateSubmissionPayloadSchema = z.strictObject({
  submissionId: IdSchema,
  assignmentVersionId: IdSchema.optional(),
});
export type EvaluateSubmissionPayload = z.infer<typeof EvaluateSubmissionPayloadSchema>;

/** 같은 제출(재평가면 같은 제출·버전)의 평가 job이 QUEUED·RUNNING인 동안 중복 적재되지 않게 하는 dedupeKey */
export function evaluateSubmissionDedupeKey(
  submissionId: string,
  assignmentVersionId?: string,
): string {
  return assignmentVersionId
    ? `EVALUATE_SUBMISSION:${submissionId}:${assignmentVersionId}`
    : `EVALUATE_SUBMISSION:${submissionId}`;
}

/**
 * `VALIDATE_RUBRIC` (T-405): VALIDATING 버전의 검증 샘플마다 전체 파이프라인을 `is_sample` evaluation으로 돌려
 * 기대 결과표와 대조하고 `validation_result`를 남긴다.
 */
export const ValidateRubricPayloadSchema = z.strictObject({
  assignmentVersionId: IdSchema,
});
export type ValidateRubricPayload = z.infer<typeof ValidateRubricPayloadSchema>;

export function validateRubricDedupeKey(assignmentVersionId: string): string {
  return `VALIDATE_RUBRIC:${assignmentVersionId}`;
}

/**
 * `REEVALUATE_ASSIGNMENT_VERSION` (T-405): 새로 승인된 버전으로 같은 과제의 기존 제출마다
 * 재평가 `EVALUATE_SUBMISSION { submissionId, assignmentVersionId }` job을 넣는다. 이전 evaluation은 그대로 남는다.
 */
export const ReevaluateAssignmentVersionPayloadSchema = z.strictObject({
  assignmentVersionId: IdSchema,
});
export type ReevaluateAssignmentVersionPayload = z.infer<
  typeof ReevaluateAssignmentVersionPayloadSchema
>;

export function reevaluateAssignmentVersionDedupeKey(assignmentVersionId: string): string {
  return `REEVALUATE_ASSIGNMENT_VERSION:${assignmentVersionId}`;
}

/**
 * `RERUN_EXECUTION` (TICKET.md T-307): 평가 하나의 하네스 케이스 하나를 같은 SHA·기준·환경으로 다시 실행해
 * `execution_records`(kind RERUN)와 근거를 추가한다. 기존 기록은 건드리지 않는다 (G-03).
 */
export const RerunExecutionPayloadSchema = z.strictObject({
  evaluationId: IdSchema,
  /** 하네스 케이스 ID (`R-05` 등). 원본 기록의 근거 `testId`와 같다 */
  caseId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "케이스 ID 형식이 아닙니다"),
});
export type RerunExecutionPayload = z.infer<typeof RerunExecutionPayloadSchema>;

/** 같은 평가·같은 케이스의 재실행 job이 QUEUED·RUNNING인 동안 중복 적재되지 않게 하는 dedupeKey */
export function rerunExecutionDedupeKey(evaluationId: string, caseId: string): string {
  return `RERUN_EXECUTION:${evaluationId}:${caseId}`;
}

/** evaluation당 재실행 횟수 상한 (기본값). `RERUN_LIMIT_PER_EVALUATION`으로 바꿀 수 있다 */
export const DEFAULT_RERUN_LIMIT_PER_EVALUATION = 20;

/** 재실행 job은 환경 장애를 한 번 더 시도한다 (평가 job의 기본 3회보다 짧게, 사람이 기다리는 작업이므로) */
export const RERUN_MAX_ATTEMPTS = 2;

/**
 * `DELETE_SUBMISSION` (TICKET.md T-506): 삭제 요청된 제출의 진행 중 job을 취소하고, 아티팩트(`submissions/<id>/`,
 * `evaluations/<id>/`)와 관련 행을 지운 뒤 `deletion_log`만 남긴다. `requestedBy`는 삭제를 확인한 검토자 이름이다.
 */
export const DeleteSubmissionPayloadSchema = z.strictObject({
  submissionId: IdSchema,
  requestedBy: z.string().trim().min(1).max(100),
});
export type DeleteSubmissionPayload = z.infer<typeof DeleteSubmissionPayloadSchema>;

export function deleteSubmissionDedupeKey(submissionId: string): string {
  return `DELETE_SUBMISSION:${submissionId}`;
}

/** 삭제 job은 스토어·DB 일시 장애를 몇 번 더 견딘다. 이미 지운 부분은 다시 지워도 결과가 같다 */
export const DELETE_SUBMISSION_MAX_ATTEMPTS = 5;
