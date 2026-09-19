import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EvaluationReportSchema,
  ExecutionContractSchema,
  RubricSchema,
  type EvaluationReport,
  type Rubric,
  type RunRecordReport,
  type Verdict,
} from "@ohmyti/core";
import {
  canonicalJson,
  checkDeterminism,
  compareReport,
  evaluationDigest,
  expectedAtPhase,
  expectedAtPhase2,
  expectedStageStates,
  gateResultJson,
  planSubmissions,
  renderReport,
  renderTable,
  SampleReposSchema,
  submittedTestsOf,
  type GatePhase,
  type GateRunSummary,
  type RunDigest,
  type SubmissionRun,
} from "./gate-phase2";
import { ExpectedMatrixSchema, SAMPLE_DIR } from "./samples-check";

const rubric: Rubric = RubricSchema.parse(
  JSON.parse(readFileSync(path.join(SAMPLE_DIR, "rubric.v1.json"), "utf8")),
);
const contract = ExecutionContractSchema.parse(
  JSON.parse(readFileSync(path.join(SAMPLE_DIR, "execution-contract.json"), "utf8")),
);
const matrix = ExpectedMatrixSchema.parse(
  JSON.parse(readFileSync(path.join(SAMPLE_DIR, "expected-matrix.json"), "utf8")),
);
const sampleA = matrix.samples.find((s) => s.id === "A")!;
const sampleC = matrix.samples.find((s) => s.id === "C")!;

const SHA = "4bee62eb91e92166bc4d6a0618d4aeb86c99fa81";
const DIGEST = "2044a2e63de05a7fa5be2f53d0693ecd2ea2b95df754926b0ee50473734c0b07";
const TS = "2026-09-18T00:00:00.000Z";
const EXECUTION_CASES = new Map<string, string>(
  rubric.criteria.filter((c) => c.method === "EXECUTION").map((c) => [c.id, `case-${c.id}`]),
);

interface Fixture {
  report: EvaluationReport;
  runs: RunRecordReport[];
}

/**
 * 배포 API가 돌려줄 리포트와 run 본문을 흉내 낸다. `failing`에 든 EXECUTION 기준은 FAIL(0점), 나머지는 PASS(만점),
 * MUTATION·HUMAN_REVIEW는 INCONCLUSIVE(null), R-11은 PASS다.
 */
