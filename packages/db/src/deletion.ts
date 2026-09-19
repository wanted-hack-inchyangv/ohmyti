import {
  assertTransition,
  DELETE_SUBMISSION_MAX_ATTEMPTS,
  deleteSubmissionDedupeKey,
  type DeleteSubmissionPayload,
} from "@ohmyti/core";
import { and, desc, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Database } from "./client";
import { CANCEL_SET, enqueue } from "./queue";
import type { DbExecutor } from "./results";
import {
  aiReviews,
  contextLinks,
  criterionResults,
  deletionLog,
  evaluations,
  evidences,
  executionRecords,
  interviewScorecards,
  jobs,
  mutationExperiments,
  reviewEvents,
  submissionContext,
  submissions,
} from "./schema";

/**
 * 제출 삭제 cascade (TICKET.md T-506).
 *
 * 1. `requestSubmissionDeletion`(web): 한 트랜잭션에서 제출을 DELETED로 바꾸고 `deleted_at`을 찍고, 이 제출의
 *    진행 중 job(평가·재실행)을 CANCELLED로 바꾼 뒤 `DELETE_SUBMISSION` job을 넣는다. 취소를 요청 시점에 하는 이유는
 *    워커 동시 실행 수가 1이면 삭제 job이 실행 중인 평가 job 뒤에서 기다리기 때문이다.
 * 2. 워커의 삭제 핸들러: 취소된 job을 실행하던 워커가 러너를 정리하고 빠져나오기를 기다린다
 *    (`listUnacknowledgedCancelledJobs`가 빌 때까지) → 아티팩트 접두사를 지운다 → `deleteSubmissionRows`.
 * 3. `deleteSubmissionRows`: 한 트랜잭션에서 관련 행을 지우고 `deletion_log`에 행 수와 지운 아티팩트를 남긴다.
 *    `execution_records`는 SQL 함수 `delete_submission_execution_records`(마이그레이션 0016)로만 지운다 (G-03).
 * 4. `findSubmissionDeletion`: 삭제된 제출 URL이 404와 "삭제됨"을 보일 근거 (삭제 중이면 PENDING).
 */

export interface DeletionCounts {
  jobs: number;
  contextLinks: number;
  interviewScorecards: number;
  aiReviews: number;
  mutationExperiments: number;
  evidences: number;
  reviewEvents: number;
  criterionResults: number;
  executionRecords: number;
  evaluations: number;
  submissionContext: number;
  submissions: number;
}

export interface DeletionArtifacts {
  /** 통째로 지운 접두사 (`submissions/<id>/`, `evaluations/<id>/`) */
  prefixes: string[];
  /** 지운 객체 수 */
  deletedObjects: number;
  /** 행이 참조했지만 이 제출의 접두사 밖이라 지우지 않은 공유 아티팩트 (샘플 스냅샷 등) */
  keptSharedRefs: string[];
}

/** `deletion_log.removed`에 남기는 내용 */
export interface DeletionRemoved {
  counts: DeletionCounts;
  artifacts: DeletionArtifacts;
  evaluationIds: string[];
  /** 삭제 요청으로 CANCELLED가 된 job */
  cancelledJobIds: string[];
}

export type RequestDeletionResult =
  | { kind: "REQUESTED"; jobId: string; cancelledJobIds: string[] }
  | { kind: "ALREADY_REQUESTED"; jobId: string }
  | { kind: "ALREADY_DELETED"; deletedAt: Date }
  | { kind: "NOT_FOUND" };

/** 이 제출을 대상으로 하는 job (삭제 job 자신은 뺀다). payload의 `submissionId` 또는 이 제출 평가의 `evaluationId` */
function relatedJobs(submissionId: string): SQL {
  return sql`${jobs.type} <> 'DELETE_SUBMISSION' AND (
    ${jobs.payload}->>'submissionId' = ${submissionId}
    OR ${jobs.payload}->>'evaluationId' IN (
      SELECT ${evaluations.id}::text FROM ${evaluations} WHERE ${evaluations.submissionId} = ${submissionId}
    )
  )`;
}

