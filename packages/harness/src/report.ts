/** 보고서 조립. rubric 검증과 케이스 실행을 묶어 `HarnessReport`를 만든다. */
import { RubricSchema, type Rubric } from "@ohmyti/core";
import { readFile } from "node:fs/promises";
import type { CaseDefinition } from "./dsl";
import { HarnessReportSchema, type CaseResult, type HarnessReport } from "./result";
import { runCases, type RunCasesOptions } from "./run";
import { harnessVersionOf } from "./version";

export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** `HARNESS_REQUEST_TIMEOUT_MS` 환경변수를 읽는다. 없거나 잘못되면 기본값 */
export function requestTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["HARNESS_REQUEST_TIMEOUT_MS"];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

export async function loadRubricFile(path: string): Promise<Rubric> {
  return RubricSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export function summarize(results: readonly CaseResult[]): HarnessReport["summary"] {
  return {
    total: results.length,
    pass: results.filter((r) => r.verdict === "PASS").length,
    fail: results.filter((r) => r.verdict === "FAIL").length,
    inconclusive: results.filter((r) => r.verdict === "INCONCLUSIVE").length,
  };
}

export interface RunHarnessOptions extends RunCasesOptions {
  caseSet: string;
  rubric: Rubric;
}

export async function runHarness(
  cases: readonly CaseDefinition[],
  options: RunHarnessOptions,
): Promise<HarnessReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const results = await runCases(cases, options);
  return HarnessReportSchema.parse({
    harnessVersion: harnessVersionOf(cases),
    caseSet: options.caseSet,
    rubricVersion: options.rubric.version,
    baseUrl: options.baseUrl,
    requestTimeoutMs: options.timeoutMs,
    startedAt,
    finishedAt: now().toISOString(),
    results,
    summary: summarize(results),
  });
}