function fixture(
  options: {
    failing?: readonly string[];
    status?: EvaluationReport["submission"]["status"];
    sha?: string;
    tests?: { status: string; total: number; files: number };
    stagesDone?: boolean;
    /** 기본 2. 4 이상이면 TEST_EFFECTIVENESS·REVIEW_WRITE(5면 CONTEXT_LINK까지) DONE */
    phase?: GatePhase;
    /** MUTATION 기준(G1~G3) 판정. 없으면 INCONCLUSIVE(null) */
    groups?: Record<string, { verdict: Verdict; earnedPoints: number | null }>;
  } = {},
): Fixture {
  const failing = options.failing ?? [];
  const phase = options.phase ?? 2;
  const evaluationId = "eval-1";
  const records: EvaluationReport["executionRecords"] = [];
  const evidences: EvaluationReport["evidences"] = [];
  const runs: RunRecordReport[] = [];
  const addRun = (
    id: string,
    kind: "HARNESS" | "SUBMITTED_TESTS",
    input: RunRecordReport["input"],
    actual: RunRecordReport["actual"],
    testId?: string,
  ) => {
    const record: EvaluationReport["executionRecords"][number] = {
      id,
      submissionSha: options.sha ?? SHA,
      rubricVersion: rubric.version,
      harnessVersion: "0.1.0+e363f5fc77e72aa6",
      environmentDigest: DIGEST,
      inputRef: `evaluations/${evaluationId}/runs/${id}/input.json`,
      expectedRef: `evaluations/${evaluationId}/runs/${id}/expected.json`,
      actualRef: `evaluations/${evaluationId}/runs/${id}/actual.json`,
      exitCode: null,
      failureKind: "NONE",
      evaluationId,
      kind,
    };
    const evidence: EvaluationReport["evidences"][number] = {
      id: `ev-${id}`,
      submissionSha: options.sha ?? SHA,
      runId: id,
      ...(testId ? { testId } : {}),
      artifactRefs: [record.actualRef],
      evaluationId,
    };
    records.push(record);
    evidences.push(evidence);
    runs.push({
      evaluationId,
      runId: id,
      record,
      evidences: [evidence],
      input,
      expected: { kind },
      actual,
      timeline: null,
      logs: { stdout: [], stderr: [] },
    });
    return evidence.id;
  };

  const startupEvidence = addRun(
    "run-startup",
    "HARNESS",
    { kind: "SERVICE_STARTUP" },
    { startup: { outcome: "HEALTHY", lastHealthStatus: 200, elapsedMs: 512 } },
  );
  const caseEvidence = new Map<string, string>();
  for (const [criterionId, caseId] of EXECUTION_CASES) {
    const verdict = failing.includes(criterionId) ? "FAIL" : "PASS";
    caseEvidence.set(
      criterionId,
      addRun(
        `run-${caseId}`,
        "HARNESS",
        { kind: "HARNESS_CASE", caseId },
        {
          caseId,
          verdict,
          failureKind: verdict === "FAIL" ? "ASSERTION" : "NONE",
          actual: { status: 201 },
          checks: [{ name: "status", ok: verdict === "PASS" }],
        },
        caseId,
      ),
    );
  }
  const tests = options.tests ?? { status: "PASSED", total: 49, files: 7 };
  const testsEvidence = addRun(
    "run-tests",
    "SUBMITTED_TESTS",
    { kind: "SUBMITTED_TESTS", framework: "vitest" },
    {
      status: tests.status,
      failureKind: "NONE",
      framework: "vitest",
      total: tests.total,
      passed: tests.total,
      failed: 0,
      skipped: 0,
      durationMs: 1234,
      testFiles: Array.from({ length: tests.files }, (_, i) => ({
        path: `test/f${i}.test.ts`,
        status: "passed",
        tests: [{ fullName: `f${i} > t`, status: "passed" }],
      })),
    },
  );

  const criterionResults: EvaluationReport["criterionResults"] = rubric.criteria.map((c) => {
    const base = {
      criterionId: c.id,
      rubricVersion: rubric.version,
      maxPoints: c.maxPoints,
      method: c.method,
      observation: "관측",
      evaluationId,
    };
    if (c.method === "EXECUTION") {
      const fail = failing.includes(c.id);
      return {
        ...base,
        verdict: (fail ? "FAIL" : "PASS") as Verdict,
        earnedPoints: fail ? 0 : c.maxPoints,
        evidenceIds: [caseEvidence.get(c.id)!, ...(c.id === "R-10" ? [startupEvidence] : [])],
        ...(fail ? { issueId: `case:${EXECUTION_CASES.get(c.id)}` } : {}),
        reviewState: "NOT_REQUIRED" as const,
      };
    }
    if (c.method === "STATIC") {
      return {
        ...base,
        verdict: "PASS" as Verdict,
        earnedPoints: c.maxPoints,
        evidenceIds: [],
        reviewState: "NOT_REQUIRED" as const,
      };
    }
    const group = c.method === "MUTATION" ? options.groups?.[c.id] : undefined;
    if (group) {
      return {
        ...base,
        verdict: group.verdict,
        earnedPoints: group.earnedPoints,
        evidenceIds: [testsEvidence],
        reviewState: group.earnedPoints === null ? ("PENDING" as const) : ("NOT_REQUIRED" as const),
      };
    }
    return {
      ...base,
      verdict: "INCONCLUSIVE" as Verdict,
      earnedPoints: null,
      evidenceIds: c.method === "MUTATION" ? [testsEvidence] : [],
      reviewState: "PENDING" as const,
    };
  });
  const earned = criterionResults.reduce((sum, r) => sum + (r.earnedPoints ?? 0), 0);
  const pending = criterionResults
    .filter((r) => r.earnedPoints === null)
    .reduce((sum, r) => sum + r.maxPoints, 0);
  const stagesDone = options.stagesDone ?? true;
  const report = EvaluationReportSchema.parse({
    evaluation: {
      id: evaluationId,
      submissionId: "sub-1",
      assignmentVersionId: "ver-1",
      rubricVersion: rubric.version,
      harnessVersion: "0.1.0+e363f5fc77e72aa6",
      environmentDigest: DIGEST,
      submissionSha: options.sha ?? SHA,
      isSample: false,
      createdAt: TS,
      finishedAt: TS,
    },
    submission: {
      id: "sub-1",
      status: options.status ?? "COMPLETED",
      repoUrl: "https://github.com/inchyangv/ohmyti-sample-a",
      repoRef: SHA,
      isSample: false,
    },
    assignment: { id: "as-1", name: "주문·재고 API", version: 1, title: "v1" },
    rubric,
    executionContract: contract,
    score: {
      earned,
      min: earned,
      max: earned + pending,
      pendingPoints: pending,
      total: 100,
      display:
        pending === 0
          ? `${earned}/100`
          : `${earned}~${earned + pending}/100 · ${pending}점 검토 대기`,
      // 게이트는 영역 소계를 대조하지 않는다 (T-302 이전 평가처럼 null)
      byArea: null,
    },
    criterionResults,
    evidences,
    executionRecords: records,
    stages: [
      { stage: "REPO_CHECK", state: "DONE" },
      { stage: "ENV_PREP", state: "DONE" },
      { stage: "REQUIREMENT_VERIFY", state: stagesDone ? "DONE" : "FAILED" },
      ...(["TEST_EFFECTIVENESS", "REVIEW_WRITE", "CONTEXT_LINK"] as const).map((stage) =>
        expectedStageStates(phase)[stage] === "DONE"
          ? { stage, state: "DONE" as const }
          : { stage, state: "SKIPPED" as const, reason: "not_implemented" },
      ),
    ],
    reviewEvents: [],
    mutationExperiments: [],
  });
  return { report, runs };
}

