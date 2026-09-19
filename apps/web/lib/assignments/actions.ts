"use server";

/**
 * 과제·기준 버전 서버 액션 (T-201). 화면(T-406)과 제출 폼(T-206)이 호출한다.
 * 실제 로직은 `service.ts`에 있으며 여기서는 DB·스토어 핸들만 연결한다.
 * 승인된 버전을 갱신하는 액션은 없다. 수정은 `createAssignmentVersionAction`으로 새 버전을 만든다.
 */
import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import {
  approveVersion,
  createVersionDraftFrom,
  readApprovalBlockers,
  readAssignmentList,
  readAssignmentVersion,
  readRubricDraft,
  registerAssignment,
  registerAssignmentVersion,
  requestRubricDraft,
  requestVersionValidation,
  saveDraftVersion,
  saveNewAssignment,
  submitToAssignmentVersion,
  type ActionResult,
  type AssignmentListItem,
  type AssignmentRow,
  type AssignmentVersionRow,
  type AssignmentVersionView,
} from "./service";

export async function createAssignmentAction(input: unknown): Promise<ActionResult<AssignmentRow>> {
  return registerAssignment({ db: getDb().db, store: getArtifactStore() }, input);
}

export async function createAssignmentVersionAction(
  input: unknown,
): Promise<ActionResult<AssignmentVersionRow>> {
  return registerAssignmentVersion({ db: getDb().db, store: getArtifactStore() }, input);
}

export async function getAssignmentVersionAction(
  assignmentVersionId: string,
): Promise<ActionResult<AssignmentVersionView>> {
  return readAssignmentVersion({ db: getDb().db }, assignmentVersionId);
}

export async function listAssignmentsAction(): Promise<AssignmentListItem[]> {
  return readAssignmentList({ db: getDb().db });
}

/** 제출 생성. 승인되지 않은 버전이면 `RUBRIC_NOT_APPROVED`로 거부한다 */
export async function createSubmissionAction(input: unknown) {
  return submitToAssignmentVersion({ db: getDb().db }, input);
}

/** 채점기 사전 검증 시작 (T-405). 워커의 `VALIDATE_RUBRIC` job이 샘플을 채점한다 */
export async function requestValidationAction(assignmentVersionId: string) {
  return requestVersionValidation({ db: getDb().db }, assignmentVersionId);
}

/** 승인 버튼 비활성 사유 (T-405) */
export async function approvalBlockersAction(input: unknown) {
  return readApprovalBlockers({ db: getDb().db }, input);
}

/** 기준 승인 (T-405). 조건을 모두 채우지 못하면 `APPROVAL_BLOCKED` */
export async function approveVersionAction(input: unknown) {
  return approveVersion({ db: getDb().db }, input);
}

/** 승인된 버전의 기준을 바꿀 때: 새 DRAFT 버전 (T-405) */
export async function createVersionDraftFromAction(input: unknown) {
  return createVersionDraftFrom({ db: getDb().db }, input);
}

/** AI 기준 초안 요청 (T-406). 워커의 `DRAFT_RUBRIC` job이 LLM을 호출한다 */
export async function requestRubricDraftAction(input: unknown) {
  return requestRubricDraft({ db: getDb().db, store: getArtifactStore() }, input);
}

/** AI 기준 초안 상태 폴링 (T-406) */
export async function getRubricDraftAction(draftId: string) {
  return readRubricDraft({ db: getDb().db }, draftId);
}

/** 새 과제 + 첫 DRAFT 버전 저장 (T-406). 기준은 `validateRubric()`을 통과해야 한다 */
export async function saveNewAssignmentAction(input: unknown) {
  return saveNewAssignment({ db: getDb().db, store: getArtifactStore() }, input);
}

/** DRAFT 버전 저장 (T-406). 승인된 버전은 고칠 수 없다 */
export async function saveDraftVersionAction(input: unknown) {
  return saveDraftVersion({ db: getDb().db, store: getArtifactStore() }, input);
}
