import type { EvaluationResults } from "@ohmyti/db";
import { describe, expect, it } from "vitest";
import { assertPremiseVerdicts, describeStageLog } from "./premise";

type Row<K extends keyof EvaluationResults> = EvaluationResults[K][number];

/** 부하로 R-05 하네스 요청이 제한 시간을 넘긴 평가 (CI 35456468020과 같은 모양) */
function inconclusiveR05(): EvaluationResults {
  return {
    executionRecords: [
      {
        id: "run-r05",
        kind: "HARNESS",
        failureKind: "TIMEOUT",
        exitCode: null,
        durationMs: 5003,
      } as Row<"executionRecords">,
    ],
    evidences: [
      { id: "ev-r05", runId: "run-r05", testId: "R-05-idempotent-resend" } as Row<"evidences">,
    ],
    criterionResults: [
      {
        criterionId: "R-05",
        verdict: "INCONCLUSIVE",
        earnedPoints: null,
        maxPoints: 14,
        evidenceIds: ["ev-r05"],
        observation: "R-05-idempotent-resend: INCONCLUSIVE (요청이 5000ms 안에 끝나지 않음)",
      } as Row<"criterionResults">,
      {
        criterionId: "R-06",
        verdict: "FAIL",
        earnedPoints: 0,
        maxPoints: 10,
        evidenceIds: [],
        observation: "",
      } as unknown as Row<"criterionResults">,
    ],
  };
}

describe("전제 단언 (T-607)", () => {
  it("판정이 전제와 다르면 케이스·관측(INCONCLUSIVE 사유)·근거 기록을 메시지에 담아 던진다", () => {
    expect(() =>
      assertPremiseVerdicts(inconclusiveR05(), { "R-05": "FAIL" }, "원본 평가: 샘플 C"),
    ).toThrowError(
      [
        "전제 불일치 (원본 평가: 샘플 C): 준비한 평가의 판정이 전제와 다릅니다",
        "기대 FAIL",
        "R-05: verdict INCONCLUSIVE, earnedPoints null/14",
        "  관측: R-05-idempotent-resend: INCONCLUSIVE (요청이 5000ms 안에 끝나지 않음)",
        "  근거 R-05-idempotent-resend: HARNESS failureKind TIMEOUT, exit null, 5003ms",
      ].join("\n"),
    );
  });

  it("전제와 같으면 통과하고, 없는 기준은 '판정 없음'으로 알린다", () => {
    expect(() => assertPremiseVerdicts(inconclusiveR05(), { "R-06": "FAIL" }, "x")).not.toThrow();
    expect(() => assertPremiseVerdicts(inconclusiveR05(), { "R-99": "PASS" }, "x")).toThrowError(
      "R-99: 판정 없음",
    );
  });

  it("단계 기록을 한 줄로 요약한다", () => {
    expect(
      describeStageLog([
        { stage: "REPO_CHECK", state: "DONE" },
        { stage: "REQUIREMENT_VERIFY", state: "FAILED", reason: "ENVIRONMENT: health timeout" },
      ]),
    ).toBe("REPO_CHECK DONE · REQUIREMENT_VERIFY FAILED (ENVIRONMENT: health timeout)");
  });
});
