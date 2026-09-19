import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RubricSchema, type Rubric } from "@ohmyti/core";
import type { CaseResult, HarnessReport } from "@ohmyti/harness";
import type { ServiceStartupObservation, SubmittedTestResult } from "@ohmyti/runner";
import {
  canonicalJson,
  checkDeterminism,
  compareSample,
  deriveCriteria,
  foldVerdicts,
  gateResultJson,
  judgementDigest,
  renderReport,
  renderTable,
  type GateRunSummary,
  type SampleObservation,
} from "./gate-phase1";
import { ExpectedMatrixSchema, SAMPLE_DIR } from "./samples-check";

const rubric: Rubric = RubricSchema.parse(
  JSON.parse(readFileSync(path.join(SAMPLE_DIR, "rubric.v1.json"), "utf8")),
);
const matrix = ExpectedMatrixSchema.parse(
  JSON.parse(readFileSync(path.join(SAMPLE_DIR, "expected-matrix.json"), "utf8")),
);
const sampleA = matrix.samples.find((s) => s.id === "A")!;
const sampleC = matrix.samples.find((s) => s.id === "C")!;
const EXECUTION_IDS = rubric.criteria.filter((c) => c.method === "EXECUTION").map((c) => c.id);

const healthy: ServiceStartupObservation = {
  outcome: "HEALTHY",
  startCommand: "npm start",
  port: 40000,
  healthPath: "/health",
  healthTimeoutMs: 10_000,
  elapsedMs: 500,
  lastHealthStatus: 200,
  healthAttempts: 3,
};

function caseResult(
  criterionId: string,
  verdict: CaseResult["verdict"],
  failureKind: CaseResult["failureKind"] = verdict === "PASS" ? "NONE" : "ASSERTION",
): CaseResult {
  return {
    caseId: `${criterionId}-case`,
    criterionIds: [criterionId],
    verdict,
    failureKind,
    timeline: [],
    checks: [{ name: "status", ok: verdict === "PASS", expected: 201, actual: 500 }],
    expected: verdict === "PASS" ? {} : { status: 201 },
    actual: verdict === "PASS" ? {} : { status: 500 },
    startedAt: "2026-09-18T00:00:00.000Z",
    finishedAt: "2026-09-18T00:00:01.000Z",
  };
}

function harnessReport(results: CaseResult[]): HarnessReport {
  return {
    harnessVersion: "0.1.0+abc",
    caseSet: "order-api-v1",
    rubricVersion: "v1",
    baseUrl: "http://127.0.0.1:40000",
    requestTimeoutMs: 5000,
    startedAt: "2026-09-18T00:00:00.000Z",
    finishedAt: "2026-09-18T00:00:10.000Z",
    results,
    summary: {
      total: results.length,
      pass: results.filter((r) => r.verdict === "PASS").length,
      fail: results.filter((r) => r.verdict === "FAIL").length,
      inconclusive: results.filter((r) => r.verdict === "INCONCLUSIVE").length,
    },
  };
}

/** 모든 EXECUTION 기준이 PASS인 보고서에서 일부 기준만 FAIL로 바꾼다 */
function reportWith(failing: readonly string[] = []): HarnessReport {
  return harnessReport(
    EXECUTION_IDS.map((id) => caseResult(id, failing.includes(id) ? "FAIL" : "PASS")),
  );
}

function testsResult(overrides: Partial<SubmittedTestResult> = {}): SubmittedTestResult {
  const file = (p: string, total: number): SubmittedTestResult["testFiles"][number] => ({
    path: p,
    status: "passed",
    total,
    passed: total,
    failed: 0,
    skipped: 0,
    durationMs: 10,
    error: null,
    tests: Array.from({ length: total }, (_, i) => ({
      fullName: `${p} > t${i}`,
      title: `t${i}`,
      status: "passed" as const,
      durationMs: 1,
      failureMessages: [],
    })),
  });
  return {
    status: "PASSED",
    failureKind: "NONE",
    framework: "vitest",
    total: 49,
    passed: 49,
    failed: 0,
    skipped: 0,
    testFiles: [file("test/a.test.ts", 25), file("test/b.test.ts", 24)].concat(
      Array.from({ length: 5 }, (_, i) => file(`test/x${i}.test.ts`, 0)),
    ),
    durationMs: 100,
    reason: null,
    typecheck: null,
    run: null,
    resultFileCollected: true,
    truncated: false,
    ...overrides,
  } as SubmittedTestResult;
}

