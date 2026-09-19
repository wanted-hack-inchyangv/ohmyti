import {
  assertTransition,
  evaluateSubmissionDedupeKey,
  type EvaluateSubmissionPayload,
  type GitHubSources,
  type ResumeTextStatus,
  type SubmissionStatus,
} from "@ohmyti/core";
import { and, eq, isNull, or } from "drizzle-orm";
import type { SubmissionRow } from "./assignments";
import type { Database } from "./client";
import { enqueue, type EnqueueResult } from "./queue";
import { submissionContext, submissions } from "./schema";

/**
 * 제출 행 갱신 (TICKET.md T-202 REPO_CHECK 단계가 쓴다).
 *
 * - `pinSubmissionSnapshot`: 수집한 SHA·스냅샷 참조를 고정한다. 이미 다른 SHA가 고정돼 있으면 바꾸지 않고
 *   `SubmissionPinConflictError`다. 같은 SHA로 다시 호출하면 스냅샷 참조만 갱신한다 (재시도 멱등).
 * - `markSubmissionUnsupported`: 상태를 UNSUPPORTED로 바꾸고 사유(`<CODE>: <detail>`)를 남긴다 (G-09).
 * - `setSubmissionStatus`: 부록 B 전이(RECEIVED → QUEUED → RUNNING → …)를 조건 없이 기록한다.
 *   전이 검사는 오케스트레이터(T-204)가 `assertTransition`으로 한다.
 * - `enqueueSubmissionEvaluation`: web·워커 공용. 제출을 QUEUED로 바꾸고 `EVALUATE_SUBMISSION` job을 넣는다 (T-204).
 * - `upsertSubmissionContext`·`getSubmissionContext`: 이력서 ref·GitHub 로그인은 `submission_context`에만 둔다 (G-10, T-206).
 * - `setResumeText`: 이력서 텍스트와 상태(NONE·EXTRACTED·IMAGE_ONLY·MANUAL)를 기록한다 (T-501).
 * - `setGitHubSources`: GitHub 프로필 보충 조회 결과를 기록한다 (T-502).
 */

export class SubmissionPinConflictError extends Error {
  constructor(
    readonly submissionId: string,
    readonly pinnedSha: string,
    readonly requestedSha: string,
  ) {
    super(
      `제출 ${submissionId}는 이미 ${pinnedSha}로 고정되어 있어 ${requestedSha}로 바꿀 수 없습니다`,
    );
    this.name = "SubmissionPinConflictError";
  }
}

export async function getSubmission(db: Database, id: string): Promise<SubmissionRow | null> {
  const [row] = await db.select().from(submissions).where(eq(submissions.id, id));
  return row ?? null;
}

export interface PinSubmissionInput {
  submissionSha: string;
  snapshotRef: string;
}

/** SHA가 비어 있거나 같은 값일 때만 갱신한다. 한 번 고정된 SHA는 브랜치가 움직여도 바뀌지 않는다. */
export async function pinSubmissionSnapshot(
  db: Database,
  id: string,
  input: PinSubmissionInput,
): Promise<SubmissionRow> {
  const [row] = await db
    .update(submissions)
    .set({
      submissionSha: input.submissionSha,
      snapshotRef: input.snapshotRef,
    })
    .where(
      and(
        eq(submissions.id, id),
        or(isNull(submissions.submissionSha), eq(submissions.submissionSha, input.submissionSha)),
      ),
    )
    .returning();
  if (row) return row;

  const current = await getSubmission(db, id);
  if (!current) throw new Error(`제출을 찾을 수 없습니다: ${id}`);
  throw new SubmissionPinConflictError(id, current.submissionSha ?? "", input.submissionSha);
}

export async function markSubmissionUnsupported(
  db: Database,
  id: string,
  reason: string,
): Promise<SubmissionRow> {
  const [row] = await db
    .update(submissions)
    .set({ status: "UNSUPPORTED", unsupportedReason: reason })
    .where(eq(submissions.id, id))
    .returning();
  if (!row) throw new Error(`제출을 찾을 수 없습니다: ${id}`);
  return row;
}

