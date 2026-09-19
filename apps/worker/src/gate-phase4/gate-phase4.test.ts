import { RubricSchema, type Rubric, type ValidationSampleActual } from "@ohmyti/core";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  checkAdversarial,
  checkAlternative,
  checkApprovalFlow,
  checkLlm,
  checkMatrix,
  GATE_SAMPLE_IDS,
  GateMatrixSchema,
  type ApprovalFlowObservation,
  type GateLlmSample,
  type GateMatrix,
  type GateSampleId,
} from "./checks";
import {
  GATE_SECTION_END,
  GATE_SECTION_START,
  renderGateMarkdown,
  replaceGateSection,
  type GateRecord,
} from "./report";

const SAMPLES_DIR = path.resolve(import.meta.dirname, "../../../../samples/order-api");

let rubric: Rubric;
let matrix: GateMatrix;

beforeAll(async () => {
  rubric = RubricSchema.parse(
    JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
  );
  matrix = GateMatrixSchema.parse(
    JSON.parse(await readFile(path.join(SAMPLES_DIR, "expected-matrix.json"), "utf8")),
  );
});

/** 기대 결과표를 그대로 옮긴 실제 결과 (파이프라인이 기대대로 채점한 경우) */
function actualFromMatrix(id: GateSampleId): ValidationSampleActual {
  const s = matrix.samples.find((x) => x.id === id)!;
  return {
    submissionId: `${id}-submission`,
    evaluationId: `${id}-evaluation`,
    submissionStatus: "COMPLETED",
    error: null,
    criteria: Object.fromEntries(
      Object.entries(s.criteria).map(([cid, c]) => [
        cid,
        {
          verdict: c.verdict as ValidationSampleActual["criteria"][string]["verdict"],
          earnedPoints: c.earnedPoints,
          reviewState: (c.reviewState ?? "NOT_REQUIRED") as "NOT_REQUIRED",
        },
      ]),
    ),
    mutations: { ...s.mutations },
    submittedTests: {
      status: s.submittedTests.status,
      total: s.submittedTests.total ?? 0,
      files: s.submittedTests.files ?? 0,
    },
    scoreDisplay: s.scoreDisplay.beforeHumanReview,
  };
}

const allActuals = () =>
  Object.fromEntries(GATE_SAMPLE_IDS.map((id) => [id, actualFromMatrix(id)])) as Record<
    GateSampleId,
    ValidationSampleActual
  >;

function llmSample(id: GateSampleId, overrides: Partial<GateLlmSample> = {}): GateLlmSample {
  return {
    sampleId: id,
    evaluationId: `${id}-evaluation`,
    reviewWriteState: "DONE",
    reviewWriteReason: null,
    reviewWriteLlm: "OK",
    reviewWriteError: null,
    interpretations: [],
    designSuggestions: [],
    suggestions: [],
    dropped: 0,
    criteriaUnchanged: true,
    calls: [{ kind: "EVIDENCE_REVIEW", model: "m", promptVersion: "p@v1", costUsd: 0.001 }],
    ...overrides,
  };
}

const FLOW_OK: ApprovalFlowObservation = {
  v1Pass: true,
  v1Mismatches: [],
  v1StatusAfterValidation: "VALIDATING",
  unsignedBlockers: ["SAMPLE_NOT_REVIEWED"],
  blankApproverBlockers: ["APPROVER_MISSING"],
  approvedStatus: "APPROVED",
  v2Pass: false,
  v2Status: "DRAFT",
  v2Mismatches: [
    { sample: "B", ref: "R-11", field: "verdict", expected: "PASS", actual: "FAIL" },
    { sample: "B", ref: "R-11", field: "earnedPoints", expected: 4, actual: 0 },
  ],
  v2Blockers: ["NOT_VALIDATING", "VALIDATION_FAILED"],
  v1StatusAfterV2: "APPROVED",
};

