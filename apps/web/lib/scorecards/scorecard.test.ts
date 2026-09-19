import {
  FORBIDDEN_REPORT_EXPRESSIONS,
  HiringReportSchema,
  InterviewScorecardInputSchema,
  findForbiddenReportExpressions,
  findJudgementKeys,
  withScorecardRevisions,
  type InterviewScorecard,
} from "@ohmyti/core";
import { createTestDatabase, seedEvaluation, type TestDatabase } from "@ohmyti/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reportFixture } from "@/lib/workbench/fixtures";
import { buildHiringReport } from "@/lib/reports/hiring-report";
import { hiringReportToMarkdown } from "@/lib/reports/hiring-report-markdown";
import { readScorecards, saveScorecard } from "./service";

/**
 * 면접 스코어카드 (TICKET.md T-707). 규칙 검사와 조립·Markdown 반영은 단위 테스트로,
 * 저장·이력·평가 불변은 DB 통합 테스트로 확인한다.
 */

const VALID_INPUT = {
  interviewer: "김면접",
  competencies: [
    { competency: "REQUIREMENTS", value: 3, note: " 요구사항 조건을 스스로 짚었다 " },
    { competency: "DEBUGGING", value: null, note: "" },
  ],
  questionNotes: [{ questionId: "FAILURE_DEBRIEF:R-06", number: 1, note: "재생 기록을 읽었다" }],
  finalNote: "동시성 조건을 한 번 더 확인하면 좋겠다",
};

function savedCard(overrides: Partial<InterviewScorecard> = {}): InterviewScorecard {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    evaluationId: "22222222-2222-4222-8222-222222222222",
    interviewer: "김면접",
    competencies: [{ competency: "REQUIREMENTS", value: 4, note: "조건을 스스로 짚었다" }],
    questionNotes: [{ questionId: "FAILURE_DEBRIEF:R-06", number: 1, note: "재생 기록을 읽었다" }],
    finalNote: "동시성 조건을 한 번 더 확인하면 좋겠다",
    revision: 1,
    latest: true,
    createdAt: "2026-09-20T01:00:00.000Z",
    ...overrides,
  };
}

