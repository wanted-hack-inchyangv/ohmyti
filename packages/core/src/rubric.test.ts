import { describe, expect, it } from "vitest";
import { sampleRubric } from "./fixtures";
import { RubricSchema, validateRubric, type Rubric, type RubricValidationCode } from "./rubric";

function codesOf(rubric: Rubric): RubricValidationCode[] {
  const result = validateRubric(rubric);
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe("validateRubric", () => {
  it("부록 A 초안 기준은 스키마와 검증을 모두 통과한다", () => {
    const rubric = sampleRubric();
    expect(RubricSchema.safeParse(rubric).success).toBe(true);
    expect(validateRubric(rubric)).toEqual({ ok: true });
  });

  it("정적 검사(staticChecks)는 STATIC 기준에만 허용하고 부록 A 기준의 다이제스트 입력을 바꾸지 않는다 (T-405)", () => {
    const rubric = sampleRubric();
    const staticIndex = rubric.criteria.findIndex((c) => c.method === "STATIC");
    rubric.criteria[staticIndex] = {
      ...rubric.criteria[staticIndex]!,
      staticChecks: [{ kind: "DEPENDENCY_DECLARED", packageName: "express" }],
    };
    expect(RubricSchema.safeParse(rubric).success).toBe(true);
    expect(validateRubric(rubric)).toEqual({ ok: true });

    const wrong = sampleRubric();
    wrong.criteria[0] = {
      ...wrong.criteria[0]!,
      staticChecks: [{ kind: "DEPENDENCY_DECLARED", packageName: "express" }],
    };
    expect(codesOf(wrong)).toEqual(["STATIC_CHECK_NOT_STATIC"]);
    expect(
      RubricSchema.safeParse({
        ...rubric,
        criteria: [
          {
            ...rubric.criteria[staticIndex],
            staticChecks: [{ kind: "DEPENDENCY_DECLARED", packageName: "Not A Name" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect("staticChecks" in RubricSchema.parse(sampleRubric()).criteria[staticIndex]!).toBe(false);
  });

  it("배점 합계가 100이 아니면 거부한다", () => {
    const rubric = sampleRubric();
    rubric.criteria[0]!.maxPoints += 1;
    expect(codesOf(rubric)).toContain("TOTAL_POINTS_MISMATCH");
  });

  it("중복 기준 ID를 거부한다", () => {
    const rubric = sampleRubric();
    // 합계를 유지한 채 ID만 겹치게 한다
    rubric.criteria[1]!.id = "R-01";
    expect(codesOf(rubric)).toEqual(["DUPLICATE_CRITERION_ID"]);
  });

  it("하위 기준이 없는 PARTIAL을 거부한다", () => {
    const rubric = sampleRubric();
    rubric.partialRules = [];
    expect(codesOf(rubric)).toEqual(["PARTIAL_WITHOUT_SUB_CRITERIA"]);

    const empty = sampleRubric();
    empty.partialRules[0]!.subCriteria = [];
    expect(codesOf(empty)).toEqual(["PARTIAL_WITHOUT_SUB_CRITERIA"]);
  });

  it("하위 기준 배점 합이 maxPoints를 넘으면 거부한다", () => {
    const rubric = sampleRubric();
    rubric.partialRules[0]!.subCriteria[0]!.points = 20;
    expect(codesOf(rubric)).toEqual(["PARTIAL_POINTS_EXCEED_MAX"]);
  });

  it("PARTIAL을 허용하지 않는 기준에 규칙이 있으면 거부한다", () => {
    const rubric = sampleRubric();
    rubric.partialRules.push({
      criterionId: "R-01",
      subCriteria: [{ id: "x", description: "x", points: 1 }],
    });
    expect(codesOf(rubric)).toEqual(["PARTIAL_RULE_NOT_ALLOWED"]);
  });

  it("존재하지 않는 기준을 참조하는 그룹을 거부한다", () => {
    const rubric = sampleRubric();
    rubric.groups[0]!.criterionIds.push("R-99");
    expect(codesOf(rubric)).toEqual(["GROUP_UNKNOWN_CRITERION"]);
  });

  it("중복 그룹 ID와 존재하지 않는 그룹 참조를 거부한다", () => {
    const rubric = sampleRubric();
    rubric.groups[1]!.id = "G1";
    expect(codesOf(rubric)).toEqual(["DUPLICATE_GROUP_ID", "CRITERION_UNKNOWN_GROUP"]);
  });

  it("독립 감점 사유가 존재하지 않는 기준을 참조하면 거부한다", () => {
    const rubric = sampleRubric();
    rubric.independentReasons[0]!.criterionIds.push("R-99");
    expect(codesOf(rubric)).toEqual(["INDEPENDENT_REASON_UNKNOWN_CRITERION"]);
  });

  it("판정 조건에 라이브러리 이름이 있으면 거부한다", () => {
    const rubric = sampleRubric();
    rubric.criteria[0]!.condition = "Express 라우터로 POST /orders를 구현해야 한다";
    const result = validateRubric(rubric);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ code: "FORBIDDEN_LIBRARY_TERM", ref: "R-01" });
      expect(result.errors[0]!.message).toContain("express");
    }
  });

  it("라이브러리 이름이 다른 단어의 일부이면 오탐하지 않는다", () => {
    const rubric = sampleRubric();
    rubric.criteria[0]!.condition = "expression을 평가하고 koala 상품을 조회한다";
    expect(validateRubric(rubric)).toEqual({ ok: true });
  });

  it("여러 오류를 한 번에 모아 반환한다", () => {
    const rubric = sampleRubric();
    rubric.criteria[0]!.maxPoints += 1;
    rubric.groups[0]!.criterionIds.push("R-99");
    expect(codesOf(rubric)).toEqual(["TOTAL_POINTS_MISMATCH", "GROUP_UNKNOWN_CRITERION"]);
  });
});
