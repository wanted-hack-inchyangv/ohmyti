import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CriterionResultSchema, type CriterionResult } from "./contracts";
import { RubricAreaSchema } from "./enums";
import { sampleRubric } from "./fixtures";
import { type Criterion, type Rubric } from "./rubric";
import {
  DuplicateDeductionError,
  ScoreAggregationError,
  UnknownSubCriterionError,
  aggregateScore,
  formatScoreDisplay,
} from "./score";

const EVIDENCE = ["ev-1"];

type ResultOverrides = Partial<Omit<CriterionResult, "criterionId">>;

function resultFor(
  rubric: Rubric,
  criterionId: string,
  overrides: ResultOverrides = {},
): CriterionResult {
  const criterion = rubric.criteria.find((c) => c.id === criterionId);
  if (!criterion) throw new Error(`fixture에 없는 기준: ${criterionId}`);
  const base: CriterionResult = {
    criterionId,
    rubricVersion: rubric.version,
    maxPoints: criterion.maxPoints,
    earnedPoints: criterion.maxPoints,
    verdict: "PASS",
    method: criterion.method,
    evidenceIds: [],
    observation: `${criterionId} 관측`,
    reviewState: "NOT_REQUIRED",
  };
  return CriterionResultSchema.parse({ ...base, ...overrides });
}

function pass(rubric: Rubric, id: string): CriterionResult {
  return resultFor(rubric, id);
}

function fail(rubric: Rubric, id: string, issueId?: string): CriterionResult {
  return resultFor(rubric, id, {
    earnedPoints: 0,
    verdict: "FAIL",
    evidenceIds: EVIDENCE,
    ...(issueId === undefined ? {} : { issueId }),
  });
}

function inconclusive(rubric: Rubric, id: string): CriterionResult {
  return resultFor(rubric, id, {
    earnedPoints: null,
    verdict: "INCONCLUSIVE",
    reviewState: "PENDING",
  });
}

function pendingReview(rubric: Rubric, id: string): CriterionResult {
  return resultFor(rubric, id, { earnedPoints: null, verdict: "PASS", reviewState: "PENDING" });
}

/** 부록 A 기대 결과표. 샘플 A: EXECUTION 전부 PASS, mutation 그룹 전부 KILLED, R-12 검토 대기. */
function sampleAResults(rubric: Rubric): CriterionResult[] {
  return rubric.criteria.map((c) =>
    c.method === "HUMAN_REVIEW" ? pendingReview(rubric, c.id) : pass(rubric, c.id),
  );
}

/** 샘플 C: R-05·R-06·R-07 FAIL(독립 사유 있음), G1 0점, G2 검토 대기, G3 5점, R-12 검토 대기. */
function sampleCResults(rubric: Rubric): CriterionResult[] {
  const failing = new Set(["R-05", "R-06", "R-07"]);
  return rubric.criteria.map((c) => {
    if (failing.has(c.id)) return fail(rubric, c.id, "missing-idempotency-store");
    if (c.id === "G1") return fail(rubric, c.id);
    if (c.id === "G2") return inconclusive(rubric, c.id);
    if (c.method === "HUMAN_REVIEW") return pendingReview(rubric, c.id);
    return pass(rubric, c.id);
  });
}

describe("formatScoreDisplay", () => {
  it("검토 대기가 없으면 N/100, 있으면 범위와 대기 배점을 표시한다 (부록 C)", () => {
    expect(formatScoreDisplay(87, 0, 100)).toBe("87/100");
    expect(formatScoreDisplay(54, 15, 100)).toBe("54~69/100 · 15점 검토 대기");
    expect(formatScoreDisplay(0, 100, 100)).toBe("0~100/100 · 100점 검토 대기");
  });
});

