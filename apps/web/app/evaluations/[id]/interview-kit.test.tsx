import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  COMPETENCIES,
  INTERVIEW_PRIORITY_LABELS,
  type EvaluationStageRecord,
  type InterviewKit,
} from "@ohmyti/core";
import type { EvaluationContextInput } from "@/lib/context/service";
import {
  FIXTURE_CONTEXT_LINK_ID,
  FIXTURE_EVALUATION_ID,
  FIXTURE_RUN_ID,
  FIXTURE_SHA,
  FIXTURE_SUBMISSION_ID,
  interviewKitFixture,
  reportFixture,
} from "@/lib/workbench/fixtures";
import {
  buildInterviewKitView,
  interviewKitPrintHref,
  RESUME_QUOTE_NOTICE,
  type InterviewKitInput,
  type InterviewKitView,
} from "@/lib/workbench/interview-kit";
import { workbenchHref, WORKBENCH_TAB_LABEL, type WorkbenchUrlState } from "@/lib/workbench/state";
import { InterviewKitTab } from "./interview-kit";

/**
 * 인터뷰 키트 화면 (T-704). 표시 모델(근거 딥링크·진행안·Markdown 내보내기)과 렌더링, 그리고 빈 상태 세 가지를 검사한다.
 * 점수·판정은 키트에 없으므로 화면에도 없어야 한다 (G-01·G-13). 복사 동작과 인쇄 결과는 E2E가 확인한다.
 */

const ORIGIN = "https://review.example.com";
const BASE_STATE: WorkbenchUrlState = {
  criterionId: null,
  runId: null,
  tab: "questions",
  filter: "all",
  pane: "code",
  source: null,
  mutationId: null,
};

const href = (patch: Partial<WorkbenchUrlState>) =>
  workbenchHref(FIXTURE_EVALUATION_ID, BASE_STATE, patch);

function contextInput(
  overrides: Partial<{
    resumeUploaded: boolean;
    textStatus: "OK" | "NONE" | "IMAGE_ONLY" | "TRUNCATED";
    reason: string | null;
    claim: string;
  }> = {},
): EvaluationContextInput {
  return {
    ok: true,
    data: {
      resume: {
        uploaded: overrides.resumeUploaded ?? true,
        textStatus: overrides.textStatus ?? "OK",
        reason: overrides.reason ?? null,
        chars: 1200,
        truncated: false,
      },
      github: { login: "octo", sources: null, invalid: false },
      links: [
        {
          id: FIXTURE_CONTEXT_LINK_ID,
          submissionId: FIXTURE_SUBMISSION_ID,
          evaluationId: FIXTURE_EVALUATION_ID,
          claim: overrides.claim ?? "Designed idempotent payment endpoints",
          claimSource: "RESUME",
          status: "EVIDENCE_FOUND",
          createdAt: "2026-09-19T00:00:00.000Z",
        },
      ],
      otherEvaluationLinkCount: 0,
    },
  } as EvaluationContextInput;
}

function view(
  options: {
    kit?: InterviewKitInput | null;
    stages?: EvaluationStageRecord[];
    context?: EvaluationContextInput | null;
  } = {},
): InterviewKitView {
  return buildInterviewKitView({
    report: reportFixture(options.stages ? { stages: options.stages } : {}),
    kit:
      options.kit === undefined
        ? {
            ok: true,
            data: {
              evaluationId: FIXTURE_EVALUATION_ID,
              artifactKey: `evaluations/${FIXTURE_EVALUATION_ID}/interview-kit.json`,
              kit: interviewKitFixture(),
            },
          }
        : options.kit,
    context: options.context === undefined ? contextInput() : options.context,
    href,
    origin: ORIGIN,
  });
}

function kitInput(kit: InterviewKit): InterviewKitInput {
  return {
    ok: true,
    data: {
      evaluationId: FIXTURE_EVALUATION_ID,
      artifactKey: `evaluations/${FIXTURE_EVALUATION_ID}/interview-kit.json`,
      kit,
    },
  };
}

const DONE_KIT_STAGE: EvaluationStageRecord = {
  stage: "INTERVIEW_KIT",
  state: "DONE",
  startedAt: "2026-09-18T09:04:00.000Z",
  finishedAt: "2026-09-18T09:05:00.000Z",
};

