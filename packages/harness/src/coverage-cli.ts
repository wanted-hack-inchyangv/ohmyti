/**
 * `pnpm harness:coverage [--rubric <path>] [--case-set <name>]`
 * rubric의 모든 EXECUTION 기준이 최소 1개 케이스에 커버되는지, 케이스가 rubric에 있는 EXECUTION 기준만 참조하는지 확인한다.
 */
import { validateRubric } from "@ohmyti/core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_CASE_SET, getCaseSet } from "./cases";
import { checkCoverage } from "./coverage";
import { loadRubricFile } from "./report";
import { harnessVersionOf } from "./version";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_RUBRIC = path.join(repoRoot, "samples/order-api/rubric.v1.json");

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      rubric: { type: "string", default: DEFAULT_RUBRIC },
      "case-set": { type: "string", default: DEFAULT_CASE_SET },
    },
    strict: true,
  });
  const rubric = await loadRubricFile(values.rubric);
  const validation = validateRubric(rubric);
  if (!validation.ok) {
    console.error("rubric 검증 실패:");
    for (const error of validation.errors) console.error(`  ${error.code}: ${error.message}`);
    process.exit(1);
  }
  const cases = getCaseSet(values["case-set"]);
  const report = checkCoverage(cases, rubric);

  for (const [criterionId, caseIds] of Object.entries(report.covered)) {
    console.log(
      `${caseIds.length > 0 ? "ok  " : "MISS"} ${criterionId}: ${caseIds.join(", ") || "(없음)"}`,
    );
  }
  for (const { caseId, criterionId } of report.unknownCriteria) {
    console.error(`ERR  케이스 ${caseId}가 rubric에 없는 기준을 참조합니다: ${criterionId}`);
  }
  for (const { caseId, criterionId, method } of report.nonExecutionCriteria) {
    console.error(
      `ERR  케이스 ${caseId}가 EXECUTION이 아닌 기준(${method})을 참조합니다: ${criterionId}`,
    );
  }
  for (const caseId of report.duplicateCaseIds) console.error(`ERR  케이스 ID 중복: ${caseId}`);

  const executionCount = Object.keys(report.covered).length;
  if (!report.ok) {
    console.error(
      `harness:coverage 실패 — EXECUTION 기준 ${executionCount}개 중 ${report.uncovered.length}개 미커버, 오류 ${report.unknownCriteria.length + report.nonExecutionCriteria.length + report.duplicateCaseIds.length}개`,
    );
    process.exit(1);
  }
  console.log(
    `harness:coverage OK — 케이스 ${cases.length}개가 rubric ${rubric.version}의 EXECUTION 기준 ${executionCount}개를 모두 커버합니다 · harnessVersion ${harnessVersionOf(cases)}`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
