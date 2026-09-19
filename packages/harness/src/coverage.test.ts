import { RubricSchema, type Rubric } from "@ohmyti/core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ORDER_API_V1_CASES } from "./cases";
import { checkCoverage } from "./coverage";
import { defineCase } from "./dsl";

const here = path.dirname(fileURLToPath(import.meta.url));
const rubric: Rubric = RubricSchema.parse(
  JSON.parse(readFileSync(path.join(here, "../../../samples/order-api/rubric.v1.json"), "utf8")),
);

const extra = defineCase({
  id: "x",
  title: "x",
  criterionIds: ["R-99", "R-12"],
  steps: [{ kind: "request", capture: "a", request: { method: "GET", path: "/health" } }],
  expect: [],
});

describe("checkCoverage", () => {
  it("rubric v1의 EXECUTION 기준 10개가 모두 커버된다", () => {
    const report = checkCoverage(ORDER_API_V1_CASES, rubric);
    expect(report.ok).toBe(true);
    expect(Object.keys(report.covered).sort()).toEqual([
      "R-01",
      "R-02",
      "R-03",
      "R-04",
      "R-05",
      "R-06",
      "R-07",
      "R-08",
      "R-09",
      "R-10",
    ]);
    expect(Object.values(report.covered).every((ids) => ids.length >= 1)).toBe(true);
  });

  it("케이스를 빼면 미커버 기준을 보고한다", () => {
    const report = checkCoverage(
      ORDER_API_V1_CASES.filter((c) => !c.criterionIds.includes("R-08")),
      rubric,
    );
    expect(report.ok).toBe(false);
    expect(report.uncovered).toEqual(["R-08"]);
  });

  it("rubric에 없는 기준과 EXECUTION이 아닌 기준 참조, 중복 ID를 보고한다", () => {
    const report = checkCoverage([...ORDER_API_V1_CASES, extra, extra], rubric);
    expect(report.ok).toBe(false);
    expect(report.unknownCriteria).toEqual([
      { caseId: "x", criterionId: "R-99" },
      { caseId: "x", criterionId: "R-99" },
    ]);
    expect(report.nonExecutionCriteria[0]).toEqual({
      caseId: "x",
      criterionId: "R-12",
      method: "HUMAN_REVIEW",
    });
    expect(report.duplicateCaseIds).toEqual(["x"]);
  });
});