/** 이 제출의 QUEUED·RUNNING job을 CANCELLED로 바꾸고 id를 돌려준다 (`cancelJob`과 같은 규칙) */
export async function cancelSubmissionJobs(
  db: DbExecutor,
  submissionId: string,
): Promise<string[]> {
  const rows = await db
    .update(jobs)
    .set(CANCEL_SET)
    .where(and(sql`${jobs.status} IN ('QUEUED', 'RUNNING')`, relatedJobs(submissionId)))
    .returning({ id: jobs.id });
  return rows.map((r) => r.id);
}

export interface UnacknowledgedJob {
  id: string;
  lockedBy: string;
  /** 취소 시각 (마지막 갱신) */
  updatedAt: Date;
}

/** 취소됐지만 실행하던 워커가 아직 빠져나왔다고 알리지 않은 job */
export async function listUnacknowledgedCancelledJobs(
  db: Database,
  submissionId: string,
): Promise<UnacknowledgedJob[]> {
  const rows = await db
    .select({ id: jobs.id, lockedBy: jobs.lockedBy, updatedAt: jobs.updatedAt })
    .from(jobs)
    .where(and(eq(jobs.status, "CANCELLED"), isNotNull(jobs.lockedBy), relatedJobs(submissionId)));
  return rows.map((r) => ({ id: r.id, lockedBy: r.lockedBy ?? "", updatedAt: r.updatedAt }));
}

export interface RequestDeletionInput {
  submissionId: string;
  /** 모달에서 입력한 검토자 이름 */
  requestedBy: string;
}

/** 삭제 요청. 이미 요청된 제출이면 삭제 job만 다시 넣는다(앞선 job이 실패했을 때의 복구 경로) */
export async function requestSubmissionDeletion(
  db: Database,
  input: RequestDeletionInput,
): Promise<RequestDeletionResult> {
  const requestedBy = input.requestedBy.trim();
  if (requestedBy === "") throw new Error("삭제를 요청한 검토자 이름이 필요합니다");
  return db.transaction(async (tx) => {
    const [submission] = await tx
      .select({
        id: submissions.id,
        status: submissions.status,
        deletedAt: submissions.deletedAt,
      })
      .from(submissions)
      .where(eq(submissions.id, input.submissionId))
      .for("update");
    if (!submission) {
      const log = await latestDeletionLog(tx, input.submissionId);
      return log ? { kind: "ALREADY_DELETED", deletedAt: log.deletedAt } : { kind: "NOT_FOUND" };
    }
    const payload: DeleteSubmissionPayload = { submissionId: submission.id, requestedBy };
    const enqueueDelete = () =>
      enqueue(tx, {
        type: "DELETE_SUBMISSION",
        payload,
        dedupeKey: deleteSubmissionDedupeKey(submission.id),
        maxAttempts: DELETE_SUBMISSION_MAX_ATTEMPTS,
      });
    if (submission.deletedAt) {
      const job = await enqueueDelete();
      return { kind: "ALREADY_REQUESTED", jobId: job.id };
    }
    if (submission.status !== "DELETED")
      assertTransition("submission", submission.status, "DELETED");
    await tx
      .update(submissions)
      .set({ status: "DELETED", deletedAt: sql`now()` })
      .where(eq(submissions.id, submission.id));
    const cancelledJobIds = await cancelSubmissionJobs(tx, submission.id);
    const job = await enqueueDelete();
    return { kind: "REQUESTED", jobId: job.id, cancelledJobIds };
  });
}

export interface SubmissionArtifactScope {
  evaluationIds: string[];
  /** 행이 참조하는 아티팩트 키 전부 (접두사 안팎을 가리지 않는다) */
  referencedRefs: string[];
}

