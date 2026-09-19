/**
 * 면접 스코어카드 저장·조회 (TICKET.md T-707, PRD 14.3의 8절). 서버 액션(`actions.ts`)과 채용 리포트 조립이 이 함수를 부른다.
 *
 * - 값은 모두 사람이 적은 것이다. 이 모듈은 값을 제안하지도 채우지도 않는다 (G-01, G-08).
 * - 평균·합산·등급을 만들지 않는다 (G-13, PRD 14.4). 여러 면접관의 기록은 그대로 나란히 돌려준다.
 * - 저장은 INSERT뿐이다. 같은 면접관이 다시 저장하면 이전 기록이 이력으로 남는다.
 * - 판정·점수 테이블은 읽지도 쓰지도 않는다. 스코어카드 유무로 과제 점수·판정·다이제스트가 달라지지 않는다.
 */
import { z } from "zod";
import {
  InterviewScorecardInputSchema,
  type InterviewScorecard,
  type InterviewScorecardInput,
} from "@ohmyti/core";
import {
  getEvaluation,
  insertInterviewScorecard,
  listInterviewScorecards,
  type Database,
} from "@ohmyti/db";

export interface ScorecardDeps {
  db: Database;
}

export type ScorecardErrorCode = "INVALID_INPUT" | "EVALUATION_NOT_FOUND" | "INTERNAL";

export type ScorecardResult<T> =
  { ok: true; data: T } | { ok: false; code: ScorecardErrorCode; message: string };

const EvaluationIdSchema = z.uuid("평가 ID 형식이 아닙니다");

function invalidInput(error: z.ZodError): ScorecardResult<never> {
  return {
    ok: false,
    code: "INVALID_INPUT",
    message: error.issues.map((i) => `${i.path.join(".") || "입력"}: ${i.message}`).join("; "),
  };
}

/** 저장된 스코어카드. 저장 순서대로이며 같은 면접관의 이전 기록도 이력으로 들어 있다 */
export async function readScorecards(
  deps: ScorecardDeps,
  evaluationId: string,
): Promise<ScorecardResult<InterviewScorecard[]>> {
  const parsed = EvaluationIdSchema.safeParse(evaluationId);
  if (!parsed.success) return invalidInput(parsed.error);
  return { ok: true, data: await listInterviewScorecards(deps.db, parsed.data) };
}

/**
 * 스코어카드 한 건을 저장한다. 수정도 같은 경로이며 새 행으로 남는다.
 * 돌려주는 값은 저장 뒤의 전체 목록이라 화면이 그대로 다시 그릴 수 있다.
 */
export async function saveScorecard(
  deps: ScorecardDeps,
  evaluationId: string,
  input: unknown,
): Promise<ScorecardResult<{ saved: InterviewScorecard; scorecards: InterviewScorecard[] }>> {
  const id = EvaluationIdSchema.safeParse(evaluationId);
  if (!id.success) return invalidInput(id.error);
  const parsed = InterviewScorecardInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);

  const evaluation = await getEvaluation(deps.db, id.data);
  if (!evaluation) {
    return { ok: false, code: "EVALUATION_NOT_FOUND", message: "평가를 찾을 수 없습니다" };
  }

  const value: InterviewScorecardInput = parsed.data;
  const row = await insertInterviewScorecard(deps.db, { evaluationId: id.data, ...value });
  const scorecards = await listInterviewScorecards(deps.db, id.data);
  const saved = scorecards.find((s) => s.id === row.id);
  if (!saved)
    return { ok: false, code: "INTERNAL", message: "저장한 스코어카드를 읽지 못했습니다" };
  return { ok: true, data: { saved, scorecards } };
}
