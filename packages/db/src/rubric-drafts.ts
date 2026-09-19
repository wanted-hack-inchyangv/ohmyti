import {
  draftRubricDedupeKey,
  type DraftRubricPayload,
  type Rubric,
  type RubricDraftFailureCode,
  type RubricDraftView,
  type RubricValidationError,
} from "@ohmyti/core";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "./client";
import { enqueue, type EnqueueResult } from "./queue";
import { rubricDrafts } from "./schema";
import { toIsoTimestamp } from "./timestamps";

/**
 * AI 채점 기준 초안 요청 (TICKET.md T-406). web은 행 + `DRAFT_RUBRIC` job을 넣고 상태를 폴링하며,
 * 워커만 LLM을 호출해 결과를 채운다 (1.1·G-05). 상태 전이는 `QUEUED → RUNNING → SUCCEEDED | FAILED`이고
 * 끝난 행은 다시 바꾸지 않는다. job 재시도로 RUNNING 행을 다시 잡는 것은 허용한다.
 */

export type RubricDraftRow = typeof rubricDrafts.$inferSelect;

export interface CreateRubricDraftInput {
  assignmentId?: string | undefined;
  specRef: string;
  specDigest: string;
}

export async function createRubricDraftRequest(
  db: Database,
  input: CreateRubricDraftInput,
): Promise<{ draft: RubricDraftRow; job: EnqueueResult }> {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .insert(rubricDrafts)
      .values({
        assignmentId: input.assignmentId ?? null,
        specRef: input.specRef,
        specDigest: input.specDigest,
      })
      .returning();
    if (!draft) throw new Error("rubric_drafts insert가 행을 돌려주지 않았습니다");
    const payload: DraftRubricPayload = { rubricDraftId: draft.id };
    const job = await enqueue(tx, {
      type: "DRAFT_RUBRIC",
      payload,
      dedupeKey: draftRubricDedupeKey(draft.id),
      // LLM 출력 오류는 재시도로 나아지지 않고, 사람이 화면에서 기다리므로 한 번 더만 시도한다
      maxAttempts: 2,
    });
    return { draft, job };
  });
}

export async function getRubricDraft(db: Database, id: string): Promise<RubricDraftRow | null> {
  const [row] = await db.select().from(rubricDrafts).where(eq(rubricDrafts.id, id)).limit(1);
  return row ?? null;
}

/** QUEUED·RUNNING → RUNNING. 이미 끝난 행이면 null (중복 job이 결과를 덮어쓰지 않는다) */
export async function markRubricDraftRunning(
  db: Database,
  id: string,
): Promise<RubricDraftRow | null> {
  const [row] = await db
    .update(rubricDrafts)
    .set({ status: "RUNNING" })
    .where(and(eq(rubricDrafts.id, id), inArray(rubricDrafts.status, ["QUEUED", "RUNNING"])))
    .returning();
  return row ?? null;
}

export interface CompleteRubricDraftInput {
  id: string;
  rubric: Rubric;
  validationErrors: RubricValidationError[];
  notes: string[];
  droppedMutationIds: string[];
  aiReviewId: string | null;
  model: string;
  promptVersion: string;
  now?: Date | undefined;
}

export async function completeRubricDraft(
  db: Database,
  input: CompleteRubricDraftInput,
): Promise<RubricDraftRow | null> {
  const [row] = await db
    .update(rubricDrafts)
    .set({
      status: "SUCCEEDED",
      rubric: input.rubric,
      validationErrors: input.validationErrors,
      notes: input.notes,
      droppedMutationIds: input.droppedMutationIds,
      aiReviewId: input.aiReviewId,
      model: input.model,
      promptVersion: input.promptVersion,
      finishedAt: input.now ?? new Date(),
    })
    .where(and(eq(rubricDrafts.id, input.id), eq(rubricDrafts.status, "RUNNING")))
    .returning();
  return row ?? null;
}

export interface FailRubricDraftInput {
  id: string;
  code: RubricDraftFailureCode;
  message: string;
  aiReviewId?: string | null | undefined;
  model?: string | null | undefined;
  promptVersion?: string | null | undefined;
  now?: Date | undefined;
}

/** 아직 끝나지 않은 행을 FAILED로 닫는다 */
export async function failRubricDraft(
  db: Database,
  input: FailRubricDraftInput,
): Promise<RubricDraftRow | null> {
  const [row] = await db
    .update(rubricDrafts)
    .set({
      status: "FAILED",
      failureCode: input.code,
      failureMessage: input.message,
      aiReviewId: input.aiReviewId ?? null,
      model: input.model ?? null,
      promptVersion: input.promptVersion ?? null,
      finishedAt: input.now ?? new Date(),
    })
    .where(and(eq(rubricDrafts.id, input.id), inArray(rubricDrafts.status, ["QUEUED", "RUNNING"])))
    .returning();
  return row ?? null;
}

/** 화면 폴링용 표현 */
export function toRubricDraftView(row: RubricDraftRow): RubricDraftView {
  return {
    id: row.id,
    status: row.status,
    rubric: row.rubric ?? null,
    validationErrors: row.validationErrors ?? [],
    notes: row.notes ?? [],
    droppedMutationIds: row.droppedMutationIds ?? [],
    failure:
      row.failureCode && row.failureMessage
        ? { code: row.failureCode, message: row.failureMessage }
        : null,
    model: row.model,
    promptVersion: row.promptVersion,
    createdAt: toIsoTimestamp(row.createdAt),
    finishedAt: row.finishedAt ? toIsoTimestamp(row.finishedAt) : null,
  };
}