/** 삭제 전에 지울 아티팩트 범위를 읽는다. 제출 행이 없으면 null */
export async function readSubmissionArtifactScope(
  db: Database,
  submissionId: string,
): Promise<SubmissionArtifactScope | null> {
  const [submission] = await db
    .select({ snapshotRef: submissions.snapshotRef })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  if (!submission) return null;
  const evaluationIds = (
    await db
      .select({ id: evaluations.id })
      .from(evaluations)
      .where(eq(evaluations.submissionId, submissionId))
  ).map((r) => r.id);
  const refs = new Set<string>();
  if (submission.snapshotRef) refs.add(submission.snapshotRef);
  const [context] = await db
    .select({ resumeRef: submissionContext.resumeRef })
    .from(submissionContext)
    .where(eq(submissionContext.submissionId, submissionId));
  if (context?.resumeRef) refs.add(context.resumeRef);
  if (evaluationIds.length > 0) {
    const records = await db
      .select({
        inputRef: executionRecords.inputRef,
        expectedRef: executionRecords.expectedRef,
        actualRef: executionRecords.actualRef,
      })
      .from(executionRecords)
      .where(inArray(executionRecords.evaluationId, evaluationIds));
    for (const r of records) {
      refs.add(r.inputRef);
      refs.add(r.expectedRef);
      refs.add(r.actualRef);
    }
    const evidenceRows = await db
      .select({ artifactRefs: evidences.artifactRefs })
      .from(evidences)
      .where(inArray(evidences.evaluationId, evaluationIds));
    for (const e of evidenceRows) for (const ref of e.artifactRefs) refs.add(ref);
    const patches = await db
      .select({ patchRef: mutationExperiments.patchRef })
      .from(mutationExperiments)
      .where(inArray(mutationExperiments.evaluationId, evaluationIds));
    for (const p of patches) if (p.patchRef) refs.add(p.patchRef);
  }
  refs.delete("");
  return { evaluationIds, referencedRefs: [...refs].sort() };
}

export class SubmissionNotMarkedForDeletionError extends Error {
  override readonly name = "SubmissionNotMarkedForDeletionError";
  constructor(submissionId: string) {
    super(`제출 ${submissionId}는 삭제 요청(deleted_at)이 없어 지울 수 없습니다`);
  }
}

export interface DeleteRowsInput {
  submissionId: string;
  requestedBy: string;
  artifacts: DeletionArtifacts;
  cancelledJobIds: string[];
}

export type DeleteRowsResult =
  | { kind: "DELETED"; logId: string; removed: DeletionRemoved }
  | { kind: "ALREADY_DELETED"; logId: string };

/**
 * 관련 행을 한 트랜잭션에서 지우고 `deletion_log`를 남긴다. 삭제 요청이 없는 제출이면
 * `SubmissionNotMarkedForDeletionError`. 이미 지워져 로그만 있으면 그 로그를 돌려준다(재시도 멱등).
 */