describe("aggregateScore: 부록 A 기대 결과표", () => {
  it("샘플 A는 90~100/100 · 10점 검토 대기 (R-12 대기)", () => {
    const rubric = sampleRubric();
    const summary = aggregateScore(sampleAResults(rubric), rubric);
    expect(summary.display).toBe("90~100/100 · 10점 검토 대기");
    expect(summary.pendingCriteria).toEqual([
      { criterionId: "R-12", area: "DESIGN", maxPoints: 10, reason: "REVIEW_PENDING" },
    ]);
  });

  it("샘플 C는 54~69/100 · 15점 검토 대기 (G2 INCONCLUSIVE + R-12 대기)", () => {
    const rubric = sampleRubric();
    const summary = aggregateScore(sampleCResults(rubric), rubric);
    expect(summary.display).toBe("54~69/100 · 15점 검토 대기");
    expect(summary.earned).toBe(54);
    expect(summary.pendingPoints).toBe(15);
    expect(summary.pendingCriteria.map((p) => [p.criterionId, p.reason])).toEqual([
      ["G2", "INCONCLUSIVE"],
      ["R-12", "REVIEW_PENDING"],
    ]);
  });

  it("2단계 시점(mutation 미구현)에는 결과가 없는 그룹 기준이 검토 대기로 누적된다", () => {
    const rubric = sampleRubric();
    const withoutMutation = (results: CriterionResult[]) =>
      results.filter((r) => r.method !== "MUTATION");
    expect(aggregateScore(withoutMutation(sampleAResults(rubric)), rubric).display).toBe(
      "75~100/100 · 25점 검토 대기",
    );
    const c = aggregateScore(withoutMutation(sampleCResults(rubric)), rubric);
    expect(c.display).toBe("49~74/100 · 25점 검토 대기");
    expect(
      c.pendingCriteria.filter((p) => p.reason === "NOT_EVALUATED").map((p) => p.criterionId),
    ).toEqual(["G1", "G2", "G3"]);
  });

  it("영역별 소계를 RubricArea 순서로 낸다", () => {
    const rubric = sampleRubric();
    const summary = aggregateScore(sampleCResults(rubric), rubric);
    expect(summary.byArea).toEqual([
      { area: "REQUIRED_FEATURES", earned: 20, min: 20, max: 20, pendingPoints: 0, total: 40 },
      { area: "EDGE_AND_FAILURE", earned: 19, min: 19, max: 19, pendingPoints: 0, total: 25 },
      { area: "TEST_EFFECTIVENESS", earned: 5, min: 5, max: 10, pendingPoints: 5, total: 15 },
      { area: "DESIGN", earned: 0, min: 0, max: 10, pendingPoints: 10, total: 10 },
      {
        area: "REPRODUCIBILITY_AND_DOCS",
        earned: 10,
        min: 10,
        max: 10,
        pendingPoints: 0,
        total: 10,
      },
    ]);
  });
});

describe("aggregateScore: 미확정 배점은 재환산하지 않는다 (G-04)", () => {
  /** 확정 50점: R-01 8 + R-02 6 + R-05 14 + R-06 6 + R-09 6 + R-10 6 + R-11 4 */
  const fiftyFixed = ["R-01", "R-02", "R-05", "R-06", "R-09", "R-10", "R-11"];

  it("50점 확정 + 50점 미확정은 50~100/100 · 50점 검토 대기이며 100/100이 되지 않는다", () => {
    const rubric = sampleRubric();
    const fixed = new Set(fiftyFixed);
    const nullPaths: Array<(id: string) => CriterionResult> = [
      (id) => inconclusive(rubric, id),
      (id) => pendingReview(rubric, id),
    ];
    for (const makePending of nullPaths) {
      const results = rubric.criteria.map((c) =>
        fixed.has(c.id) ? pass(rubric, c.id) : makePending(c.id),
      );
      const summary = aggregateScore(results, rubric);
      expect(summary.display).toBe("50~100/100 · 50점 검토 대기");
      expect(summary.earned).toBe(50);
      expect(summary.max).toBe(100);
      expect(summary.display).not.toBe("100/100");
    }
    // 결과 자체가 없는 경로
    const missing = rubric.criteria.filter((c) => fixed.has(c.id)).map((c) => pass(rubric, c.id));
    const summary = aggregateScore(missing, rubric);
    expect(summary.display).toBe("50~100/100 · 50점 검토 대기");
    expect(summary.pendingCriteria).toHaveLength(rubric.criteria.length - fixed.size);
  });

  it("빈 결과는 모든 배점이 검토 대기다", () => {
    const rubric = sampleRubric();
    const summary = aggregateScore([], rubric);
    expect(summary.display).toBe("0~100/100 · 100점 검토 대기");
    expect(summary.pendingCriteria.every((p) => p.reason === "NOT_EVALUATED")).toBe(true);
  });
});