describe("expectedAtPhase2", () => {
  it("EXECUTION·STATIC은 기대 결과표, MUTATION·HUMAN_REVIEW는 INCONCLUSIVE(null)", () => {
    expect(expectedAtPhase2("EXECUTION", { verdict: "FAIL", earnedPoints: 0 })).toEqual({
      verdict: "FAIL",
      earnedPoints: 0,
    });
    expect(expectedAtPhase2("STATIC", { verdict: "PASS", earnedPoints: 4 })).toEqual({
      verdict: "PASS",
      earnedPoints: 4,
    });
    expect(expectedAtPhase2("MUTATION", { verdict: "PASS", earnedPoints: 5 })).toEqual({
      verdict: "INCONCLUSIVE",
      earnedPoints: null,
    });
    expect(expectedAtPhase2("HUMAN_REVIEW", undefined)).toEqual({
      verdict: "INCONCLUSIVE",
      earnedPoints: null,
    });
    expect(expectedAtPhase2("EXECUTION", undefined)).toBeNull();
  });
});

describe("단계별 기대값 (T-507)", () => {
  it("4단계부터 MUTATION은 기대 결과표를 따르고 HUMAN_REVIEW는 표대로 INCONCLUSIVE다", () => {
    const cell = { verdict: "FAIL" as Verdict, earnedPoints: 0 };
    expect(expectedAtPhase(2, "MUTATION", cell)).toEqual({
      verdict: "INCONCLUSIVE",
      earnedPoints: null,
    });
    expect(expectedAtPhase(4, "MUTATION", cell)).toEqual(cell);
    expect(expectedAtPhase(5, "MUTATION", cell)).toEqual(cell);
    expect(
      expectedAtPhase(5, "HUMAN_REVIEW", { verdict: "INCONCLUSIVE", earnedPoints: null }),
    ).toEqual({ verdict: "INCONCLUSIVE", earnedPoints: null });
    expect(expectedAtPhase(5, "EXECUTION", undefined)).toBeNull();
  });

  it("단계 상태: 2는 뒤 세 단계 SKIPPED, 4는 CONTEXT_LINK만 SKIPPED, 5는 모두 DONE", () => {
    expect(Object.values(expectedStageStates(2)).filter((s) => s === "SKIPPED")).toHaveLength(3);
    expect(expectedStageStates(4)).toMatchObject({
      TEST_EFFECTIVENESS: "DONE",
      REVIEW_WRITE: "DONE",
      CONTEXT_LINK: "SKIPPED",
    });
    expect(Object.values(expectedStageStates(5)).every((s) => s === "DONE")).toBe(true);
  });

  it("5단계: 결함 C 리포트(G1 FAIL·G2 미확정·G3 PASS, 모든 단계 DONE)는 beforeHumanReview와 일치한다", () => {
    const { report, runs } = fixture({
      phase: 5,
      failing: ["R-05", "R-06", "R-07"],
      tests: { status: "PASSED", total: 11, files: 3 },
      groups: {
        G1: { verdict: "FAIL", earnedPoints: 0 },
        G2: { verdict: "INCONCLUSIVE", earnedPoints: null },
        G3: { verdict: "PASS", earnedPoints: 5 },
      },
    });
    const c = compareReport(rubric, sampleC, report, runs, SHA, 5);
    expect(c.mismatches).toEqual([]);
    expect(c.scoreDisplay).toEqual({
      expected: "54~69/100 · 15점 검토 대기",
      actual: "54~69/100 · 15점 검토 대기",
      ok: true,
    });
    // 같은 리포트를 2단계 기대값으로 보면 MUTATION·점수·단계 상태가 모두 어긋난다
    const asPhase2 = compareReport(rubric, sampleC, report, runs, SHA, 2);
    expect(asPhase2.mismatches.filter((m) => /^G[13]:/.test(m))).toHaveLength(2);
    expect(asPhase2.mismatches.some((m) => m.startsWith("점수 표시"))).toBe(true);
    expect(asPhase2.mismatches).toContain("단계 CONTEXT_LINK: 기대 SKIPPED(미구현) ≠ 실제 DONE");
  });

  it("5단계 기대값에서 단계가 SKIPPED로 남으면 불일치다", () => {
    const { report, runs } = fixture({ phase: 4 });
    const c = compareReport(rubric, sampleA, report, runs, SHA, 5);
    expect(c.mismatches).toContain("단계 CONTEXT_LINK: 기대 DONE ≠ 실제 SKIPPED");
  });
});