function observation(
  sampleId: SampleObservation["sampleId"],
  round: number,
  harness: HarnessReport | null,
  tests: SubmittedTestResult | null,
  startup: ServiceStartupObservation | null = healthy,
): SampleObservation {
  return {
    sampleId,
    round,
    environmentDigest: "env-digest",
    harnessVersion: harness?.harnessVersion ?? null,
    startup,
    harness,
    tests,
    durationMs: 1234 + round,
  };
}

describe("foldVerdicts", () => {
  it("FAIL이 하나라도 있으면 FAIL이고 그 failureKind를 쓴다", () => {
    expect(
      foldVerdicts([
        { verdict: "PASS", failureKind: "NONE" },
        { verdict: "INCONCLUSIVE", failureKind: "ENVIRONMENT" },
        { verdict: "FAIL", failureKind: "SUBMISSION" },
      ]),
    ).toEqual({ verdict: "FAIL", failureKind: "SUBMISSION" });
  });
  it("FAIL이 없고 INCONCLUSIVE가 있으면 INCONCLUSIVE, 모두 PASS면 PASS", () => {
    expect(
      foldVerdicts([
        { verdict: "PASS", failureKind: "NONE" },
        { verdict: "INCONCLUSIVE", failureKind: "TIMEOUT" },
      ]),
    ).toEqual({ verdict: "INCONCLUSIVE", failureKind: "TIMEOUT" });
    expect(foldVerdicts([{ verdict: "PASS", failureKind: "NONE" }])).toEqual({
      verdict: "PASS",
      failureKind: "NONE",
    });
  });
});

describe("deriveCriteria", () => {
  it("EXECUTION 기준만 만들고 PASS는 배점 전부, FAIL은 0점이다", () => {
    const derived = deriveCriteria(rubric, reportWith(["R-05", "R-07"]), healthy);
    expect(derived.map((d) => d.criterionId)).toEqual(EXECUTION_IDS);
    const r05 = derived.find((d) => d.criterionId === "R-05")!;
    expect(r05).toMatchObject({ verdict: "FAIL", earnedPoints: 0, failureKind: "ASSERTION" });
    expect(r05.reason).toContain("R-05-case");
    const r01 = derived.find((d) => d.criterionId === "R-01")!;
    expect(r01).toMatchObject({ verdict: "PASS", earnedPoints: 8, failureKind: "NONE" });
    expect(r01.reason).toBeUndefined();
  });

  it("기동이 HEALTHY가 아니면 R-10은 FAIL·SUBMISSION, 나머지는 INCONCLUSIVE·ENVIRONMENT다", () => {
    const failed: ServiceStartupObservation = {
      ...healthy,
      outcome: "EXITED_BEFORE_HEALTHY",
      lastHealthStatus: null,
      reason: "exit 1",
    };
    const derived = deriveCriteria(rubric, null, failed);
    expect(derived.find((d) => d.criterionId === "R-10")).toMatchObject({
      verdict: "FAIL",
      earnedPoints: 0,
      failureKind: "SUBMISSION",
    });
    for (const d of derived.filter((d) => d.criterionId !== "R-10")) {
      expect(d).toMatchObject({
        verdict: "INCONCLUSIVE",
        earnedPoints: null,
        failureKind: "ENVIRONMENT",
      });
      expect(d.reason).toContain("exit 1");
    }
  });

  it("기준을 참조하는 케이스가 없으면 INCONCLUSIVE·ENVIRONMENT다 (커버리지 누락)", () => {
    const derived = deriveCriteria(rubric, harnessReport([caseResult("R-01", "PASS")]), healthy);
    expect(derived.find((d) => d.criterionId === "R-02")).toMatchObject({
      verdict: "INCONCLUSIVE",
      earnedPoints: null,
      failureKind: "ENVIRONMENT",
      caseIds: [],
    });
  });
});

