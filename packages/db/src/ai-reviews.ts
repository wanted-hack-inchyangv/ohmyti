import type { AiReviewKind, AiUsage } from "@ohmyti/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "./results";
import { aiReviews } from "./schema";

/**
 * LLM 호출 기록 (`ai_reviews`, TICKET.md 1.5). `@ohmyti/llm`의 RecordingLlmClient가 호출마다 한 행을 남긴다.
 * 실패한 호출도 과금되었을 수 있으므로 `output`에 `{ error }`를 담아 기록한다.
 */

export type AiReviewRow = typeof aiReviews.$inferSelect;

export interface NewAiReview {
  kind: AiReviewKind;
  evaluationId?: string;
  assignmentVersionId?: string;
  submissionId?: string;
  provider: string;
  model: string;
  promptVersion: string;
  inputDigest: string;
  /** JSON으로 표현 가능한 값. undefined는 넣지 않는다 */
  output: unknown;
  usage: AiUsage;
  costUsd: number;
}

/**
 * 한 행을 추가한다. evaluation에 속한 기록이면 `version`은 같은 evaluation·kind의 마지막 버전 + 1이다
 * (재생성은 새 버전으로 쌓이고 이전 행을 덮어쓰지 않는다, T-407). evaluation이 없는 기록(초안 등)은 1이다
 */
export async function insertAiReview(db: DbExecutor, row: NewAiReview): Promise<AiReviewRow> {
  const version = row.evaluationId
    ? sql<number>`(select coalesce(max(${aiReviews.version}), 0) + 1 from ${aiReviews} where ${aiReviews.evaluationId} = ${row.evaluationId} and ${aiReviews.kind} = ${row.kind})`
    : 1;
  const [inserted] = await db
    .insert(aiReviews)
    .values({
      version,
      kind: row.kind,
      evaluationId: row.evaluationId ?? null,
      assignmentVersionId: row.assignmentVersionId ?? null,
      submissionId: row.submissionId ?? null,
      provider: row.provider,
      model: row.model,
      promptVersion: row.promptVersion,
      inputDigest: row.inputDigest,
      output: row.output,
      usage: row.usage,
      costUsd: row.costUsd.toFixed(6),
    })
    .returning();
  if (!inserted) throw new Error("ai_reviews 행을 추가하지 못했습니다");
  return inserted;
}

export async function listAiReviews(
  db: DbExecutor,
  filter: { evaluationId: string; kind?: AiReviewKind },
): Promise<AiReviewRow[]> {
  return db
    .select()
    .from(aiReviews)
    .where(
      filter.kind
        ? and(eq(aiReviews.evaluationId, filter.evaluationId), eq(aiReviews.kind, filter.kind))
        : eq(aiReviews.evaluationId, filter.evaluationId),
    )
    .orderBy(asc(aiReviews.createdAt), asc(aiReviews.id));
}
