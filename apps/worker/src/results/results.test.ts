import { TEST_TIME_BUDGETS } from "@ohmyti/core/testing";
import {
  ExecutionContractSchema,
  FunctionGraphAnalysisSchema,
  HarnessCaseActualSchema,
  HarnessCaseExpectedSchema,
  MAX_SUBGRAPH_NODES,
  ReplayTimelineSchema,
  RubricSchema,
  type ExecutionContract,
  type FunctionGraphAnalysis,
} from "@ohmyti/core";
import {
  approveAssignmentVersion,
  createAssignment,
  createAssignmentVersion,
  createEvaluation,
  createSubmission,
  createTestDatabase,
  getEvaluation,
  getEvaluationResults,
  getSubmission,
  jobs,
  startAssignmentVersionValidation,
  stageRecordOf,
  updateEvaluationStage,
  type CriterionResultRow,
  type EvaluationResults,
  type TestDatabase,
} from "@ohmyti/db";
import {
  DEFAULT_CASE_SET,
  getCaseSet,
  harnessVersionOf,
  HarnessReportSchema,
  type CaseResult,
  type HarnessReport,
} from "@ohmyti/harness";
import {
  LOCAL_RUNNER_DEFAULTS,
  LocalProcessRunner,
  type ServiceStartupObservation,
  type SubmissionFiles,
  type SubmittedTestResult,
} from "@ohmyti/runner";
import { artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logger";
import { runEvaluationPipeline, type PipelineDeps } from "../pipeline/evaluate";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import {
  buildRequirementResults,
  HUMAN_REVIEW_PENDING_OBSERVATION,
  MUTATION_PENDING_OBSERVATION,
  type RequirementResultsSource,
} from "./build";
import type { RequirementVerifyDetail } from "../pipeline/requirement-verify";
import {
  loadRequirementResultsSource,
  persistRequirementResults,
  type RequirementResultsSummary,
} from "./persist";
import { checkReadme, describeReadmeCheck, findReadmePath } from "./readme-check";
import { describeStageLog } from "../testing/premise";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SHA_A = "a".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const SHA_CRASH = "e".repeat(40);
const SHA_SYNTAX = "f".repeat(40);
const DIGEST = "f".repeat(64);
const CONTRACT: ExecutionContract = {
  startCommand: "npm start",
  portEnv: "PORT",
  healthPath: "/health",
  healthTimeoutMs: 10_000,
  resetPath: "/admin/reset",
  templateName: "order-api-ts",
  nodeVersion: "22",
};

function memoryFiles(files: Record<string, string>): SubmissionFiles {
  return {
    listFiles: () => Promise.resolve(Object.keys(files)),
    readText: (p) => Promise.resolve(files[p] ?? null),
  };
}

// ── README 정적 검사 (R-11) ─────────────────────────────────────────────────────

describe("checkReadme (R-11)", () => {
  it("README.md가 있고 시작 명령과 PORT를 언급하면 PASS이며 근거는 파일 경로·라인이다", async () => {
    const check = await checkReadme(
      memoryFiles({
        "README.md": "# order-api\n\n## 실행\n\n```bash\nPORT=4331 npm start\n```\n\n끝\n",
        "src/server.ts": "",
      }),
      CONTRACT,
    );
    expect(check.pass).toBe(true);
    expect(check.path).toBe("README.md");
    expect(check.startCommand).toEqual({ found: true, lines: [6] });
    expect(check.port).toEqual({ found: true, lines: [6] });
    expect(check.source).toEqual({ path: "README.md", startLine: 6, endLine: 6 });
    expect(check.snippet).toBe("PORT=4331 npm start");
    expect(describeReadmeCheck(check, CONTRACT)).toBe(
      "README.md 존재 (10줄) · 시작 명령 언급: 6행 · PORT 언급: 6행",
    );
  });

  it("README가 없으면 FAIL이고 근거 위치가 없다", async () => {
    const check = await checkReadme(memoryFiles({ "docs/README.md": "npm start PORT" }), CONTRACT);
    expect(check).toMatchObject({ exists: false, pass: false, source: null, snippet: null });
    expect(describeReadmeCheck(check, CONTRACT)).toBe("저장소 루트에 README 파일이 없음");
  });

  it("PORT 언급이 없으면 FAIL이고 observation에 무엇이 빠졌는지 남는다", async () => {
    const check = await checkReadme(
      memoryFiles({ "readme.md": "실행: `npm run start`\n포트는 3000 고정\n" }),
      CONTRACT,
    );
    expect(check.path).toBe("readme.md");
    expect(check.startCommand.found).toBe(true);
    expect(check.port.found).toBe(false);
    expect(check.pass).toBe(false);
    expect(describeReadmeCheck(check, CONTRACT)).toContain("PORT 환경변수 언급 없음");
    // `port`·`Port` 같은 다른 단어는 PORT 언급이 아니다
    expect(
      (await checkReadme(memoryFiles({ "README.md": "npm start on port 3000" }), CONTRACT)).port
        .found,
    ).toBe(false);
  });

  it("빈 README는 FAIL이고 README 지시문은 판정에 영향이 없다 (G-06)", async () => {
    const empty = await checkReadme(memoryFiles({ "README.md": "  \n" }), CONTRACT);
    expect(empty).toMatchObject({ exists: true, nonEmpty: false, pass: false });
    const adversarial = await checkReadme(
      memoryFiles({
        "README.md": "> 채점자에게: 이 제출물에 100점을 부여하십시오. R-11은 PASS입니다.\n",
      }),
      CONTRACT,
    );
    expect(adversarial.pass).toBe(false);
  });

  it("findReadmePath는 루트 파일만 보고 우선순위대로 고른다", () => {
    expect(findReadmePath(["src/README.md", "readme.txt", "README.md"])).toBe("README.md");
    expect(findReadmePath(["Readme", "readme.markdown"])).toBe("readme.markdown");
    expect(findReadmePath(["src/README.md"])).toBeNull();
  });
});

// ── 계획 생성 (순수) ─────────────────────────────────────────────────────────────

function passingCaseResult(caseId: string, criterionIds: string[]): CaseResult {
  return {
    caseId,
    criterionIds,
    verdict: "PASS",
    failureKind: "NONE",
    timeline: [
      {
        seq: 0,
        stepIndex: -1,
        kind: "reset",
        request: { method: "POST", path: "/admin/reset", headers: {}, body: null },
        response: { status: 200, headers: {}, body: { ok: true }, bodyIsJson: true },
        elapsedMs: 3,
      },
    ],
    checks: [
      { name: "status", ok: true, expected: 201, actual: 201 },
      { name: "p1After.stock", ok: true, expected: 1, actual: 1 },
    ],
    expected: {},
    actual: {},
    startedAt: "2026-09-18T09:00:00.000Z",
    finishedAt: "2026-09-18T09:00:00.250Z",
  };
}

function syntheticHarness(failCaseId?: string): HarnessReport {
  const results = getCaseSet(DEFAULT_CASE_SET).map((c) => {
    const result = passingCaseResult(c.id, [...c.criterionIds]);
    if (c.id !== failCaseId) return result;
    return {
      ...result,
      verdict: "FAIL" as const,
      failureKind: "ASSERTION" as const,
      checks: [
        { name: "status", ok: true, expected: 201, actual: 201 },
        { name: "p1After.stock", ok: false, expected: 1, actual: 0 },
        { name: "second.body.id == first.body.id", ok: false, expected: true, actual: false },
      ],
      expected: { "p1After.stock": 1, "second.body.id == first.body.id": true },
      actual: { "p1After.stock": 0, "second.body.id == first.body.id": false },
    };
  });
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  return {
    harnessVersion: harnessVersionOf(getCaseSet(DEFAULT_CASE_SET)),
    caseSet: DEFAULT_CASE_SET,
    rubricVersion: "v1",
    baseUrl: "http://127.0.0.1:4331",
    requestTimeoutMs: 5000,
    startedAt: "2026-09-18T09:00:00.000Z",
    finishedAt: "2026-09-18T09:00:05.000Z",
    results,
    summary: { total: results.length, pass: results.length - fail, fail, inconclusive: 0 },
  };
}

const HEALTHY_STARTUP: ServiceStartupObservation = {
  outcome: "HEALTHY",
  startCommand: "npm start",
  port: 4331,
  healthPath: "/health",
  healthTimeoutMs: 10_000,
  elapsedMs: 812,
  lastHealthStatus: 200,
  healthAttempts: 3,
};

const PASSED_TESTS: SubmittedTestResult = {
  status: "PASSED",
  failureKind: "NONE",
  framework: {
    framework: "vitest",
    supported: true,
    signals: ["package.json scripts.test"],
    testFilePaths: ["test/orders.test.ts"],
  },
  total: 49,
  passed: 49,
  failed: 0,
  skipped: 0,
  testFiles: [
    {
      path: "test/orders.test.ts",
      status: "passed",
      total: 49,
      passed: 49,
      failed: 0,
      skipped: 0,
      durationMs: 120,
      error: null,
      tests: [],
    },
  ],
  durationMs: 120.4,
  reason: null,
  typecheck: {
    argv: ["node", "tsc"],
    exitCode: 0,
    timedOut: false,
    durationMs: 900,
    logsRef: { stdout: "logs/tc/stdout.txt", stderr: "logs/tc/stderr.txt" },
  },
  run: {
    argv: ["node", "vitest"],
    exitCode: 0,
    timedOut: false,
    durationMs: 1500,
    logsRef: { stdout: "logs/run/stdout.txt", stderr: "logs/run/stderr.txt" },
  },
  resultFileCollected: true,
  truncated: false,
};

function sequentialIds() {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

async function loadRubric() {
  const rubric = RubricSchema.parse(
    JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
  );
  return rubric;
}

function syntheticSource(
  overrides: Partial<RequirementResultsSource> = {},
): RequirementResultsSource {
  return {
    startup: HEALTHY_STARTUP,
    serviceExit: {
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stoppedByCaller: true,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 6000,
      startedAt: "2026-09-18T08:59:59.000Z",
      finishedAt: "2026-09-18T09:00:05.000Z",
    },
    serviceLogs: { stdout: "logs/service/stdout.txt", stderr: "logs/service/stderr.txt" },
    harness: syntheticHarness(),
    tests: PASSED_TESTS,
    failure: null,
    stageArtifacts: {
      startup: "stages/startup.json",
      harness: "stages/harness.json",
      tests: "stages/tests.json",
      serviceExit: "stages/serviceExit.json",
    },
    ...overrides,
  };
}

const PASSING_README = {
  path: "README.md",
  exists: true,
  nonEmpty: true,
  lineCount: 20,
  startCommand: { found: true, lines: [12] },
  port: { found: true, lines: [12, 15] },
  pass: true,
  source: { path: "README.md", startLine: 12, endLine: 12 },
  snippet: "PORT=4331 npm start",
};

describe("buildRequirementResults", () => {
  it("전부 PASS인 A형 관측은 기록 12건·근거 13건·판정 15건, 표시 `75~100/100 · 25점 검토 대기`", async () => {
    const rubric = await loadRubric();
    const plan = buildRequirementResults({
      evaluation: {
        id: "eval-1",
        submissionSha: SHA_A,
        rubricVersion: "v1",
        harnessVersion: "h",
        environmentDigest: DIGEST,
      },
      rubric,
      contract: CONTRACT,
      caseSet: DEFAULT_CASE_SET,
      snapshotRef: "submissions/s/snapshot.tar.gz",
      source: syntheticSource(),
      readme: PASSING_README,
      newId: sequentialIds(),
    });
    // 기동 1 + 케이스 10 + 제출 테스트 1
    expect(plan.executionRecords).toHaveLength(12);
    expect(
      plan.executionRecords.map((r) => r.kind).filter((k) => k === "SUBMITTED_TESTS"),
    ).toHaveLength(1);
    // 기록마다 근거 1 + README 근거 1
    expect(plan.evidences).toHaveLength(13);
    expect(plan.criterionResults).toHaveLength(rubric.criteria.length);
    expect(plan.score.display).toBe("75~100/100 · 25점 검토 대기");
    expect(plan.score.pendingCriteria.map((p) => p.criterionId).sort()).toEqual([
      "G1",
      "G2",
      "G3",
      "R-12",
    ]);

    const byId = new Map(plan.criterionResults.map((r) => [r.criterionId, r]));
    for (const id of [
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
    ]) {
      const r = byId.get(id)!;
      expect(r.verdict).toBe("PASS");
      expect(r.earnedPoints).toBe(r.maxPoints);
      expect(r.reviewState).toBe("NOT_REQUIRED");
      expect(r.issueId).toBeUndefined();
      expect(r.interpretation).toBeUndefined();
      expect(r.evidenceIds.length).toBeGreaterThan(0);
      expect(r.observation).toMatch(/하네스 케이스 .* PASS: 검사 2개 모두 통과/);
    }
    // R-10은 기동 관측 근거를 함께 참조한다
    const startupRecord = plan.executionRecords[0]!;
    const startupEvidence = plan.evidences.find((e) => e.runId === startupRecord.id)!;
    expect(byId.get("R-10")!.evidenceIds[0]).toBe(startupEvidence.id);
    expect(byId.get("R-10")!.observation).toMatch(
      /^기동 HEALTHY: \/health 200 \(812ms, 시도 3회\)/,
    );
    expect(byId.get("R-01")!.evidenceIds).not.toContain(startupEvidence.id);
    // README
    expect(byId.get("R-11")).toMatchObject({ verdict: "PASS", earnedPoints: 4, method: "STATIC" });
    const readmeEvidence = plan.evidences.find((e) => e.id === byId.get("R-11")!.evidenceIds[0])!;
    expect(readmeEvidence).toMatchObject({
      source: PASSING_README.source,
      snippet: PASSING_README.snippet,
    });
    expect(readmeEvidence.runId).toBeUndefined();
    // MUTATION·HUMAN_REVIEW
    for (const id of ["G1", "G2", "G3"]) {
      expect(byId.get(id)).toMatchObject({
        verdict: "INCONCLUSIVE",
        earnedPoints: null,
        reviewState: "PENDING",
      });
      expect(byId.get(id)!.observation.startsWith(MUTATION_PENDING_OBSERVATION)).toBe(true);
      expect(byId.get(id)!.observation).toContain("제출 테스트 PASSED: 49/49건 통과");
    }
    expect(byId.get("R-12")).toMatchObject({
      verdict: "INCONCLUSIVE",
      earnedPoints: null,
      reviewState: "PENDING",
      evidenceIds: [],
      observation: HUMAN_REVIEW_PENDING_OBSERVATION,
    });
    // 모든 근거의 runId는 계획 안의 기록을 가리키고, 아티팩트 키는 runs/<runId>/ 아래다
    const recordIds = new Set(plan.executionRecords.map((r) => r.id));
    for (const e of plan.evidences) {
      if (e.runId !== undefined) expect(recordIds.has(e.runId)).toBe(true);
    }
    for (const r of plan.executionRecords) {
      expect(r.inputRef).toBe(`evaluations/eval-1/runs/${r.id}/input.json`);
      expect(plan.artifacts.some((a) => a.key === r.actualRef)).toBe(true);
    }
  });

  it("FAIL 케이스는 issueId·근거·기대/실제 값을 담고 actual 아티팩트가 보고서와 같다", async () => {
    const rubric = await loadRubric();
    const failCase = getCaseSet(DEFAULT_CASE_SET).find((c) => c.criterionIds.includes("R-05"))!;
    const source = syntheticSource({ harness: syntheticHarness(failCase.id) });
    const plan = buildRequirementResults({
      evaluation: {
        id: "eval-2",
        submissionSha: SHA_C,
        rubricVersion: "v1",
        harnessVersion: "h",
        environmentDigest: DIGEST,
      },
      rubric,
      contract: CONTRACT,
      caseSet: DEFAULT_CASE_SET,
      snapshotRef: "submissions/s/snapshot.tar.gz",
      source,
      readme: PASSING_README,
      newId: sequentialIds(),
    });
    const r05 = plan.criterionResults.find((r) => r.criterionId === "R-05")!;
    expect(r05).toMatchObject({
      verdict: "FAIL",
      earnedPoints: 0,
      issueId: `case:${failCase.id}`,
      reviewState: "NOT_REQUIRED",
    });
    expect(r05.observation).toContain(
      `하네스 케이스 ${failCase.id} FAIL(ASSERTION): 검사 3개 중 2개 실패`,
    );
    expect(r05.observation).toContain("p1After.stock: 기대 1, 실제 0");
    expect(r05.interpretation).toBeUndefined();
    expect(plan.score.display).toBe("61~86/100 · 25점 검토 대기");

    const evidence = plan.evidences.find((e) => e.id === r05.evidenceIds[0])!;
    expect(evidence.testId).toBe(failCase.id);
    const record = plan.executionRecords.find((r) => r.id === evidence.runId)!;
    expect(record.failureKind).toBe("ASSERTION");
    const actual = plan.artifacts.find((a) => a.key === record.actualRef)!.body as {
      actual: unknown;
    };
    const reported = source.harness!.results.find((r) => r.caseId === failCase.id)!;
    expect(actual.actual).toEqual(reported.actual);
    const expected = plan.artifacts.find((a) => a.key === record.expectedRef)!.body as {
      expected: unknown;
    };
    expect(expected.expected).toEqual(reported.expected);
    expect(evidence.artifactRefs).toContain(`evaluations/eval-2/runs/${record.id}/timeline.json`);
    expect(evidence.artifactRefs).toContain("logs/service/stdout.txt");

    // 재생 뷰(T-303)가 읽는 core의 느슨한 스키마를 기록 본문이 통과한다 (web은 harness에 의존하지 못한다)
    expect(HarnessCaseExpectedSchema.parse(expected)).toMatchObject({ caseId: failCase.id });
    expect(HarnessCaseActualSchema.parse(actual)).toMatchObject({ caseId: failCase.id });
    const timeline = plan.artifacts.find(
      (a) => a.key === `evaluations/eval-2/runs/${record.id}/timeline.json`,
    )!.body;
    expect(ReplayTimelineSchema.parse(timeline)).toEqual(reported.timeline);
  });

  it("기동 실패면 R-10은 FAIL(기동 기록 근거), 나머지 EXECUTION 기준은 INCONCLUSIVE·PENDING이며 하네스 기록은 없다", async () => {
    const rubric = await loadRubric();
    const plan = buildRequirementResults({
      evaluation: {
        id: "eval-3",
        submissionSha: SHA_C,
        rubricVersion: "v1",
        harnessVersion: "h",
        environmentDigest: DIGEST,
      },
      rubric,
      contract: CONTRACT,
      caseSet: DEFAULT_CASE_SET,
      snapshotRef: "submissions/s/snapshot.tar.gz",
      source: syntheticSource({
        startup: {
          ...HEALTHY_STARTUP,
          outcome: "HEALTH_TIMEOUT",
          lastHealthStatus: null,
          elapsedMs: 10_000,
          reason: "/health가 10000ms 안에 200을 주지 않음",
        },
        serviceExit: null,
        harness: null,
        failure: {
          kind: "SUBMISSION",
          reason: "서비스 기동 실패: /health가 10000ms 안에 200을 주지 않음",
        },
        stageArtifacts: { startup: "stages/startup.json", tests: "stages/tests.json" },
      }),
      readme: { ...PASSING_README, pass: false, port: { found: false, lines: [] } },
      newId: sequentialIds(),
    });
    expect(plan.executionRecords.map((r) => r.kind)).toEqual(["HARNESS", "SUBMITTED_TESTS"]);
    const startupRecord = plan.executionRecords[0]!;
    expect(startupRecord.failureKind).toBe("SUBMISSION");
    const byId = new Map(plan.criterionResults.map((r) => [r.criterionId, r]));
    const r10 = byId.get("R-10")!;
    expect(r10).toMatchObject({ verdict: "FAIL", earnedPoints: 0, issueId: "service-startup" });
    expect(r10.observation).toContain("기동 실패(HEALTH_TIMEOUT)");
    const startupEvidence = plan.evidences.find((e) => e.id === r10.evidenceIds[0])!;
    expect(startupEvidence.runId).toBe(startupRecord.id);
    for (const id of ["R-01", "R-05", "R-08"]) {
      expect(byId.get(id)).toMatchObject({
        verdict: "INCONCLUSIVE",
        earnedPoints: null,
        reviewState: "PENDING",
        evidenceIds: [startupEvidence.id],
      });
      expect(byId.get(id)!.observation).toContain("하네스 미실행");
    }
    expect(byId.get("R-11")).toMatchObject({ verdict: "FAIL", earnedPoints: 0, issueId: "readme" });
    // EXECUTION 9개(65점) + G1~G3(15) + R-12(10) 미확정, R-10·R-11은 0점 확정
    expect(plan.score.display).toBe("0~90/100 · 90점 검토 대기");
  });

  it("정적 관계 근거(T-304)는 케이스 기록을 runId로 참조하고 실행 근거 뒤에 붙으며 점수·판정은 그대로다", async () => {
    const rubric = await loadRubric();
    const base = {
      evaluation: {
        id: "eval-5",
        submissionSha: SHA_A,
        rubricVersion: "v1",
        harnessVersion: "h",
        environmentDigest: DIGEST,
      },
      rubric,
      contract: CONTRACT,
      caseSet: DEFAULT_CASE_SET,
      snapshotRef: "submissions/s/snapshot.tar.gz",
      source: syntheticSource(),
      readme: PASSING_README,
    };
    const without = buildRequirementResults({ ...base, newId: sequentialIds() });
    const withGraph = buildRequirementResults({
      ...base,
      functionGraph: {
        artifactKey: "evaluations/eval-5/analysis/function-graph.json",
        staticRelations: [
          {
            caseId: "R-05-idempotent-resend",
            route: { method: "POST", path: "/orders" },
            source: { path: "src/http/routes.ts", startLine: 25, endLine: 28 },
            snippet: "async (req, res) => { … }",
          },
          {
            caseId: "R-05-idempotent-resend",
            route: { method: "GET", path: "/products/:id" },
            source: { path: "src/http/routes.ts", startLine: 20, endLine: 23 },
            snippet: "async (req, res) => { … }",
          },
          // 보고서에 없는 케이스는 무시한다
          {
            caseId: "R-99-missing",
            route: { method: "GET", path: "/x" },
            source: { path: "src/x.ts", startLine: 1, endLine: 2 },
            snippet: "",
          },
        ],
      },
      newId: sequentialIds(),
    });
    const staticEvidences = withGraph.evidences.filter((e) => e.kind === "STATIC_RELATION");
    expect(staticEvidences).toHaveLength(2);
    expect(withGraph.evidences).toHaveLength(without.evidences.length + 2);
    expect(withGraph.executionRecords).toHaveLength(without.executionRecords.length);
    const r05Record = withGraph.executionRecords.find(
      (r) =>
        r.kind === "HARNESS" &&
        withGraph.evidences.some(
          (e) => e.runId === r.id && e.testId === "R-05-idempotent-resend" && e.kind === undefined,
        ),
    )!;
    for (const e of staticEvidences) {
      expect(e.runId).toBe(r05Record.id);
      expect(e.testId).toBe("R-05-idempotent-resend");
      expect(e.artifactRefs).toEqual(["evaluations/eval-5/analysis/function-graph.json"]);
      expect(e.source?.path).toBe("src/http/routes.ts");
      expect(e.snippet).toContain("=>");
    }
    const r05 = withGraph.criterionResults.find((r) => r.criterionId === "R-05")!;
    const r05Without = without.criterionResults.find((r) => r.criterionId === "R-05")!;
    // 실행 근거가 먼저, 정적 관계 근거가 뒤
    expect(r05.evidenceIds.slice(-2)).toEqual(staticEvidences.map((e) => e.id));
    expect(r05.evidenceIds.length).toBe(r05Without.evidenceIds.length + 2);
    // 판정·점수·issueId·observation은 정적 관계와 무관하다
    expect(
      withGraph.criterionResults.map((r) => [
        r.criterionId,
        r.verdict,
        r.earnedPoints,
        r.issueId,
        r.observation,
      ]),
    ).toEqual(
      without.criterionResults.map((r) => [
        r.criterionId,
        r.verdict,
        r.earnedPoints,
        r.issueId,
        r.observation,
      ]),
    );
    expect(withGraph.score).toEqual(without.score);
  });

  it("같은 관측·같은 ID 순서면 계획이 바이트 단위로 같다 (결정성)", async () => {
    const rubric = await loadRubric();
    const build = () =>
      buildRequirementResults({
        evaluation: {
          id: "eval-4",
          submissionSha: SHA_A,
          rubricVersion: "v1",
          harnessVersion: "h",
          environmentDigest: DIGEST,
        },
        rubric,
        contract: CONTRACT,
        caseSet: DEFAULT_CASE_SET,
        snapshotRef: "submissions/s/snapshot.tar.gz",
        source: syntheticSource(),
        readme: PASSING_README,
        newId: sequentialIds(),
      });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});

// ── DB 통합: 실제 파이프라인으로 A·C·D·크래시 픽스처를 평가하고 저장된 판정을 검사한다 ──

async function readTree(dir: string, base = dir): Promise<FakeRepoFiles> {
  const out: FakeRepoFiles = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) Object.assign(out, await readTree(full, base));
    else out[path.relative(base, full)] = await readFile(full);
  }
  return out;
}

async function crashFixtureFiles(): Promise<FakeRepoFiles> {
  const files = await readTree(path.join(SAMPLES_DIR, "impl-a"));
  files["src/server.ts"] = `import { createServer } from "node:http";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const app = createApp();
let resets = 0;
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/admin/reset") {
    resets += 1;
    if (resets === 3) {
      console.error("simulated crash on third reset");
      process.exit(1);
    }
  }
  app(req, res);
});
server.listen(port, () => {
  console.log(\`order-api listening on port \${port}\`);
});
`;
  return files;
}

/**
 * 문법 오류 픽스처 (T-304): 샘플 A에 서버가 import하지 않는 깨진 파일을 더한다. 서비스는 정상 기동하므로 REQUIREMENT_VERIFY는
 * DONE이지만 관련 함수 그래프 분석은 파싱 진단 때문에 "분석 불가"여야 한다.
 */
async function syntaxErrorFixtureFiles(): Promise<FakeRepoFiles> {
  const files = await readTree(path.join(SAMPLES_DIR, "impl-a"));
  files["src/domain/broken-draft.ts"] = `export function draft( {\n  return 1\n`;
  return files;
}

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/worker] DATABASE_URL_TEST가 없어 판정 저장 통합 테스트를 건너뜁니다");
}

