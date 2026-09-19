import {
  approvalBlockers,
  assertTransition,
  evaluateSubmissionDedupeKey,
  isBootstrapApprovalPendingReview,
  reevaluateAssignmentVersionDedupeKey,
  validateRubricDedupeKey,
  type ApprovalBlocker,
  type EvaluateSubmissionPayload,
  type ReevaluateAssignmentVersionPayload,
  type ValidateRubricPayload,
  type ValidationResult,
} from "@ohmyti/core";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  AssignmentError,
  createAssignmentVersion,
  getAssignmentVersion,
  type AssignmentVersionRow,
  type SubmissionRow,
} from "./assignments";
import type { Database } from "./client";
import { enqueue, type EnqueueResult } from "./queue";
import { assignmentVersions, evaluations, jobs, submissions, validationSamples } from "./schema";
import type { JobRow } from "./queue";

/**
 * 채점기 사전 검증과 승인 게이트 (TICKET.md T-405, 부록 B AssignmentVersion `DRAFT → VALIDATING → DRAFT | APPROVED`).
 *
 * - `requestAssignmentVersionValidation`: DRAFT → VALIDATING(이전 결과 지움) + `VALIDATE_RUBRIC` job.
 * - `createValidationRunSubmission`: 검증 샘플 하나를 채점할 `is_sample` 제출. 저장소 대신 샘플 스냅샷을 쓰고 SHA는 샘플 내용 해시다.
 * - `recordAssignmentVersionValidation`: pass면 VALIDATING에 결과만 남기고(승인 대기), 아니면 VALIDATING → DRAFT.
 * - `approveValidatedAssignmentVersion`: `approvalBlockers`(검증 pass + 모든 샘플 사람 검토 + 승인자 이름)를 버전 행 잠금 안에서
 *   검사해 APPROVED로 바꾸고, 같은 과제의 이전 APPROVED 버전은 RETIRED로 내린다. 이전 버전에 실제 제출이 있으면
 *   `REEVALUATE_ASSIGNMENT_VERSION` job을 넣는다. 사유가 하나라도 있으면 `AssignmentError(APPROVAL_BLOCKED)`.
 * - `createDraftFromVersion`: 기준 변경은 새 DRAFT 버전(명세·실행 계약·하네스·검증 샘플 복사)으로만 한다.
 *
 * 시드의 부트스트랩 승인(`approveAssignmentVersion`, `approved_by = 'seed'`)은 이 게이트를 거치지 않으며
 * 화면에 `부트스트랩 승인 · 샘플 검토 대기` 배지로 표시한다.
 */

export type ValidationSampleRow = typeof validationSamples.$inferSelect;

export async function listValidationSamples(
  db: Database,
  assignmentVersionId: string,
): Promise<ValidationSampleRow[]> {
  return db
    .select()
    .from(validationSamples)
    .where(eq(validationSamples.assignmentVersionId, assignmentVersionId))
    .orderBy(asc(validationSamples.kind), asc(validationSamples.name), asc(validationSamples.id));
}

export interface ValidationRequestResult {
  version: AssignmentVersionRow;
  job: EnqueueResult;
}

/**
 * 검증을 시작한다. DRAFT면 VALIDATING으로 바꾸고 이전 결과를 지운 뒤 job을 넣는다.
 * 이미 VALIDATING이고 결과가 없으면(진행 중이거나 job 적재 전에 끊김) job만 다시 넣는다 (dedupeKey로 하나만 존재).
 */
export async function requestAssignmentVersionValidation(
  db: Database,
  assignmentVersionId: string,
): Promise<ValidationRequestResult> {
  let version = await getAssignmentVersion(db, assignmentVersionId);
  if (!version) {
    throw new AssignmentError(
      "VERSION_NOT_FOUND",
      `과제 버전을 찾을 수 없습니다: ${assignmentVersionId}`,
    );
  }
  if (version.status === "DRAFT") {
    assertTransition("assignmentVersion", "DRAFT", "VALIDATING");
    const [row] = await db
      .update(assignmentVersions)
      .set({ status: "VALIDATING", validationResult: null })
      .where(and(eq(assignmentVersions.id, version.id), eq(assignmentVersions.status, "DRAFT")))
      .returning();
    if (!row) {
      throw new AssignmentError(
        "INVALID_TRANSITION",
        `과제 버전 ${version.id}의 상태가 바뀌어 검증을 시작하지 못했습니다`,
      );
    }
    version = row;
  } else if (version.status !== "VALIDATING" || version.validationResult !== null) {
    throw new AssignmentError(
      "INVALID_TRANSITION",
      version.status === "VALIDATING"
        ? `과제 버전 ${version.id}은 이미 검증을 마쳤습니다. 승인하거나 새 버전을 만드세요`
        : `과제 버전 ${version.id}은 ${version.status} 상태라 검증할 수 없습니다`,
      { status: version.status },
    );
  }
  const payload: ValidateRubricPayload = { assignmentVersionId: version.id };
  const job = await enqueue(db, {
    type: "VALIDATE_RUBRIC",
    payload,
    dedupeKey: validateRubricDedupeKey(version.id),
  });
  return { version, job };
}

