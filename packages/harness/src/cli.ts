/**
 * `pnpm harness:run --base-url <url> --rubric <path> --out <file> [--case <id>] [--case-set <name>] [--timeout-ms <n>]`
 *
 * 기동된 제출 서비스에 케이스를 실행하고 보고서 JSON을 파일에 쓴다. 서비스 기동은 하지 않는다(T-108).
 * 종료 코드: 0 = 실행 완료(FAIL·INCONCLUSIVE가 있어도 0. 판정은 보고서가 담는다), 1 = 인자 오류·rubric 오류·커버리지 실패.
 */
import { validateRubric } from "@ohmyti/core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CASE_SET, getCaseSet } from "./cases";
import { checkCoverage } from "./coverage";
import { loadRubricFile, requestTimeoutFromEnv, runHarness } from "./report";

function usage(): never {
  console.error(
    "사용법: harness:run --base-url <url> --rubric <path> --out <file> [--case <id>]... [--case-set <name>] [--timeout-ms <n>]",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "base-url": { type: "string" },
      rubric: { type: "string" },
      out: { type: "string" },
      case: { type: "string", multiple: true },
      "case-set": { type: "string", default: DEFAULT_CASE_SET },
      "timeout-ms": { type: "string" },
    },
    strict: true,
  });
  const baseUrl = values["base-url"];
  const rubricPath = values.rubric;
  const outPath = values.out;
  if (!baseUrl || !rubricPath || !outPath) usage();
  try {
    new URL(baseUrl);
  } catch {
    console.error(`--base-url이 URL이 아닙니다: ${baseUrl}`);
    process.exit(1);
  }
  const timeoutMs =
    values["timeout-ms"] !== undefined ? Number(values["timeout-ms"]) : requestTimeoutFromEnv();
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    console.error(`--timeout-ms는 양의 정수여야 합니다: ${values["timeout-ms"]}`);
    process.exit(1);
  }

  const rubric = await loadRubricFile(rubricPath);
  const validation = validateRubric(rubric);
  if (!validation.ok) {
    console.error("rubric 검증 실패:");
    for (const error of validation.errors) console.error(`  ${error.code}: ${error.message}`);
    process.exit(1);
  }
  const cases = getCaseSet(values["case-set"]);
  const coverage = checkCoverage(cases, rubric);
  if (!coverage.ok) {
    console.error("케이스 커버리지 검사 실패. `pnpm harness:coverage`로 확인하세요.");
    process.exit(1);
  }
  const caseIds = values.case;
  if (caseIds) {
    const known = new Set(cases.map((c) => c.id));
    const unknown = caseIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      console.error(`알 수 없는 케이스 ID: ${unknown.join(", ")}`);
      console.error(`사용 가능: ${[...known].join(", ")}`);
      process.exit(1);
    }
  }

  const options = {
    baseUrl,
    timeoutMs,
    caseSet: values["case-set"],
    rubric,
    onCaseFinished: (result: { caseId: string; verdict: string; failureKind: string }) => {
      console.log(`${result.verdict.padEnd(12)} ${result.caseId} (${result.failureKind})`);
    },
    ...(caseIds ? { caseIds } : {}),
  };
  const report = await runHarness(cases, options);

  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  const { total, pass, fail, inconclusive } = report.summary;
  console.log(
    `harness:run 완료 — ${total}건 (PASS ${pass}, FAIL ${fail}, INCONCLUSIVE ${inconclusive}) · harnessVersion ${report.harnessVersion} · ${outPath}`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
