/**
 * 케이스 ↔ rubric 커버리지 검사 (T-107 인수 기준).
 * 각 케이스는 최소 1개 기준을 참조하고(스키마가 보장), 참조한 기준은 rubric에 있는 EXECUTION 기준이어야 하며,
 * rubric의 모든 EXECUTION 기준은 최소 1개 케이스에 커버되어야 한다.
 */
import type { Rubric } from "@ohmyti/core";
import type { CaseDefinition } from "./dsl";

export interface CoverageReport {
  ok: boolean;
  /** 기준 ID → 커버하는 케이스 ID */
  covered: Record<string, string[]>;
  /** 케이스가 없는 EXECUTION 기준 */
  uncovered: string[];
  /** rubric에 없는 기준을 참조한 케이스 */
  unknownCriteria: Array<{ caseId: string; criterionId: string }>;
  /** EXECUTION이 아닌 기준을 참조한 케이스 */
  nonExecutionCriteria: Array<{ caseId: string; criterionId: string; method: string }>;
  duplicateCaseIds: string[];
}

export function checkCoverage(cases: readonly CaseDefinition[], rubric: Rubric): CoverageReport {
  const byId = new Map(rubric.criteria.map((c) => [c.id, c]));
  const covered: Record<string, string[]> = {};
  for (const criterion of rubric.criteria) {
    if (criterion.method === "EXECUTION") covered[criterion.id] = [];
  }
  const unknownCriteria: CoverageReport["unknownCriteria"] = [];
  const nonExecutionCriteria: CoverageReport["nonExecutionCriteria"] = [];
  const seen = new Set<string>();
  const duplicateCaseIds: string[] = [];

  for (const c of cases) {
    if (seen.has(c.id)) duplicateCaseIds.push(c.id);
    seen.add(c.id);
    for (const criterionId of c.criterionIds) {
      const criterion = byId.get(criterionId);
      if (!criterion) {
        unknownCriteria.push({ caseId: c.id, criterionId });
      } else if (criterion.method !== "EXECUTION") {
        nonExecutionCriteria.push({ caseId: c.id, criterionId, method: criterion.method });
      } else {
        covered[criterionId]!.push(c.id);
      }
    }
  }

  const uncovered = Object.entries(covered)
    .filter(([, caseIds]) => caseIds.length === 0)
    .map(([id]) => id);
  return {
    ok:
      uncovered.length === 0 &&
      unknownCriteria.length === 0 &&
      nonExecutionCriteria.length === 0 &&
      duplicateCaseIds.length === 0,
    covered,
    uncovered,
    unknownCriteria,
    nonExecutionCriteria,
    duplicateCaseIds,
  };
}
