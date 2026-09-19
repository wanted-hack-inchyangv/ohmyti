export const PACKAGE_NAME = "@ohmyti/runner" as const;

export {
  RUNNER_KINDS,
  RunnerKindSchema,
  TemplateManifestSchema,
  DependencyIssueCodeSchema,
  SubmissionPackageJsonSchema,
  checkDependencies,
  computeEnvironmentDigest,
  sha256Hex,
} from "./template";
export type {
  RunnerKind,
  TemplateManifest,
  DependencyIssueCode,
  DependencyIssue,
  DependencyCheckResult,
  SubmissionPackageJson,
} from "./template";

export * from "./runner";
export {
  LOCAL_RUNNER_DEFAULTS,
  loadLocalRunnerConfig,
  type LocalRunnerConfig,
  type LocalRunnerLimits,
} from "./config";
export {
  LocalProcessRunner,
  CHILD_ENV_WHITELIST,
  splitCommand,
  type LocalProcessRunnerOptions,
} from "./local/local-runner";
export {
  assertCommandAllowed,
  assertScriptsAllowed,
  blockedReason,
  scriptBlockedReason,
  requestedScriptName,
  INSTALL_SUBCOMMANDS,
  PACKAGE_MANAGERS,
  ALWAYS_BLOCKED_PROGRAMS,
} from "./local/commands";
export { unpackSnapshot, inspectSnapshot, planEntryPath, type UnpackResult } from "./local/unpack";
export {
  packDirectoryToTarGz,
  PACK_DEFAULT_EXCLUDE,
  type PackDirectoryOptions,
} from "./local/pack";
export { findFreePort, waitForHealth } from "./local/net";
export { isGroupAlive, killGroup } from "./local/process";
export {
  SUBMITTED_TEST_STATUSES,
  SubmittedTestStatusSchema,
  TEST_FRAMEWORKS,
  TestFrameworkSchema,
  SUPPORTED_TEST_FRAMEWORKS,
  FrameworkDetectionSchema,
  SubmittedTestCaseStatusSchema,
  SubmittedTestCaseSchema,
  SubmittedTestFileSchema,
  CommandEvidenceSchema,
  SubmittedTestResultSchema,
  type SubmittedTestStatus,
  type TestFramework,
  type FrameworkDetection,
  type SubmittedTestCaseStatus,
  type SubmittedTestCase,
  type SubmittedTestFile,
  type CommandEvidence,
  type SubmittedTestResult,
} from "./submitted-tests/schema";
export {
  detectTestFramework,
  directoryFiles,
  inMemoryFiles,
  type SubmissionFiles,
} from "./submitted-tests/detect";
export {
  parseVitestReport,
  VitestJsonReportSchema,
  VitestReportParseError,
  type ParsedReport,
  type ParseReportOptions,
  type VitestJsonReport,
} from "./submitted-tests/vitest-report";
export {
  runSubmittedTests,
  failureKindOf,
  SUBMITTED_TESTS_DEFAULTS,
  type RunSubmittedTestsOptions,
} from "./submitted-tests/run";
export { VERCEL_RUNNER_DEFAULTS, loadVercelRunnerConfig, type VercelRunnerConfig } from "./config";
export {
  VercelSandboxRunner,
  SANDBOX_SERVICE_PORT,
  type VercelSandboxRunnerOptions,
} from "./vercel/vercel-runner";
export {
  vercelSandboxClient,
  type SandboxClient,
  type SandboxHandle,
  type SandboxProcess,
  type SandboxCommandParams,
  type SandboxCommandFinished,
  type CreateSandboxOptions,
  type SandboxCredentials,
  type SandboxNetworkPolicy,
} from "./vercel/client";
export { createRunnerFromEnv, type CreateRunnerOptions } from "./factory";
