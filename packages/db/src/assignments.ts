import { createHash } from "node:crypto";
import {
  assertTransition,
  formatRubricVersion,
  ReportProfileSchema,
  rubricContentForDigest,
  validateRubric,
  type AssignmentVersionStatus,
  type ExecutionContract,
  type ReportProfile,
  type Rubric,
  type RubricValidationError,
} from "@ohmyti/core";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { Database } from "./client";
import { assignments, assignmentVersions, submissions } from "./schema";
import { summarizeVersionValidation } from "./validation";

/**
 * 과제·기준 버전 등록과 승인 전 채점 차단 (TICKET.md T-201, 부록 B의 AssignmentVersion 상태 머신).
 *
 * - `createAssignmentVersion`: 항상 DRAFT로 만든다. `rubricVersion = v<n>-<sha256(rubric 내용) 앞 8자>`이며
 *   저장하는 rubric의 `version` 필드도 같은 값으로 채운다 (CriterionResult.rubricVersion과 `aggregateScore()`가 대조한다).
 * - 상태 전이 함수는 `WHERE status = <from>` 조건으로 갱신하고, 바뀐 행이 없으면 `InvalidTransitionError`다.
 * - 승인된 버전을 고치는 함수는 없다. 수정은 새 버전 생성으로만 하며, DB 트리거
 *   `assignment_versions_immutable_when_approved`가 이중으로 막는다.
 * - `createSubmission`: 버전이 APPROVED가 아니면 `SubmissionRejectedError(RUBRIC_NOT_APPROVED)`.
 *   DB 트리거 `submissions_require_approved_version`이 같은 규칙을 강제한다.
 */

export type AssignmentRow = typeof assignments.$inferSelect;
export type AssignmentVersionRow = typeof assignmentVersions.$inferSelect;
export type SubmissionRow = typeof submissions.$inferSelect;

export type AssignmentErrorCode =
  | "ASSIGNMENT_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "RUBRIC_INVALID"
  | "RUBRIC_VERSION_EXISTS"
  | "INVALID_TRANSITION"
  | "APPROVAL_BLOCKED";

export class AssignmentError extends Error {
  constructor(
    readonly code: AssignmentErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AssignmentError";
  }
}

export type SubmissionRejectReason = "RUBRIC_NOT_APPROVED" | "VERSION_NOT_FOUND";

/** 제출 생성 거부. `reason`은 화면·API가 그대로 사용자에게 보여 준다 (G-09). */
export class SubmissionRejectedError extends Error {
  constructor(
    readonly reason: SubmissionRejectReason,
    readonly assignmentVersionId: string,
    readonly versionStatus: AssignmentVersionStatus | null,
  ) {
    super(
      reason === "RUBRIC_NOT_APPROVED"
        ? `승인되지 않은 기준 버전(${versionStatus ?? "없음"})에는 제출을 만들 수 없습니다`
        : `과제 버전을 찾을 수 없습니다: ${assignmentVersionId}`,
    );
    this.name = "SubmissionRejectedError";
  }
}

/** rubric 내용(`version` 제외)의 sha256 hex. */
export function rubricContentDigest(rubric: Rubric): string {
  return createHash("sha256").update(rubricContentForDigest(rubric)).digest("hex");
}

/** `v<n>-<sha256(rubric 내용) 앞 8자>`. 내용이 1바이트라도 다르면 값이 다르다. */
export function computeRubricVersion(rubric: Rubric, version: number): string {
  return formatRubricVersion(version, rubricContentDigest(rubric));
}

/** 명세 원문의 sha256 hex (`assignment_versions.spec_digest`). */
export function specDigestOf(specMarkdown: string): string {
  return createHash("sha256").update(specMarkdown, "utf8").digest("hex");
}

export interface CreateAssignmentInput {
  name: string;
  description?: string | undefined;
}

export async function createAssignment(
  db: Database,
  input: CreateAssignmentInput,
): Promise<AssignmentRow> {
  const name = input.name.trim();
  if (!name) throw new AssignmentError("RUBRIC_INVALID", "과제 이름은 비어 있을 수 없습니다");
  const [row] = await db
    .insert(assignments)
    .values({ name, description: input.description?.trim() || null })
    .returning();
  if (!row) throw new Error("assignments insert가 행을 돌려주지 않았습니다");
  return row;
}

