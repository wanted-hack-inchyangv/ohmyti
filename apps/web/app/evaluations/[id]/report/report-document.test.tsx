import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  findForbiddenReportExpressions,
  type ContextLink,
  type EvaluationReport,
  type EvaluationStageRecord,
  type HiringReport,
  type ReportProfile,
} from "@ohmyti/core";
import {
  DEFECTIVE_SAMPLE_VERDICTS,
  FIXTURE_CONTEXT_LINK_ID,
  FIXTURE_EVALUATION_ID,
  FIXTURE_RUN_ID,
  FIXTURE_SUBMISSION_ID,
  interviewKitFixture,
  reportFixture,
} from "@/lib/workbench/fixtures";
import { buildHiringReport, type HiringReportInput } from "@/lib/reports/hiring-report";
import type { KitRefView } from "@/lib/workbench/interview-kit";
import {
  buildHiringReportView,
  HIRING_REPORT_DISCLAIMER,
  hiringReportHref,
} from "@/lib/reports/hiring-report-view";
import { HiringReportDocument, printRefs } from "./report-document";

/**
 * 채용 리포트 화면 (T-706, PRD 14.3). 표시 모델과 렌더링을 함께 검사한다.
 * - 상단 고지, 점수 표기, 영역·판정 막대, 근거 딥링크
 * - 검토 대기·INCONCLUSIVE·LLM 미실행·이력서 없음 네 가지 상태가 각각 보인다 (G-14)
 * - 인터뷰 키트 질문은 슬롯 ID가 아니라 번호(Q1)와 주 질문 문장으로 보인다
 * - 프로필의 영향 문장이 있으면 강조하고, 없으면 기준의 판정 조건을 대신 보인다
 * - 출력 전체에 금지 표현이 없다 (PRD 14.4)
 * 인쇄(PDF)·Markdown 복사 동작과 화면 레이아웃은 E2E(`e2e/workbench-hiring-report.spec.ts`)가 확인한다.
 */

// 스코어카드 입력 폼(T-707)은 클라이언트 컴포넌트라 서버 렌더링에서 라우터가 필요하다
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const ORIGIN = "https://review.example.com";

const PROFILE: ReportProfile = {
  profileVersion: 1,
  criteria: [
    {
      criterionId: "R-05",
      competency: "DATA_INTEGRITY",
      impact: "같은 주문 요청이 두 번 처리되어 중복 결제로 이어질 수 있습니다.",
    },
  ],
};

const CONTEXT_LINKS: ContextLink[] = [
  {
    id: FIXTURE_CONTEXT_LINK_ID,
    submissionId: FIXTURE_SUBMISSION_ID,
    evaluationId: FIXTURE_EVALUATION_ID,
    claim: "결제 API에 멱등 처리를 도입했습니다",
    claimSource: "RESUME",
    status: "EVIDENCE_FOUND",
    githubEvidence: [
      {
        repo: "example/payments",
        url: "https://github.com/example/payments/pull/12",
        summary: "재전송 키로 중복 결제를 막은 변경",
      },
    ],
    assignmentObservation: {
      criterionId: "R-05",
      summary: "이번 과제에서는 재전송이 두 번 처리되었습니다",
    },
    followUpQuestion: "그때의 재전송 판단 기준은 무엇이었나요?",
    createdAt: "2026-09-18T09:04:00.000Z",
  },
];

const INTERVIEW_KIT_STAGE: EvaluationStageRecord = {
  stage: "INTERVIEW_KIT",
  state: "DONE",
  detail: {
    slotCount: 3,
    templateCount: 1,
    llm: "OK",
    llmReason: null,
    promptVersion: "interview-kit-1",
    model: "deepseek-chat",
    aiReviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    inputDigest: "b".repeat(64),
    dropped: [],
    artifactKey: `evaluations/${FIXTURE_EVALUATION_ID}/interview-kit.json`,
    priorities: { MUST: 1, SHOULD: 2, OPTIONAL: 0 },
  },
};

function defectiveReport(overrides: Partial<Parameters<typeof reportFixture>[0]> = {}) {
  return reportFixture({
    verdicts: DEFECTIVE_SAMPLE_VERDICTS,
    aggregate: true,
    stages: [INTERVIEW_KIT_STAGE],
    ...overrides,
  });
}

