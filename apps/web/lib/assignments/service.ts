/**
 * 과제·기준 버전 등록과 제출 생성 (T-201). 서버 액션(`actions.ts`)이 이 함수들을 부르며,
 * DB·스토어를 인자로 받아 테스트에서는 임시 DB와 fs 스토어를 넣는다.
 *
 * 승인된 버전을 고치는 함수는 없다. 수정은 새 버전 생성으로만 한다.
 */
import { z } from "zod";
import {
  ExecutionContractSchema,
  MAX_RUBRIC_DRAFT_SPEC_BYTES,
  RubricSchema,
  ValidationResultSchema,
  approvalBlockers,
  validateRubric,
  type ApprovalBlocker,
  type AssignmentVersionStatus,
  type RubricDraftView,
  type RubricValidationError,
  type ValidationResult,
  type ValidationSampleKind,
} from "@ohmyti/core";
import {
  AssignmentError,
  approveValidatedAssignmentVersion,
  checkAssignmentVersionApproval,
  createAssignment,
  createRubricDraftRequest,
  deleteAssignmentWithoutVersions,
  getAssignmentVersionByNumber,
  getLatestValidationJob,
  getRubricDraft,
  listAssignmentVersions,
  listKnownHarnessVersions,
  listValidationSamples,
  toRubricDraftView,
  updateDraftAssignmentVersion,
  createDraftFromVersion,
  requestAssignmentVersionValidation,
  createAssignmentVersion,
  createSubmission,
  getAssignment,
  getAssignmentVersion,
  listAssignments,
  specDigestOf,
  SubmissionRejectedError,
  type AssignmentListItem,
  type AssignmentRow,
  type ApproveValidatedVersionResult,
  type AssignmentVersionRow,
  type Database,
  type ValidationRequestResult,
  type SubmissionRow,
} from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, type ArtifactStore } from "@ohmyti/storage";

export interface AssignmentDeps {
  db: Database;
  store: ArtifactStore;
}

export type ActionErrorCode =
  | "INVALID_INPUT"
  | "ASSIGNMENT_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "RUBRIC_INVALID"
  | "RUBRIC_VERSION_EXISTS"
  | "RUBRIC_NOT_APPROVED"
  | "INVALID_TRANSITION"
  | "APPROVAL_BLOCKED"
  | "DRAFT_NOT_FOUND"
  | "INTERNAL";

/** 서버 액션의 반환값. 예상되는 실패는 예외가 아니라 `ok: false`로 돌려주고 화면이 사유를 그대로 보여 준다 (G-09). */
export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; code: ActionErrorCode; message: string; details?: unknown };

export const CreateAssignmentInputSchema = z.strictObject({
  name: z.string().trim().min(1, "과제 이름을 입력하세요").max(200),
  description: z.string().trim().max(2000).optional(),
});
export type CreateAssignmentInput = z.infer<typeof CreateAssignmentInputSchema>;

/** 명세 원문 크기 상한 (1 MiB). 스토어 상한(64 MiB)보다 훨씬 작게 둔다 */
export const MAX_SPEC_BYTES = 1024 * 1024;

export const CreateAssignmentVersionInputSchema = z.strictObject({
  assignmentId: z.uuid(),
  title: z.string().trim().min(1, "버전 제목을 입력하세요").max(200),
  specMarkdown: z.string().min(1, "과제 명세를 입력하세요"),
  executionContract: ExecutionContractSchema,
  rubric: RubricSchema,
  /** 이 버전을 검증·채점할 하네스 버전. 워커의 `harnessVersionOf(caseSet)`와 같아야 한다 */
  harnessVersion: z.string().trim().min(1),
});
export type CreateAssignmentVersionInput = z.infer<typeof CreateAssignmentVersionInputSchema>;

export const CreateSubmissionInputSchema = z.strictObject({
  assignmentVersionId: z.uuid(),
  repoUrl: z.url({ protocol: /^https?$/ }),
  repoRef: z.string().trim().min(1).max(200).optional(),
});
export type CreateSubmissionInput = z.infer<typeof CreateSubmissionInputSchema>;

/** 화면용 상태 표기 */
export const ASSIGNMENT_VERSION_STATUS_LABEL: Record<AssignmentVersionStatus, string> = {
  DRAFT: "초안",
  VALIDATING: "검증 중",
  APPROVED: "승인됨",
  RETIRED: "폐기됨",
};

/** `주문·재고 API · v1 · 승인됨` */
export function formatVersionLabel(
  assignmentName: string,
  version: { version: number; status: AssignmentVersionStatus },
): string {
  return `${assignmentName} · v${version.version} · ${ASSIGNMENT_VERSION_STATUS_LABEL[version.status]}`;
}