describe("gate:phase4 대조", () => {
  it("기대 결과표와 같은 결과면 모든 대조가 통과한다", () => {
    const actuals = allActuals();
    expect(checkMatrix(matrix, actuals)).toMatchObject({ pass: true, problems: [] });
    expect(checkAlternative(rubric, actuals.B)).toMatchObject({ pass: true });
    expect(checkAlternative(rubric, actuals.B).detail).toContain("테스트 실효성 15/15");
    expect(checkAdversarial(actuals.C, actuals.D)).toMatchObject({ pass: true });
    expect(checkApprovalFlow(FLOW_OK)).toMatchObject({ pass: true });
  });

  it("점수 표시·그룹·mutation이 하나라도 다르면 기대 결과표 대조가 실패한다", () => {
    const actuals = allActuals();
    actuals.A.criteria.G1 = { verdict: "INCONCLUSIVE", earnedPoints: null, reviewState: "PENDING" };
    actuals.A.mutations["M-01"] = "SURVIVED";
    actuals.A.scoreDisplay = "75~100/100 · 25점 검토 대기";
    const result = checkMatrix(matrix, actuals);
    expect(result.pass).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        "A G1: 기대 PASS, 실제 INCONCLUSIVE",
        expect.stringMatching(/^A M-01/),
        'A 점수 표시: 기대 "90~100/100 · 10점 검토 대기", 실제 "75~100/100 · 25점 검토 대기"',
      ]),
    );
  });

  it("파이프라인이 끝나지 않은 샘플은 기준 대조 없이 실패로 기록한다", () => {
    const actuals = allActuals();
    actuals.C = { ...actuals.C, submissionStatus: "FAILED", error: "환경 장애" };
    const result = checkMatrix(matrix, actuals);
    expect(result.pass).toBe(false);
    expect(result.problems[0]).toContain("C 채점 파이프라인이 끝나지 않았습니다: 환경 장애");
  });

  it("B: 기준 하나가 FAIL이거나 그룹이 만점이 아니면 실패하고, 사람 검토 기준이 확정되어 있어도 실패한다", () => {
    const failed = actualFromMatrix("B");
    failed.criteria["R-11"] = { verdict: "FAIL", earnedPoints: 0, reviewState: "NOT_REQUIRED" };
    failed.criteria.G2 = { verdict: "INCONCLUSIVE", earnedPoints: null, reviewState: "PENDING" };
    const result = checkAlternative(rubric, failed);
    expect(result.pass).toBe(false);
    // rubric 순서 (G2가 R-11보다 앞)
    expect(result.problems).toEqual([
      "B G2: 기대 PASS 5점, 실제 INCONCLUSIVE 미확정",
      "B R-11: 기대 PASS 4점, 실제 FAIL 0",
      "B 테스트 실효성 그룹: 10/15",
    ]);

    const decided = actualFromMatrix("B");
    decided.criteria["R-12"] = { verdict: "PASS", earnedPoints: 10, reviewState: "CONFIRMED" };
    expect(checkAlternative(rubric, decided).problems[0]).toMatch(/^B R-12: 사람 검토 기준/);
  });

  it("D: 점수 표시나 기준 하나의 earned_points가 C와 다르면 실패한다", () => {
    const c = actualFromMatrix("C");
    const d = actualFromMatrix("D");
    d.criteria["R-05"] = { verdict: "PASS", earnedPoints: 14, reviewState: "NOT_REQUIRED" };
    d.scoreDisplay = "68~83/100 · 15점 검토 대기";
    const result = checkAdversarial(c, d);
    expect(result.pass).toBe(false);
    expect(result.problems).toEqual([
      '점수 표시: C "54~69/100 · 15점 검토 대기", D "68~83/100 · 15점 검토 대기"',
      "R-05: earned_points C 0, D 14",
    ]);
    // null(미확정)과 0점은 다르다 (G-04)
    const d2 = actualFromMatrix("D");
    d2.criteria.G2 = { verdict: "FAIL", earnedPoints: 0, reviewState: "NOT_REQUIRED" };
    expect(checkAdversarial(c, d2).problems).toEqual(["G2: earned_points C null, D 0"]);
    // 판정 행이 빠져도 실패다
    const d3 = actualFromMatrix("D");
    delete d3.criteria["R-01"];
    expect(checkAdversarial(c, d3).problems).toEqual(["R-01: D에 판정 행이 없습니다"]);
  });

  it("LLM: 판정이 바뀌었거나 REVIEW_WRITE가 끝나지 않으면 실패하고, 실제 LLM 모드는 호출 기록을 요구한다", () => {
    const ok = GATE_SAMPLE_IDS.map((id) => llmSample(id));
    expect(checkLlm(ok, true)).toMatchObject({ pass: true });
    expect(checkLlm(ok, true).detail).toContain("호출 4건 · 비용 $0.004000");

    const changed = [llmSample("A", { criteriaUnchanged: false }), llmSample("B")];
    expect(checkLlm(changed, false).problems).toEqual([
      "A REVIEW_WRITE 전후 판정이 달라졌거나 확인하지 못했습니다",
    ]);
    const skipped = [llmSample("C", { reviewWriteState: "SKIPPED", calls: [] })];
    expect(checkLlm(skipped, false).problems).toEqual(["C REVIEW_WRITE 상태 SKIPPED"]);
    expect(checkLlm(skipped, true).problems).toContain("C LLM 호출 기록(ai_reviews)이 없습니다");
    // 제공자 오류는 판정과 무관하므로 막지 않는다
    const providerError = [llmSample("D", { reviewWriteLlm: "INCONCLUSIVE" })];
    expect(checkLlm(providerError, true).pass).toBe(true);
  });

  it("승인 흐름: v1 검증 불일치는 원인과 함께 실패로 남는다", () => {
    const result = checkApprovalFlow({
      ...FLOW_OK,
      v1Pass: false,
      v1Mismatches: ["정답 구현 A 제출 테스트 status: 기대 PASSED, 실제 FAILED"],
    });
    expect(result.problems.slice(0, 2)).toEqual([
      "v1 검증이 pass가 아닙니다",
      "v1 검증 불일치: 정답 구현 A 제출 테스트 status: 기대 PASSED, 실제 FAILED",
    ]);
  });

  it("승인 흐름: 서명 없는 승인이 통과하거나 v2 불일치가 B 밖에서 나오면 실패한다", () => {
    expect(checkApprovalFlow({ ...FLOW_OK, unsignedBlockers: [] }).problems[0]).toContain(
      "SAMPLE_NOT_REVIEWED",
    );
    const extra = checkApprovalFlow({
      ...FLOW_OK,
      v2Mismatches: [
        ...FLOW_OK.v2Mismatches,
        { sample: "D", ref: "M-02", field: "outcome", expected: "SURVIVED", actual: "KILLED" },
      ],
    });
    expect(extra.problems).toEqual(["v2 불일치 샘플 [B, D] (기대 B만)"]);
    expect(checkApprovalFlow({ ...FLOW_OK, v2Pass: true, v2Blockers: [] }).problems).toEqual([
      "v2(express 필수) 검증이 불일치를 내지 않았습니다",
      "v2 승인이 VALIDATION_FAILED로 막히지 않았습니다: []",
    ]);
  });
});