/**
 * 버전의 가장 최근 `VALIDATE_RUBRIC` job (T-406 화면의 진행 상태). VALIDATING인데 결과가 없고 job이 FAILED면
 * 화면이 실패 사유를 보여 주고 다시 실행하게 한다 (`requestAssignmentVersionValidation`이 job만 다시 넣는다).
 */
export async function getLatestValidationJob(
  db: Database,
  assignmentVersionId: string,
): Promise<JobRow | null> {
  const [row] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "VALIDATE_RUBRIC"),
        sql`${jobs.payload} ->> 'assignmentVersionId' = ${assignmentVersionId}`,
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return row ?? null;
}

/** `validation-sample:<샘플 id>`. 검증 제출은 저장소가 아니라 샘플 스냅샷을 채점한다 */
export function validationSampleRepoUrl(validationSampleId: string): string {
  return `validation-sample:${validationSampleId}`;
}

/**
 * 검증 샘플 하나를 채점할 제출을 만든다. `is_sample = true`라 실제 제출 통계·재평가 대상에 섞이지 않는다.
 * SHA는 샘플 내용 해시를 미리 고정한다(REPO_CHECK가 저장소 대신 샘플 스냅샷을 복사한다).
 */
export async function createValidationRunSubmission(
  db: Database,
  sample: Pick<ValidationSampleRow, "id" | "assignmentVersionId" | "submissionSha">,
): Promise<SubmissionRow> {
  const [row] = await db
    .insert(submissions)
    .values({
      assignmentVersionId: sample.assignmentVersionId,
      repoUrl: validationSampleRepoUrl(sample.id),
      submissionSha: sample.submissionSha,
      isSample: true,
      validationSampleId: sample.id,
    })
    .returning();
  if (!row) throw new Error("submissions insert가 행을 돌려주지 않았습니다");
  return row;
}

