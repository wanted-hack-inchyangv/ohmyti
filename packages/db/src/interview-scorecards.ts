import {
  InterviewScorecardSchema,
  withScorecardRevisions,
  type InterviewScorecard,
  type InterviewScorecardInput,
} from "@ohmyti/core";
import { asc, eq } from "drizzle-orm";
import type { DbExecutor } from "./results";
import { interviewScorecards } from "./schema";
import { toIsoTimestamp } from "./timestamps";

/**
 * 면접 스코어카드 저장 (TICKET.md T-707). 이 파일은 스코어카드가 읽고 쓰는 DB 경계다.
 *
 * - 쓰기는 INSERT뿐이다. 수정은 새 행으로 남기며 이전 행을 지우거나 덮어쓰지 않는다(이력 보존).
 * - 평가·판정 테이블은 읽지도 쓰지도 않는다. 스코어카드 유무로 과제 점수·판정·다이제스트가 달라지지 않는다.
 */

export type InterviewScorecardRow = typeof interviewScorecards.$inferSelect;

/** 스코어카드 한 건을 넣는다. 같은 면접관의 이전 기록은 그대로 남는다 */
export async function insertInterviewScorecard(
  db: DbExecutor,
  input: { evaluationId: string } & InterviewScorecardInput,
): Promise<InterviewScorecardRow> {
  const [row] = await db
    .insert(interviewScorecards)
    .values({
      evaluationId: input.evaluationId,
      interviewer: input.interviewer,
      competencies: [...input.competencies],
      questionNotes: [...input.questionNotes],
      finalNote: input.finalNote,
    })
    .returning();
  if (!row) throw new Error("interview_scorecards insert가 행을 돌려주지 않았습니다");
  return row;
}

/** 평가의 스코어카드 전부. 저장 순서대로(오래된 것부터) */
export async function listInterviewScorecards(
  db: DbExecutor,
  evaluationId: string,
): Promise<InterviewScorecard[]> {
  const rows = await db
    .select()
    .from(interviewScorecards)
    .where(eq(interviewScorecards.evaluationId, evaluationId))
    .orderBy(asc(interviewScorecards.createdAt), asc(interviewScorecards.id));
  return withScorecardRevisions(
    rows.map((row) => ({
      id: row.id,
      evaluationId: row.evaluationId,
      interviewer: row.interviewer,
      competencies: row.competencies,
      questionNotes: row.questionNotes,
      finalNote: row.finalNote,
      createdAt: toIsoTimestamp(row.createdAt),
    })),
  ).map((row) => InterviewScorecardSchema.parse(row));
}