function invalidInput(error: z.ZodError): ActionResult<never> {
  return {
    ok: false,
    code: "INVALID_INPUT",
    message: error.issues.map((i) => `${i.path.join(".") || "입력"}: ${i.message}`).join("; "),
    details: error.issues,
  };
}

function fromAssignmentError(error: unknown): ActionResult<never> {
  if (error instanceof AssignmentError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  if (error instanceof SubmissionRejectedError) {
    return {
      ok: false,
      code: error.reason,
      message: error.message,
      details: { assignmentVersionId: error.assignmentVersionId, status: error.versionStatus },
    };
  }
  throw error;
}

export async function registerAssignment(
  deps: AssignmentDeps,
  rawInput: unknown,
): Promise<ActionResult<AssignmentRow>> {
  const parsed = CreateAssignmentInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    return { ok: true, data: await createAssignment(deps.db, parsed.data) };
  } catch (error) {
    return fromAssignmentError(error);
  }
}

/**
 * DRAFT 버전을 만든다. 명세 원문은 내용 주소 키(`assignments/<id>/specs/<sha256>.md`)로 스토어에 먼저 넣고,
 * 그 참조와 다이제스트를 버전에 기록한다. rubric은 `validateRubric()`을 통과해야 한다 (RUBRIC_INVALID).
 */
export async function registerAssignmentVersion(
  deps: AssignmentDeps,
  rawInput: unknown,
): Promise<ActionResult<AssignmentVersionRow>> {
  const parsed = CreateAssignmentVersionInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  if (Buffer.byteLength(input.specMarkdown, "utf8") > MAX_SPEC_BYTES) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: `과제 명세가 ${MAX_SPEC_BYTES}바이트를 넘습니다`,
    };
  }
  if (!(await getAssignment(deps.db, input.assignmentId))) {
    return {
      ok: false,
      code: "ASSIGNMENT_NOT_FOUND",
      message: `과제를 찾을 수 없습니다: ${input.assignmentId}`,
    };
  }

  const specDigest = specDigestOf(input.specMarkdown);
  const specRef = artifactKeys.assignmentSpec(input.assignmentId, specDigest);
  await deps.store.put(specRef, input.specMarkdown, {
    contentType: ARTIFACT_CONTENT_TYPES.assignmentSpec,
  });
  try {
    const row = await createAssignmentVersion(deps.db, {
      assignmentId: input.assignmentId,
      title: input.title,
      specRef,
      specDigest,
      rubric: input.rubric,
      executionContract: input.executionContract,
      harnessVersion: input.harnessVersion,
    });
    return { ok: true, data: row };
  } catch (error) {
    return fromAssignmentError(error);
  }
}

export interface AssignmentVersionView {
  version: AssignmentVersionRow;
  assignment: AssignmentRow;
  label: string;
}

export async function readAssignmentVersion(
  deps: Pick<AssignmentDeps, "db">,
  assignmentVersionId: string,
): Promise<ActionResult<AssignmentVersionView>> {
  if (!z.uuid().safeParse(assignmentVersionId).success) {
    return { ok: false, code: "INVALID_INPUT", message: "버전 ID 형식이 올바르지 않습니다" };
  }
  const version = await getAssignmentVersion(deps.db, assignmentVersionId);
  if (!version) {
    return {
      ok: false,
      code: "VERSION_NOT_FOUND",
      message: `과제 버전을 찾을 수 없습니다: ${assignmentVersionId}`,
    };
  }
  const assignment = await getAssignment(deps.db, version.assignmentId);
  if (!assignment) {
    return {
      ok: false,
      code: "ASSIGNMENT_NOT_FOUND",
      message: `과제를 찾을 수 없습니다: ${version.assignmentId}`,
    };
  }
  return {
    ok: true,
    data: { version, assignment, label: formatVersionLabel(assignment.name, version) },
  };
}

export function readAssignmentList(
  deps: Pick<AssignmentDeps, "db">,
): Promise<AssignmentListItem[]> {
  return listAssignments(deps.db);
}

/**
 * 제출을 만든다. 버전이 APPROVED가 아니면 `RUBRIC_NOT_APPROVED`다 (함수 검사 + DB 트리거).
 * 저장소 수집·job 적재는 T-202·T-206의 범위다.
 */
export async function submitToAssignmentVersion(
  deps: Pick<AssignmentDeps, "db">,
  rawInput: unknown,
): Promise<ActionResult<SubmissionRow>> {
  const parsed = CreateSubmissionInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    return { ok: true, data: await createSubmission(deps.db, parsed.data) };
  } catch (error) {
    return fromAssignmentError(error);
  }
}

