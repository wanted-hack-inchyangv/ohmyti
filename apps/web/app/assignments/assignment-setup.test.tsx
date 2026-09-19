import { renderToStaticMarkup } from "react-dom/server";
import type { ValidationResult } from "@ohmyti/core";
import { sampleRubric } from "@ohmyti/core/fixtures";
import { describe, expect, it } from "vitest";
import type { VersionSetupView } from "@/lib/assignments/service";
import { ReadOnlyVersionView, versionScreen } from "./[id]/versions/[v]/page";
import { validationPhase } from "./[id]/versions/[v]/validation-section";
import { IssueList, SampleTable, ValidationChecksTable } from "./setup-views";

const now = new Date("2026-09-19T00:00:00Z");

function setup(status: VersionSetupView["version"]["status"]): VersionSetupView {
  return {
    assignment: {
      id: "a1",
      name: "주문·재고 API",
      description: null,
      createdAt: now,
      updatedAt: now,
    },
    version: {
      id: "11111111-1111-4111-8111-111111111111",
      assignmentId: "a1",
      version: 2,
      status,
      title: "v2",
      specRef: "assignments/a1/specs/x.md",
      specDigest: "a".repeat(64),
      rubric: { ...sampleRubric(), version: "v2-01234567" },
      rubricVersion: "v2-01234567",
      executionContract: {
        startCommand: "npm start",
        portEnv: "PORT",
        healthPath: "/health",
        healthTimeoutMs: 10000,
        resetPath: "/admin/reset",
        templateName: "order-api-ts",
        nodeVersion: "22",
      },
      harnessVersion: "0.1.0+abc",
      validationResult: null,
      reportProfile: null,
      approvedBy: status === "APPROVED" ? "홍길동" : null,
      approvedAt: status === "APPROVED" ? now : null,
      retiredAt: null,
      createdAt: now,
      updatedAt: now,
    },
    label: "주문·재고 API · v2",
    specMarkdown: "# 주문 API\n- POST /orders\n",
    specError: null,
    samples: [
      { id: "s1", name: "A", kind: "CORRECT", humanReviewedBy: "리뷰어" },
      { id: "s2", name: "B", kind: "ALTERNATIVE", humanReviewedBy: null },
    ],
    validation: null,
    validationJob: null,
    blockers: [],
    versions: [{ version: 2, status }],
  };
}

const result: ValidationResult = {
  kind: "rubric_validation",
  assignmentVersionId: "11111111-1111-4111-8111-111111111111",
  rubricVersion: "v2-01234567",
  harnessVersion: "0.1.0+abc",
  startedAt: "2026-09-19T00:00:00.000Z",
  finishedAt: "2026-09-19T00:01:00.000Z",
  pass: true,
  perSample: (
    [
      ["A", "CORRECT", "정답 통과", "90~100/100 · 10점 검토 대기"],
      ["B", "ALTERNATIVE", "대안 통과", "90~100/100 · 10점 검토 대기"],
      ["C", "DEFECTIVE", "결함 탐지", "54~69/100 · 15점 검토 대기"],
      ["D", "ADVERSARIAL", "적대 샘플 동일", "54~69/100 · 15점 검토 대기"],
    ] as const
  ).map(([name, kind, check, scoreDisplay], i) => ({
    sampleId: `2222222${i}-2222-4222-8222-222222222222`,
    name,
    kind,
    check,
    submissionSha: "0".repeat(40),
    submissionId: null,
    evaluationId: null,
    status: "MATCH" as const,
    mismatchCount: 0,
    scoreDisplay,
    error: null,
  })),
  mismatches: [],
};

