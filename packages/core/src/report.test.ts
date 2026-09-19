import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  EvaluationReportResponseSchema,
  SubmissionSummaryResponseSchema,
  formatStoredScoreDisplay,
} from "./report";
import { formatScoreDisplay } from "./score";

describe("formatStoredScoreDisplay", () => {
  it("저장된 min·max로 부록 C 표기를 만들고 집계 엔진의 표기와 같다", () => {
    expect(formatStoredScoreDisplay({ earned: 87, min: 87, max: 87, pendingPoints: 0 })).toBe(
      "87/100",
    );
    expect(formatStoredScoreDisplay({ earned: 54, min: 54, max: 69, pendingPoints: 15 })).toBe(
      "54~69/100 · 15점 검토 대기",
    );
    expect(formatStoredScoreDisplay({ earned: 54, min: 54, max: 69, pendingPoints: 15 })).toBe(
      formatScoreDisplay(54, 15, 100),
    );
  });
});

describe("응답 봉투 스키마", () => {
  it("오류 봉투는 알려진 코드만 허용한다", () => {
    expect(
      ApiErrorSchema.safeParse({ ok: false, code: "RUN_NOT_FOUND", message: "없음" }).success,
    ).toBe(true);
    expect(ApiErrorSchema.safeParse({ ok: false, code: "OTHER", message: "없음" }).success).toBe(
      false,
    );
  });

  it("성공 봉투는 data가 엔드포인트 스키마를 통과해야 한다", () => {
    expect(EvaluationReportResponseSchema.safeParse({ ok: true, data: {} }).success).toBe(false);
    expect(
      SubmissionSummaryResponseSchema.safeParse({
        ok: false,
        code: "SUBMISSION_NOT_FOUND",
        message: "없음",
      }).success,
    ).toBe(true);
  });
});