function input(overrides: Partial<HiringReportInput> = {}): HiringReportInput {
  return {
    report: defectiveReport(),
    kit: interviewKitFixture(),
    contextLinks: CONTEXT_LINKS,
    designSignals: null,
    profile: PROFILE,
    ...overrides,
  };
}

function viewOf(overrides: Partial<HiringReportInput> = {}) {
  const built = input(overrides);
  return buildHiringReportView({
    report: built.report,
    hiring: buildHiringReport(built),
    origin: ORIGIN,
  });
}

function render(overrides: Partial<HiringReportInput> = {}): string {
  return renderToStaticMarkup(<HiringReportDocument view={viewOf(overrides)} />);
}

describe("채용 리포트 화면 · 한눈 요약과 핵심 관측", () => {
  it("상단 고지와 점수 표기, 영역 소계·판정 분포 막대를 보인다", () => {
    const view = viewOf();
    const html = render();
    expect(view.disclaimer).toBe(HIRING_REPORT_DISCLAIMER);
    expect(html).toContain("이 문서는 실행 근거를 정리한 자료이며 채용 결정은 사람이 합니다.");
    // 점수 표기는 저장된 값 그대로다 (부록 C: 검토 대기가 있으면 범위 표기)
    expect(view.scoreDisplay).toMatch(/^\d+~\d+\/100 · \d+점 검토 대기$/);
    expect(html).toContain(view.scoreDisplay);
    // 영역 소계 다섯 개가 모두 막대가 된다
    expect(view.areaBars).toHaveLength(5);
    expect(view.areaBars.map((bar) => bar.label)).toContain("테스트 실효성");
    // 미확정은 주황, 실제 실패는 빨강이다 (T-301)
    const verdictTones = Object.fromEntries(view.verdictBar.parts.map((p) => [p.key, p.tone]));
    expect(verdictTones).toMatchObject({ PASS: "ink", FAIL: "fail", INCONCLUSIVE: "pending" });
  });

  it("확인된 결함은 잃은 배점 순이고 기준·재생 딥링크를 갖는다", () => {
    const view = viewOf();
    expect(view.defects.map((d) => d.criterionId)).toEqual(["R-05", "R-06", "R-07"]);
    const r05 = view.defects[0]!;
    expect(r05.href).toBe(`/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05`);
    const replay = r05.refs.find((ref) => ref.kind === "EXECUTION_RECORD")!;
    expect(replay.href).toBe(
      `/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&run=${FIXTURE_RUN_ID}`,
    );
    expect(replay.exportUrl).toBe(`${ORIGIN}${replay.href}`);
    const html = render();
    // HTML 속성에서는 `&`가 `&amp;`로 이스케이프된다
    expect(html).toContain(`href="${replay.href!.replace(/&/g, "&amp;")}"`);
  });

  it("프로필의 영향 문장은 관측 문장과 함께 보이고, 없으면 기준의 판정 조건을 대신 보인다", () => {
    const withProfile = viewOf();
    expect(withProfile.defects[0]!.impact).toBe(PROFILE.criteria[0]!.impact);
    expect(withProfile.defects[0]!.condition).toBeNull();
    expect(render()).toContain(`영향: ${PROFILE.criteria[0]!.impact}`);

    const without = viewOf({ profile: null });
    expect(without.defects[0]!.impact).toBeNull();
    expect(without.defects[0]!.condition).not.toBeNull();
    const html = render({ profile: null });
    expect(html).toContain("판정 조건:");
    // 영향 문장이 없을 때 빈 `영향:` 줄을 남기지 않는다
    expect(html).not.toContain("영향: </p>");
  });
});