describe("gate:phase4 기록", () => {
  function record(): GateRecord {
    const actuals = allActuals();
    const checks = [
      checkMatrix(matrix, actuals),
      checkAlternative(rubric, actuals.B),
      checkAdversarial(actuals.C, actuals.D),
    ];
    return {
      kind: "phase4_gate",
      pass: checks.every((c) => c.pass),
      startedAt: "2026-09-19T00:00:00.000Z",
      durationMs: 90_000,
      environment: { node: "v22", platform: "linux x64", runner: "local", database: "임시 DB" },
      llm: { mode: "fake", provider: "fake", requestedModel: "fake-model" },
      rubricVersion: "v1-x",
      harnessVersion: "h",
      matrixReviewedBy: null,
      checks,
      samples: GATE_SAMPLE_IDS.map((id) => ({
        id,
        name: matrix.samples.find((s) => s.id === id)!.name,
        validationStatus: "MATCH",
        scoreDisplay: actuals[id].scoreDisplay,
        expectedScoreDisplay: matrix.samples.find((s) => s.id === id)!.scoreDisplay
          .beforeHumanReview,
        criteria: actuals[id].criteria,
        mutations: actuals[id].mutations,
        submittedTests: actuals[id].submittedTests,
        llm: llmSample(id, {
          interpretations:
            id === "C"
              ? [
                  {
                    criterionId: "R-05",
                    confidence: "HIGH",
                    evidenceCount: 2,
                    minimalRepro: "a | b",
                  },
                ]
              : [],
        }),
      })),
      approvalFlow: FLOW_OK,
    };
  }

  it("Fake 모드임을 밝히고 표의 셀 구분자를 이스케이프한다", () => {
    const md = renderGateMarkdown(record());
    expect(md.startsWith(GATE_SECTION_START)).toBe(true);
    expect(md.trimEnd().endsWith(GATE_SECTION_END)).toBe(true);
    expect(md).toContain("- 결과: **통과**");
    expect(md).toContain("Fake LLM");
    expect(md).toContain("실제 LLM 결과가 아니다");
    expect(md).toContain("| C | R-05 | HIGH | 2 | a \\| b |");
    expect(md).toContain("| R-05 | PASS 14 | PASS 14 | FAIL 0 | FAIL 0 | 같음 |");
    expect(md).toContain("T-101 사람 확인 대기");
    expect(md).not.toContain("macOS 주의");
  });

  it("표식 사이만 바꾸고 앞뒤 문서(사람 검토 절)는 그대로 둔다", () => {
    const section = renderGateMarkdown(record());
    const first = replaceGateSection("# 기존 기록\n\n본문\n", section);
    expect(first).toBe(`# 기존 기록\n\n본문\n\n---\n\n${section}`);
    const withReview = `${first}\n## 사람 검토\n\n- [ ] 서명\n`;
    const again = replaceGateSection(withReview, section.replace("**통과**", "**실패**"));
    expect(again.startsWith("# 기존 기록\n\n본문\n\n---\n\n")).toBe(true);
    expect(again).toContain("**실패**");
    expect(again).not.toContain("**통과**");
    expect(again.endsWith("\n## 사람 검토\n\n- [ ] 서명\n")).toBe(true);
    expect(replaceGateSection("", section)).toBe(section);
  });
});
