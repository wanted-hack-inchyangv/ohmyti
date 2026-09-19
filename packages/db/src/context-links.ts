import {
  ContextLinkSchema,
  type ContextLink,
  type ContextQuestion,
  type ContextStatus,
  type Verdict,
} from "@ohmyti/core";
import { asc, eq } from "drizzle-orm";
import type { DbExecutor } from "./results";
import { contextLinks, criterionResults } from "./schema";
import { toIsoTimestamp } from "./timestamps";

/**
 * 맥락 연결 저장 (TICKET.md T-503). 이 파일은 맥락 연결 단계가 읽고 쓰는 DB 경계다.
 * 판정 행에서는 기준 ID·판정·관측 문장 세 열만 읽는다. 배점·획득 열과 평가 합계 열은 읽지 않는다
 * (정적 검사 `scripts/check-context-isolation.ts`가 이 파일도 검사한다).
 */

export type ContextLinkRow = typeof contextLinks.$inferSelect;

/** 과제 관측 한 줄: 기준 ID + 판정 + 관측 문장 */
export interface CriterionObservation {
  criterionId: string;
  verdict: Verdict;
  observation: string;
}

/** 평가의 기준별 관측. 기준 ID 순 */
export async function listCriterionObservations(
  db: DbExecutor,
  evaluationId: string,
): Promise<CriterionObservation[]> {
  return db
    .select({
      criterionId: criterionResults.criterionId,
      verdict: criterionResults.verdict,
      observation: criterionResults.observation,
    })
    .from(criterionResults)
    .where(eq(criterionResults.evaluationId, evaluationId))
    .orderBy(asc(criterionResults.criterionId));
}

export interface NewContextLink {
  claim: string;
  claimSource: "RESUME" | "SYSTEM";
  status: ContextStatus;
  githubEvidence?: Array<{ repo: string; url: string; summary: string }> | null;
  assignmentObservation?: { criterionId?: string; summary: string } | null;
  followUpQuestion?: string | null;
  /** 인터뷰 질문 구조 (T-703) */
  question?: ContextQuestion | null;
  aiReviewId?: string | null;
}

/**
 * 제출의 맥락 연결을 통째로 바꾼다. 한 트랜잭션에서 이전 행을 지우고 새 행을 넣는다.
 * 재시도·재평가에서 같은 제출의 연결이 섞이지 않는다. 행은 넣은 순서대로 `created_at`이 오른다.
 */
export async function replaceContextLinks(
  db: DbExecutor,
  input: { submissionId: string; evaluationId: string | null; links: NewContextLink[] },
): Promise<ContextLinkRow[]> {
  return db.transaction(async (tx) => {
    await tx.delete(contextLinks).where(eq(contextLinks.submissionId, input.submissionId));
    if (input.links.length === 0) return [];
    const base = Date.now();
    return tx
      .insert(contextLinks)
      .values(
        input.links.map((link, i) => ({
          submissionId: input.submissionId,
          evaluationId: input.evaluationId,
          claimSource: link.claimSource,
          claim: link.claim,
          status: link.status,
          githubEvidence: link.githubEvidence ?? null,
          assignmentObservation: link.assignmentObservation ?? null,
          followUpQuestion: link.followUpQuestion ?? null,
          question: link.question ?? null,
          aiReviewId: link.aiReviewId ?? null,
          // 같은 문장 안의 now()는 모두 같으므로 순서를 밀리초로 벌려 둔다
          createdAt: new Date(base + i),
        })),
      )
      .returning();
  });
}

/** 제출의 맥락 연결. 저장 순서대로 */
export async function listContextLinks(
  db: DbExecutor,
  submissionId: string,
): Promise<ContextLinkRow[]> {
  return db
    .select()
    .from(contextLinks)
    .where(eq(contextLinks.submissionId, submissionId))
    .orderBy(asc(contextLinks.createdAt), asc(contextLinks.id));
}

/** 행 → core 엔터티 (스키마 검증 포함) */
export function toContextLink(row: ContextLinkRow): ContextLink {
  return ContextLinkSchema.parse({
    id: row.id,
    submissionId: row.submissionId,
    evaluationId: row.evaluationId,
    claim: row.claim,
    claimSource: row.claimSource,
    status: row.status,
    ...(row.githubEvidence ? { githubEvidence: row.githubEvidence } : {}),
    ...(row.assignmentObservation ? { assignmentObservation: row.assignmentObservation } : {}),
    ...(row.followUpQuestion ? { followUpQuestion: row.followUpQuestion } : {}),
    ...(row.question ? { question: row.question } : {}),
    ...(row.aiReviewId ? { aiReviewId: row.aiReviewId } : {}),
    createdAt: toIsoTimestamp(row.createdAt),
  });
}
