/**
 * 제출 테스트 실행 결과 (T-109). 러너가 수집한 리포터 결과 파일만으로 만든다 (G-07).
 * stdout의 `PASS`·`passed` 문구와 저장소가 제공한 점수 파일은 어떤 필드에도 반영하지 않는다.
 */
import { FailureKindSchema } from "@ohmyti/core";
import { z } from "zod";

export const SUBMITTED_TEST_STATUSES = [
  "PASSED",
  "FAILED",
  "NO_TESTS",
  "UNSUPPORTED_FRAMEWORK",
  "BUILD_FAIL",
  "TIMEOUT",
  "INCONCLUSIVE",
] as const;
export const SubmittedTestStatusSchema = z.enum(SUBMITTED_TEST_STATUSES);
export type SubmittedTestStatus = z.infer<typeof SubmittedTestStatusSchema>;

/** 감지 가능한 프레임워크. `vitest`만 실행하고 나머지는 UNSUPPORTED_FRAMEWORK다. */
export const TEST_FRAMEWORKS = [
  "vitest",
  "jest",
  "mocha",
  "ava",
  "jasmine",
  "tap",
  "node-test",
  "unknown",
  "none",
] as const;
export const TestFrameworkSchema = z.enum(TEST_FRAMEWORKS);
export type TestFramework = z.infer<typeof TestFrameworkSchema>;

export const SUPPORTED_TEST_FRAMEWORKS: readonly TestFramework[] = ["vitest"];

export const FrameworkDetectionSchema = z.object({
  framework: TestFrameworkSchema,
  supported: z.boolean(),
  /** 판단 근거 (예: `package.json devDependencies.vitest`, `vitest.config.ts`) */
  signals: z.array(z.string()),
  /** 테스트로 보이는 파일 (`*.test.*`, `*.spec.*`, `__tests__/`). 프레임워크와 무관하게 수집 */
  testFilePaths: z.array(z.string()),
});
export type FrameworkDetection = z.infer<typeof FrameworkDetectionSchema>;

export const SubmittedTestCaseStatusSchema = z.enum([
  "passed",
  "failed",
  "skipped",
  "todo",
  "pending",
]);
export type SubmittedTestCaseStatus = z.infer<typeof SubmittedTestCaseStatusSchema>;

export const SubmittedTestCaseSchema = z.object({
  /** 상위 describe 이름을 포함한 전체 이름 */
  fullName: z.string(),
  title: z.string(),
  status: SubmittedTestCaseStatusSchema,
  durationMs: z.number().nonnegative().nullable(),
  /** 마스킹·경로 정규화·길이 상한 적용 후 */
  failureMessages: z.array(z.string()),
});
export type SubmittedTestCase = z.infer<typeof SubmittedTestCaseSchema>;

export const SubmittedTestFileSchema = z.object({
  /** 작업 디렉터리 기준 상대 경로 (`/` 구분) */
  path: z.string(),
  status: z.enum(["passed", "failed"]),
  total: z.int().nonnegative(),
  passed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  durationMs: z.number().nonnegative(),
  /** 파일 수준 오류 (변환 실패, import 실패, 최상위 예외). 테스트가 하나도 실행되지 못한 경우 */
  error: z.string().nullable(),
  tests: z.array(SubmittedTestCaseSchema),
});
export type SubmittedTestFile = z.infer<typeof SubmittedTestFileSchema>;

export const CommandEvidenceSchema = z.object({
  argv: z.array(z.string()),
  exitCode: z.int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.int().nonnegative(),
  logsRef: z.object({ stdout: z.string(), stderr: z.string() }),
});
export type CommandEvidence = z.infer<typeof CommandEvidenceSchema>;

export const SubmittedTestResultSchema = z
  .object({
    status: SubmittedTestStatusSchema,
    /** G-11: PASSED→NONE, FAILED→ASSERTION, BUILD_FAIL·UNSUPPORTED_FRAMEWORK→SUBMISSION, TIMEOUT→TIMEOUT, INCONCLUSIVE→ENVIRONMENT, NO_TESTS→NONE */
    failureKind: FailureKindSchema,
    framework: FrameworkDetectionSchema,
    total: z.int().nonnegative(),
    passed: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    skipped: z.int().nonnegative(),
    testFiles: z.array(SubmittedTestFileSchema),
    /** 리포터가 기록한 테스트 실행 시간 합. 실행하지 않았으면 0 */
    durationMs: z.number().nonnegative(),
    /** PASSED·FAILED가 아닌 상태의 사유. 사람이 읽는 한 문장 */
    reason: z.string().nullable(),
    /** `tsc --noEmit` 실행 근거. tsconfig.json이 없거나 typecheck를 껐으면 null */
    typecheck: CommandEvidenceSchema.nullable(),
    /** vitest 실행 근거. 실행 전에 끝났으면 null */
    run: CommandEvidenceSchema.nullable(),
    /** 결과 파일을 수집했는지. false인데 status가 PASSED·FAILED일 수 없다 */
    resultFileCollected: z.boolean(),
    /** 테스트 수가 상한을 넘어 `testFiles[].tests`를 일부만 실었는지 */
    truncated: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if ((value.status === "PASSED" || value.status === "FAILED") && !value.resultFileCollected) {
      ctx.addIssue({
        code: "custom",
        path: ["resultFileCollected"],
        message: `${value.status}는 리포터 결과 파일이 있어야 한다 (G-07)`,
      });
    }
    if (value.status === "PASSED" && value.failed !== 0) {
      ctx.addIssue({ code: "custom", path: ["failed"], message: "PASSED는 failed가 0이어야 한다" });
    }
    if (value.status === "PASSED" && value.total === 0) {
      ctx.addIssue({ code: "custom", path: ["total"], message: "테스트가 0개면 NO_TESTS다" });
    }
  });
export type SubmittedTestResult = z.infer<typeof SubmittedTestResultSchema>;