/** 샘플의 검증 제출 중 `since` 이후에 만든 가장 최근 것 (job 재시도가 같은 제출을 이어서 쓴다) */
export async function findValidationRunSubmission(
  db: Database,
  validationSampleId: string,
  since: Date,
): Promise<SubmissionRow | null> {
  const [row] = await db
    .select()
    .from(submissions)
    .where(
      and(
        eq(submissions.validationSampleId, validationSampleId),
        gte(submissions.createdAt, since),
      ),
    )
    .orderBy(desc(submissions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * 검증 결과를 기록한다. pass면 VALIDATING을 유지한 채 결과만 남기고(승인 대기), 아니면 VALIDATING → DRAFT.
 * 버전이 VALIDATING이 아니면 `INVALID_TRANSITION`.
 */
export async function recordAssignmentVersionValidation(
  db: Database,
  input: { id: string; validationResult: ValidationResult },
): Promise<AssignmentVersionRow> {
  const pass = input.validationResult.pass;
  if (!pass) assertTransition("assignmentVersion", "VALIDATING", "DRAFT");
  const [row] = await db
    .update(assignmentVersions)
    .set({
      validationResult: input.validationResult,
      ...(pass ? {} : { status: "DRAFT" as const }),
    })
    .where(and(eq(assignmentVersions.id, input.id), eq(assignmentVersions.status, "VALIDATING")))
    .returning();
  if (row) return row;
  const current = await getAssignmentVersion(db, input.id);
  if (!current) {
    throw new AssignmentError("VERSION_NOT_FOUND", `과제 버전을 찾을 수 없습니다: ${input.id}`);
  }
  throw new AssignmentError(
    "INVALID_TRANSITION",
    `과제 버전 ${input.id}은 ${current.status} 상태라 검증 결과를 기록할 수 없습니다`,
    { status: current.status },
  );
}

export interface ApproveValidatedVersionInput {
  id: string;
  approvedBy: string;
  now?: Date | undefined;
}

export interface ApproveValidatedVersionResult {
  version: AssignmentVersionRow;
  /** 같은 과제에서 RETIRED로 내린 이전 승인 버전 */
  retiredVersionIds: string[];
  /** 이전 버전에 실제 제출이 있어 넣은 재평가 job. 없으면 null */
  reevaluation: EnqueueResult | null;
}

/** 승인 조건을 검사한다. 빈 배열이면 승인할 수 있다 (화면이 버튼 비활성 사유로 쓴다) */
export async function checkAssignmentVersionApproval(
  db: Database,
  input: { id: string; approvedBy: string },
): Promise<ApprovalBlocker[]> {
  const version = await getAssignmentVersion(db, input.id);
  if (!version) {
    throw new AssignmentError("VERSION_NOT_FOUND", `과제 버전을 찾을 수 없습니다: ${input.id}`);
  }
  const samples = await listValidationSamples(db, version.id);
  return approvalBlockers({ version, samples, approvedBy: input.approvedBy });
}

export async function approveValidatedAssignmentVersion(
  db: Database,
  input: ApproveValidatedVersionInput,
): Promise<ApproveValidatedVersionResult> {
  const now = input.now ?? new Date();
  const approvedBy = input.approvedBy.trim();
  const { version, retiredVersionIds } = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(assignmentVersions)
      .where(eq(assignmentVersions.id, input.id))
      .for("update");
    if (!locked) {
      throw new AssignmentError("VERSION_NOT_FOUND", `과제 버전을 찾을 수 없습니다: ${input.id}`);
    }
    const samples = await tx
      .select()
      .from(validationSamples)
      .where(eq(validationSamples.assignmentVersionId, locked.id));
    const blockers = approvalBlockers({ version: locked, samples, approvedBy });
    if (blockers.length > 0) {
      throw new AssignmentError(
        "APPROVAL_BLOCKED",
        `승인할 수 없습니다: ${blockers.map((b) => b.message).join("; ")}`,
        { blockers },
      );
    }
    assertTransition("assignmentVersion", "VALIDATING", "APPROVED");
    const [approved] = await tx
      .update(assignmentVersions)
      .set({ status: "APPROVED", approvedBy, approvedAt: now })
      .where(and(eq(assignmentVersions.id, locked.id), eq(assignmentVersions.status, "VALIDATING")))
      .returning();
    if (!approved) throw new Error(`과제 버전 ${locked.id} 승인 갱신이 행을 돌려주지 않았습니다`);
    assertTransition("assignmentVersion", "APPROVED", "RETIRED");
    const retired = await tx
      .update(assignmentVersions)
      .set({ status: "RETIRED", retiredAt: now })
      .where(
        and(
          eq(assignmentVersions.assignmentId, locked.assignmentId),
          eq(assignmentVersions.status, "APPROVED"),
          ne(assignmentVersions.id, locked.id),
        ),
      )
      .returning({ id: assignmentVersions.id });
    return { version: approved, retiredVersionIds: retired.map((r) => r.id) };
  });

  const targets = await listReevaluationTargets(db, version.id);
  let reevaluation: EnqueueResult | null = null;
  if (targets.length > 0) {
    const payload: ReevaluateAssignmentVersionPayload = { assignmentVersionId: version.id };
    reevaluation = await enqueue(db, {
      type: "REEVALUATE_ASSIGNMENT_VERSION",
      payload,
      dedupeKey: reevaluateAssignmentVersionDedupeKey(version.id),
    });
  }
  return { version, retiredVersionIds, reevaluation };
}

/**
 * 새 승인 버전으로 재평가할 제출: 같은 과제의 다른 버전에 들어온 실제 제출(`is_sample = false`, 삭제·UNSUPPORTED 제외) 중
 * 이 버전으로 끝난 evaluation이 아직 없는 것. 검증 제출과 샘플 체험 제출은 섞지 않는다.
 */
export async function listReevaluationTargets(
  db: Database,
  assignmentVersionId: string,
): Promise<SubmissionRow[]> {
  const version = await getAssignmentVersion(db, assignmentVersionId);
  if (!version) return [];
  const siblingVersions = db
    .select({ id: assignmentVersions.id })
    .from(assignmentVersions)
    .where(
      and(
        eq(assignmentVersions.assignmentId, version.assignmentId),
        ne(assignmentVersions.id, version.id),
      ),
    );
  const alreadyEvaluated = db
    .select({ id: evaluations.submissionId })
    .from(evaluations)
    .where(and(eq(evaluations.assignmentVersionId, version.id), isNotNull(evaluations.finishedAt)));
  return db
    .select()
    .from(submissions)
    .where(
      and(
        inArray(submissions.assignmentVersionId, siblingVersions),
        eq(submissions.isSample, false),
        isNull(submissions.deletedAt),
        notInArray(submissions.status, ["DELETED", "UNSUPPORTED"]),
        notInArray(submissions.id, alreadyEvaluated),
      ),
    )
    .orderBy(asc(submissions.createdAt), asc(submissions.id));
}

/** 재평가 `EVALUATE_SUBMISSION { submissionId, assignmentVersionId }` job. 제출 상태는 바꾸지 않는다 */
export function enqueueSubmissionReevaluation(
  db: Database,
  input: { submissionId: string; assignmentVersionId: string },
): Promise<EnqueueResult> {
  const payload: EvaluateSubmissionPayload = {
    submissionId: input.submissionId,
    assignmentVersionId: input.assignmentVersionId,
  };
  return enqueue(db, {
    type: "EVALUATE_SUBMISSION",
    payload,
    dedupeKey: evaluateSubmissionDedupeKey(input.submissionId, input.assignmentVersionId),
  });
}

export interface CreateDraftFromVersionInput {
  sourceVersionId: string;
  /** 바뀐 기준. `version` 필드는 새로 계산된다 */
  rubric: AssignmentVersionRow["rubric"];
  title?: string | undefined;
}

/**
 * 기준 변경은 새 DRAFT 버전으로만 한다. 명세·실행 계약·하네스는 원본 그대로 복사하고, 검증 샘플(스냅샷·기대 결과·검토자)도
 * 복사한다. 샘플 검토는 샘플 코드와 기대 결과표에 대한 것이므로 기준이 바뀌어도 유지된다.
 */
export async function createDraftFromVersion(
  db: Database,
  input: CreateDraftFromVersionInput,
): Promise<{ version: AssignmentVersionRow; samples: ValidationSampleRow[] }> {
  const source = await getAssignmentVersion(db, input.sourceVersionId);
  if (!source) {
    throw new AssignmentError(
      "VERSION_NOT_FOUND",
      `과제 버전을 찾을 수 없습니다: ${input.sourceVersionId}`,
    );
  }
  const version = await createAssignmentVersion(db, {
    assignmentId: source.assignmentId,
    title: input.title ?? source.title,
    specRef: source.specRef,
    specDigest: source.specDigest,
    rubric: input.rubric,
    executionContract: source.executionContract,
    harnessVersion: source.harnessVersion,
  });
  const sourceSamples = await listValidationSamples(db, source.id);
  const samples =
    sourceSamples.length === 0
      ? []
      : await db
          .insert(validationSamples)
          .values(
            sourceSamples.map((s) => ({
              assignmentVersionId: version.id,
              name: s.name,
              kind: s.kind,
              snapshotRef: s.snapshotRef,
              submissionSha: s.submissionSha,
              expected: s.expected,
              humanReviewedBy: s.humanReviewedBy,
              humanReviewedAt: s.humanReviewedAt,
            })),
          )
          .returning();
  return { version, samples };
}

/** 과제 목록 화면용 검증 요약 */
export interface VersionValidationSummary {
  samplesTotal: number;
  samplesReviewed: number;
  /** 실제 제출 수 (`is_sample`·삭제 제외) */
  submissionCount: number;
  bootstrapPendingReview: boolean;
}

export async function summarizeVersionValidation(
  db: Database,
  versions: ReadonlyArray<Pick<AssignmentVersionRow, "id" | "status" | "approvedBy">>,
): Promise<Map<string, VersionValidationSummary>> {
  const out = new Map<string, VersionValidationSummary>();
  if (versions.length === 0) return out;
  const ids = versions.map((v) => v.id);
  const [samples, counts] = await Promise.all([
    db
      .select({
        assignmentVersionId: validationSamples.assignmentVersionId,
        humanReviewedBy: validationSamples.humanReviewedBy,
      })
      .from(validationSamples)
      .where(inArray(validationSamples.assignmentVersionId, ids)),
    db
      .select({
        assignmentVersionId: submissions.assignmentVersionId,
        n: sql<number>`count(*)::int`,
      })
      .from(submissions)
      .where(
        and(
          inArray(submissions.assignmentVersionId, ids),
          eq(submissions.isSample, false),
          isNull(submissions.deletedAt),
        ),
      )
      .groupBy(submissions.assignmentVersionId),
  ]);
  const countByVersion = new Map(counts.map((c) => [c.assignmentVersionId, c.n]));
  for (const version of versions) {
    const own = samples.filter((s) => s.assignmentVersionId === version.id);
    out.set(version.id, {
      samplesTotal: own.length,
      samplesReviewed: own.filter((s) => s.humanReviewedBy?.trim()).length,
      submissionCount: countByVersion.get(version.id) ?? 0,
      bootstrapPendingReview: isBootstrapApprovalPendingReview(version, own),
    });
  }
  return out;
}