describe("채용 리포트 화면 · 인쇄물 축약 (T-802)", () => {
  it("인쇄물 근거는 기준 1 + 재생 1 + 코드 위치 2로 줄이고 나머지 코드 위치는 개수로 센다", () => {
    const ref = (kind: KitRefView["kind"], label: string): KitRefView => ({
      kind,
      label,
      href: null,
      exportUrl: null,
    });
    const refs = [
      ref("CRITERION", "R-05"),
      ref("EXECUTION_RECORD", "R-05 재생"),
      ref("SOURCE", "src/a.ts:1-2"),
      ref("SOURCE", "src/b.ts:3-4"),
      ref("SOURCE", "src/c.ts:5-6"),
      ref("MUTATION", "M-01"),
    ];
    const reduced = printRefs(refs);
    expect(reduced.refs.map((r) => r.label)).toEqual([
      "R-05",
      "R-05 재생",
      "src/a.ts:1-2",
      "src/b.ts:3-4",
    ]);
    expect(reduced.overflow).toBe(1);
    // 코드 위치가 상한 이하면 남는 개수가 없다
    expect(printRefs(refs.slice(0, 4)).overflow).toBe(0);
  });

  it("화면에는 근거 전체와 판정 조건이 남고, 인쇄용 목록은 따로 그린다", () => {
    const html = render({ profile: null });
    expect(html).toContain("판정 조건:");
    expect(html).toContain('data-testid="report-print-refs"');
    // 화면 목록은 저장된 근거를 하나도 빼지 않는다
    const view = viewOf({ profile: null });
    const defect = view.defects[0]!;
    for (const item of defect.refs) expect(html).toContain(item.label);
  });
});

describe("채용 리포트 화면 · 인터뷰 키트 질문 표시", () => {
  it("역량별 관측과 면접 권고는 슬롯 ID 대신 질문 번호와 주 질문 문장을 보인다", () => {
    const view = viewOf();
    const debugging = view.competencies.find((c) => c.competency === "DEBUGGING")!;
    expect(debugging.questions).toHaveLength(1);
    expect(debugging.questions[0]!.label).toBe("Q1");
    expect(debugging.questions[0]!.question).toContain("R-05 재생 기록을 함께 보겠습니다.");
    expect(debugging.questions[0]!.href).toContain("#kit-q-FAILURE_DEBRIEF-R-05");
    expect(view.interviewGuide.questions.map((q) => q.label)).toEqual(["Q1"]);

    const html = render();
    expect(html).toContain("Q1");
    expect(html).toContain("R-05 재생 기록을 함께 보겠습니다.");
    // 슬롯 ID는 읽는 사람에게 보이지 않는다 (data 속성과 링크 앵커에만 남는다)
    expect(html).not.toContain(">FAILURE_DEBRIEF:R-05<");
    expect(view.markdown).toContain("Q1. R-05 재생 기록을 함께 보겠습니다.");
    expect(view.markdown).not.toContain("면접에서 확인할 질문: FAILURE_DEBRIEF:R-05");
  });

  it("키트가 없는 평가는 면접 권고와 역량별 질문에 인터뷰 키트 없음을 보인다", () => {
    const view = viewOf({ kit: null });
    expect(view.interviewGuide.status).toBe("NO_DATA");
    expect(view.interviewGuide.notice).toContain("인터뷰 키트가 없습니다");
    const debugging = view.competencies.find((c) => c.competency === "DEBUGGING")!;
    expect(debugging.questionsEmpty).toBe("인터뷰 키트 없음");
    const html = render({ kit: null });
    expect(html).toContain("인터뷰 키트 없음");
    expect(view.markdown).toContain("면접에서 확인할 질문: 인터뷰 키트 없음");
  });
});

describe("채용 리포트 화면 · 네 가지 상태 (G-14)", () => {
  it("검토 대기 기준이 요약과 평가 범위에 모두 보인다", () => {
    const base = defectiveReport();
    const report: EvaluationReport = {
      ...base,
      criterionResults: base.criterionResults.map((result) =>
        result.criterionId === "R-12" ? { ...result, reviewState: "PENDING" as const } : result,
      ),
    };
    const view = viewOf({ report });
    expect(view.pendingReview.map((c) => c.criterionId)).toContain("R-12");
    const html = render({ report });
    expect(html).toContain("검토 대기:");
    expect(html).toContain("R-12");
  });

  it("INCONCLUSIVE 기준은 미확정으로 보이고 환경 장애는 따로 표시한다 (G-11)", () => {
    const view = viewOf();
    expect(view.scope.inconclusive.map((i) => i.criterionId)).toEqual(["G1", "G2", "G3", "R-12"]);
    const html = render();
    expect(html).toContain("미확정 기준");
    expect(html).toContain("미확정");
  });

  it("LLM을 부르지 못한 키트는 사유와 기본 질문 표시를 함께 보인다", () => {
    const kit = interviewKitFixture({
      generation: { llm: "NOT_CONFIGURED", llmReason: "LLM 키가 설정되지 않음" },
    });
    const view = viewOf({ kit });
    expect(view.interviewGuide.notice).toContain("LLM 키가 설정되지 않음");
    const html = render({ kit });
    expect(html).toContain("LLM 키가 설정되지 않음");
    expect(html).toContain("슬롯별 기본 질문으로 채웠습니다");
  });

  it("이력서가 없으면 이력서 절이 사유를 보인다", () => {
    const view = viewOf({ contextLinks: [] });
    expect(view.resumeLinks.status).toBe("NO_RESUME");
    const html = render({ contextLinks: [] });
    expect(html).toContain("이력서가 제출되지 않아 연결할 주장이 없습니다");
  });
});