describe("과제 설정 화면 구성 (T-406)", () => {
  it("편집기는 DRAFT에서만, 검증·승인 컨트롤은 DRAFT·VALIDATING에서만 그린다", () => {
    expect(versionScreen("DRAFT")).toEqual({
      editable: true,
      validationControls: true,
      newVersion: false,
    });
    expect(versionScreen("VALIDATING")).toEqual({
      editable: false,
      validationControls: true,
      newVersion: true,
    });
    for (const status of ["APPROVED", "RETIRED"] as const) {
      expect(versionScreen(status)).toEqual({
        editable: false,
        validationControls: false,
        newVersion: true,
      });
    }
  });

  it("승인된 버전 본문에는 편집 컨트롤(input·textarea·select·button)이 없다", () => {
    const html = renderToStaticMarkup(<ReadOnlyVersionView setup={setup("APPROVED")} />);
    expect(html).toContain('data-testid="version-readonly"');
    expect(html).toContain('data-criterion="R-05"');
    expect(html).toContain("POST /orders");
    expect(html).toContain("v2-01234567");
    for (const tag of ["<input", "<textarea", "<select", "<button", "<form"]) {
      expect(html).not.toContain(tag);
    }
  });

  it("명세를 읽지 못하면 사유를 보여 준다", () => {
    const view = {
      ...setup("APPROVED"),
      specMarkdown: null,
      specError: "명세 원문을 읽지 못했습니다",
    };
    expect(renderToStaticMarkup(<ReadOnlyVersionView setup={view} />)).toContain(
      "명세 원문을 읽지 못했습니다",
    );
  });

  it("검증 샘플 표는 종류·확인 항목·검토자(없으면 검토 대기)를 보인다", () => {
    const html = renderToStaticMarkup(<SampleTable samples={setup("DRAFT").samples} />);
    expect(html).toContain("정답 구현");
    expect(html).toContain("대안 통과");
    expect(html).toContain("리뷰어");
    expect(html).toContain("검토 대기");
    expect(renderToStaticMarkup(<SampleTable samples={[]} />)).toContain("검증 샘플이 없습니다");
  });

  it("검증 결과 표는 정답 통과 / 대안 통과 / 결함 탐지 / 적대 샘플 동일 네 줄이다", () => {
    const html = renderToStaticMarkup(<ValidationChecksTable result={result} />);
    for (const check of ["정답 통과", "대안 통과", "결함 탐지", "적대 샘플 동일"]) {
      expect(html).toContain(`data-check-row="${check}"`);
    }
    expect(html.match(/data-sample-status="MATCH"/g)).toHaveLength(4);
  });

  it("검증 진행 상태: 검증 중·job 실패·통과·불일치를 구분한다", () => {
    expect(validationPhase({ status: "DRAFT", validation: null, validationJob: null })).toBe(
      "idle",
    );
    expect(
      validationPhase({
        status: "VALIDATING",
        validation: null,
        validationJob: { status: "RUNNING", lastError: null, attempts: 1 },
      }),
    ).toBe("running");
    expect(
      validationPhase({
        status: "VALIDATING",
        validation: null,
        validationJob: { status: "FAILED", lastError: "x", attempts: 3 },
      }),
    ).toBe("job-failed");
    expect(validationPhase({ status: "VALIDATING", validation: result, validationJob: null })).toBe(
      "passed",
    );
    expect(
      validationPhase({
        status: "DRAFT",
        validation: { ...result, pass: false },
        validationJob: null,
      }),
    ).toBe("mismatch");
  });

  it("오류 목록은 코드와 메시지를 함께 보인다", () => {
    const html = renderToStaticMarkup(
      <IssueList
        title="저장하기 전에 고쳐야 할 점"
        issues={[
          { code: "FORBIDDEN_LIBRARY_TERM", message: "판정 조건에 라이브러리 이름", ref: "R-01" },
        ]}
      />,
    );
    expect(html).toContain('data-issue-code="FORBIDDEN_LIBRARY_TERM"');
    expect(html).toContain("판정 조건에 라이브러리 이름");
    expect(renderToStaticMarkup(<IssueList title="x" issues={[]} />)).toBe("");
  });
});