describe("aggregateScore: PARTIAL은 rubric 하위 기준으로만 계산한다", () => {
  it("충족한 하위 기준 배점 합을 확정 점수로 쓴다", () => {
    const rubric = sampleRubric();
    const results = sampleAResults(rubric).map((r) =>
      r.criterionId === "R-12"
        ? resultFor(rubric, "R-12", {
            verdict: "PARTIAL",
            earnedPoints: 7,
            evidenceIds: EVIDENCE,
            reviewState: "CONFIRMED",
            satisfiedSubCriterionIds: ["R-12a", "R-12b"],
          })
        : r,
    );
    const summary = aggregateScore(results, rubric);
    expect(summary.display).toBe("97/100");
    expect(summary.pendingCriteria).toEqual([]);
  });

  it("rubric에 없는 하위 기준을 참조하면 예외다", () => {
    const rubric = sampleRubric();
    const results = [
      resultFor(rubric, "R-12", {
        verdict: "PARTIAL",
        earnedPoints: 4,
        evidenceIds: EVIDENCE,
        reviewState: "CONFIRMED",
        satisfiedSubCriterionIds: ["R-12a", "R-12z"],
      }),
    ];
    expect(() => aggregateScore(results, rubric)).toThrow(UnknownSubCriterionError);
    expect(() => aggregateScore(results, rubric)).toThrow(/R-12z/);
  });

  it("PARTIAL을 허용하지 않는 기준의 PARTIAL 결과는 예외다", () => {
    const rubric = sampleRubric();
    const results = [
      resultFor(rubric, "R-01", {
        verdict: "PARTIAL",
        earnedPoints: 4,
        evidenceIds: EVIDENCE,
        satisfiedSubCriterionIds: ["x"],
      }),
    ];
    expect(() => aggregateScore(results, rubric)).toThrowError(
      expect.objectContaining({ code: "PARTIAL_NOT_ALLOWED" }) as Error,
    );
  });

  it("결과의 earnedPoints가 하위 기준 합과 다르면 예외다", () => {
    const rubric = sampleRubric();
    const results = [
      resultFor(rubric, "R-12", {
        verdict: "PARTIAL",
        earnedPoints: 9,
        evidenceIds: EVIDENCE,
        reviewState: "CONFIRMED",
        satisfiedSubCriterionIds: ["R-12a"],
      }),
    ];
    expect(() => aggregateScore(results, rubric)).toThrowError(
      expect.objectContaining({ code: "PARTIAL_POINTS_MISMATCH" }) as Error,
    );
  });

  it("earnedPoints가 null인 PARTIAL은 검토 대기로 누적한다", () => {
    const rubric = sampleRubric();
    const results = [
      resultFor(rubric, "R-12", {
        verdict: "PARTIAL",
        earnedPoints: null,
        reviewState: "PENDING",
        satisfiedSubCriterionIds: ["R-12a"],
      }),
    ];
    const summary = aggregateScore(results, rubric);
    expect(summary.pendingCriteria.find((p) => p.criterionId === "R-12")?.reason).toBe(
      "REVIEW_PENDING",
    );
  });
});