describe("인터뷰 키트 표시 모델", () => {
  it("하단 탭 이름이 인터뷰 키트다", () => {
    expect(WORKBENCH_TAB_LABEL.questions).toBe("인터뷰 키트");
  });

  it("질문을 우선순위로 묶고 유형·역량·예상 시간·기본 질문 표시를 옮긴다", () => {
    const v = view();
    expect(v.questionCount).toBe(3);
    expect(v.groups.map((g) => g.priority)).toEqual(["MUST", "SHOULD"]);
    expect(v.groups[0]!.label).toBe(INTERVIEW_PRIORITY_LABELS.MUST);
    expect(v.groups[0]!.minutes).toBe(8);
    expect(v.groups[1]!.minutes).toBe(11);
    const first = v.groups[0]!.questions[0]!;
    expect(first.number).toBe(1);
    expect(first.kindLabel).toBe("실패 디브리핑");
    expect(first.competencyName).toBe(COMPETENCIES.DEBUGGING.name);
    expect(first.isTemplate).toBe(false);
    expect(v.templateCount).toBe(1);
    expect(v.groups[1]!.questions.find((q) => q.id === "TEST_DESIGN:G1")!.isTemplate).toBe(true);
  });

  it("근거 참조를 기존 워크벤치 딥링크로 바꾼다 (기준·재생·코드 위치·이력서 연결)", () => {
    const first = view().groups[0]!.questions[0]!;
    const byKind = new Map(first.refs.map((r) => [r.kind, r]));
    expect(byKind.get("CRITERION")!.href).toBe(
      `/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&tab=questions`,
    );
    // 재생 딥링크: 기준 + 실행 기록 + 중앙 패널
    expect(byKind.get("EXECUTION_RECORD")!.href).toBe(
      `/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&run=${FIXTURE_RUN_ID}&tab=questions`,
    );
    expect(byKind.get("SOURCE")!.href).toContain("source=src%2Fhttp%2Froutes.ts%3A25-28");
    // 코드 위치의 내보내기 주소는 고정 SHA 링크다
    expect(byKind.get("SOURCE")!.exportUrl).toBe(
      `https://github.com/example/order-api/blob/${FIXTURE_SHA}/src/http/routes.ts#L25-L28`,
    );
    const bridge = view().groups[1]!.questions.find((q) => q.kind === "RESUME_BRIDGE")!;
    expect(bridge.refs[0]!.href).toBe(
      `/evaluations/${FIXTURE_EVALUATION_ID}?tab=resume#claim-${FIXTURE_CONTEXT_LINK_ID}`,
    );
    expect(bridge.claim).toBe("Designed idempotent payment endpoints");
  });

  it("진행안 45분·60분의 구간 합이 각각 45분·60분을 넘지 않는다", () => {
    const v = view();
    expect(v.plans.map((p) => p.durationMinutes)).toEqual([45, 60]);
    for (const plan of v.plans) {
      expect(plan.totalMinutes).toBeLessThanOrEqual(plan.durationMinutes);
      const sum = plan.segments.reduce((total, s) => total + s.minutes, 0);
      expect(sum).toBe(plan.totalMinutes);
    }
    expect(v.plans[0]!.totalMinutes).toBe(24);
    expect(v.plans[1]!.totalMinutes).toBe(29);
    // 구간의 질문은 키트의 순번을 그대로 쓴다
    expect(v.plans[1]!.segments[3]!.questions[0]!.number).toBe(3);
  });

  it("역량별 4단계 앵커는 질문에 쓰인 역량만 보이고 값은 비어 있다", () => {
    const v = view();
    expect(v.anchors.map((a) => a.competency)).toEqual(["DATA_INTEGRITY", "TESTING", "DEBUGGING"]);
    for (const group of v.anchors) {
      expect(group.anchors.map((a) => a.value)).toEqual([1, 2, 3, 4]);
    }
    expect(v.anchors.find((a) => a.competency === "DEBUGGING")!.interviewOnly).toBe(true);
  });

  it("인쇄용 보기 주소는 평가 하위 경로다", () => {
    expect(view().printHref).toBe(`/evaluations/${FIXTURE_EVALUATION_ID}/interview-kit`);
    expect(interviewKitPrintHref("abc")).toBe("/evaluations/abc/interview-kit");
  });
});