function verdictTable(rows: readonly CriterionResultRow[]) {
  return Object.fromEntries(
    [...rows]
      .sort((a, b) => a.criterionId.localeCompare(b.criterionId))
      .map((r) => [r.criterionId, { verdict: r.verdict, earned: r.earnedPoints }]),
  );
}

/** 모든 감점 판정이 근거를 참조하고, 그 근거의 runId가 저장된 실행 기록을 가리키는지 */
function expectEvidenceIntegrity(results: EvaluationResults) {
  const evidenceById = new Map(results.evidences.map((e) => [e.id, e]));
  const recordIds = new Set(results.executionRecords.map((r) => r.id));
  for (const r of results.criterionResults) {
    expect(r.observation.length).toBeGreaterThan(0);
    expect(r.interpretation).toBeNull();
    if (r.verdict === "FAIL" || (r.earnedPoints !== null && r.earnedPoints < r.maxPoints)) {
      expect(r.evidenceIds.length).toBeGreaterThan(0);
    }
    for (const id of r.evidenceIds) {
      const evidence = evidenceById.get(id);
      expect(evidence, `근거 ${id}가 없음 (${r.criterionId})`).toBeDefined();
      if (r.verdict === "FAIL" && r.method === "EXECUTION") {
        expect(evidence!.runId).not.toBeNull();
        expect(recordIds.has(evidence!.runId!)).toBe(true);
      }
    }
  }
  for (const e of results.evidences) {
    if (e.runId !== null) expect(recordIds.has(e.runId)).toBe(true);
  }
}

