import { describe, expect, it } from "vitest";
import { rubricToDraftOutput, sampleRubric, sampleRubricDraftOutput } from "./fixtures";
import { validateRubric } from "./rubric";
import {
  RubricDraftOutputSchema,
  draftRubricDedupeKey,
  rubricFromDraftOutput,
  type RubricDraftOutput,
} from "./rubric-draft";

describe("rubricFromDraftOutput (T-406)", () => {
  it("부록 A 초안 응답을 validateRubric을 통과하는 Rubric으로 옮긴다 (역변환과 왕복)", () => {
    const output = RubricDraftOutputSchema.parse(sampleRubricDraftOutput());
    const { rubric, droppedMutationIds } = rubricFromDraftOutput(output);
    expect(droppedMutationIds).toEqual([]);
    expect(validateRubric(rubric)).toEqual({ ok: true });
    const { version: _v, ...expected } = sampleRubric();
    const { version, ...actual } = rubric;
    expect(version).toBe("draft");
    expect(actual).toEqual(expected);
  });

  it("하위 기준이 있으면 PARTIAL을 허용하고 하위 기준의 maxPoints를 points로 옮긴다. 그룹이 null이면 groupId가 없다", () => {
    const { rubric } = rubricFromDraftOutput(sampleRubricDraftOutput());
    const r12 = rubric.criteria.find((c) => c.id === "R-12")!;
    expect(r12.allowPartial).toBe(true);
    expect(rubric.partialRules).toEqual([
      {
        criterionId: "R-12",
        subCriteria: [
          { id: "R-12a", description: "계층 분리", points: 4 },
          { id: "R-12b", description: "멱등성 저장소 추상화", points: 3 },
          { id: "R-12c", description: "변경 용이성", points: 3 },
        ],
      },
    ]);
    const r01 = rubric.criteria.find((c) => c.id === "R-01")!;
    expect(r01.allowPartial).toBe(false);
    expect("groupId" in r01).toBe(false);
    expect(rubric.criteria.find((c) => c.id === "G1")!.groupId).toBe("G1");
  });

  it("허용 목록 밖의 mutation ID는 버리고 알린다", () => {
    const output: RubricDraftOutput = {
      ...sampleRubricDraftOutput(),
      groups: [{ id: "G1", name: "경계", criterionIds: ["R-03"], mutationIds: ["M-01", "M-99"] }],
    };
    const { rubric, droppedMutationIds } = rubricFromDraftOutput(output, {
      allowedMutationIds: ["M-01", "M-02"],
    });
    expect(rubric.groups[0]!.mutationIds).toEqual(["M-01"]);
    expect(droppedMutationIds).toEqual(["M-99"]);
  });

  it("형식은 맞지만 규칙을 어긴 초안도 변환하고, 판정은 validateRubric이 한다", () => {
    const rubric = sampleRubric();
    rubric.criteria[0] = {
      ...rubric.criteria[0]!,
      maxPoints: 1,
      condition: "express 라우터로 구현",
    };
    const { rubric: converted } = rubricFromDraftOutput(rubricToDraftOutput(rubric));
    const result = validateRubric(converted);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.map((e) => e.code).sort()).toEqual([
      "FORBIDDEN_LIBRARY_TERM",
      "TOTAL_POINTS_MISMATCH",
    ]);
  });

  it("출력 스키마는 모르는 키와 형식이 틀린 ID를 거부한다", () => {
    const base = sampleRubricDraftOutput();
    expect(RubricDraftOutputSchema.safeParse({ ...base, score: 100 }).success).toBe(false);
    expect(
      RubricDraftOutputSchema.safeParse({
        ...base,
        criteria: [{ ...base.criteria[0]!, id: "R 01; drop" }],
      }).success,
    ).toBe(false);
  });

  it("dedupeKey는 초안마다 다르다", () => {
    expect(draftRubricDedupeKey("a")).toBe("DRAFT_RUBRIC:a");
  });
});