export async function deleteSubmissionRows(
  db: Database,
  input: DeleteRowsInput,
): Promise<DeleteRowsResult> {
  const { submissionId } = input;
  return db.transaction(async (tx) => {
    const [submission] = await tx
      .select({ id: submissions.id, deletedAt: submissions.deletedAt })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .for("update");
    if (!submission) {
      const log = await latestDeletionLog(tx, submissionId);
      if (log) return { kind: "ALREADY_DELETED", logId: log.id };
      throw new Error(`제출을 찾을 수 없고 삭제 기록도 없습니다: ${submissionId}`);
    }
    if (!submission.deletedAt) throw new SubmissionNotMarkedForDeletionError(submissionId);

    // 핸들러가 기다리는 사이에 새로 들어온 job이 있으면 여기서도 취소한다. 로그에는 삭제 요청 이후
    // 취소된 job 전체(web이 요청 시점에 취소한 것 포함)를 남긴다
    await cancelSubmissionJobs(tx, submissionId);
    const cancelled = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, "CANCELLED"), relatedJobs(submissionId)));
    const evaluationIds = (
      await tx
        .select({ id: evaluations.id })
        .from(evaluations)
        .where(eq(evaluations.submissionId, submissionId))
    ).map((r) => r.id);
    const byEvaluation = (table: { evaluationId: PgColumn }) =>
      evaluationIds.length > 0 ? inArray(table.evaluationId, evaluationIds) : sql`false`;

    const count = async (query: Promise<unknown[]>) => (await query).length;
    const counts: DeletionCounts = {
      jobs: await count(
        tx
          .delete(jobs)
          .where(and(sql`${jobs.status} NOT IN ('QUEUED', 'RUNNING')`, relatedJobs(submissionId)))
          .returning({ id: jobs.id }),
      ),
      contextLinks: await count(
        tx
          .delete(contextLinks)
          .where(or(eq(contextLinks.submissionId, submissionId), byEvaluation(contextLinks)))
          .returning({ id: contextLinks.id }),
      ),
      interviewScorecards: await count(
        tx
          .delete(interviewScorecards)
          .where(byEvaluation(interviewScorecards))
          .returning({ id: interviewScorecards.id }),
      ),
      aiReviews: await count(
        tx
          .delete(aiReviews)
          .where(or(eq(aiReviews.submissionId, submissionId), byEvaluation(aiReviews)))
          .returning({ id: aiReviews.id }),
      ),
      mutationExperiments: await count(
        tx
          .delete(mutationExperiments)
          .where(byEvaluation(mutationExperiments))
          .returning({ id: mutationExperiments.id }),
      ),
      evidences: await count(
        tx.delete(evidences).where(byEvaluation(evidences)).returning({ id: evidences.id }),
      ),
      // review_events는 append-only 트리거가 직접 DELETE를 막는다. criterion_results·evaluations의 cascade로 지워진다
      reviewEvents: await count(
        tx.select({ id: reviewEvents.id }).from(reviewEvents).where(byEvaluation(reviewEvents)),
      ),
      criterionResults: await count(
        tx
          .delete(criterionResults)
          .where(byEvaluation(criterionResults))
          .returning({ id: criterionResults.id }),
      ),
      executionRecords: await deleteExecutionRecords(tx, submissionId),
      evaluations: await count(
        tx
          .delete(evaluations)
          .where(eq(evaluations.submissionId, submissionId))
          .returning({ id: evaluations.id }),
      ),
      submissionContext: await count(
        tx
          .delete(submissionContext)
          .where(eq(submissionContext.submissionId, submissionId))
          .returning({ id: submissionContext.submissionId }),
      ),
      submissions: await count(
        tx
          .delete(submissions)
          .where(eq(submissions.id, submissionId))
          .returning({ id: submissions.id }),
      ),
    };

    const removed: DeletionRemoved = {
      counts,
      artifacts: input.artifacts,
      evaluationIds,
      cancelledJobIds: [...new Set([...input.cancelledJobIds, ...cancelled.map((j) => j.id)])],
    };
    const [log] = await tx
      .insert(deletionLog)
      .values({ submissionId, requestedBy: input.requestedBy, removed })
      .returning({ id: deletionLog.id });
    if (!log) throw new Error("deletion_log insert가 행을 돌려주지 않았습니다");
    return { kind: "DELETED", logId: log.id, removed };
  });
}

/** 삭제 전용 SQL 함수로만 실행 기록을 지운다. 애플리케이션 코드는 트리거 통로(GUC)를 직접 열지 않는다 */
async function deleteExecutionRecords(tx: DbExecutor, submissionId: string): Promise<number> {
  const rows = await tx.execute<{ deleted: number }>(
    sql`SELECT public.delete_submission_execution_records(${submissionId}::uuid) AS deleted`,
  );
  return Number(rows[0]?.deleted ?? 0);
}

export type DeletionLogRow = typeof deletionLog.$inferSelect;

async function latestDeletionLog(
  db: DbExecutor,
  submissionId: string,
): Promise<DeletionLogRow | null> {
  const [row] = await db
    .select()
    .from(deletionLog)
    .where(eq(deletionLog.submissionId, submissionId))
    .orderBy(desc(deletionLog.deletedAt))
    .limit(1);
  return row ?? null;
}

export async function getDeletionLog(
  db: Database,
  submissionId: string,
): Promise<DeletionLogRow | null> {
  return latestDeletionLog(db, submissionId);
}

export type SubmissionDeletion =
  { state: "PENDING"; requestedAt: Date } | { state: "DONE"; deletedAt: Date };

/** 삭제 요청됐거나(`PENDING`) 삭제가 끝난(`DONE`) 제출이면 그 상태, 아니면 null */
export async function findSubmissionDeletion(
  db: Database,
  submissionId: string,
): Promise<SubmissionDeletion | null> {
  const [submission] = await db
    .select({ deletedAt: submissions.deletedAt })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  if (submission) {
    return submission.deletedAt ? { state: "PENDING", requestedAt: submission.deletedAt } : null;
  }
  const log = await latestDeletionLog(db, submissionId);
  return log ? { state: "DONE", deletedAt: log.deletedAt } : null;
}