describe("Markdown 내보내기", () => {
  it("필수 질문·꼬리 질문·신호·근거 URL(고정 SHA)이 들어 있다", () => {
    const md = view().markdown;
    expect(md).toContain("# 인터뷰 키트 · 주문·재고 API");
    expect(md).toContain(`${ORIGIN}/evaluations/${FIXTURE_EVALUATION_ID}`);
    expect(md).toContain("## 필수 질문");
    expect(md).toContain("Q1. 실패 디브리핑");
    expect(md).toContain("**질문**: R-05 재생 기록을 함께 보겠습니다.");
    expect(md).toContain("**꼬리 질문**");
    expect(md).toContain("1. 재전송 요청이 처음 요청과 같은 키인지는 어디에서 판단하나요?");
    expect(md).toContain("**좋은 답변의 신호**");
    expect(md).toContain("**우려 신호**");
    // 근거 URL: 코드 위치는 고정 SHA, 나머지는 워크벤치 절대 주소
    expect(md).toContain(
      `https://github.com/example/order-api/blob/${FIXTURE_SHA}/src/http/routes.ts#L25-L28`,
    );
    expect(md).toContain(`${ORIGIN}/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&run=`);
    expect(md).not.toMatch(/blob\/HEAD|blob\/main/);
    // 진행안과 평가 척도
    expect(md).toContain("## 45분 진행안 (구간 합 24분)");
    expect(md).toContain("## 60분 진행안 (구간 합 29분)");
    expect(md).toContain("## 평가 척도 (역량별 4단계, 면접관 기입)");
    // 기본 질문 표시
    expect(md).toContain("· 기본 질문");
    // 점수·판정은 넣지 않는다
    expect(md).not.toMatch(/점수|\/100|PASS|FAIL/);
  });

  it("이력서 연결 질문이 있으면 인용 안내를 함께 적는다", () => {
    expect(view().resumeQuoteNotice).toBe(RESUME_QUOTE_NOTICE);
    expect(view().markdown).toContain(RESUME_QUOTE_NOTICE);
    const noBridge = interviewKitFixture({
      questions: interviewKitFixture().questions.filter((q) => q.kind !== "RESUME_BRIDGE"),
      plans: interviewKitFixture().plans.map((p) => ({
        ...p,
        segments: p.segments.filter((s) => s.name !== "이력서 연결"),
      })),
    });
    const v = view({ kit: kitInput(noBridge) });
    expect(v.resumeQuoteNotice).toBeNull();
    expect(v.markdown).not.toContain(RESUME_QUOTE_NOTICE);
  });
});