describe("compareSample", () => {
  it("A: 모두 PASS + 제출 테스트 49건/7파일이면 불일치가 없다", () => {
    const derived = deriveCriteria(rubric, reportWith(), healthy);
    const comparison = compareSample(rubric, sampleA, derived, testsResult());
    expect(comparison.mismatches).toEqual([]);
    expect(comparison.tests.ok).toBe(true);
    expect(comparison.rows.filter((r) => r.inScope).every((r) => r.ok)).toBe(true);
    // 범위 밖 기준(G1~G3, R-11, R-12)은 판정하지 않는다
    expect(comparison.rows.filter((r) => !r.inScope).map((r) => r.criterionId)).toEqual([
      "G1",
      "G2",
      "G3",
      "R-12",
      "R-11",
    ]);
    expect(comparison.rows.filter((r) => !r.inScope).every((r) => r.ok === null)).toBe(true);
  });

  it("C: R-05·R-06·R-07 FAIL이면 일치, A 기대표로 대조하면 세 건이 불일치다", () => {
    const derived = deriveCriteria(rubric, reportWith(["R-05", "R-06", "R-07"]), healthy);
    const testsC = testsResult({
      total: 11,
      passed: 11,
      testFiles: testsResult().testFiles.slice(0, 3),
    });
    expect(compareSample(rubric, sampleC, derived, testsC).mismatches).toEqual([]);

    const againstA = compareSample(rubric, sampleA, derived, testsResult());
    expect(againstA.mismatches).toHaveLength(3);
    expect(againstA.mismatches[0]).toMatch(/^R-05: 기대 PASS\(14\) ≠ 실제 FAIL\(0\)/);
  });

  it("제출 테스트 상태·개수·파일 수가 다르면 불일치다", () => {
    const derived = deriveCriteria(rubric, reportWith(), healthy);
    const wrongTotal = compareSample(rubric, sampleA, derived, testsResult({ total: 48 }));
    expect(wrongTotal.mismatches).toEqual([
      "제출 테스트: 기대 PASSED 49건/7파일 ≠ 실제 PASSED 48건/7파일",
    ]);
    const inconclusive = compareSample(
      rubric,
      sampleA,
      derived,
      testsResult({
        status: "INCONCLUSIVE",
        failureKind: "ENVIRONMENT",
        total: 0,
        passed: 0,
        testFiles: [],
        reason: "결과 파일 없음",
      }),
    );
    expect(inconclusive.mismatches[0]).toContain("INCONCLUSIVE 0건/0파일 — 결과 파일 없음");
    expect(compareSample(rubric, sampleA, derived, null).mismatches[0]).toContain("≠ 실제 없음");
  });
});

describe("judgementDigest · checkDeterminism", () => {
  it("시각·소요 시간·포트·timeline이 달라도 판정이 같으면 digest가 같다", () => {
    const first = observation("A", 1, reportWith(), testsResult());
    const second: SampleObservation = {
      ...observation("A", 2, reportWith(), testsResult({ durationMs: 999 })),
      startup: { ...healthy, port: 41000, elapsedMs: 800 },
      durationMs: 5000,
    };
    second.harness!.results[0]!.timeline = [
      {
        seq: 0,
        stepIndex: -1,
        kind: "reset",
        request: { method: "POST", path: "/admin/reset", headers: {}, body: null },
        response: { status: 200, headers: {}, body: { ok: true }, bodyIsJson: true },
        elapsedMs: 3,
      },
    ];
    second.harness!.startedAt = "2026-09-18T09:00:00.000Z";
    expect(judgementDigest(first)).toBe(judgementDigest(second));
  });

  it("케이스 actual 값이나 테스트 상태가 다르면 digest가 다르고 checkDeterminism이 잡는다", () => {
    const base = observation("C", 1, reportWith(["R-05"]), testsResult());
    const changed = observation("C", 2, reportWith(["R-05"]), testsResult());
    changed.harness!.results.find((r) => r.criterionIds[0] === "R-05")!.actual = { status: 503 };
    const testsChanged = observation(
      "C",
      3,
      reportWith(["R-05"]),
      testsResult({ passed: 48, failed: 1 }),
    );
    const digests = [base, changed, testsChanged].map((o) => ({
      sampleId: o.sampleId,
      round: o.round,
      digest: judgementDigest(o),
    }));
    expect(new Set(digests.map((d) => d.digest)).size).toBe(3);
    const problems = checkDeterminism(digests);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^C: 회차별 판정 digest가 다름/);
    expect(checkDeterminism([digests[0]!, { ...digests[0]!, round: 2 }])).toEqual([]);
  });

  it("canonicalJson은 키 순서와 무관하게 같은 문자열을 만든다", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })).toBe(
      canonicalJson({ a: { c: 2, d: [3, { y: 2, z: 1 }] }, b: 1 }),
    );
  });
});

