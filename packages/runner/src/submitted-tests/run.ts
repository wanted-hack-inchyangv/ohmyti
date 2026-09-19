/**
 * 제출 테스트 실행기 (T-109). 준비된 환경(`PreparedEnv`) 안에서 템플릿의 vitest를 직접 호출하고
 * JSON 리포터 결과 파일만으로 결과를 만든다.
 *
 * 순서: 프레임워크 감지 → (tsconfig.json이 있으면) `tsc --noEmit` → vitest 실행 → 결과 파일 수집·파싱.
 * - stdout·stderr는 로그로만 저장하고 판정에 쓰지 않는다 (G-07).
 * - 결과 파일이 없거나 형식이 다르면 INCONCLUSIVE(ENVIRONMENT)다. 환경 장애와 제출 오류를 구분한다 (G-11).
 */
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { FailureKind } from "@ohmyti/core";
import {
  RunnerEnvironmentError,
  type CommandResult,
  type PreparedEnv,
  type SandboxRunner,
} from "../runner";
import { detectTestFramework, directoryFiles, type SubmissionFiles } from "./detect";
import {
  SubmittedTestResultSchema,
  type CommandEvidence,
  type FrameworkDetection,
  type SubmittedTestResult,
  type SubmittedTestStatus,
} from "./schema";
import { VitestReportParseError, parseVitestReport, type ParsedReport } from "./vitest-report";

export interface RunSubmittedTestsOptions {
  /** vitest 실행의 벽시계 제한. 기본 러너의 `runTimeoutMs` */
  timeoutMs?: number;
  /** `tsc --noEmit` 제한. 기본 `timeoutMs` */
  typecheckTimeoutMs?: number;
  /** 루트 `tsconfig.json`이 있으면 vitest 전에 `tsc --noEmit -p tsconfig.json`을 실행한다. 기본 true */
  typecheck?: boolean;
  /** 프레임워크 감지에 쓸 파일 접근자. 기본 `env.files`, 없으면 `directoryFiles(env.workDir)` */
  files?: SubmissionFiles;
  /** 실패 메시지에서 가릴 비밀값 */
  secrets?: readonly string[];
  /** 결과 파일 크기 상한(바이트). 넘으면 INCONCLUSIVE. 기본 8 MiB */
  maxResultBytes?: number;
  /** `testFiles[].tests`에 실을 테스트 수 상한. 기본 5000 */
  maxTests?: number;
  /** 로그 라벨 접두사. 기본 `tests` → `tests-typecheck`, `tests-vitest` */
  label?: string;
}

export const SUBMITTED_TESTS_DEFAULTS = {
  maxResultBytes: 8 * 1024 * 1024,
  maxTests: 5000,
  label: "tests",
} as const;

const FAILURE_KIND_BY_STATUS: Record<SubmittedTestStatus, FailureKind> = {
  PASSED: "NONE",
  FAILED: "ASSERTION",
  NO_TESTS: "NONE",
  UNSUPPORTED_FRAMEWORK: "SUBMISSION",
  BUILD_FAIL: "SUBMISSION",
  TIMEOUT: "TIMEOUT",
  INCONCLUSIVE: "ENVIRONMENT",
};

/** 상태에 대응하는 실패 종류 (G-11) */
export function failureKindOf(status: SubmittedTestStatus): FailureKind {
  return FAILURE_KIND_BY_STATUS[status];
}