/**
 * 버전이 하나도 없는 과제를 지운다 (T-406 새 과제 저장에서 첫 버전 생성이 실패했을 때의 보상 삭제).
 * 버전이 있으면 지우지 않고 false다.
 */
export async function deleteAssignmentWithoutVersions(db: Database, id: string): Promise<boolean> {
  const deleted = await db
    .delete(assignments)
    .where(
      and(
        eq(assignments.id, id),
        sql`not exists (select 1 from ${assignmentVersions} where ${assignmentVersions.assignmentId} = ${assignments.id})`,
      ),
    )
    .returning({ id: assignments.id });
  return deleted.length > 0;
}

export async function getAssignment(db: Database, id: string): Promise<AssignmentRow | null> {
  const [row] = await db.select().from(assignments).where(eq(assignments.id, id)).limit(1);
  return row ?? null;
}

export interface CreateAssignmentVersionInput {
  assignmentId: string;
  title: string;
  /** 명세 원문의 artifact ref. 본문은 호출자가 스토어에 넣는다 */
  specRef: string;
  specDigest: string;
  rubric: Rubric;
  executionContract: ExecutionContract;
  harnessVersion: string;
}

/**
 * DRAFT 버전을 만든다. 버전 번호는 과제 안에서 1부터 이어지며, 같은 과제의 동시 생성은 과제 행 잠금으로 직렬화한다.
 * `validateRubric()`을 통과하지 못하면 `AssignmentError(RUBRIC_INVALID)`이고 `details`에 오류 목록이 있다.
 */
export async function createAssignmentVersion(
  db: Database,
  input: CreateAssignmentVersionInput,
): Promise<AssignmentVersionRow> {
  const validation = validateRubric(input.rubric);
  if (!validation.ok) {
    throw new AssignmentError(
      "RUBRIC_INVALID",
      `채점 기준이 유효하지 않습니다: ${validation.errors.map((e) => e.message).join("; ")}`,
      validation.errors satisfies RubricValidationError[],
    );
  }

  return db.transaction(async (tx) => {
    const [assignment] = await tx
      .select({ id: assignments.id })
      .from(assignments)
      .where(eq(assignments.id, input.assignmentId))
      .for("update");
    if (!assignment) {
      throw new AssignmentError(
        "ASSIGNMENT_NOT_FOUND",
        `과제를 찾을 수 없습니다: ${input.assignmentId}`,
      );
    }

    const [latest] = await tx
      .select({ max: sql<number>`coalesce(max(${assignmentVersions.version}), 0)::int` })
      .from(assignmentVersions)
      .where(eq(assignmentVersions.assignmentId, input.assignmentId));
    const version = (latest?.max ?? 0) + 1;
    const rubricVersion = computeRubricVersion(input.rubric, version);

    const [existing] = await tx
      .select({ id: assignmentVersions.id, assignmentId: assignmentVersions.assignmentId })
      .from(assignmentVersions)
      .where(eq(assignmentVersions.rubricVersion, rubricVersion))
      .limit(1);
    if (existing) {
      throw new AssignmentError(
        "RUBRIC_VERSION_EXISTS",
        `같은 내용의 기준 버전 ${rubricVersion}이 이미 있습니다 (과제 ${existing.assignmentId})`,
        { existingVersionId: existing.id },
      );
    }

    const [row] = await tx
      .insert(assignmentVersions)
      .values({
        assignmentId: input.assignmentId,
        version,
        status: "DRAFT",
        title: input.title,
        specRef: input.specRef,
        specDigest: input.specDigest,
        rubric: { ...input.rubric, version: rubricVersion },
        rubricVersion,
        executionContract: input.executionContract,
        harnessVersion: input.harnessVersion,
      })
      .returning();
    if (!row) throw new Error("assignment_versions insert가 행을 돌려주지 않았습니다");
    return row;
  });
}

export interface UpdateDraftAssignmentVersionInput {
  id: string;
  title: string;
  specRef: string;
  specDigest: string;
  rubric: Rubric;
  executionContract: ExecutionContract;
}

/**
 * DRAFT 버전의 명세·실행 계약·기준을 고친다 (T-406 과제 설정 화면의 저장). 버전 번호는 그대로이고
 * `rubricVersion`은 새 내용으로 다시 계산하며, 이전 검증 결과는 새 기준에 대한 것이 아니므로 지운다.
 * DRAFT가 아니면 `INVALID_TRANSITION`이다. 승인된 버전은 이 함수로도 고칠 수 없다 (DB 트리거가 이중으로 막는다).
 */