describe("compareReport", () => {
  it("정답 A 리포트는 불일치가 없고 점수 표시가 withoutMutationStage와 같다", () => {
    const { report, runs } = fixture();
    const c = compareReport(rubric, sampleA, report, runs, SHA, 2);
    expect(c.mismatches).toEqual([]);
    expect(c.rows.every((r) => r.ok)).toBe(true);
    expect(c.scoreDisplay).toEqual({
      expected: "75~100/100 · 25점 검토 대기",
      actual: "75~100/100 · 25점 검토 대기",
      ok: true,
    });
    expect(c.tests.ok).toBe(true);
  });

  it("결함 C 리포트(R-05·R-06·R-07 FAIL, 11건/3파일)는 C의 기대와 일치하고 A의 기대와는 어긋난다", () => {
    const { report, runs } = fixture({
      failing: ["R-05", "R-06", "R-07"],
      tests: { status: "PASSED", total: 11, files: 3 },
    });
    expect(compareReport(rubric, sampleC, report, runs, SHA, 2).mismatches).toEqual([]);
    const againstA = compareReport(rubric, sampleA, report, runs, SHA, 2);
    expect(againstA.mismatches.filter((m) => /^R-0[567]:/.test(m))).toHaveLength(3);
    expect(againstA.mismatches.some((m) => m.startsWith("점수 표시"))).toBe(true);
    expect(againstA.mismatches.some((m) => m.startsWith("제출 테스트"))).toBe(true);
    expect(againstA.rows.find((r) => r.criterionId === "R-05")?.actual?.issueId).toBe(
      "case:case-R-05",
    );
  });

  it("상태·고정 SHA·단계 상태가 기대와 다르면 불일치로 잡는다", () => {
    const { report, runs } = fixture({ status: "FAILED", stagesDone: false });
    const c = compareReport(rubric, sampleA, report, runs, "0".repeat(40), 2);
    expect(c.mismatches).toEqual(
      expect.arrayContaining([
        expect.stringContaining("제출 상태: 기대 COMPLETED ≠ 실제 FAILED"),
        expect.stringContaining("고정 SHA"),
        expect.stringContaining("단계 REQUIREMENT_VERIFY: 기대 DONE ≠ 실제 FAILED"),
      ]),
    );
  });

  it("제출 테스트 기록이 없으면 제출 테스트 불일치다", () => {
    const { report, runs } = fixture();
    const withoutTests = runs.filter((r) => r.record.kind !== "SUBMITTED_TESTS");
    expect(submittedTestsOf(withoutTests)).toBeNull();
    const c = compareReport(rubric, sampleA, report, withoutTests, SHA, 2);
    expect(c.mismatches.some((m) => m.includes("제출 테스트") && m.includes("없음"))).toBe(true);
  });
});