export async function runSubmittedTests(
  runner: SandboxRunner,
  env: PreparedEnv,
  options: RunSubmittedTestsOptions = {},
): Promise<SubmittedTestResult> {
  const label = options.label ?? SUBMITTED_TESTS_DEFAULTS.label;
  const files = options.files ?? env.files ?? directoryFiles(env.workDir);
  const framework = await detectTestFramework(files);
  const base = emptyResult(framework);

  if (framework.framework === "none") {
    return finish({
      ...base,
      status: "NO_TESTS",
      reason: "테스트 파일과 테스트 프레임워크가 없습니다",
    });
  }
  if (!framework.supported) {
    return finish({
      ...base,
      status: "UNSUPPORTED_FRAMEWORK",
      reason:
        framework.framework === "unknown"
          ? `테스트 파일 ${framework.testFilePaths.length}개가 있지만 프레임워크를 감지하지 못했습니다 (vitest만 지원)`
          : `${framework.framework}는 지원하지 않는 테스트 프레임워크입니다 (vitest만 지원)`,
    });
  }

  // 1) 타입 검사. vitest는 타입을 지우고 실행하므로 타입 오류는 tsc로만 잡힌다.
  let typecheck: CommandEvidence | null = null;
  if (options.typecheck ?? true) {
    const hasTsconfig = (await files.readText("tsconfig.json")) !== null;
    if (hasTsconfig) {
      const tscEntry = path.join(env.templateDir, "node_modules", "typescript", "bin", "tsc");
      const tscTimeout = options.typecheckTimeoutMs ?? options.timeoutMs;
      let result: CommandResult;
      try {
        result = await runner.runCommand(
          env,
          ["node", tscEntry, "--noEmit", "-p", "tsconfig.json"],
          {
            ...(tscTimeout === undefined ? {} : { timeoutMs: tscTimeout }),
            label: `${label}-typecheck`,
          },
        );
      } catch (error) {
        if (error instanceof RunnerEnvironmentError) {
          return finish({
            ...base,
            status: "INCONCLUSIVE",
            reason: `tsc를 실행할 수 없습니다: ${error.message}`,
          });
        }
        throw error;
      }
      typecheck = evidence(result);
      if (result.timedOut) {
        return finish({
          ...base,
          typecheck,
          status: "TIMEOUT",
          reason: `tsc --noEmit이 ${result.durationMs}ms 안에 끝나지 않았습니다`,
        });
      }
      if (result.exitCode !== 0) {
        return finish({
          ...base,
          typecheck,
          status: "BUILD_FAIL",
          reason: `tsc --noEmit 실패 (exit ${result.exitCode ?? result.signal ?? "?"}): ${firstLines(result.stdout || result.stderr, 5)}`,
        });
      }
    }
  }

  // 2) vitest 실행. 결과 파일은 작업 디렉터리 밖(환경 루트 안)의 예측할 수 없는 이름으로 둔다.
  const resultFile = path.join(
    env.rootDir,
    "test-results",
    `vitest-${randomBytes(8).toString("hex")}.json`,
  );
  const vitestEntry = path.join(env.templateDir, "node_modules", "vitest", "vitest.mjs");
  const argv = ["node", vitestEntry, "run", "--reporter=json", `--outputFile=${resultFile}`];
  let result: CommandResult;
  try {
    result = await runner.runCommand(env, argv, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      collectFiles: [path.relative(env.workDir, resultFile)],
      label: `${label}-vitest`,
    });
  } catch (error) {
    if (error instanceof RunnerEnvironmentError) {
      return finish({
        ...base,
        typecheck,
        status: "INCONCLUSIVE",
        reason: `vitest를 실행할 수 없습니다: ${error.message}`,
      });
    }
    throw error;
  }
  const run = evidence(result);
  if (result.timedOut) {
    return finish({
      ...base,
      typecheck,
      run,
      status: "TIMEOUT",
      reason: `vitest가 ${result.durationMs}ms 안에 끝나지 않았습니다`,
    });
  }
  const collected = result.files[0];
  if (!collected) {
    return finish({
      ...base,
      typecheck,
      run,
      status: "INCONCLUSIVE",
      reason: `vitest가 결과 파일을 남기지 않았습니다 (exit ${result.exitCode ?? result.signal ?? "?"}). stdout은 판정에 쓰지 않습니다`,
    });
  }
  const maxResultBytes = options.maxResultBytes ?? SUBMITTED_TESTS_DEFAULTS.maxResultBytes;
  if (collected.bytes.byteLength > maxResultBytes) {
    return finish({
      ...base,
      typecheck,
      run,
      status: "INCONCLUSIVE",
      reason: `결과 파일이 ${collected.bytes.byteLength}바이트로 상한 ${maxResultBytes}바이트를 넘습니다`,
    });
  }

  let parsed: ParsedReport;
  try {
    parsed = parseVitestReport(collected.bytes, {
      workDirs: await withRealpath(env.workDir),
      stripPaths: await withRealpath(env.rootDir),
      maxTests: options.maxTests ?? SUBMITTED_TESTS_DEFAULTS.maxTests,
      ...(options.secrets ? { secrets: options.secrets } : {}),
    });
  } catch (error) {
    if (error instanceof VitestReportParseError) {
      return finish({ ...base, typecheck, run, status: "INCONCLUSIVE", reason: error.message });
    }
    throw error;
  }

  const counts = {
    total: parsed.total,
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: parsed.skipped,
    durationMs: parsed.durationMs,
    testFiles: parsed.testFiles,
    truncated: parsed.truncated,
    resultFileCollected: true,
  };
  if (parsed.fileErrors.length > 0) {
    const first = parsed.fileErrors[0];
    return finish({
      ...base,
      ...counts,
      typecheck,
      run,
      status: "BUILD_FAIL",
      reason: `테스트 파일 ${parsed.fileErrors.length}개를 불러오지 못했습니다: ${first?.path ?? "?"}: ${firstLines(first?.error ?? "", 3)}`,
    });
  }
  if (parsed.total === 0) {
    return finish({
      ...base,
      ...counts,
      typecheck,
      run,
      status: "NO_TESTS",
      reason: "vitest가 테스트를 하나도 찾지 못했습니다",
    });
  }
  if (parsed.failed > 0 || !parsed.success || result.exitCode !== 0) {
    return finish({
      ...base,
      ...counts,
      typecheck,
      run,
      status: "FAILED",
      reason:
        parsed.failed > 0
          ? `${parsed.total}개 중 ${parsed.failed}개 실패`
          : `테스트 실패 수는 0이지만 vitest가 실패로 끝났습니다 (exit ${result.exitCode ?? result.signal ?? "?"}, success=${String(parsed.success)})`,
    });
  }
  return finish({ ...base, ...counts, typecheck, run, status: "PASSED", reason: null });
}

function emptyResult(framework: FrameworkDetection): SubmittedTestResult {
  return {
    status: "INCONCLUSIVE",
    failureKind: "ENVIRONMENT",
    framework,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    testFiles: [],
    durationMs: 0,
    reason: null,
    typecheck: null,
    run: null,
    resultFileCollected: false,
    truncated: false,
  };
}

function finish(result: SubmittedTestResult): SubmittedTestResult {
  return SubmittedTestResultSchema.parse({ ...result, failureKind: failureKindOf(result.status) });
}

function evidence(result: CommandResult): CommandEvidence {
  return {
    argv: result.argv,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    logsRef: result.logsRef,
  };
}

function firstLines(text: string, count: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const head = lines.slice(0, count).join(" | ");
  return lines.length > count ? `${head} | …(${lines.length - count}줄 더)` : head;
}

async function withRealpath(dir: string): Promise<string[]> {
  try {
    const real = await realpath(dir);
    return real === dir ? [dir] : [dir, real];
  } catch {
    return [dir];
  }
}