export async function setSubmissionStatus(
  db: Database,
  id: string,
  status: SubmissionStatus,
): Promise<SubmissionRow> {
  const [row] = await db
    .update(submissions)
    .set({ status })
    .where(eq(submissions.id, id))
    .returning();
  if (!row) throw new Error(`제출을 찾을 수 없습니다: ${id}`);
  return row;
}

/**
 * `EVALUATE_SUBMISSION` job을 넣는다. 제출이 RECEIVED면 QUEUED로 바꾼다 (이미 QUEUED·RUNNING이면 그대로).
 * dedupeKey(`evaluateSubmissionDedupeKey`)로 같은 제출의 활성 job은 하나만 존재한다.
 */
export async function enqueueSubmissionEvaluation(
  db: Database,
  submissionId: string,
  options: { maxAttempts?: number | undefined } = {},
): Promise<EnqueueResult> {
  const submission = await getSubmission(db, submissionId);
  if (!submission) throw new Error(`제출을 찾을 수 없습니다: ${submissionId}`);
  if (submission.status === "RECEIVED") {
    assertTransition("submission", submission.status, "QUEUED");
    await setSubmissionStatus(db, submissionId, "QUEUED");
  }
  const payload: EvaluateSubmissionPayload = { submissionId };
  return enqueue(db, {
    type: "EVALUATE_SUBMISSION",
    payload,
    dedupeKey: evaluateSubmissionDedupeKey(submissionId),
    maxAttempts: options.maxAttempts,
  });
}

export type SubmissionContextRow = typeof submissionContext.$inferSelect;

export interface SubmissionContextInput {
  resumeRef?: string | null | undefined;
  githubLogin?: string | null | undefined;
}

/**
 * 지원자 맥락 행을 만들거나 갱신한다. 주지 않은 필드는 기존 값을 유지한다.
 * 채점 경로(`submissions`·`evaluations`)는 이 테이블을 읽지 않는다.
 */
export async function upsertSubmissionContext(
  db: Database,
  submissionId: string,
  input: SubmissionContextInput,
): Promise<SubmissionContextRow> {
  const updates = {
    ...(input.resumeRef !== undefined ? { resumeRef: input.resumeRef } : {}),
    ...(input.githubLogin !== undefined ? { githubLogin: input.githubLogin } : {}),
  };
  const [row] = await db
    .insert(submissionContext)
    .values({ submissionId, ...updates })
    .onConflictDoUpdate({
      // `$onUpdate`는 update()에만 적용되므로 upsert에서는 직접 갱신한다
      target: submissionContext.submissionId,
      set: { ...updates, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("submission_context upsert 실패");
  return row;
}

export async function getSubmissionContext(
  db: Database,
  submissionId: string,
): Promise<SubmissionContextRow | null> {
  const [row] = await db
    .select()
    .from(submissionContext)
    .where(eq(submissionContext.submissionId, submissionId));
  return row ?? null;
}

export interface ResumeTextUpdate {
  status: ResumeTextStatus;
  /** EXTRACTED·MANUAL일 때만 본문이 있다. 그 밖의 상태에서는 null로 지운다 */
  text: string | null;
  /** 추출하지 못한 사유. 본문을 담지 않는다 */
  reason: string | null;
}

/** 이력서 텍스트와 상태를 기록한다 (T-501). 맥락 행이 없으면 만든다 */
export async function setResumeText(
  db: Database,
  submissionId: string,
  update: ResumeTextUpdate,
): Promise<SubmissionContextRow> {
  const values = {
    resumeText: update.text,
    resumeTextStatus: update.status,
    resumeTextReason: update.reason,
  };
  const [row] = await db
    .insert(submissionContext)
    .values({ submissionId, ...values })
    .onConflictDoUpdate({
      target: submissionContext.submissionId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("submission_context 이력서 텍스트 기록 실패");
  return row;
}

/** GitHub 프로필 보충 조회 결과를 기록한다 (T-502). 맥락 행이 없으면 만든다 */
export async function setGitHubSources(
  db: Database,
  submissionId: string,
  sources: GitHubSources,
): Promise<SubmissionContextRow> {
  const [row] = await db
    .insert(submissionContext)
    .values({ submissionId, githubSources: sources })
    .onConflictDoUpdate({
      target: submissionContext.submissionId,
      set: { githubSources: sources, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("submission_context GitHub 근거 기록 실패");
  return row;
}