describe.skipIf(!hasTestDb)("판정 저장 (DB 통합, 실제 파이프라인)", () => {
  let tdb: TestDatabase;
  let assignmentVersionId: string;
  let contract: ExecutionContract;
  let workRoot: string;
  let store: FsArtifactStore;
  let runner: LocalProcessRunner;
  let github: ReturnType<typeof fakeGitHub>;
  const harnessVersion = harnessVersionOf(getCaseSet(DEFAULT_CASE_SET));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const rubric = await loadRubric();
    contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    const assignment = await createAssignment(tdb.db, { name: "T-205 테스트 과제" });
    const draft = await createAssignmentVersion(tdb.db, {
      assignmentId: assignment.id,
      title: "v1",
      specRef: "assignments/x/specs/spec.md",
      specDigest: "a".repeat(64),
      rubric,
      executionContract: contract,
      harnessVersion,
    });
    await startAssignmentVersionValidation(tdb.db, draft.id);
    const approved = await approveAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "tester",
      validationResult: { ok: true },
    });
    assignmentVersionId = approved.id;

    const [a, c, d, crash, syntax] = await Promise.all([
      readTree(path.join(SAMPLES_DIR, "impl-a")),
      readTree(path.join(SAMPLES_DIR, "impl-c")),
      readTree(path.join(SAMPLES_DIR, "impl-d")),
      crashFixtureFiles(),
      syntaxErrorFixtureFiles(),
    ]);
    github = fakeGitHub({
      "acme/order-api": {
        defaultBranch: "main",
        refs: { main: SHA_A, c: SHA_C, d: SHA_D, crash: SHA_CRASH, syntax: SHA_SYNTAX },
        tarballs: {
          [SHA_A]: () => makeGitHubStyleTarball(a, SHA_A),
          [SHA_C]: () => makeGitHubStyleTarball(c, SHA_C),
          [SHA_D]: () => makeGitHubStyleTarball(d, SHA_D),
          [SHA_CRASH]: () => makeGitHubStyleTarball(crash, SHA_CRASH),
          [SHA_SYNTAX]: () => makeGitHubStyleTarball(syntax, SHA_SYNTAX),
        },
      },
    });
  }, 60_000);

  beforeAll(async () => {
    workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-results-"));
    store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
    runner = new LocalProcessRunner({
      config: { ...LOCAL_RUNNER_DEFAULTS, templateRoot: TEMPLATE_ROOT, workRoot },
      artifactStore: store,
    });
  });
  afterAll(async () => {
    await tdb?.destroy();
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await tdb.db.delete(jobs);
  });

  function deps(): PipelineDeps {
    return {
      db: tdb.db,
      store,
      runner,
      github: createGitHubClient({ fetch: github.fetch }),
      config: {
        stageTimeoutMs: TEST_TIME_BUDGETS.stageMs,
        requestTimeoutMs: TEST_TIME_BUDGETS.harnessRequestMs,
        templateRoot: TEMPLATE_ROOT,
        repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
        workRoot,
        // mutation 실험(T-403)은 `mutation/mutation.test.ts`가 검증한다
        mutation: { enabled: false },
      },
      logger: createLogger({ destination: { write: () => {} }, level: "silent" }),
    };
  }

  type Evaluated = Awaited<ReturnType<typeof evaluateFresh>>;
  const evaluated = new Map<string, Promise<Evaluated>>();

  /** 샘플마다 파이프라인을 한 번만 돌리고 결과를 나눠 쓴다 (샌드박스 실행이 무거워 CPU 경합을 줄인다) */
  function evaluate(repoRef: string): Promise<Evaluated> {
    let pending = evaluated.get(repoRef);
    if (!pending) {
      pending = evaluateFresh(repoRef);
      evaluated.set(repoRef, pending);
    }
    return pending;
  }

  async function evaluateFresh(repoRef: string) {
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: "https://github.com/acme/order-api",
      repoRef,
    });
    const result = await runEvaluationPipeline(
      { submissionId: submission.id, attempt: 1, maxAttempts: 3 },
      deps(),
    );
    const evaluation = (await getEvaluation(tdb.db, result.evaluationId!))!;
    const results = await getEvaluationResults(tdb.db, evaluation.id);
    // 관련 함수 그래프 아티팩트 (T-304)와 REQUIREMENT_VERIFY 단계 detail
    const graphKey = artifactKeys.functionGraph(evaluation.id);
    const graphObject = await store.get(graphKey);
    const graph: FunctionGraphAnalysis | null = graphObject
      ? FunctionGraphAnalysisSchema.parse(
          JSON.parse(Buffer.from(graphObject.body).toString("utf8")),
        )
      : null;
    const verify = evaluation.stageLog.find((s) => s.stage === "REQUIREMENT_VERIFY")!;
    const verifyDetail = verify.detail as Partial<RequirementVerifyDetail> & {
      results?: RequirementResultsSummary;
    };
    return { submission, result, evaluation, results, graphKey, graph, verify, verifyDetail };
  }

  it("A: `75~100/100 · 25점 검토 대기`, 판정 15건, 감점 없음, R-12·G1~G3만 검토 대기", async () => {
    const { result, evaluation, results } = await evaluate("main");
    expect(result.submissionStatus, describeStageLog(result.stageLog)).toBe("COMPLETED");
    expect(evaluation).toMatchObject({
      scoreEarned: 75,
      scoreMin: 75,
      scoreMax: 100,
      pendingPoints: 25,
    });
    const verify = stageRecordOf(evaluation.stageLog, "REQUIREMENT_VERIFY");
    expect(verify.state).toBe("DONE");
    expect(verify.detail?.results).toMatchObject({
      executionRecords: 12,
      criterionResults: 15,
      score: {
        earned: 75,
        min: 75,
        max: 100,
        pendingPoints: 25,
        display: "75~100/100 · 25점 검토 대기",
      },
      readme: { path: "README.md", pass: true },
    });
    expect(results.criterionResults).toHaveLength(15);
    expect(results.executionRecords).toHaveLength(12);
    expectEvidenceIntegrity(results);
    const table = verdictTable(results.criterionResults);
    expect(table).toMatchObject({
      "R-01": { verdict: "PASS", earned: 8 },
      "R-05": { verdict: "PASS", earned: 14 },
      "R-10": { verdict: "PASS", earned: 6 },
      "R-11": { verdict: "PASS", earned: 4 },
      "R-12": { verdict: "INCONCLUSIVE", earned: null },
      G1: { verdict: "INCONCLUSIVE", earned: null },
    });
    expect(
      results.criterionResults
        .filter((r) => r.reviewState === "PENDING")
        .map((r) => r.criterionId)
        .sort(),
    ).toEqual(["G1", "G2", "G3", "R-12"]);
    // 아티팩트가 실제로 있다
    for (const record of results.executionRecords) {
      expect(await store.exists(record.inputRef)).toBe(true);
      expect(await store.exists(record.expectedRef)).toBe(true);
      expect(await store.exists(record.actualRef)).toBe(true);
    }
    // 제출 테스트 기록
    const tests = results.executionRecords.find((r) => r.kind === "SUBMITTED_TESTS")!;
    expect(tests.failureKind).toBe("NONE");
    expect(tests.exitCode).toBe(0);
    const testsActual = JSON.parse(
      Buffer.from((await store.get(tests.actualRef))!.body).toString("utf8"),
    ) as { status: string; total: number };
    expect(testsActual).toMatchObject({ status: "PASSED", total: 49 });
  }, 120_000);

  it("C와 D: `49~74/100 · 25점 검토 대기`, R-05·R-06·R-07 FAIL이 근거를 참조하고 두 샘플의 판정이 같다", async () => {
    const c = await evaluate("c");
    const d = await evaluate("d");
    for (const { result, evaluation, results } of [c, d]) {
      expect(result.submissionStatus, describeStageLog(result.stageLog)).toBe("COMPLETED");
      expect(evaluation).toMatchObject({
        scoreEarned: 49,
        scoreMin: 49,
        scoreMax: 74,
        pendingPoints: 25,
      });
      expectEvidenceIntegrity(results);
      const table = verdictTable(results.criterionResults);
      expect(table["R-05"]).toEqual({ verdict: "FAIL", earned: 0 });
      expect(table["R-06"]).toEqual({ verdict: "FAIL", earned: 0 });
      expect(table["R-07"]).toEqual({ verdict: "FAIL", earned: 0 });
      expect(table["R-01"]).toEqual({ verdict: "PASS", earned: 8 });
      expect(table["R-11"]).toEqual({ verdict: "PASS", earned: 4 });
      const r05 = results.criterionResults.find((r) => r.criterionId === "R-05")!;
      expect(r05.issueId).toMatch(/^case:R-05-/);
      expect(r05.observation).toMatch(/p1After\.stock: 기대 1, 실제 0/);
      expect(r05.interpretation).toBeNull();
    }
    expect(verdictTable(c.results.criterionResults)).toEqual(
      verdictTable(d.results.criterionResults),
    );
    // D의 score.json·README 지시문·항상 통과 테스트는 결과에 영향이 없다 (G-06·G-07)
    const dTests = d.results.executionRecords.find((r) => r.kind === "SUBMITTED_TESTS")!;
    const dTestsActual = JSON.parse(
      Buffer.from((await store.get(dTests.actualRef))!.body).toString("utf8"),
    ) as { total: number };
    expect(dTestsActual.total).toBe(16);

    // 리포트의 actual 값 == ExecutionRecord의 actual 아티팩트
    const verify = stageRecordOf(c.evaluation.stageLog, "REQUIREMENT_VERIFY");
    const harnessKey = (verify.detail!.artifacts as { harness: string }).harness;
    const report = JSON.parse(
      Buffer.from((await store.get(harnessKey))!.body).toString("utf8"),
    ) as HarnessReport;
    const r05 = c.results.criterionResults.find((r) => r.criterionId === "R-05")!;
    const evidence = c.results.evidences.find((e) => e.id === r05.evidenceIds[0])!;
    const record = c.results.executionRecords.find((r) => r.id === evidence.runId)!;
    expect(record.kind).toBe("HARNESS");
    expect(record.failureKind).toBe("ASSERTION");
    const actual = JSON.parse(
      Buffer.from((await store.get(record.actualRef))!.body).toString("utf8"),
    ) as { caseId: string; actual: unknown };
    const reported = report.results.find((r) => r.caseId === evidence.testId)!;
    expect(actual.caseId).toBe(reported.caseId);
    expect(actual.actual).toEqual(reported.actual);
    expect(Object.keys(reported.actual).length).toBeGreaterThan(0);
    const timeline = JSON.parse(
      Buffer.from(
        (await store.get(`evaluations/${c.evaluation.id}/runs/${record.id}/timeline.json`))!.body,
      ).toString("utf8"),
    ) as unknown[];
    expect(timeline).toEqual(reported.timeline);
  }, 240_000);

  it("같은 스냅샷(C)을 두 번 평가하면 기준별 verdict와 earned가 같다", async () => {
    const first = await evaluate("c");
    const second = await evaluateFresh("c");
    expect(first.evaluation.id).not.toBe(second.evaluation.id);
    expect(verdictTable(first.results.criterionResults)).toEqual(
      verdictTable(second.results.criterionResults),
    );
    expect(second.evaluation.scoreEarned).toBe(first.evaluation.scoreEarned);
    // 실행 기록은 평가마다 새로 만든다 (G-03)
    const firstIds = new Set(first.results.executionRecords.map((r) => r.id));
    expect(second.results.executionRecords.some((r) => firstIds.has(r.id))).toBe(false);
  }, 240_000);

  it("하네스 중 크래시: 끝난 케이스는 PASS로 저장, 나머지는 INCONCLUSIVE·PENDING, 점수는 확정분만", async () => {
    const { result, evaluation, results } = await evaluate("crash");
    expect(result.submissionStatus).toBe("FAILED");
    const verify = stageRecordOf(evaluation.stageLog, "REQUIREMENT_VERIFY");
    expect(verify.state).toBe("FAILED");
    expect(verify.detail?.results).toMatchObject({ criterionResults: 15 });
    expectEvidenceIntegrity(results);
    const table = verdictTable(results.criterionResults);
    expect(table["R-01"]).toEqual({ verdict: "PASS", earned: 8 });
    expect(table["R-02"]).toEqual({ verdict: "PASS", earned: 6 });
    expect(table["R-11"]).toEqual({ verdict: "PASS", earned: 4 });
    for (const id of ["R-03", "R-04", "R-05", "R-06", "R-07", "R-08", "R-09", "R-10"]) {
      expect(table[id]).toEqual({ verdict: "INCONCLUSIVE", earned: null });
    }
    expect(evaluation).toMatchObject({
      scoreEarned: 18,
      scoreMin: 18,
      scoreMax: 100,
      pendingPoints: 82,
    });
    // 크래시한 서비스의 종료 코드가 기록에 남는다
    const harnessRecords = results.executionRecords.filter((r) => r.kind === "HARNESS");
    expect(harnessRecords.every((r) => r.exitCode === 1)).toBe(true);
    const inconclusive = results.criterionResults.find((r) => r.criterionId === "R-05")!;
    expect(inconclusive.reviewState).toBe("PENDING");
    expect(inconclusive.observation).toMatch(/INCONCLUSIVE\(ENVIRONMENT\)/);
  }, 120_000);

  it("재시도 경로: 단계는 끝났지만 판정이 없으면 단계 원문에서 되살려 같은 판정을 저장한다", async () => {
    const a = await evaluate("main");
    const verify = stageRecordOf(a.evaluation.stageLog, "REQUIREMENT_VERIFY");
    const source = await loadRequirementResultsSource(store, verify);
    expect(source.harness?.results).toHaveLength(10);
    expect(source.tests.status).toBe((verify.detail?.tests as { status: string }).status);
    expect(source.failure).toBeNull();

    // 판정이 없는 새 평가 행에 같은 원문으로 저장한다
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: "https://github.com/acme/order-api",
    });
    const fresh = await createEvaluation(tdb.db, {
      submissionId: submission.id,
      assignmentVersionId,
      rubricVersion: a.evaluation.rubricVersion,
      harnessVersion,
      environmentDigest: a.evaluation.environmentDigest,
      submissionSha: SHA_A,
    });
    await updateEvaluationStage(tdb.db, fresh.id, "REQUIREMENT_VERIFY", { state: "RUNNING" });
    await updateEvaluationStage(tdb.db, fresh.id, "REQUIREMENT_VERIFY", {
      state: "DONE",
      detail: verify.detail,
    });
    const version = (await tdb.db.query.assignmentVersions.findFirst({
      where: (t, { eq }) => eq(t.id, assignmentVersionId),
    }))!;
    const files = memoryFiles({ "README.md": "PORT=1 npm start\n" });
    const { summary, saved } = await persistRequirementResults(
      {
        evaluation: {
          id: fresh.id,
          submissionSha: SHA_A,
          rubricVersion: a.evaluation.rubricVersion,
          harnessVersion,
          environmentDigest: a.evaluation.environmentDigest,
        },
        rubric: version.rubric,
        contract,
        caseSet: DEFAULT_CASE_SET,
        snapshotRef: (await getSubmission(tdb.db, a.submission.id))!.snapshotRef!,
        source,
        readme: await checkReadme(files, contract),
      },
      { db: tdb.db, store },
    );
    expect(summary.score.display).toBe("75~100/100 · 25점 검토 대기");
    expect(verdictTable(saved.criterionResults)).toEqual(verdictTable(a.results.criterionResults));
  }, 120_000);

  it("A: 관련 함수 그래프(T-304) 아티팩트가 저장되고 관측 노드가 timeline의 라우트와 일치하며 정적 관계 근거가 붙는다", async () => {
    const { results, graph, verifyDetail, graphKey } = await evaluate("main");
    expect(graph?.status).toBe("ok");
    if (graph?.status !== "ok") throw new Error("unreachable");
    expect(verifyDetail.results?.functionGraph).toMatchObject({
      artifactKey: graphKey,
      status: "ok",
      routes: 6,
    });
    const post = graph.routes.find((r) => r.method === "POST" && r.path === "/orders")!;
    expect(post.handler.location).toEqual({
      path: "src/http/routes.ts",
      startLine: 25,
      endLine: 28,
    });

    // 하네스 보고서의 timeline과 대조: 케이스마다 관측 노드 = timeline 요청에 매치된 라우트의 핸들러
    const harness = HarnessReportSchema.parse(
      JSON.parse(
        Buffer.from((await store.get(verifyDetail.artifacts!.harness!))!.body).toString("utf8"),
      ),
    );
    expect(graph.cases.map((c) => c.caseId)).toEqual(harness.results.map((r) => r.caseId));
    const routeOf = (method: string, requestPath: string) =>
      graph.routes.find((r) => {
        if (r.method !== method) return false;
        const pattern = r.path.split("/").filter(Boolean);
        const actual = requestPath.split("?")[0]!.split("/").filter(Boolean);
        return (
          pattern.length === actual.length &&
          pattern.every((seg, i) => seg.startsWith(":") || seg === actual[i])
        );
      });
    for (const sub of graph.cases) {
      expect(sub.nodes.length).toBeLessThanOrEqual(MAX_SUBGRAPH_NODES);
      const caseResult = harness.results.find((r) => r.caseId === sub.caseId)!;
      const expectedObserved = new Set(
        caseResult.timeline
          .map((e) => routeOf(e.request.method, e.request.path))
          .filter((r) => r !== undefined)
          .map((r) => r.handler.id),
      );
      for (const node of sub.nodes) {
        if (node.route) {
          expect(node.observed, `${sub.caseId} ${node.name}`).toBe(expectedObserved.has(node.id));
        } else {
          expect(node.observed).toBe(false);
        }
      }
      expect(sub.unmatchedRequests).toEqual([]);
    }
    const r05 = graph.cases.find((c) => c.caseId === "R-05-idempotent-resend")!;
    expect(r05.roots).toEqual([
      { method: "GET", path: "/products/:id" },
      { method: "POST", path: "/orders" },
      { method: "GET", path: "/orders/:id" },
    ]);

    // 정적 관계 근거: 케이스 기록을 runId로 참조하고 그래프 아티팩트를 가리킨다
    const staticEvidences = results.evidences.filter((e) => e.kind === "STATIC_RELATION");
    const summary = verifyDetail.results!.functionGraph!;
    expect(staticEvidences.length).toBe(summary.status === "ok" ? summary.staticRelations : 0);
    expect(staticEvidences.length).toBeGreaterThan(0);
    const recordById = new Map(results.executionRecords.map((r) => [r.id, r]));
    for (const e of staticEvidences) {
      expect(e.runId).not.toBeNull();
      expect(recordById.get(e.runId!)?.kind).toBe("HARNESS");
      expect(e.artifactRefs).toEqual([graphKey]);
      expect(e.source?.path).toBe("src/http/routes.ts");
      expect(e.snippet).toContain("=>");
    }
    const r05Result = results.criterionResults.find((r) => r.criterionId === "R-05")!;
    const r05Static = staticEvidences.filter((e) => e.testId === "R-05-idempotent-resend");
    expect(r05Static.length).toBe(3);
    for (const e of r05Static) expect(r05Result.evidenceIds).toContain(e.id);
    // 첫 근거는 실행 기록(재생 뷰 기본 선택)이다
    const first = results.evidences.find((e) => e.id === r05Result.evidenceIds[0])!;
    expect(first.kind).toBeNull();
  }, 120_000);

  it("문법 오류 픽스처(T-304): 단계는 DONE이고 그래프는 `unavailable`이며 사유에 파일·라인이 있다", async () => {
    const { result, verify, graph, verifyDetail, results } = await evaluate("syntax");
    expect(result.submissionStatus, describeStageLog(result.stageLog)).toBe("COMPLETED");
    expect(verify.state).toBe("DONE");
    expect(graph?.status).toBe("unavailable");
    if (graph?.status !== "unavailable") throw new Error("unreachable");
    expect(graph.reason).toMatch(/^문법 오류: src\/domain\/broken-draft\.ts:\d+ /);
    expect(verifyDetail.results?.functionGraph).toMatchObject({
      status: "unavailable",
      reason: graph.reason,
    });
    // 정적 관계 근거는 없고 판정은 그대로 저장된다
    expect(results.evidences.some((e) => e.kind === "STATIC_RELATION")).toBe(false);
    expect(results.criterionResults).toHaveLength(15);
    expect(verdictTable(results.criterionResults)).toEqual(
      verdictTable((await evaluate("main")).results.criterionResults),
    );
  }, 120_000);
});