export const ApproveVersionInputSchema = z.strictObject({
  assignmentVersionId: z.uuid(),
  /** 승인자 이름. 비어 있으면 `APPROVAL_BLOCKED(APPROVER_MISSING)` */
  approvedBy: z.string().max(200),
});

export const CreateDraftFromVersionInputSchema = z.strictObject({
  sourceVersionId: z.uuid(),
  rubric: RubricSchema,
  title: z.string().trim().min(1).max(200).optional(),
});

/**
 * 채점기 사전 검증 시작 (T-405): DRAFT → VALIDATING + `VALIDATE_RUBRIC` job. 실행은 워커가 한다 (G-05).
 */
export async function requestVersionValidation(
  deps: Pick<AssignmentDeps, "db">,
  assignmentVersionId: string,
): Promise<ActionResult<ValidationRequestResult>> {
  if (!z.uuid().safeParse(assignmentVersionId).success) {
    return { ok: false, code: "INVALID_INPUT", message: "버전 ID 형식이 올바르지 않습니다" };
  }
  try {
    return {
      ok: true,
      data: await requestAssignmentVersionValidation(deps.db, assignmentVersionId),
    };
  } catch (error) {
    return fromAssignmentError(error);
  }
}

/** 승인 버튼 비활성 사유. 빈 배열이면 승인할 수 있다 */
export async function readApprovalBlockers(
  deps: Pick<AssignmentDeps, "db">,
  rawInput: unknown,
): Promise<ActionResult<ApprovalBlocker[]>> {
  const parsed = ApproveVersionInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    return {
      ok: true,
      data: await checkAssignmentVersionApproval(deps.db, {
        id: parsed.data.assignmentVersionId,
        approvedBy: parsed.data.approvedBy,
      }),
    };
  } catch (error) {
    return fromAssignmentError(error);
  }
}

/**
 * 기준 승인 (T-405): 검증 pass + 모든 샘플 사람 검토 + 승인자 이름. 하나라도 빠지면 `APPROVAL_BLOCKED`이고
 * `details.blockers`에 사유가 모두 있다. 승인되면 이전 승인 버전은 RETIRED, 기존 제출은 재평가 job에 들어간다.
 */
export async function approveVersion(
  deps: Pick<AssignmentDeps, "db">,
  rawInput: unknown,
): Promise<ActionResult<ApproveValidatedVersionResult>> {
  const parsed = ApproveVersionInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    return {
      ok: true,
      data: await approveValidatedAssignmentVersion(deps.db, {
        id: parsed.data.assignmentVersionId,
        approvedBy: parsed.data.approvedBy,
      }),
    };
  } catch (error) {
    return fromAssignmentError(error);
  }
}

/** 기준 변경은 새 DRAFT 버전으로만 한다 (명세·실행 계약·하네스·검증 샘플 복사) */
export async function createVersionDraftFrom(
  deps: Pick<AssignmentDeps, "db">,
  rawInput: unknown,
): Promise<ActionResult<AssignmentVersionRow>> {
  const parsed = CreateDraftFromVersionInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  try {
    const { version } = await createDraftFromVersion(deps.db, parsed.data);
    return { ok: true, data: version };
  } catch (error) {
    return fromAssignmentError(error);
  }
}

// ---------------------------------------------------------------------------
// 과제 설정 화면 (T-406): AI 기준 초안, 새 과제 저장, DRAFT 편집, 검증·승인 화면 데이터
// ---------------------------------------------------------------------------

export const RequestRubricDraftInputSchema = z.strictObject({
  specMarkdown: z.string().trim().min(1, "AI 초안을 만들려면 과제 명세를 먼저 입력하세요"),
  /** 기존 과제의 DRAFT 화면에서 요청하면 과제에 연결한다 */
  assignmentId: z.uuid().optional(),
});

/**
 * AI 기준 초안 요청: 명세를 내용 주소 키(`rubric-drafts/specs/<sha256>.md`)로 스토어에 넣고 `rubric_drafts` 행과
 * `DRAFT_RUBRIC` job을 만든다. LLM 호출은 워커가 한다 (web은 LLM 패키지에 의존하지 않는다, G-05·1.1).
 */