describe("renderTable · renderReport", () => {
  it("표에 샘플 × 기준 verdict와 기대값 대조(✓/✗), 범위 밖 표시, 제출 테스트 행이 있다", () => {
    const derivedA = deriveCriteria(rubric, reportWith(), healthy);
    const derivedC = deriveCriteria(rubric, reportWith(["R-05", "R-06", "R-07"]), healthy);
    const comparisons = [
      compareSample(rubric, sampleA, derivedA, testsResult()),
      compareSample(rubric, sampleC, derivedC, testsResult({ total: 48 })),
    ];
    const table = renderTable(rubric, comparisons);
    expect(table).toContain("| 기준 | method | 배점 | A (기대 → 실제) | C (기대 → 실제) |");
    expect(table).toContain("| R-05 | EXECUTION | 14 | PASS 14 → PASS 14 ✓ | FAIL 0 → FAIL 0 ✓ |");
    expect(table).toContain("| G1 | MUTATION | 5 | PASS 5 → (범위 밖) | FAIL 0 → (범위 밖) |");
    expect(table).toContain("PASSED 11건/3파일 → PASSED 48건/7파일 ✗");
  });

  it("기록에 실행 일시·환경 digest·결과 표·결정성 표가 있다", () => {
    const derivedA = deriveCriteria(rubric, reportWith(), healthy);
    const comparison = compareSample(rubric, sampleA, derivedA, testsResult());
    const obs = [1, 2, 3].map((round) => observation("A", round, reportWith(), testsResult()));
    const digests = obs.map((o) => ({
      sampleId: o.sampleId,
      round: o.round,
      digest: judgementDigest(o),
    }));
    const summary: GateRunSummary = {
      startedAt: "2026-09-18T08:00:00.000Z",
      finishedAt: "2026-09-18T08:00:30.000Z",
      totalMs: 30_000,
      rounds: 3,
      nodeVersion: "v22.0.0",
      runnerKind: "local",
      environmentDigest: "env-digest",
      harnessVersion: "0.1.0+abc",
      rubricVersion: "v1",
      matrixPath: path.join(SAMPLE_DIR, "expected-matrix.json"),
      observations: obs,
      comparisons: [comparison],
      digests,
      determinismProblems: [],
      environmentErrors: [],
      ok: true,
    };
    const report = renderReport(rubric, summary);
    expect(report).toContain("- 결과: **통과**");
    expect(report).toContain(
      "- 실행 일시: 2026-09-18T08:00:00.000Z ~ 2026-09-18T08:00:30.000Z (총 30.0초",
    );
    expect(report).toContain("- environmentDigest: `env-digest`");
    expect(report).toContain("| R-01 | EXECUTION | 8 | PASS 8 → PASS 8 ✓ |");
    expect(report).toContain(
      `| A | \`${digests[0]!.digest.slice(0, 16)}\` | \`${digests[0]!.digest.slice(0, 16)}\` | \`${digests[0]!.digest.slice(0, 16)}\` | ✓ |`,
    );
    expect(report).toContain("## 불일치\n\n없음");
  });

  it("gateResultJson은 관측 원문을 빼고 대조·결정성 결과만 담으며 경로는 저장소 상대 경로다", () => {
    const derivedA = deriveCriteria(rubric, reportWith(), healthy);
    const comparison = compareSample(rubric, sampleA, derivedA, testsResult());
    const obs = [observation("A", 1, reportWith(), testsResult())];
    const summary: GateRunSummary = {
      startedAt: "2026-09-18T08:00:00.000Z",
      finishedAt: "2026-09-18T08:00:30.000Z",
      totalMs: 30_000,
      rounds: 1,
      nodeVersion: "v22.0.0",
      runnerKind: "local",
      environmentDigest: "env-digest",
      harnessVersion: "0.1.0+abc",
      rubricVersion: "v1",
      matrixPath: path.join(SAMPLE_DIR, "expected-matrix.json"),
      observations: obs,
      comparisons: [comparison],
      digests: [{ sampleId: "A", round: 1, digest: judgementDigest(obs[0]!) }],
      determinismProblems: [],
      environmentErrors: [],
      ok: true,
    };
    const json = gateResultJson(summary, path.resolve(SAMPLE_DIR, "..", ".."));
    expect(json).toMatchObject({
      gate: "phase1",
      ticket: "T-110",
      ok: true,
      rounds: 1,
      environmentDigest: "env-digest",
      harnessVersion: "0.1.0+abc",
      rubricVersion: "v1",
      matrixPath: path.join("samples", "order-api", "expected-matrix.json"),
    });
    expect(json).not.toHaveProperty("observations");
    expect(json.comparisons[0]?.rows.find((r) => r.criterionId === "R-01")).toMatchObject({
      expected: { verdict: "PASS", earnedPoints: 8 },
      actual: { verdict: "PASS", earnedPoints: 8 },
      ok: true,
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe("expected-matrix.json", () => {
  it("샘플마다 제출 테스트 기대값(status·total·files)이 있다", () => {
    for (const sample of matrix.samples) {
      expect(sample.submittedTests.status).toBe("PASSED");
      expect(sample.submittedTests.total).toBeGreaterThan(0);
      expect(sample.submittedTests.files).toBeGreaterThan(0);
    }
  });
});
