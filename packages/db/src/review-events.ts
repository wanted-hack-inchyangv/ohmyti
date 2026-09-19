import {
  ReviewEventSchema,
  type ReviewEvent,
  type ReviewEventKind,
  type ReviewSnapshot,
  type ReviewState,
  type Verdict,
} from "@ohmyti/core";
import { and, asc, eq } from "drizzle-orm";
import type { CriterionResultRow, DbExecutor } from "./results";
import { criterionResults, reviewEvents } from "./schema";
import { toIsoTimestamp } from "./timestamps";

/**
 * 사람이 점수를 수정한 이력 (`review_events`, PRD 9장). 기록은 T-306(사람 수정)이 남기고 리포트 API(T-207)가 읽는다.
 * 원래 값(`previous`)은 여기 남고 `criterion_results`가 현재 값을 갖는다 (부록 C).
 * 테이블은 쌓이기만 한다: UPDATE·직접 DELETE는 트리거 `review_events_append_only`가 거부한다.
 */

export type ReviewEventRow = typeof reviewEvents.$inferSelect;

export async function listReviewEvents(
  db: DbExecutor,
  evaluationId: string,
): Promise<ReviewEventRow[]> {
  return db
    .select()
    .from(reviewEvents)
    .where(eq(reviewEvents.evaluationId, evaluationId))
    .orderBy(asc(reviewEvents.createdAt), asc(reviewEvents.id));
}

export interface NewReviewEvent {
  evaluationId: string;
  criterionResultId: string;
  criterionId: string;
  kind: ReviewEventKind;
  reviewer: string;
  previous: ReviewSnapshot;
  next: ReviewSnapshot;
  reason: string;
}

export async function insertReviewEvent(
  db: DbExecutor,
  event: NewReviewEvent,
): Promise<ReviewEventRow> {
  const [row] = await db.insert(reviewEvents).values(event).returning();
  if (!row) throw new Error("review_events INSERT가 행을 돌려주지 않았습니다");
  return row;
}

/** 행 → core `ReviewEvent`. `previous`·`next` jsonb는 스키마로 검증한다 */
export function toReviewEvent(row: ReviewEventRow): ReviewEvent {
  return ReviewEventSchema.parse({
    id: row.id,
    evaluationId: row.evaluationId,
    criterionId: row.criterionId,
    kind: row.kind,
    reviewer: row.reviewer,
    previous: row.previous,
    next: row.next,
    reason: row.reason,
    createdAt: toIsoTimestamp(row.createdAt),
  });
}

/**
 * 검토 액션을 위해 판정 행을 잠그고 읽는다 (`FOR UPDATE`). 같은 기준에 동시에 두 액션이 오면 뒤의 것이 앞의 결과를 읽는다.
 * 트랜잭션 안에서 불러야 잠금이 의미가 있다.
 */
export async function lockCriterionResult(
  db: DbExecutor,
  evaluationId: string,
  criterionId: string,
): Promise<CriterionResultRow | null> {
  const [row] = await db
    .select()
    .from(criterionResults)
    .where(
      and(
        eq(criterionResults.evaluationId, evaluationId),
        eq(criterionResults.criterionId, criterionId),
      ),
    )
    .for("update");
  return row ?? null;
}

export interface CriterionReviewPatch {
  earnedPoints: number | null;
  verdict: Verdict;
  reviewState: ReviewState;
  /** PARTIAL이 아니면 null */
  satisfiedSubCriterionIds: string[] | null;
  /** 근거 ID 전체(기존 + 새로 연결한 것). 호출자가 잠근 행의 `evidenceIds`에 이어 붙인다 */
  evidenceIds: string[];
}

/** 사람 검토 결과를 판정 행에 쓴다. DB 제약(G-02·G-04)이 위반 값을 거부한다 */
export async function applyCriterionReview(
  db: DbExecutor,
  criterionResultId: string,
  patch: CriterionReviewPatch,
): Promise<CriterionResultRow> {
  const [row] = await db
    .update(criterionResults)
    .set({
      earnedPoints: patch.earnedPoints,
      verdict: patch.verdict,
      reviewState: patch.reviewState,
      satisfiedSubCriterionIds: patch.satisfiedSubCriterionIds,
      evidenceIds: patch.evidenceIds,
      updatedAt: new Date(),
    })
    .where(eq(criterionResults.id, criterionResultId))
    .returning();
  if (!row) throw new Error(`판정 행을 찾을 수 없습니다: ${criterionResultId}`);
  return row;
}
