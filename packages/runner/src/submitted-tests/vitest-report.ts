/**
 * vitest JSON 리포터(`--reporter=json --outputFile=…`) 결과 파일 파싱 (T-109).
 * 형식은 템플릿에 고정된 vitest 4.1.11의 `JsonReporter`를 따른다. 스키마에 맞지 않으면 파싱 실패이며
 * 호출자는 INCONCLUSIVE(ENVIRONMENT)로 기록한다. stdout은 어떤 경우에도 파싱하지 않는다 (G-07).
 */
import { maskSensitive } from "@ohmyti/core";
import { z } from "zod";
import { SubmittedTestFileSchema, type SubmittedTestCase, type SubmittedTestFile } from "./schema";

const AssertionResultSchema = z.object({
  ancestorTitles: z.array(z.string()).default([]),
  fullName: z.string(),
  status: z.string(),
  title: z.string().default(""),
  duration: z.number().nullable().optional(),
  failureMessages: z.array(z.string()).default([]),
});

const TestResultSchema = z.object({
  assertionResults: z.array(AssertionResultSchema),
  startTime: z.number(),
  endTime: z.number(),
  status: z.string(),
  message: z.string().default(""),
  name: z.string(),
});

export const VitestJsonReportSchema = z.object({
  numTotalTestSuites: z.int().nonnegative(),
  numPassedTestSuites: z.int().nonnegative(),
  numFailedTestSuites: z.int().nonnegative(),
  numPendingTestSuites: z.int().nonnegative(),
  numTotalTests: z.int().nonnegative(),
  numPassedTests: z.int().nonnegative(),
  numFailedTests: z.int().nonnegative(),
  numPendingTests: z.int().nonnegative(),
  numTodoTests: z.int().nonnegative(),
  startTime: z.number(),
  success: z.boolean(),
  testResults: z.array(TestResultSchema),
});
export type VitestJsonReport = z.infer<typeof VitestJsonReportSchema>;

export interface ParseReportOptions {
  /** 절대 경로를 상대 경로로 바꿀 기준. 환경의 `workDir`와 그 realpath (macOS `/tmp` → `/private/tmp`) */
  workDirs: readonly string[];
  /** 메시지에서 지울 추가 경로 접두사 (환경 `rootDir`) */
  stripPaths?: readonly string[];
  /** 마스킹할 비밀값 */
  secrets?: readonly string[];
  /** 파일 전체에 실을 테스트 수 상한. 넘으면 `truncated` */
  maxTests?: number;
  /** 실패 메시지 하나의 길이 상한 */
  maxMessageChars?: number;
  /** 테스트 하나에 실을 실패 메시지 수 상한 */
  maxMessagesPerTest?: number;
}

export interface ParsedReport {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  success: boolean;
  testFiles: SubmittedTestFile[];
  /** 테스트를 하나도 실행하지 못한 채 실패한 파일 (변환·import 오류) */
  fileErrors: { path: string; error: string }[];
  truncated: boolean;
}

export class VitestReportParseError extends Error {
  override readonly name = "VitestReportParseError";
}

/** 결과 파일 바이트 → 구조화 결과. JSON이 아니거나 스키마가 다르면 `VitestReportParseError` */
export function parseVitestReport(bytes: Uint8Array, options: ParseReportOptions): ParsedReport {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new VitestReportParseError(
      `결과 파일이 JSON이 아닙니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = VitestJsonReportSchema.safeParse(json);
  if (!parsed.success) {
    throw new VitestReportParseError(
      `결과 파일이 vitest JSON 리포터 형식이 아닙니다: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return toParsedReport(parsed.data, options);
}

function toParsedReport(report: VitestJsonReport, options: ParseReportOptions): ParsedReport {
  const maxTests = options.maxTests ?? 5000;
  const clean = makeCleaner(options);
  let recorded = 0;
  let truncated = false;
  const testFiles: SubmittedTestFile[] = [];
  const fileErrors: { path: string; error: string }[] = [];

  const sorted = [...report.testResults].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const file of sorted) {
    const filePath = relativePath(file.name, options.workDirs);
    const tests: SubmittedTestCase[] = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const assertion of file.assertionResults) {
      const status = caseStatus(assertion.status);
      if (status === "passed") passed += 1;
      else if (status === "failed") failed += 1;
      else skipped += 1;
      if (recorded >= maxTests) {
        truncated = true;
        continue;
      }
      recorded += 1;
      tests.push({
        fullName: clean(assertion.fullName),
        title: clean(assertion.title),
        status,
        durationMs:
          typeof assertion.duration === "number" && assertion.duration >= 0
            ? assertion.duration
            : null,
        failureMessages: assertion.failureMessages
          .slice(0, options.maxMessagesPerTest ?? 5)
          .map((m) => clean(m)),
      });
    }
    const error =
      file.status === "failed" && file.assertionResults.length === 0
        ? clean(file.message) || "테스트 파일을 실행하지 못했습니다"
        : null;
    if (error !== null) fileErrors.push({ path: filePath, error });
    testFiles.push(
      SubmittedTestFileSchema.parse({
        path: filePath,
        status: file.status === "failed" ? "failed" : "passed",
        total: file.assertionResults.length,
        passed,
        failed,
        skipped,
        durationMs: Math.max(0, file.endTime - file.startTime),
        error,
        tests,
      }),
    );
  }

  return {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests + report.numTodoTests,
    durationMs: testFiles.reduce((sum, f) => sum + f.durationMs, 0),
    success: report.success,
    testFiles,
    fileErrors,
    truncated,
  };
}

function caseStatus(status: string): SubmittedTestCase["status"] {
  switch (status) {
    case "passed":
    case "failed":
    case "skipped":
    case "todo":
    case "pending":
      return status;
    default:
      return "pending";
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function makeCleaner(options: ParseReportOptions): (text: string) => string {
  const prefixes = [...options.workDirs, ...(options.stripPaths ?? [])]
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);
  const maxChars = options.maxMessageChars ?? 4000;
  return (text) => {
    let out = text.replace(ANSI_PATTERN, "");
    for (const prefix of prefixes) {
      out = out.split(`${prefix}/`).join("").split(prefix).join("<env>");
    }
    out = maskSensitive(out, options.secrets ?? []);
    if (out.length > maxChars) out = `${out.slice(0, maxChars)}…[truncated]`;
    return out;
  };
}

function relativePath(absolute: string, workDirs: readonly string[]): string {
  const normalized = absolute.split("\\").join("/");
  for (const workDir of [...workDirs].sort((a, b) => b.length - a.length)) {
    const prefix = workDir.endsWith("/") ? workDir : `${workDir}/`;
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  }
  return normalized;
}