export async function requestRubricDraft(
  deps: AssignmentDeps,
  rawInput: unknown,
): Promise<ActionResult<{ draftId: string }>> {
  const parsed = RequestRubricDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  const { specMarkdown, assignmentId } = parsed.data;
  if (Buffer.byteLength(specMarkdown, "utf8") > MAX_RUBRIC_DRAFT_SPEC_BYTES) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: `AI 초안에 쓸 수 있는 명세는 ${MAX_RUBRIC_DRAFT_SPEC_BYTES}바이트까지입니다`,
    };
  }
  if (assignmentId && !(await getAssignment(deps.db, assignmentId))) {
    return {
      ok: false,
      code: "ASSIGNMENT_NOT_FOUND",
      message: `과제를 찾을 수 없습니다: ${assignmentId}`,
    };
  }
  const specDigest = specDigestOf(specMarkdown);
  const specRef = artifactKeys.rubricDraftSpec(specDigest);
  await deps.store.put(specRef, specMarkdown, {
    contentType: ARTIFACT_CONTENT_TYPES.assignmentSpec,
  });
  const { draft } = await createRubricDraftRequest(deps.db, { assignmentId, specRef, specDigest });
  return { ok: true, data: { draftId: draft.id } };
}

/** 초안 상태 폴링 */
export async function readRubricDraft(
  deps: Pick<AssignmentDeps, "db">,
  draftId: string,
): Promise<ActionResult<RubricDraftView>> {
  if (!z.uuid().safeParse(draftId).success) {
    return { ok: false, code: "INVALID_INPUT", message: "초안 ID 형식이 올바르지 않습니다" };
  }
  const row = await getRubricDraft(deps.db, draftId);
  if (!row) {
    return { ok: false, code: "DRAFT_NOT_FOUND", message: `AI 초안 요청을 찾을 수 없습니다` };
  }
  return { ok: true, data: toRubricDraftView(row) };
}

function rubricInvalid(errors: RubricValidationError[]): ActionResult<never> {
  return {
    ok: false,
    code: "RUBRIC_INVALID",
    message: `채점 기준이 유효하지 않습니다: ${errors.map((e) => e.message).join("; ")}`,
    details: errors,
  };
}

export const SaveNewAssignmentInputSchema = z.strictObject({
  name: z.string().trim().min(1, "과제 이름을 입력하세요").max(200),
  description: z.string().trim().max(2000).optional(),
  title: z.string().trim().min(1, "버전 제목을 입력하세요").max(200),
  specMarkdown: z.string().min(1, "과제 명세를 입력하세요"),
  executionContract: ExecutionContractSchema,
  rubric: RubricSchema,
  harnessVersion: z.string().trim().min(1, "하네스 버전을 고르세요"),
});

/**
 * 새 과제 + 첫 DRAFT 버전 저장 (`/assignments/new`). 기준은 `validateRubric()`을 먼저 통과해야 하며,
 * 과제를 만든 뒤 버전 생성이 실패하면 빈 과제를 지워 목록에 남기지 않는다.
 */
export async function saveNewAssignment(
  deps: AssignmentDeps,
  rawInput: unknown,
): Promise<ActionResult<{ assignment: AssignmentRow; version: AssignmentVersionRow }>> {
  const parsed = SaveNewAssignmentInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  const validation = validateRubric(input.rubric);
  if (!validation.ok) return rubricInvalid(validation.errors);

  const assignment = await registerAssignment(deps, {
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
  });
  if (!assignment.ok) return assignment;
  const version = await registerAssignmentVersion(deps, {
    assignmentId: assignment.data.id,
    title: input.title,
    specMarkdown: input.specMarkdown,
    executionContract: input.executionContract,
    rubric: input.rubric,
    harnessVersion: input.harnessVersion,
  });
  if (!version.ok) {
    await deleteAssignmentWithoutVersions(deps.db, assignment.data.id);
    return version;
  }
  return { ok: true, data: { assignment: assignment.data, version: version.data } };
}

export const SaveDraftVersionInputSchema = z.strictObject({
  assignmentVersionId: z.uuid(),
  title: z.string().trim().min(1, "버전 제목을 입력하세요").max(200),
  specMarkdown: z.string().min(1, "과제 명세를 입력하세요"),
  executionContract: ExecutionContractSchema,
  rubric: RubricSchema,
});

