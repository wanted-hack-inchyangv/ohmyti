"use server";

/**
 * 채용 리포트 8절의 면접 스코어카드 서버 액션 (TICKET.md T-707). 규칙과 저장은 `service.ts`에 있고
 * 여기서는 DB 핸들만 붙인다. 성공하면 클라이언트가 `router.refresh()`로 리포트를 다시 그린다.
 */
import { getDb } from "@/lib/db";
import { saveScorecard, type ScorecardResult } from "./service";
import type { InterviewScorecard } from "@ohmyti/core";

export async function saveScorecardAction(
  evaluationId: string,
  input: unknown,
): Promise<ScorecardResult<{ saved: InterviewScorecard; scorecards: InterviewScorecard[] }>> {
  return saveScorecard({ db: getDb().db }, evaluationId, input);
}