export async function updateDraftAssignmentVersion(
  db: Database,
  input: UpdateDraftAssignmentVersionInput,
): Promise<AssignmentVersionRow> {
  const validation = validateRubric(input.rubric);
  if (!validation.ok) {
    throw new AssignmentError(
      "RUBRIC_INVALID",
      `채점 기준이 유효하지 않습니다: ${validation.errors.map((e) => e.message).join("; ")}`,
      validation.errors satisfies RubricValidationError[],
    );
  }
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(assignmentVersions)
      .where(eq(assignmentVersions.id, input.id))
      .for("update");
    if (!locked) {
      throw new AssignmentError("VERSION_NOT_FOUND", `과제 버전을 찾을 수 없습니다: ${input.id}`);
    }
    if (locked.status !== "DRAFT") {
      throw new AssignmentError(
        "INVALID_TRANSITION",
        `과제 버전 ${input.id}은 ${locked.status} 상태라 고칠 수 없습니다. 새 버전을 만드세요`,
        { status: locked.status },
      );
    }
    const rubricVersion = computeRubricVersion(input.rubric, locked.version);
    const [existing] = await tx
      .select({ id: assignmentVersions.id, assignmentId: assignmentVersions.assignmentId })
      .from(assignmentVersions)
      .where(
        and(
          eq(assignmentVersions.rubricVersion, rubricVersion),
          ne(assignmentVersions.id, locked.id),
        ),
      )
      .limit(1);
    if (existing) {
      throw new AssignmentError(
        "RUBRIC_VERSION_EXISTS",
        `같은 내용의 기준 버전 ${rubricVersion}이 이미 있습니다 (과제 ${existing.assignmentId})`,
        { existingVersionId: existing.id },
      );
    }
    const [row] = await tx
      .update(assignmentVersions)
      .set({
        title: input.title,
        specRef: input.specRef,
        specDigest: input.specDigest,
        rubric: { ...input.rubric, version: rubricVersion },
        rubricVersion,
        executionContract: input.executionContract,
        validationResult: null,
      })
      .where(and(eq(assignmentVersions.id, locked.id), eq(assignmentVersions.status, "DRAFT")))
      .returning();
    if (!row) throw new Error(`과제 버전 ${locked.id} 갱신이 행을 돌려주지 않았습니다`);
    return row;
  });
}