describe("세 가지 빈 상태 (G-14)", () => {
  it("키트가 없는 이전 평가는 사유와 함께 이전 후속 질문 목록을 보인다", () => {
    const v = view({ kit: { ok: false, code: "ARTIFACT_NOT_FOUND", message: "없음" } });
    expect(v.missing!.title).toBe("인터뷰 키트가 없는 평가");
    expect(v.missing!.description).toContain("이전 후속 질문 목록");
    const html = renderToStaticMarkup(
      <InterviewKitTab kit={v} fallback={<p>이전 후속 질문 목록</p>} />,
    );
    expect(html).toContain("인터뷰 키트가 없는 평가");
    expect(html).toContain("이전 후속 질문 목록");
    expect(html).not.toContain('data-testid="interview-kit"');
  });

  it("단계가 끝나지 않은 평가는 단계 상태와 사유를 보인다", () => {
    const v = view({
      kit: { ok: false, code: "ARTIFACT_NOT_FOUND", message: "없음" },
      stages: [
        {
          stage: "INTERVIEW_KIT",
          state: "SKIPPED",
          reason: "검증 실행은 인터뷰 키트를 만들지 않음",
        },
      ],
    });
    expect(v.missing!.title).toContain("인터뷰 키트");
    expect(v.missing!.description).toContain("검증 실행은 인터뷰 키트를 만들지 않음");
  });

  it("LLM 미실행이면 상단에 사유를 보이고 모든 질문이 기본 질문이다", () => {
    const kit = interviewKitFixture({
      questions: interviewKitFixture().questions.map((q) => ({
        ...q,
        source: "TEMPLATE" as const,
      })),
      generation: { llm: "NOT_CONFIGURED", llmReason: "LLM 미설정", templateCount: 3 },
    });
    const v = view({ kit: kitInput(kit), stages: [DONE_KIT_STAGE] });
    expect(v.llmNotice).toContain("LLM 미설정");
    expect(v.llmNotice).toContain("모든 질문을 슬롯별 기본 질문으로 채웠습니다");
    expect(v.templateCount).toBe(3);
    expect(v.templateNotice).toBeNull();
    const html = renderToStaticMarkup(<InterviewKitTab kit={v} fallback={null} />);
    expect(html).toContain("LLM 미설정");
    expect(html).toContain("기본 질문");
  });

  it("이력서가 없는 평가는 이력서 연결 질문이 없는 이유를 보인다", () => {
    const kit = interviewKitFixture({
      questions: interviewKitFixture().questions.filter((q) => q.kind !== "RESUME_BRIDGE"),
      plans: interviewKitFixture().plans.map((p) => ({
        ...p,
        segments: p.segments.filter((s) => s.name !== "이력서 연결"),
      })),
    });
    const v = view({
      kit: kitInput(kit),
      context: contextInput({ resumeUploaded: false, textStatus: "NONE" }),
      stages: [DONE_KIT_STAGE],
    });
    expect(v.resumeNotice).toBe(
      "이력서가 제출되지 않아 이력서 연결 질문이 없습니다. 모든 질문은 과제 관측에서 나왔습니다.",
    );
    expect(v.resumeQuoteNotice).toBeNull();
  });

  it("LLM 문장 일부가 검사에 걸리면 기본 질문으로 바꿨다고 알린다", () => {
    const v = view({ stages: [DONE_KIT_STAGE] });
    expect(v.llmNotice).toBeNull();
    expect(v.templateNotice).toBe(
      "LLM이 쓴 문장 중 1개가 질문 검사에 걸려 기본 질문으로 바꿨습니다.",
    );
  });
});

describe("렌더링", () => {
  it("질문 카드에 역량·시간·의도·꼬리 질문·신호·근거 링크가 모두 있고 점수 표시는 없다", () => {
    const v = view();
    const html = renderToStaticMarkup(<InterviewKitTab kit={v} fallback={null} />);
    expect(html).toContain('data-testid="interview-kit"');
    expect(html).toContain('data-kit-question="FAILURE_DEBRIEF:R-05"');
    expect(html).toContain('data-kind="FAILURE_DEBRIEF"');
    expect(html).toContain('data-priority="MUST"');
    expect(html).toContain('data-source="TEMPLATE"');
    expect(html).toContain("8분");
    expect(html).toContain(COMPETENCIES.DEBUGGING.name);
    expect(html).toContain("꼬리 질문");
    expect(html).toContain("좋은 답변의 신호");
    expect(html).toContain("우려 신호");
    expect(html).toContain(`run=${FIXTURE_RUN_ID}`);
    expect(html).toContain("평가 척도 (역량별 4단계)");
    expect(html).toContain(RESUME_QUOTE_NOTICE);
    // 점수·합격 성격의 표시는 없다 (평가 척도 문구의 "우선순위"는 면접관 기입 기준이라 대상이 아니다)
    expect(html).not.toMatch(/점수|\/100|합격|탈락|지원자 순위/);
  });

  it("인쇄 모드는 근거 주소를 글자로 적고 링크를 만들지 않는다", () => {
    const v = view();
    const html = renderToStaticMarkup(<InterviewKitTab kit={v} fallback={null} />);
    expect(html).toContain('href="/evaluations/');
    const printHtml = renderToStaticMarkup(
      <InterviewKitTab kit={{ ...v, plans: [] }} fallback={null} />,
    );
    // 진행안이 없어도 카드가 그대로 보인다
    expect(printHtml).toContain('data-kit-question="FAILURE_DEBRIEF:R-05"');
  });
});
