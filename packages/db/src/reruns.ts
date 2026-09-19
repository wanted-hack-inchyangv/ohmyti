import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { DbExecutor } from "./results";
import { criterionResults, jobs } from "./schema";
import type { JobRow } from "./queue";

/**
 * 재실행 (TICKET.md T-307) 조회·쓰기.
 *
 * - `listRerunJobs`: 평가 하나의 `RERUN_EXECUTION` job (payload의 `evaluationId`로 찾는다, 생성 순). CANCELLED는 제외한다.
 *   web은 이 목록으로 대기·실행·실패 상태와 횟수 상한을 보여 주고, 워커는 상한을 다시 확인한다.
 * - `appendCriterionResultEvidence`: 재실행 근거를 기준 판정의 `evidence_ids` 뒤에 붙인다. 점수·판정·observation은 건드리지 않는다
 *   (재실행은 새 기록일 뿐 판정을 바꾸지 않는다, G-03). `FOR UPDATE`로 잠가 사람 검토(T-306)의 갱신과 겹치지 않게 한다.
 */

export async function listRerunJobs(db: DbExecutor, evaluationId: string): Promise<JobRow[]> {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "RERUN_EXECUTION"),
        ne(jobs.status, "CANCELLED"),
        sql`${jobs.payload} ->> 'evaluationId' = ${evaluationId}`,
      ),
    )
    .orderBy(asc(jobs.createdAt), asc(jobs.id));
}

/** 잠근 뒤 `evidence_ids`에 없는 것만 뒤에 붙인다. 갱신한 판정 행 ID를 돌려준다 (없으면 빈 배열) */
export async function appendCriterionResultEvidence(
  db: DbExecutor,
  evaluationId: string,
  criterionIds: readonly string[],
  evidenceIds: readonly string[],
): Promise<string[]> {
  if (criterionIds.length === 0 || evidenceIds.length === 0) return [];
  const updated: string[] = [];
  for (const criterionId of criterionIds) {
    const [row] = await db
      .select({ id: criterionResults.id, evidenceIds: criterionResults.evidenceIds })
      .from(criterionResults)
      .where(
        and(
          eq(criterionResults.evaluationId, evaluationId),
          eq(criterionResults.criterionId, criterionId),
        ),
      )
      .for("update");
    if (!row) continue;
    const next = [...row.evidenceIds];
    for (const id of evidenceIds) if (!next.includes(id)) next.push(id);
    if (next.length === row.evidenceIds.length) continue;
    await db
      .update(criterionResults)
      .set({ evidenceIds: next, updatedAt: new Date() })
      .where(eq(criterionResults.id, row.id));
    updated.push(row.id);
  }
  return updated;
}