describe("evaluationDigest · checkDeterminism", () => {
  it("판정이 같으면 ID·시각이 달라도 digest가 같고, 판정이 다르면 다르다", () => {
    const a1 = fixture();
    const a2 = fixture();
    // 레코드 ID·시각·소요 시간을 바꿔도 digest는 같아야 한다
    a2.report.evaluation.id = "eval-2";
    a2.report.evaluation.createdAt = "2026-09-18T01:00:00.000Z";
    for (const r of a2.runs) {
      (r.actual as { durationMs?: number }).durationMs = 999;
    }
    expect(evaluationDigest(a1.report, a1.runs)).toBe(evaluationDigest(a2.report, a2.runs));
    const c = fixture({ failing: ["R-05"] });
    expect(evaluationDigest(c.report, c.runs)).not.toBe(evaluationDigest(a1.report, a1.runs));
    expect(evaluationDigest(a1.report, a1.runs)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("LLM 추정 근거(LLM_INTERPRETATION) 수가 달라도 digest가 같고, 실행·정적 근거 수가 다르면 다르다 (T-507)", () => {
    const base = fixture();
    const withLlm = fixture();
    const r12 = withLlm.report.criterionResults.find((r) => r.criterionId === "R-12")!;
    for (const id of ["ev-llm-1", "ev-llm-2"]) {
      withLlm.report.evidences.push({
        id,
        submissionSha: SHA,
        kind: "LLM_INTERPRETATION",
        artifactRefs: [],
        evaluationId: "eval-1",
      });
      r12.evidenceIds.push(id);
    }
    expect(evaluationDigest(withLlm.report, withLlm.runs)).toBe(
      evaluationDigest(base.report, base.runs),
    );
    const withStatic = fixture();
    withStatic.report.evidences.push({
      id: "ev-static",
      submissionSha: SHA,
      kind: "STATIC_RELATION",
      artifactRefs: [],
      evaluationId: "eval-1",
    });
    withStatic.report.criterionResults
      .find((r) => r.criterionId === "R-12")!
      .evidenceIds.push("ev-static");
    expect(evaluationDigest(withStatic.report, withStatic.runs)).not.toBe(
      evaluationDigest(base.report, base.runs),
    );
  });

  it("같은 샘플의 회차별 digest가 다르면 문제로 보고한다", () => {
    const digests: RunDigest[] = [
      { sampleId: "A", round: 1, submissionId: "s1", evaluationId: "e1", digest: "aa" },
      { sampleId: "A", round: 2, submissionId: "s2", evaluationId: "e2", digest: "aa" },
      { sampleId: "C", round: 1, submissionId: "s3", evaluationId: "e3", digest: "cc" },
      { sampleId: "C", round: 2, submissionId: "s4", evaluationId: "e4", digest: "cd" },
    ];
    const problems = checkDeterminism(digests);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("C:");
  });

  it("canonicalJson은 키 순서가 달라도 같은 문자열을 만든다", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });
});

describe("planSubmissions", () => {
  it("샘플마다 1회 + 반복 샘플은 repeat회, 제출 순서는 회차 순이다", () => {
    expect(planSubmissions(["A", "B", "C", "D"], 3, ["A", "C"])).toEqual([
      { sampleId: "A", round: 1 },
      { sampleId: "B", round: 1 },
      { sampleId: "C", round: 1 },
      { sampleId: "D", round: 1 },
      { sampleId: "A", round: 2 },
      { sampleId: "C", round: 2 },
      { sampleId: "A", round: 3 },
      { sampleId: "C", round: 3 },
    ]);
    // 실행 대상에 없는 샘플은 반복하지 않는다
    expect(planSubmissions(["B"], 3, ["A"])).toEqual([{ sampleId: "B", round: 1 }]);
  });
});

describe("sample-repos.json", () => {
  it("샘플 A/B/C/D와 미지원 저장소의 URL·SHA가 있다", () => {
    const repos = SampleReposSchema.parse(
      JSON.parse(readFileSync(path.join(SAMPLE_DIR, "sample-repos.json"), "utf8")),
    );
    expect(Object.keys(repos.samples).sort()).toEqual(["A", "B", "C", "D"]);
    expect(repos.unsupported.expectedReasonCode).toBe("UNSUPPORTED_LANGUAGE");
    for (const entry of [...Object.values(repos.samples), repos.unsupported]) {
      expect(entry.url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    }
  });
});

describe("renderReport · gateResultJson", () => {
  function summaryOf(): GateRunSummary {
    const a = fixture();
    const c = fixture({
      failing: ["R-05", "R-06", "R-07"],
      tests: { status: "PASSED", total: 11, files: 3 },
    });
    const run = (
      sampleId: SubmissionRun["sampleId"],
      round: number,
      f: Fixture,
      expected: typeof sampleA,
    ): SubmissionRun => ({
      sampleId,
      round,
      submissionId: `sub-${sampleId}-${round}`,
      evaluationId: `eval-${sampleId}-${round}`,
      status: "COMPLETED",
      submittedAt: TS,
      finishedAt: TS,
      waitMs: 70_000,
      comparison: compareReport(rubric, expected, f.report, f.runs, SHA, 2),
      digest: evaluationDigest(f.report, f.runs),
    });
    return {
      baseUrl: "https://ohmyti.vercel.app",
      phase: 2,
      startedAt: TS,
      finishedAt: TS,
      totalMs: 600_000,
      assignmentVersion: {
        id: "ver-1",
        label: "주문·재고 API · v1 · 승인됨",
        rubricVersion: "v1-be07fb44",
      },
      reposPath: "samples/order-api/sample-repos.json",
      repos: SampleReposSchema.parse(
        JSON.parse(readFileSync(path.join(SAMPLE_DIR, "sample-repos.json"), "utf8")),
      ),
      matrixPath: "samples/order-api/expected-matrix.json",
      runs: [run("A", 1, a, sampleA), run("C", 1, c, sampleC), run("A", 2, a, sampleA)],
      determinismProblems: [],
      unsupported: {
        repoUrl: "https://github.com/inchyangv/ohmyti-sample-python",
        submissionId: "sub-py",
        status: "UNSUPPORTED",
        unsupportedReason: "UNSUPPORTED_LANGUAGE: TypeScript·JavaScript 소스가 없습니다",
        expectedReasonCode: "UNSUPPORTED_LANGUAGE",
        apiOk: true,
        htmlOk: true,
        problems: [],
      },
      ok: true,
    };
  }

  it("기록에 결과·표·결정성·미지원 절이 있고 JSON 요약이 회차별 digest를 담는다", () => {
    const summary = summaryOf();
    const md = renderReport(rubric, summary);
    expect(md).toContain("# 2단계 게이트: 배포 환경 E2E (T-208)");
    expect(md).toContain("- 결과: **통과**");
    expect(md).toContain("- 기대값 기준: 2단계 배포");
    expect(md).toContain("| R-05 | EXECUTION | 14 | PASS 14 → PASS 14 ✓ | FAIL 0 → FAIL 0 ✓ |");
    expect(md).toContain("## 결정성");
    expect(md).toContain("| A | https://github.com/inchyangv/ohmyti-sample-a | `");
    expect(md).toContain("| A | `");
    expect(md).toContain("| ✓ |");
    expect(md).toContain("UNSUPPORTED_LANGUAGE");
    expect(renderTable(rubric, summary.runs)).toContain("| 점수 표시 | - | - |");

    const json = gateResultJson(summary) as { gate: string; runs: { digest: string | null }[] };
    expect(json.gate).toBe("phase2");
    expect(json.runs).toHaveLength(3);
    expect(json.runs[0]!.digest).toBe(json.runs[2]!.digest);
  });
});