describe("스코어카드 입력 규칙 (T-707)", () => {
  it("공백만 있는 메모는 적지 않은 것(null)으로 다룬다", () => {
    const parsed = InterviewScorecardInputSchema.parse(VALID_INPUT);
    expect(parsed.competencies[0]!.note).toBe("요구사항 조건을 스스로 짚었다");
    expect(parsed.competencies[1]!.note).toBeNull();
  });

  it("이름만 적고 아무것도 기입하지 않으면 거절한다", () => {
    const result = InterviewScorecardInputSchema.safeParse({
      interviewer: "김면접",
      competencies: [{ competency: "REQUIREMENTS", value: null, note: "" }],
      questionNotes: [],
      finalNote: "",
    });
    expect(result.success).toBe(false);
  });

  it("면접관 이름이 비면 거절한다", () => {
    const result = InterviewScorecardInputSchema.safeParse({ ...VALID_INPUT, interviewer: "  " });
    expect(result.success).toBe(false);
  });

  it("같은 역량을 두 번 적으면 거절한다", () => {
    const result = InterviewScorecardInputSchema.safeParse({
      ...VALID_INPUT,
      competencies: [
        { competency: "REQUIREMENTS", value: 3, note: "가" },
        { competency: "REQUIREMENTS", value: 4, note: "나" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("척도는 1~4 밖의 값을 받지 않는다", () => {
    const result = InterviewScorecardInputSchema.safeParse({
      ...VALID_INPUT,
      competencies: [{ competency: "REQUIREMENTS", value: 5, note: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("같은 면접관의 기록에 순번과 마지막 여부를 붙인다", () => {
    const rows = [
      { interviewer: "김면접", createdAt: "2026-09-20T01:00:00.000Z" },
      { interviewer: "박면접", createdAt: "2026-09-20T01:05:00.000Z" },
      { interviewer: "김면접", createdAt: "2026-09-20T02:00:00.000Z" },
    ];
    expect(withScorecardRevisions(rows).map((r) => [r.interviewer, r.revision, r.latest])).toEqual([
      ["김면접", 1, false],
      ["박면접", 1, true],
      ["김면접", 2, true],
    ]);
  });
});

describe("저장된 스코어카드가 리포트에 실린다 (T-707)", () => {
  const base = {
    report: reportFixture(),
    kit: null,
    contextLinks: null,
    designSignals: null,
    profile: null,
  };

  it("스코어카드가 없으면 8절의 저장 목록이 비어 있다", () => {
    const report = buildHiringReport(base);
    expect(HiringReportSchema.safeParse(report).success).toBe(true);
    expect(report.scorecard.saved).toEqual([]);
    expect(hiringReportToMarkdown(report)).toContain("저장된 스코어카드가 없습니다.");
  });

  it("저장된 스코어카드를 JSON과 Markdown에 그대로 싣는다", () => {
    const report = buildHiringReport({ ...base, scorecards: [savedCard()] });
    expect(HiringReportSchema.safeParse(report).success).toBe(true);
    expect(report.scorecard.saved).toHaveLength(1);
    const markdown = hiringReportToMarkdown(report);
    expect(markdown).toContain("#### 김면접");
    expect(markdown).toContain("요구사항 이해와 구현 정확성: 4 탁월 · 조건을 스스로 짚었다");
    expect(markdown).toContain("질문 Q1: 재생 기록을 읽었다");
    expect(markdown).toContain("최종 의견: 동시성 조건을 한 번 더 확인하면 좋겠다");
  });

  it("여러 면접관의 기록을 나란히 싣고 평균·합산을 만들지 않는다", () => {
    const report = buildHiringReport({
      ...base,
      scorecards: [
        savedCard({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", interviewer: "김면접" }),
        savedCard({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", interviewer: "박면접" }),
      ],
    });
    expect(report.scorecard.saved.map((s) => s.interviewer)).toEqual(["김면접", "박면접"]);
    // 판단 키(평균·등급·합계)가 스키마 어디에도 없다
    expect(findJudgementKeys(HiringReportSchema)).toEqual([]);
    expect(findForbiddenReportExpressions(hiringReportToMarkdown(report))).toEqual([]);
    expect(FORBIDDEN_REPORT_EXPRESSIONS.length).toBeGreaterThan(0);
  });

  it("스코어카드 유무로 과제 점수·판정·감사 정보가 달라지지 않는다", () => {
    const without = buildHiringReport(base);
    const withCards = buildHiringReport({ ...base, scorecards: [savedCard()] });
    expect(withCards.summary).toEqual(without.summary);
    expect(withCards.requirements).toEqual(without.requirements);
    expect(withCards.competencies).toEqual(without.competencies);
    expect(withCards.audit).toEqual(without.audit);
    expect({ ...withCards.scorecard, saved: [] }).toEqual(without.scorecard);
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/web] DATABASE_URL_TEST가 없어 스코어카드 통합 테스트를 건너뜁니다");
}

describe.skipIf(!hasTestDb)("스코어카드 저장 (통합, T-707)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
  });

  it("저장하고 다시 저장하면 이전 값이 이력으로 남는다", async () => {
    const seed = await seedEvaluation(tdb.db);
    const first = await saveScorecard({ db: tdb.db }, seed.evaluationId, VALID_INPUT);
    expect(first.ok).toBe(true);
    const second = await saveScorecard({ db: tdb.db }, seed.evaluationId, {
      ...VALID_INPUT,
      competencies: [{ competency: "REQUIREMENTS", value: 1, note: "다시 적었다" }],
    });
    expect(second.ok).toBe(true);

    const read = await readScorecards({ db: tdb.db }, seed.evaluationId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data).toHaveLength(2);
    expect(read.data[0]!.competencies[0]!.value).toBe(3);
    expect(read.data[0]!.latest).toBe(false);
    expect(read.data[1]!.competencies[0]!.value).toBe(1);
    expect(read.data[1]!.latest).toBe(true);
  });

  it("없는 평가에는 저장하지 않는다", async () => {
    const result = await saveScorecard(
      { db: tdb.db },
      "33333333-3333-4333-8333-333333333333",
      VALID_INPUT,
    );
    expect(result).toMatchObject({ ok: false, code: "EVALUATION_NOT_FOUND" });
  });

  it("평가 ID 형식이 아니거나 내용이 비면 거절한다", async () => {
    expect(await saveScorecard({ db: tdb.db }, "not-a-uuid", VALID_INPUT)).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    const seed = await seedEvaluation(tdb.db);
    expect(
      await saveScorecard({ db: tdb.db }, seed.evaluationId, {
        interviewer: "김면접",
        competencies: [],
        questionNotes: [],
        finalNote: "",
      }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});