describe("채용 리포트 화면 · 금지 표현과 구조", () => {
  it("렌더링 결과와 Markdown 전체에 금지 표현이 없다", () => {
    for (const overrides of [
      {},
      { kit: null },
      { profile: null },
    ] as Partial<HiringReportInput>[]) {
      const view = viewOf(overrides);
      expect(findForbiddenReportExpressions(render(overrides))).toEqual([]);
      expect(findForbiddenReportExpressions(view.markdown)).toEqual([]);
    }
  });

  it("PRD 14.3의 아홉 개 절이 순서대로 있고 스코어카드는 빈 양식이다", () => {
    const html = render();
    const sections = [...html.matchAll(/data-section="(\d)"/g)].map((m) => m[1]);
    expect(sections).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    const view = viewOf();
    expect(view.scorecard.humanOnly).toBe(true);
    expect(view.scorecard.competencies).toHaveLength(9);
    expect(html).toContain("면접관이 기입하는 빈 양식입니다.");
    expect(html).toContain("면접관 최종 의견");
  });

  it("스코어카드 절에 입력 폼이 있고 저장된 기록이 없으면 그렇게 적는다 (T-707)", () => {
    const html = render();
    expect(html).toContain('data-testid="scorecard-form"');
    expect(html).toContain('data-testid="scorecard-saved-empty"');
    expect(html).toContain("저장된 스코어카드가 없습니다.");
    // 시스템은 어떤 척도도 미리 고르지 않는다 (G-08)
    expect(html).not.toContain("checked=");
  });

  it("저장된 스코어카드를 면접관마다 나란히 보이고 합산하지 않는다 (T-707)", () => {
    const html = render({
      scorecards: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          evaluationId: FIXTURE_EVALUATION_ID,
          interviewer: "김면접",
          competencies: [{ competency: "REQUIREMENTS", value: 2, note: "조건을 짚지 못했다" }],
          questionNotes: [
            { questionId: "FAILURE_DEBRIEF:R-06", number: 1, note: "재생 기록을 읽었다" },
          ],
          finalNote: "동시성 조건을 한 번 더 확인하면 좋겠다",
          revision: 1,
          latest: false,
          createdAt: "2026-09-20T01:00:00.000Z",
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          evaluationId: FIXTURE_EVALUATION_ID,
          interviewer: "박면접",
          competencies: [{ competency: "DEBUGGING", value: 4, note: null }],
          questionNotes: [],
          finalNote: null,
          revision: 1,
          latest: true,
          createdAt: "2026-09-20T02:00:00.000Z",
        },
      ],
    });
    expect(html).toContain('data-interviewer="김면접"');
    expect(html).toContain('data-interviewer="박면접"');
    expect(html).toContain("요구사항 이해와 구현 정확성: 2 보완 필요 · 조건을 짚지 못했다");
    expect(html).toContain("이전 기록");
    expect(html).toContain("최종 의견: 적지 않음");
    expect(findForbiddenReportExpressions(html)).toEqual([]);
  });

  it("리포트 링크 경로는 평가 하위의 `report`다", () => {
    expect(hiringReportHref(FIXTURE_EVALUATION_ID)).toBe(
      `/evaluations/${FIXTURE_EVALUATION_ID}/report`,
    );
  });

  it("리포트의 점수·판정은 조립된 저장값을 그대로 옮긴다", () => {
    const built = input();
    const hiring: HiringReport = buildHiringReport(built);
    const view = buildHiringReportView({ report: built.report, hiring, origin: ORIGIN });
    expect(view.scoreDisplay).toBe(hiring.summary.score!.display);
    expect(view.requirements.map((r) => r.verdict)).toEqual(
      hiring.requirements.criteria.map((c) => c.verdict),
    );
  });
});
