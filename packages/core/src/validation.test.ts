import { describe, expect, it } from "vitest";
import {
  approvalBlockers,
  buildValidationResult,
  compareValidationSample,
  isBootstrapApprovalPendingReview,
  type ValidationSampleActual,
  type ValidationSampleRef,
} from "./validation";

const ID = {
  version: "11111111-1111-4111-8111-111111111111",
  a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  c: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const SHA = { a: "1".repeat(40), b: "2".repeat(40), c: "3".repeat(40) };

const sampleA: ValidationSampleRef = {
  id: ID.a,
  name: "정답 A",
  kind: "CORRECT",
  submissionSha: SHA.a,
};
const sampleB: ValidationSampleRef = {
  id: ID.b,
  name: "대안 B",
  kind: "ALTERNATIVE",
  submissionSha: SHA.b,
};
const sampleC: ValidationSampleRef = {
  id: ID.c,
  name: "결함 C",
  kind: "DEFECTIVE",
  submissionSha: SHA.c,
};

const expected = {
  criteria: {
    "R-01": { verdict: "PASS", earnedPoints: 8 },
    G1: { verdict: "PASS", earnedPoints: 5 },
    "R-12": { verdict: "INCONCLUSIVE", earnedPoints: null, reviewState: "PENDING", note: "메모" },
  },
  mutations: { "M-01": "KILLED" },
  submittedTests: { status: "PASSED", total: 10, files: 2 },
  description: "설명은 대조하지 않는다",
};

function actual(overrides: Partial<ValidationSampleActual> = {}): ValidationSampleActual {
  return {
    submissionId: "s1",
    evaluationId: "e1",
    submissionStatus: "COMPLETED",
    error: null,
    criteria: {
      "R-01": { verdict: "PASS", earnedPoints: 8, reviewState: "NOT_REQUIRED" },
      G1: { verdict: "PASS", earnedPoints: 5, reviewState: "NOT_REQUIRED" },
      "R-12": { verdict: "INCONCLUSIVE", earnedPoints: null, reviewState: "PENDING" },
    },
    mutations: { "M-01": "KILLED" },
    submittedTests: { status: "PASSED", total: 10, files: 2 },
    scoreDisplay: "13~23/23 · 10점 검토 대기",
    ...overrides,
  };
}

describe("compareValidationSample", () => {
  it("기준·mutation·제출 테스트가 모두 같으면 불일치가 없다", () => {
    expect(compareValidationSample(sampleA, expected, actual())).toEqual([]);
  });

  it("기준별 verdict·점수·검토 상태, mutation 결과, 제출 테스트를 각각 대조한다", () => {
    const found = compareValidationSample(
      sampleB,
      expected,
      actual({
        criteria: {
          "R-01": { verdict: "FAIL", earnedPoints: 0, reviewState: "NOT_REQUIRED" },
          G1: { verdict: "PASS", earnedPoints: 5, reviewState: "NOT_REQUIRED" },
          "R-12": { verdict: "INCONCLUSIVE", earnedPoints: null, reviewState: "CONFIRMED" },
          "R-99": { verdict: "PASS", earnedPoints: 1, reviewState: "NOT_REQUIRED" },
        },
        mutations: {},
        submittedTests: { status: "PASSED", total: 9, files: 2 },
      }),
    );
    expect(found.map((m) => [m.subject, m.ref, m.field, m.expected, m.actual])).toEqual([
      ["CRITERION", "R-01", "verdict", "PASS", "FAIL"],
      ["CRITERION", "R-01", "earnedPoints", 8, 0],
      ["CRITERION", "R-12", "reviewState", "PENDING", "CONFIRMED"],
      ["CRITERION", "R-99", null, null, "PASS"],
      ["MUTATION", "M-01", "outcome", "KILLED", null],
      ["SUBMITTED_TESTS", "submittedTests", "total", 10, 9],
    ]);
    expect(found.every((m) => m.sampleId === ID.b && m.sampleKind === "ALTERNATIVE")).toBe(true);
    expect(found[0]!.message).toBe("R-01: 기대 PASS, 실제 FAIL");
    expect(found[4]!.message).toBe("M-01: 기대 KILLED, 실제 실험 없음");
  });

  it("파이프라인이 끝나지 않았으면 결과를 대조하지 않고 오류 하나만 남긴다", () => {
    const found = compareValidationSample(
      sampleA,
      expected,
      actual({ submissionStatus: "FAILED", error: "ENVIRONMENT: 러너 준비 실패", criteria: {} }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      subject: "EVALUATION",
      expected: "COMPLETED",
      actual: "FAILED",
    });
    expect(found[0]!.message).toContain("러너 준비 실패");
  });

  it("기대 결과표 형식이 틀리면 불일치로 남긴다", () => {
    const found = compareValidationSample(
      sampleA,
      { criteria: { "R-01": { verdict: "OK" } } },
      actual(),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.ref).toBe("expected");
  });
});

describe("buildValidationResult", () => {
  const base = {
    assignmentVersionId: ID.version,
    rubricVersion: "v1-abcdef12",
    harnessVersion: "0.1.0+x",
    startedAt: "2026-09-19T00:00:00.000Z",
    finishedAt: "2026-09-19T00:01:00.000Z",
  };

  it("정답·대안·결함 샘플이 모두 일치하면 pass다", () => {
    const result = buildValidationResult({
      ...base,
      runs: [sampleA, sampleB, sampleC].map((sample) => ({ sample, expected, actual: actual() })),
    });
    expect(result.pass).toBe(true);
    expect(result.perSample.map((s) => [s.name, s.check, s.status])).toEqual([
      ["정답 A", "정답 통과", "MATCH"],
      ["대안 B", "대안 통과", "MATCH"],
      ["결함 C", "결함 탐지", "MATCH"],
    ]);
  });

  it("필수 종류(정답·대안·결함) 샘플이 빠지면 pass가 아니다", () => {
    const result = buildValidationResult({
      ...base,
      runs: [{ sample: sampleA, expected, actual: actual() }],
    });
    expect(result.pass).toBe(false);
    expect(result.mismatches.map((m) => [m.subject, m.ref])).toEqual([
      ["SAMPLE_SET", "ALTERNATIVE"],
      ["SAMPLE_SET", "DEFECTIVE"],
    ]);
    const empty = buildValidationResult({ ...base, runs: [] });
    expect(empty.pass).toBe(false);
    expect(empty.mismatches).toHaveLength(3);
  });

  it("한 샘플이라도 불일치·오류면 pass가 아니고 샘플 상태에 반영된다", () => {
    const result = buildValidationResult({
      ...base,
      runs: [
        { sample: sampleA, expected, actual: actual() },
        { sample: sampleB, expected, actual: actual({ mutations: { "M-01": "SURVIVED" } }) },
        { sample: sampleC, expected, actual: actual({ submissionStatus: "FAILED" }) },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.perSample.map((s) => [s.status, s.mismatchCount])).toEqual([
      ["MATCH", 0],
      ["MISMATCH", 1],
      ["ERROR", 1],
    ]);
  });
});

describe("approvalBlockers", () => {
  const passing = buildValidationResult({
    assignmentVersionId: ID.version,
    rubricVersion: "v2-abcdef12",
    harnessVersion: "0.1.0+x",
    startedAt: "2026-09-19T00:00:00.000Z",
    finishedAt: "2026-09-19T00:01:00.000Z",
    runs: [sampleA, sampleB, sampleC].map((sample) => ({ sample, expected, actual: actual() })),
  });
  const version = {
    id: ID.version,
    status: "VALIDATING" as const,
    rubricVersion: "v2-abcdef12",
    harnessVersion: "0.1.0+x",
    validationResult: passing,
  };
  const reviewed = [sampleA, sampleB, sampleC].map((s) => ({ ...s, humanReviewedBy: "검토자" }));

  it("검증 pass + 모든 샘플 검토 + 승인자 이름이면 막는 사유가 없다", () => {
    expect(approvalBlockers({ version, samples: reviewed, approvedBy: "담당자" })).toEqual([]);
  });

  it("human_reviewed_by가 빈 샘플이 하나라도 있으면 검증 pass여도 거부한다", () => {
    const samples = reviewed.map((s, i) => (i === 1 ? { ...s, humanReviewedBy: null } : s));
    const blockers = approvalBlockers({ version, samples, approvedBy: "담당자" });
    expect(blockers.map((b) => b.code)).toEqual(["SAMPLE_NOT_REVIEWED"]);
    expect(blockers[0]!.message).toContain("대안 B");
    const blank = reviewed.map((s, i) => (i === 0 ? { ...s, humanReviewedBy: "  " } : s));
    expect(
      approvalBlockers({ version, samples: blank, approvedBy: "담당자" }).map((b) => b.code),
    ).toEqual(["SAMPLE_NOT_REVIEWED"]);
  });

  it("검증 결과 없음·불일치·다른 버전의 결과·바뀐 샘플·승인자 없음·상태를 각각 막는다", () => {
    const codes = (input: Parameters<typeof approvalBlockers>[0]) =>
      approvalBlockers(input).map((b) => b.code);
    expect(
      codes({
        version: { ...version, validationResult: null },
        samples: reviewed,
        approvedBy: "x",
      }),
    ).toEqual(["VALIDATION_MISSING"]);
    expect(
      codes({
        version: { ...version, validationResult: { ...passing, pass: false } },
        samples: reviewed,
        approvedBy: "x",
      }),
    ).toEqual(["VALIDATION_FAILED"]);
    expect(
      codes({
        version: { ...version, rubricVersion: "v3-00000000" },
        samples: reviewed,
        approvedBy: "x",
      }),
    ).toEqual(["VALIDATION_STALE"]);
    expect(
      codes({
        version,
        samples: reviewed.map((s, i) => (i === 2 ? { ...s, submissionSha: "9".repeat(40) } : s)),
        approvedBy: "x",
      }),
    ).toEqual(["VALIDATION_STALE"]);
    expect(codes({ version, samples: reviewed, approvedBy: " " })).toEqual(["APPROVER_MISSING"]);
    expect(
      codes({ version: { ...version, status: "DRAFT" }, samples: reviewed, approvedBy: "x" }),
    ).toEqual(["NOT_VALIDATING"]);
    expect(codes({ version, samples: [], approvedBy: "x" })).toEqual([
      "VALIDATION_STALE",
      "SAMPLES_MISSING",
    ]);
  });
});

describe("isBootstrapApprovalPendingReview", () => {
  it("시드 승인이고 검토 안 된 샘플이 있을 때만 배지를 보인다", () => {
    const seed = { status: "APPROVED" as const, approvedBy: "seed" };
    expect(isBootstrapApprovalPendingReview(seed, [{ humanReviewedBy: null }])).toBe(true);
    expect(isBootstrapApprovalPendingReview(seed, [])).toBe(true);
    expect(isBootstrapApprovalPendingReview(seed, [{ humanReviewedBy: "검토자" }])).toBe(false);
    expect(
      isBootstrapApprovalPendingReview({ status: "APPROVED", approvedBy: "담당자" }, [
        { humanReviewedBy: null },
      ]),
    ).toBe(false);
    expect(
      isBootstrapApprovalPendingReview({ status: "VALIDATING", approvedBy: null }, [
        { humanReviewedBy: null },
      ]),
    ).toBe(false);
  });
});
