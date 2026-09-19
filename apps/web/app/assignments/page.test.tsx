import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssignmentList, metadata } from "./page";

describe("/assignments", () => {
  it("메타데이터 제목이 있다", () => {
    expect(metadata.title).toBe("과제 목록 · CodeGraph Reviewer");
  });

  it("과제 · v<n> · 상태 라벨과 rubric_version·승인자를 표시한다", () => {
    const html = renderToStaticMarkup(
      <AssignmentList
        items={[
          {
            id: "a1",
            name: "주문·재고 API",
            description: "샘플 과제",
            createdAt: new Date("2026-09-18T00:00:00Z"),
            versions: [
              {
                id: "v2",
                version: 2,
                status: "DRAFT",
                title: "주문·재고 API v2",
                rubricVersion: "v2-01234567",
                harnessVersion: "0.1.0+abc",
                approvedBy: null,
                approvedAt: null,
                createdAt: new Date("2026-09-18T01:00:00Z"),
                validationResult: null,
                samplesTotal: 0,
                samplesReviewed: 0,
                submissionCount: 0,
                bootstrapPendingReview: false,
              },
              {
                id: "v1",
                version: 1,
                status: "APPROVED",
                title: "주문·재고 API v1",
                rubricVersion: "v1-89abcdef",
                harnessVersion: "0.1.0+abc",
                approvedBy: "seed",
                approvedAt: new Date("2026-09-18T00:30:00Z"),
                createdAt: new Date("2026-09-18T00:00:00Z"),
                validationResult: { gate: "phase1", ok: true },
                samplesTotal: 4,
                samplesReviewed: 0,
                submissionCount: 3,
                bootstrapPendingReview: true,
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('data-version-label="주문·재고 API · v1 · 승인됨"');
    expect(html).toContain('data-version-label="주문·재고 API · v2 · 초안"');
    expect(html).toContain("v1-89abcdef");
    expect(html).toContain("seed · 2026-09-18");
    expect(html).toContain("승인됨");
    expect(html).not.toMatch(/정확도|비용 절감|%/);
    // T-405: 시드 부트스트랩 승인 배지, 샘플 검토 수, 실제 제출 수. 1단계 게이트 JSON은 검증 결과로 표시하지 않는다
    expect(html).toContain("부트스트랩 승인 · 샘플 검토 대기");
    expect(html.match(/data-testid="bootstrap-approval-badge"/g)).toHaveLength(1);
    expect(html).toContain("4개 · 검토 0/4");
    expect(html).toContain("3건");
    expect(html).not.toContain("data-validation-pass");
  });

  it("채점기 검증 불일치 표를 표시한다 (T-405)", () => {
    const sample = (
      id: string,
      name: string,
      kind: string,
      check: string,
      status: string,
      mismatchCount: number,
    ) => ({
      sampleId: id,
      name,
      kind,
      check,
      submissionSha: "1".repeat(40),
      submissionId: null,
      evaluationId: null,
      status,
      mismatchCount,
      scoreDisplay: null,
      error: null,
    });
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const mismatch = (field: string, expected: string | number, actual: string | number) => ({
      sampleId: b,
      sampleName: "대안 정답 구현 B",
      sampleKind: "ALTERNATIVE",
      subject: "CRITERION",
      ref: "R-11",
      field,
      expected,
      actual,
      message: `R-11: ${field}`,
    });
    const validationResult = {
      kind: "rubric_validation",
      assignmentVersionId: "11111111-1111-4111-8111-111111111111",
      rubricVersion: "v2-01234567",
      harnessVersion: "0.1.0+abc",
      startedAt: "2026-09-19T00:00:00.000Z",
      finishedAt: "2026-09-19T00:01:00.000Z",
      perSample: [
        sample(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "정답 구현 A",
          "CORRECT",
          "정답 통과",
          "MATCH",
          0,
        ),
        sample(b, "대안 정답 구현 B", "ALTERNATIVE", "대안 통과", "MISMATCH", 2),
      ],
      mismatches: [mismatch("verdict", "PASS", "FAIL"), mismatch("earnedPoints", 4, 0)],
      pass: false,
    };
    const html = renderToStaticMarkup(
      <AssignmentList
        items={[
          {
            id: "a1",
            name: "주문·재고 API",
            description: null,
            createdAt: new Date("2026-09-18T00:00:00Z"),
            versions: [
              {
                id: "v2",
                version: 2,
                status: "DRAFT",
                title: "v2",
                rubricVersion: "v2-01234567",
                harnessVersion: "0.1.0+abc",
                approvedBy: null,
                approvedAt: null,
                createdAt: new Date("2026-09-18T01:00:00Z"),
                validationResult,
                samplesTotal: 4,
                samplesReviewed: 4,
                submissionCount: 0,
                bootstrapPendingReview: false,
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('data-validation-pass="false"');
    expect(html).toContain("채점기 검증 불일치 2건: 승인할 수 없습니다");
    expect(html).toContain("대안 통과 · 대안 정답 구현 B · 불일치");
    expect(html).toContain("정답 통과 · 정답 구현 A · 일치");
    expect(html).toContain('data-testid="validation-mismatches"');
    expect(html).toContain("불일치 표");
    expect(html).toMatch(
      /대안 정답 구현 B<\/td><td[^>]*>R-11<\/td><td[^>]*>verdict<\/td><td[^>]*>PASS<\/td><td[^>]*>FAIL/,
    );
    expect(html).not.toContain("부트스트랩 승인");
  });

  it("과제가 없으면 시드 안내를 보여 준다", () => {
    const html = renderToStaticMarkup(<AssignmentList items={[]} />);
    expect(html).toContain("pnpm db:seed:sample");
  });
});