/** 과제 안의 버전 번호로 찾는다 (`/assignments/[id]/versions/[v]`) */
export async function getAssignmentVersionByNumber(
  db: Database,
  assignmentId: string,
  version: number,
): Promise<AssignmentVersionRow | null> {
  const [row] = await db
    .select()
    .from(assignmentVersions)
    .where(
      and(
        eq(assignmentVersions.assignmentId, assignmentId),
        eq(assignmentVersions.version, version),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 등록된 버전들이 쓰는 하네스 버전 목록 (최근 승인·생성 순, 중복 제거). 새 과제 화면이 선택지로 쓴다.
 * web은 하네스 패키지를 번들하지 않으므로(G-05) 워커가 승인에 쓴 값을 DB에서 고른다.
 */
export async function listKnownHarnessVersions(db: Database): Promise<string[]> {
  const rows = await db
    .select({ harnessVersion: assignmentVersions.harnessVersion })
    .from(assignmentVersions)
    .orderBy(
      sql`case when ${assignmentVersions.status} = 'APPROVED' then 0 else 1 end`,
      desc(assignmentVersions.createdAt),
    );
  return [...new Set(rows.map((r) => r.harnessVersion))];
}

export async function getAssignmentVersion(
  db: Database,
  id: string,
): Promise<AssignmentVersionRow | null> {
  const [row] = await db
    .select()
    .from(assignmentVersions)
    .where(eq(assignmentVersions.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * 채용 리포트 프로필을 저장한다 (T-705). 기준별 역량 보정과 영향 문장일 뿐 rubric 본문·rubricVersion·점수와 무관하므로
 * 승인된 버전에도 넣을 수 있다 (불변 트리거의 대상 열이 아니다). `null`을 주면 프로필을 지운다.
 */
export async function setAssignmentVersionReportProfile(
  db: Database,
  id: string,
  profile: ReportProfile | null,
): Promise<AssignmentVersionRow | null> {
  if (profile) ReportProfileSchema.parse(profile);
  const [row] = await db
    .update(assignmentVersions)
    .set({ reportProfile: profile, updatedAt: new Date() })
    .where(eq(assignmentVersions.id, id))
    .returning();
  return row ?? null;
}

export async function getAssignmentVersionByRubricVersion(
  db: Database,
  rubricVersion: string,
): Promise<AssignmentVersionRow | null> {
  const [row] = await db
    .select()
    .from(assignmentVersions)
    .where(eq(assignmentVersions.rubricVersion, rubricVersion))
    .limit(1);
  return row ?? null;
}

export async function listAssignmentVersions(
  db: Database,
  assignmentId: string,
): Promise<AssignmentVersionRow[]> {
  return db
    .select()
    .from(assignmentVersions)
    .where(eq(assignmentVersions.assignmentId, assignmentId))
    .orderBy(desc(assignmentVersions.version));
}

/** 목록 화면용 요약. rubric·계약 본문은 싣지 않는다 */
export interface AssignmentVersionSummary {
  id: string;
  version: number;
  status: AssignmentVersionStatus;
  title: string;
  rubricVersion: string;
  harnessVersion: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  /** 채점기 사전 검증 결과 (T-405 `ValidationResult`, 시드 버전은 1단계 게이트 JSON). 없으면 null */
  validationResult: unknown;
  /** 검증 샘플 수와 사람이 검토한 샘플 수 */
  samplesTotal: number;
  samplesReviewed: number;
  /** 실제 제출 수 (`is_sample`·삭제 제외). 검증 실행은 세지 않는다 */
  submissionCount: number;
  /** 시드 부트스트랩 승인이고 검토 안 된 샘플이 있어 `부트스트랩 승인 · 샘플 검토 대기` 배지를 보일지 */
  bootstrapPendingReview: boolean;
}

export interface AssignmentListItem {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  versions: AssignmentVersionSummary[];
}

/** 과제 목록. 각 과제의 버전을 번호 내림차순으로 싣는다 (버전 없는 과제도 포함). */
export async function listAssignments(db: Database): Promise<AssignmentListItem[]> {
  const rows = await db
    .select({
      assignmentId: assignments.id,
      name: assignments.name,
      description: assignments.description,
      assignmentCreatedAt: assignments.createdAt,
      versionId: assignmentVersions.id,
      version: assignmentVersions.version,
      status: assignmentVersions.status,
      title: assignmentVersions.title,
      rubricVersion: assignmentVersions.rubricVersion,
      harnessVersion: assignmentVersions.harnessVersion,
      approvedBy: assignmentVersions.approvedBy,
      approvedAt: assignmentVersions.approvedAt,
      validationResult: assignmentVersions.validationResult,
      versionCreatedAt: assignmentVersions.createdAt,
    })
    .from(assignments)
    .leftJoin(assignmentVersions, eq(assignmentVersions.assignmentId, assignments.id))
    .orderBy(asc(assignments.createdAt), asc(assignments.id), desc(assignmentVersions.version));

  const items = new Map<string, AssignmentListItem>();
  for (const row of rows) {
    let item = items.get(row.assignmentId);
    if (!item) {
      item = {
        id: row.assignmentId,
        name: row.name,
        description: row.description,
        createdAt: row.assignmentCreatedAt,
        versions: [],
      };
      items.set(row.assignmentId, item);
    }
    if (row.versionId !== null && row.version !== null && row.status !== null) {
      item.versions.push({
        id: row.versionId,
        version: row.version,
        status: row.status,
        title: row.title ?? "",
        rubricVersion: row.rubricVersion ?? "",
        harnessVersion: row.harnessVersion ?? "",
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt,
        createdAt: row.versionCreatedAt ?? row.assignmentCreatedAt,
        validationResult: row.validationResult ?? null,
        samplesTotal: 0,
        samplesReviewed: 0,
        submissionCount: 0,
        bootstrapPendingReview: false,
      });
    }
  }
  const versions = [...items.values()].flatMap((item) => item.versions);
  const summaries = await summarizeVersionValidation(db, versions);
  for (const version of versions) {
    const summary = summaries.get(version.id);
    if (summary) Object.assign(version, summary);
  }
  return [...items.values()];
}

async function transition(
  db: Database,
  id: string,
  from: AssignmentVersionStatus,
  to: AssignmentVersionStatus,
  patch: Partial<typeof assignmentVersions.$inferInsert>,
): Promise<AssignmentVersionRow> {
  assertTransition("assignmentVersion", from, to);
  const [row] = await db
    .update(assignmentVersions)
    .set({ ...patch, status: to })
    .where(and(eq(assignmentVersions.id, id), eq(assignmentVersions.status, from)))
    .returning();
  if (row) return row;

  const current = await getAssignmentVersion(db, id);
  if (!current) {
    throw new AssignmentError("VERSION_NOT_FOUND", `과제 버전을 찾을 수 없습니다: ${id}`);
  }
  throw new AssignmentError(
    "INVALID_TRANSITION",
    `과제 버전 ${id}은 ${current.status} 상태라 ${from} → ${to} 전이를 할 수 없습니다`,
    { status: current.status },
  );
}

/** DRAFT → VALIDATING. 채점기 사전 검증(T-405)을 시작할 때 */
export function startAssignmentVersionValidation(
  db: Database,
  id: string,
): Promise<AssignmentVersionRow> {
  return transition(db, id, "DRAFT", "VALIDATING", {});
}

/** VALIDATING → DRAFT (검증 불일치). 결과는 남긴다 */
export function rejectAssignmentVersionValidation(
  db: Database,
  input: { id: string; validationResult: unknown },
): Promise<AssignmentVersionRow> {
  return transition(db, input.id, "VALIDATING", "DRAFT", {
    validationResult: input.validationResult,
  });
}

export interface ApproveAssignmentVersionInput {
  id: string;
  approvedBy: string;
  /** 승인 근거가 된 검증 결과 (샘플별 기대·실제 대조). 승인 후에는 바꿀 수 없다 */
  validationResult: unknown;
  now?: Date | undefined;
}

/** VALIDATING → APPROVED. 이후 이 버전은 불변이며 제출을 받을 수 있다 */
export function approveAssignmentVersion(
  db: Database,
  input: ApproveAssignmentVersionInput,
): Promise<AssignmentVersionRow> {
  const approvedBy = input.approvedBy.trim();
  if (!approvedBy)
    throw new AssignmentError("RUBRIC_INVALID", "approvedBy는 비어 있을 수 없습니다");
  return transition(db, input.id, "VALIDATING", "APPROVED", {
    approvedBy,
    approvedAt: input.now ?? new Date(),
    validationResult: input.validationResult,
  });
}

/** APPROVED → RETIRED. 더 이상 제출을 받지 않는다 */
export function retireAssignmentVersion(
  db: Database,
  id: string,
  now: Date = new Date(),
): Promise<AssignmentVersionRow> {
  return transition(db, id, "APPROVED", "RETIRED", { retiredAt: now });
}

export interface CreateSubmissionInput {
  assignmentVersionId: string;
  repoUrl: string;
  repoRef?: string | undefined;
  isSample?: boolean | undefined;
  /** 샘플 체험 제출(T-505)의 샘플 ID. 주면 `isSample`은 항상 true다 */
  demoSampleId?: string | undefined;
}

/**
 * 제출을 만든다. 버전이 APPROVED가 아니면 `SubmissionRejectedError(RUBRIC_NOT_APPROVED)`다.
 * 검사와 INSERT 사이의 상태 변경은 DB 트리거가 잡는다 (같은 사유 문자열 `RUBRIC_NOT_APPROVED`).
 */
export async function createSubmission(
  db: Database,
  input: CreateSubmissionInput,
): Promise<SubmissionRow> {
  const version = await getAssignmentVersion(db, input.assignmentVersionId);
  if (!version) {
    throw new SubmissionRejectedError("VERSION_NOT_FOUND", input.assignmentVersionId, null);
  }
  if (version.status !== "APPROVED") {
    throw new SubmissionRejectedError(
      "RUBRIC_NOT_APPROVED",
      input.assignmentVersionId,
      version.status,
    );
  }
  const [row] = await db
    .insert(submissions)
    .values({
      assignmentVersionId: input.assignmentVersionId,
      repoUrl: input.repoUrl,
      repoRef: input.repoRef ?? null,
      isSample: input.demoSampleId ? true : (input.isSample ?? false),
      demoSampleId: input.demoSampleId ?? null,
    })
    .returning();
  if (!row) throw new Error("submissions insert가 행을 돌려주지 않았습니다");
  return row;
}