/** DRAFT 버전 저장. 승인·검증 중인 버전은 `INVALID_TRANSITION`으로 거부한다 (수정은 새 버전으로) */
export async function saveDraftVersion(
  deps: AssignmentDeps,
  rawInput: unknown,
): Promise<ActionResult<AssignmentVersionRow>> {
  const parsed = SaveDraftVersionInputSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  if (Buffer.byteLength(input.specMarkdown, "utf8") > MAX_SPEC_BYTES) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: `과제 명세가 ${MAX_SPEC_BYTES}바이트를 넘습니다`,
    };
  }
  const validation = validateRubric(input.rubric);
  if (!validation.ok) return rubricInvalid(validation.errors);
  const current = await getAssignmentVersion(deps.db, input.assignmentVersionId);
  if (!current) {
    return {
      ok: false,
      code: "VERSION_NOT_FOUND",
      message: `과제 버전을 찾을 수 없습니다: ${input.assignmentVersionId}`,
    };
  }
  const specDigest = specDigestOf(input.specMarkdown);
  const specRef = artifactKeys.assignmentSpec(current.assignmentId, specDigest);
  await deps.store.put(specRef, input.specMarkdown, {
    contentType: ARTIFACT_CONTENT_TYPES.assignmentSpec,
  });
  try {
    return {
      ok: true,
      data: await updateDraftAssignmentVersion(deps.db, {
        id: current.id,
        title: input.title,
        specRef,
        specDigest,
        rubric: input.rubric,
        executionContract: input.executionContract,
      }),
    };
  } catch (error) {
    return fromAssignmentError(error);
  }
}

export interface SetupSample {
  id: string;
  name: string;
  kind: ValidationSampleKind;
  humanReviewedBy: string | null;
}

export interface VersionSetupView {
  assignment: AssignmentRow;
  version: AssignmentVersionRow;
  label: string;
  /** 명세 원문. 스토어에서 읽지 못하면 null이고 `specError`에 사유 */
  specMarkdown: string | null;
  specError: string | null;
  samples: SetupSample[];
  /** T-405 `ValidationResult`. 시드 버전의 게이트 JSON처럼 형식이 다르면 null */
  validation: ValidationResult | null;
  /** 가장 최근 검증 job */
  validationJob: { status: string; lastError: string | null; attempts: number } | null;
  /** 승인자 이름을 뺀 승인 차단 사유 (이름은 화면에서 입력한다) */
  blockers: ApprovalBlocker[];
  /** 과제의 모든 버전 (번호 내림차순) */
  versions: Array<{ version: number; status: AssignmentVersionStatus }>;
}

/** `/assignments/[id]/versions/[v]` 화면 데이터 */
export async function readVersionSetup(
  deps: AssignmentDeps,
  assignmentId: string,
  versionNumber: number,
): Promise<ActionResult<VersionSetupView>> {
  if (!z.uuid().safeParse(assignmentId).success || !Number.isSafeInteger(versionNumber)) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "과제 ID나 버전 번호 형식이 올바르지 않습니다",
    };
  }
  const assignment = await getAssignment(deps.db, assignmentId);
  if (!assignment) {
    return { ok: false, code: "ASSIGNMENT_NOT_FOUND", message: "과제를 찾을 수 없습니다" };
  }
  const version = await getAssignmentVersionByNumber(deps.db, assignmentId, versionNumber);
  if (!version) {
    return {
      ok: false,
      code: "VERSION_NOT_FOUND",
      message: `과제 버전 v${versionNumber}을 찾을 수 없습니다`,
    };
  }
  const [spec, samples, job, siblings] = await Promise.all([
    deps.store.get(version.specRef).catch(() => null),
    listValidationSamples(deps.db, version.id),
    getLatestValidationJob(deps.db, version.id),
    listAssignmentVersions(deps.db, assignmentId),
  ]);
  const validation = ValidationResultSchema.safeParse(version.validationResult);
  return {
    ok: true,
    data: {
      assignment,
      version,
      label: formatVersionLabel(assignment.name, version),
      specMarkdown: spec ? Buffer.from(spec.body).toString("utf8") : null,
      specError: spec ? null : `명세 원문을 읽지 못했습니다 (${version.specRef})`,
      samples: samples.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        humanReviewedBy: s.humanReviewedBy?.trim() || null,
      })),
      validation: validation.success ? validation.data : null,
      validationJob: job
        ? { status: job.status, lastError: job.lastError, attempts: job.attempts }
        : null,
      blockers: approvalBlockers({ version, samples, approvedBy: "" }).filter(
        (b) => b.code !== "APPROVER_MISSING",
      ),
      versions: siblings.map((v) => ({ version: v.version, status: v.status })),
    },
  };
}

/** 새 과제 화면의 선택지: 워커가 승인에 쓴 하네스 버전 (최근 승인 순) */
export async function readNewAssignmentOptions(
  deps: Pick<AssignmentDeps, "db">,
): Promise<{ harnessVersions: string[] }> {
  return { harnessVersions: await listKnownHarnessVersions(deps.db) };
}

export type { AssignmentListItem, AssignmentRow, AssignmentVersionRow, RubricValidationError };