describe("aggregateScore: 같은 결함의 중복 감점 (G-12)", () => {
  it("independentReason이 있는 기준 묶음은 각각 감점한다", () => {
    const rubric = sampleRubric();
    expect(() => aggregateScore(sampleCResults(rubric), rubric)).not.toThrow();
  });

  it("independentReason이 없으면 DuplicateDeductionError다", () => {
    const rubric = sampleRubric();
    const results = [fail(rubric, "R-01", "shared-bug"), fail(rubric, "R-02", "shared-bug")];
    expect(() => aggregateScore(results, rubric)).toThrow(DuplicateDeductionError);
    try {
      aggregateScore(results, rubric);
    } catch (error) {
      expect(error).toBeInstanceOf(ScoreAggregationError);
      const e = error as DuplicateDeductionError;
      expect(e.code).toBe("DUPLICATE_DEDUCTION");
      expect(e.issueId).toBe("shared-bug");
      expect(e.criterionIds).toEqual(["R-01", "R-02"]);
    }
  });

  it("independentReason이 일부 기준만 덮으면 예외다", () => {
    const rubric = sampleRubric();
    // R-05·R-06·R-07은 덮이지만 R-01은 아니다
    const results = [
      fail(rubric, "R-05", "shared-bug"),
      fail(rubric, "R-06", "shared-bug"),
      fail(rubric, "R-01", "shared-bug"),
    ];
    expect(() => aggregateScore(results, rubric)).toThrow(DuplicateDeductionError);
  });

  it("같은 issueId라도 만점이면 감점이 아니므로 예외가 아니다", () => {
    const rubric = sampleRubric();
    const results = [
      resultFor(rubric, "R-01", { issueId: "shared" }),
      resultFor(rubric, "R-02", { issueId: "shared" }),
    ];
    expect(() => aggregateScore(results, rubric)).not.toThrow();
  });
});

describe("aggregateScore: 입력 불일치", () => {
  it("rubric에 없는 기준, 중복 결과, 버전·배점 불일치는 예외다", () => {
    const rubric = sampleRubric();
    const codeOf = (results: CriterionResult[]) => {
      try {
        aggregateScore(results, rubric);
        return null;
      } catch (error) {
        return (error as ScoreAggregationError).code;
      }
    };
    expect(codeOf([{ ...pass(rubric, "R-01"), criterionId: "R-99" }])).toBe("UNKNOWN_CRITERION");
    expect(codeOf([pass(rubric, "R-01"), pass(rubric, "R-01")])).toBe("DUPLICATE_RESULT");
    expect(codeOf([{ ...pass(rubric, "R-01"), rubricVersion: "other" }])).toBe(
      "RUBRIC_VERSION_MISMATCH",
    );
    expect(codeOf([{ ...pass(rubric, "R-01"), maxPoints: 9, earnedPoints: 9 }])).toBe(
      "MAX_POINTS_MISMATCH",
    );
  });
});

/** 속성 테스트용 임의 rubric·결과 생성기. */
const criterionArb = (index: number): fc.Arbitrary<Criterion> =>
  fc
    .record({
      area: fc.constantFrom(...RubricAreaSchema.options),
      maxPoints: fc.integer({ min: 0, max: 30 }),
      allowPartial: fc.boolean(),
    })
    .map(({ area, maxPoints, allowPartial }) => ({
      id: `C-${index}`,
      area,
      title: `C-${index}`,
      maxPoints,
      method: allowPartial ? "HUMAN_REVIEW" : "EXECUTION",
      condition: "관측 조건",
      allowPartial,
    }));

const rubricArb: fc.Arbitrary<Rubric> = fc
  .integer({ min: 1, max: 12 })
  .chain((count) => fc.tuple(...Array.from({ length: count }, (_, i) => criterionArb(i))))
  .chain((criteria) =>
    fc
      .tuple(
        ...criteria.map((criterion) =>
          criterion.allowPartial
            ? fc
                .array(fc.integer({ min: 0, max: 10 }), { minLength: 1, maxLength: 4 })
                .map((points) => {
                  // 하위 배점 합이 maxPoints를 넘지 않게 자른다
                  let budget = criterion.maxPoints;
                  return points.map((p, i) => {
                    const clipped = Math.min(p, budget);
                    budget -= clipped;
                    return { id: `${criterion.id}-s${i}`, description: "하위", points: clipped };
                  });
                })
            : fc.constant(null),
        ),
      )
      .map((subs) => ({
        version: "prop-v1",
        criteria,
        groups: [],
        partialRules: criteria.flatMap((criterion, i) => {
          const sub = subs[i];
          return sub ? [{ criterionId: criterion.id, subCriteria: sub }] : [];
        }),
        independentReasons: [],
      })),
  );

type ResultKind = "PASS" | "FAIL" | "PARTIAL" | "INCONCLUSIVE" | "PENDING" | "MISSING";

