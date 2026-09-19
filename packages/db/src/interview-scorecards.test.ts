import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEvaluation } from "./evaluations";
import { insertInterviewScorecard, listInterviewScorecards } from "./interview-scorecards";
import { evaluations, interviewScorecards, submissions } from "./schema";
import { seedEvaluation } from "./test-fixtures";
import { createTestDatabase, type TestDatabase } from "./testing";

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/db] DATABASE_URL_TEST가 없어 스코어카드 통합 테스트를 건너뜁니다");
}

function card(interviewer: string, value: 1 | 2 | 3 | 4, note: string) {
  return {
    interviewer,
    competencies: [
      { competency: "REQUIREMENTS" as const, value, note },
      { competency: "DEBUGGING" as const, value: null, note: null },
    ],
    questionNotes: [{ questionId: "FAILURE_DEBRIEF:R-06", number: 1, note: "재생 기록을 짚었다" }],
    finalNote: `${interviewer}의 최종 의견`,
  };
}

describe.skipIf(!hasTestDb)("interview_scorecards (통합, T-707)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
  });

  it("같은 면접관이 다시 저장하면 이전 값이 이력으로 남는다", async () => {
    const seed = await seedEvaluation(tdb.db);
    await insertInterviewScorecard(tdb.db, {
      evaluationId: seed.evaluationId,
      ...card("김면접", 2, "첫 기록"),
    });
    await insertInterviewScorecard(tdb.db, {
      evaluationId: seed.evaluationId,
      ...card("김면접", 4, "다시 적은 기록"),
    });

    const saved = await listInterviewScorecards(tdb.db, seed.evaluationId);
    expect(saved).toHaveLength(2);
    expect(saved.map((s) => [s.revision, s.latest])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(saved[0]!.competencies[0]!.value).toBe(2);
    expect(saved[0]!.competencies[0]!.note).toBe("첫 기록");
    expect(saved[1]!.competencies[0]!.value).toBe(4);
  });

  it("여러 면접관의 기록을 나란히 두고 합산하지 않는다", async () => {
    const seed = await seedEvaluation(tdb.db);
    await insertInterviewScorecard(tdb.db, {
      evaluationId: seed.evaluationId,
      ...card("김면접", 3, "가"),
    });
    await insertInterviewScorecard(tdb.db, {
      evaluationId: seed.evaluationId,
      ...card("박면접", 1, "나"),
    });
    const saved = await listInterviewScorecards(tdb.db, seed.evaluationId);
    expect(saved.map((s) => s.interviewer)).toEqual(["김면접", "박면접"]);
    expect(saved.every((s) => s.latest)).toBe(true);
  });

  it("UPDATE를 거부한다 (수정은 새 행으로만 남는다)", async () => {
    const seed = await seedEvaluation(tdb.db);
    const row = await insertInterviewScorecard(tdb.db, {
      evaluationId: seed.evaluationId,
      ...card("김면접", 2, "첫 기록"),
    });
    await expect(
      tdb.db
        .update(interviewScorecards)
        .set({ finalNote: "몰래 고침" })
        .where(eq(interviewScorecards.id, row.id)),
    ).rejects.toThrow();
    const [after] = await tdb.db
      .select({ finalNote: interviewScorecards.finalNote })
      .from(interviewScorecards)
      .where(eq(interviewScorecards.id, row.id));
    expect(after?.finalNote).toBe("김면접의 최종 의견");
  });

  it("스코어카드를 저장해도 평가 행의 점수·판정·다이제스트가 그대로다", async () => {
    const seed = await seedEvaluation(tdb.db);
    const before = await getEvaluation(tdb.db, seed.evaluationId);
    await insertInterviewScorecard(tdb.db, {
      evaluationId: seed.evaluationId,
      ...card("김면접", 4, "탁월"),
    });
    const after = await getEvaluation(tdb.db, seed.evaluationId);
    expect(after).toEqual(before);
  });

  it("평가를 지우면 스코어카드 행이 남지 않는다 (제출 삭제 cascade)", async () => {
    const seed = await seedEvaluation(tdb.db);
    await insertInterviewScorecard(tdb.db, {
      evaluationId: seed.evaluationId,
      ...card("김면접", 3, "기록"),
    });
    await tdb.db.delete(evaluations).where(eq(evaluations.id, seed.evaluationId));
    await tdb.db.delete(submissions).where(eq(submissions.id, seed.submissionId));
    expect(await listInterviewScorecards(tdb.db, seed.evaluationId)).toEqual([]);
  });
});