function resultsArb(rubric: Rubric): fc.Arbitrary<CriterionResult[]> {
  return fc
    .tuple(
      ...rubric.criteria.map((criterion) =>
        fc.tuple(
          fc.constantFrom<ResultKind>(
            "PASS",
            "FAIL",
            "INCONCLUSIVE",
            "PENDING",
            "MISSING",
            ...(criterion.allowPartial ? (["PARTIAL"] as const) : []),
          ),
          fc.integer({ min: 0, max: criterion.maxPoints }),
          fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
        ),
      ),
    )
    .map((choices) =>
      choices.flatMap(([kind, points, mask], i) => {
        const criterion = rubric.criteria[i]!;
        // issueId는 기준마다 다르게 두어 중복 감점 규칙과 무관하게 만든다
        const issueId = `issue-${criterion.id}`;
        switch (kind) {
          case "MISSING":
            return [];
          case "PASS":
            return [pass(rubric, criterion.id)];
          case "FAIL":
            return [
              resultFor(rubric, criterion.id, {
                verdict: "FAIL",
                earnedPoints: points,
                evidenceIds: EVIDENCE,
                issueId,
              }),
            ];
          case "INCONCLUSIVE":
            return [inconclusive(rubric, criterion.id)];
          case "PENDING":
            return [pendingReview(rubric, criterion.id)];
          case "PARTIAL": {
            const rule = rubric.partialRules.find((r) => r.criterionId === criterion.id)!;
            const satisfied = rule.subCriteria.filter((_, j) => mask[j] ?? false);
            const earned = satisfied.reduce((sum, s) => sum + s.points, 0);
            return [
              resultFor(rubric, criterion.id, {
                verdict: "PARTIAL",
                earnedPoints: earned,
                evidenceIds: EVIDENCE,
                reviewState: "CONFIRMED",
                satisfiedSubCriterionIds: satisfied.map((s) => s.id),
              }),
            ];
          }
        }
      }),
    );
}

const inputArb = rubricArb.chain((rubric) =>
  resultsArb(rubric).map((results) => ({ rubric, results })),
);

describe("aggregateScore 속성 (fast-check)", () => {
  it("min + pendingPoints === max, earned === min, max <= total", () => {
    fc.assert(
      fc.property(inputArb, ({ rubric, results }) => {
        const s = aggregateScore(results, rubric);
        expect(s.min + s.pendingPoints).toBe(s.max);
        expect(s.earned).toBe(s.min);
        expect(s.max).toBeLessThanOrEqual(s.total);
        expect(s.earned).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it("영역별 소계 합 === 전체 (earned, pendingPoints, max, total)", () => {
    fc.assert(
      fc.property(inputArb, ({ rubric, results }) => {
        const s = aggregateScore(results, rubric);
        const sum = (key: "earned" | "pendingPoints" | "max" | "total") =>
          s.byArea.reduce((acc, area) => acc + area[key], 0);
        expect(sum("earned")).toBe(s.earned);
        expect(sum("pendingPoints")).toBe(s.pendingPoints);
        expect(sum("max")).toBe(s.max);
        expect(sum("total")).toBe(s.total);
        for (const area of s.byArea) expect(area.min + area.pendingPoints).toBe(area.max);
      }),
      { numRuns: 300 },
    );
  });

  it("미확정 배점이 있으면 표시에 범위와 검토 대기가 있고, 없으면 N/total이다", () => {
    fc.assert(
      fc.property(inputArb, ({ rubric, results }) => {
        const s = aggregateScore(results, rubric);
        // 배점 0인 기준도 미확정 목록에는 남으므로 목록의 배점 합으로 비교한다
        expect(s.pendingCriteria.reduce((acc, p) => acc + p.maxPoints, 0)).toBe(s.pendingPoints);
        if (s.pendingPoints === 0) {
          expect(s.display).toBe(`${s.earned}/${s.total}`);
        } else {
          expect(s.display).toBe(`${s.min}~${s.max}/${s.total} · ${s.pendingPoints}점 검토 대기`);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("결과 순서를 바꿔도 결과가 같다", () => {
    fc.assert(
      fc.property(inputArb, fc.infiniteStream(fc.nat()), ({ rubric, results }, seeds) => {
        const shuffled = [...results];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = seeds.next().value % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        expect(aggregateScore(shuffled, rubric)).toEqual(aggregateScore(results, rubric));
      }),
      { numRuns: 100 },
    );
  });
});
