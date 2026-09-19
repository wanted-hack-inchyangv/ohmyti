import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EvaluationStageRecord, Evidence, ReviewEvent } from "@ohmyti/core";
import { buildEvidencePanelView, REVIEW_EVENT_KIND_LABEL } from "@/lib/workbench/evidence-panel";
import {
  FIXTURE_EVALUATION_ID,
  FIXTURE_RUN_ID,
  FIXTURE_SHA,
  reportFixture,
  type ReportFixtureOptions,
} from "@/lib/workbench/fixtures";
import { parseWorkbenchSearchParams, workbenchHref } from "@/lib/workbench/state";
import { buildWorkbenchView } from "@/lib/workbench/view";
import { validateReviewFields } from "./review-actions";
import { WorkbenchShell } from "./workbench-shell";

/**
 * 평가 근거·검토 이력 패널 (T-306). 정적 HTML을 렌더링해 관측/추정 구분, 근거 링크(중앙 이동), 이력 순서·내용,
 * 삭제 액션 부재, 토큰 규칙(추정만 pending)을 검사한다. 액션의 저장 규칙은 `lib/reviews/service.test.ts`(통합)와
 * core `review.test.ts`가 검사한다.
 */

const HUMAN_EVIDENCE_ID = "3d5b1a2e-0000-4000-8000-00000000a306";
const STATIC_EVIDENCE_ID = "3d5b1a2e-0000-4000-8000-00000000a304";

function eventOf(overrides: Partial<ReviewEvent> & { id: string; createdAt: string }): ReviewEvent {
  return {
    evaluationId: FIXTURE_EVALUATION_ID,
    criterionId: "R-05",
    kind: "OVERRIDE",
    reviewer: "reviewer@example.com",
    previous: { earnedPoints: 0, verdict: "FAIL", reviewState: "NOT_REQUIRED" },
    next: { earnedPoints: 14, verdict: "PASS", reviewState: "CONFIRMED" },
    reason: "재현 결과 검토",
    ...overrides,
  };
}

const EVENTS: ReviewEvent[] = [
  eventOf({
    id: "e1000000-0000-4000-8000-000000000001",
    createdAt: "2026-09-18T10:00:00.000Z",
    reason: "첫 번째 수정: 부분 인정",
    next: { earnedPoints: 3, verdict: "FAIL", reviewState: "CONFIRMED" },
  }),
  eventOf({
    id: "e1000000-0000-4000-8000-000000000002",
    createdAt: "2026-09-18T10:05:00.000Z",
    reviewer: "other@example.com",
    reason: "두 번째 수정: 전부 인정",
    previous: { earnedPoints: 3, verdict: "FAIL", reviewState: "CONFIRMED" },
  }),
  eventOf({
    id: "e1000000-0000-4000-8000-000000000003",
    createdAt: "2026-09-18T10:07:00.000Z",
    criterionId: "R-12",
    kind: "APPROVE_DESIGN",
    previous: { earnedPoints: null, verdict: "INCONCLUSIVE", reviewState: "PENDING" },
    next: { earnedPoints: 10, verdict: "PASS", reviewState: "CONFIRMED" },
    reason: "설계 점수를 확정했습니다",
  }),
];

function render(query: Record<string, string> = {}, options: ReportFixtureOptions = {}) {
  const report = reportFixture(options);
  const urlState = parseWorkbenchSearchParams(query);
  const href = (patch: Parameters<typeof workbenchHref>[2]) =>
    workbenchHref(report.evaluation.id, urlState, patch);
  const view = buildWorkbenchView(report, urlState, href);
  return { html: renderToStaticMarkup(<WorkbenchShell view={view} />), view, report };
}

function panelHtml(html: string): string {
  const start = html.indexOf(
    '<aside class="flex min-w-0 flex-col rounded-xl border border-neutral-200 bg-surface" data-panel="evidence"',
  );
  expect(start).toBeGreaterThan(0);
  return html.slice(start, html.indexOf("</aside>", start));
}

describe("EvidencePanel: 관측·추정·근거", () => {
  it("선택한 기준의 관측·method·판정·근거 목록을 리포트에서 그대로 옮긴다", () => {
    const { html, view, report } = render({ criterion: "R-05" });
    const panel = panelHtml(html);
    const result = report.criterionResults.find((r) => r.criterionId === "R-05")!;
    expect(panel).toContain('data-evidence-status="ok"');
    expect(panel).toContain(`data-testid="observation">${result.observation}<`);
    expect(panel).toContain('data-testid="evidence-points">0/14<');
    expect(panel).toContain('data-testid="evidence-method">실행<');
    expect(panel).toContain('data-verdict="FAIL"');
    expect(panel).toContain('data-review-state="NOT_REQUIRED"');
    expect(view.evidencePanel.evidences).toHaveLength(1);
    // 실행 근거를 누르면 중앙 실패 재생(`?run=`)으로 간다
    expect(panel).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&amp;run=${FIXTURE_RUN_ID}"`,
    );
    expect(panel).toContain('data-href-target="run"');
    expect(panel).toContain("R-05-case");
    // 추정은 아직 없다 (4단계 전)
    expect(panel).toContain('data-testid="interpretation-empty"');
    expect(panel).not.toContain('data-testid="interpretation"');
  });

  it("interpretation이 있으면 추정 라벨(pending)과 본문을 관측과 나눠 보이고, 코드 위치 근거는 코드 근거 탭으로 간다", () => {
    const staticEvidence: Evidence = {
      id: STATIC_EVIDENCE_ID,
      evaluationId: FIXTURE_EVALUATION_ID,
      submissionSha: FIXTURE_SHA,
      source: { path: "src/http/routes.ts", startLine: 25, endLine: 28 },
      artifactRefs: [],
      kind: "STATIC_RELATION",
    };
    const { html } = render(
      { criterion: "R-05" },
      {
        interpretations: { "R-05": "멱등성 키 저장 없이 새 주문을 만드는 것으로 보임" },
        extraEvidences: [{ criterionId: "R-05", evidence: staticEvidence }],
      },
    );
    const panel = panelHtml(html);
    expect(panel).toContain(
      'data-testid="interpretation">멱등성 키 저장 없이 새 주문을 만드는 것으로 보임<',
    );
    expect(panel).toMatch(/data-interpretation="true" class="contents"><span data-tone="pending"/);
    expect(panel).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&amp;source=src%2Fhttp%2Froutes.ts%3A25-28"`,
    );
    expect(panel).toContain('data-href-target="source"');
    expect(panel).toContain('data-evidence-kind="STATIC_RELATION"');
  });

  it("사람 검토 근거는 회색 라벨이며 링크가 없다", () => {
    const human: Evidence = {
      id: HUMAN_EVIDENCE_ID,
      evaluationId: FIXTURE_EVALUATION_ID,
      submissionSha: FIXTURE_SHA,
      artifactRefs: [],
      kind: "HUMAN_REVIEW",
    };
    const { html, view } = render(
      { criterion: "R-12" },
      { extraEvidences: [{ criterionId: "R-12", evidence: human }] },
    );
    const panel = panelHtml(html);
    const item = view.evidencePanel.evidences.find((e) => e.id === HUMAN_EVIDENCE_ID)!;
    expect(item.label).toBe("사람 검토");
    expect(item.href).toBeNull();
    expect(panel).toContain('data-evidence-kind="HUMAN_REVIEW"');
    expect(panel).toContain("검토 이력의 사유가 근거입니다");
  });

  it("기준을 고르지 않으면 빈 상태와 평가 전체 이력을, 판정 저장 전 기준이면 안내를 보인다", () => {
    const none = render({}, { reviewEvents: EVENTS });
    expect(panelHtml(none.html)).toContain('data-testid="evidence-empty"');
    expect(panelHtml(none.html)).toContain("검토 이력 3건 · 평가 전체");
    expect(none.view.evidencePanel.historyScope).toBe("evaluation");
    expect(none.view.evidencePanel.actions).toBeNull();

    const noResult = render({ criterion: "R-02" });
    expect(panelHtml(noResult.html)).toContain('data-testid="evidence-no-result"');
    expect(noResult.view.evidencePanel.status).toBe("no-result");
    expect(noResult.view.evidencePanel.actions).toBeNull();
    expect(panelHtml(noResult.html)).not.toContain('data-testid="review-actions"');
  });
});

describe("EvidencePanel: LLM 근거 탐색·리뷰 (T-407)", () => {
  const AI_REVIEW_ID = "3d5b1a2e-0000-4000-8000-00000000a407";
  const CAUSE_EVIDENCE_ID = "3d5b1a2e-0000-4000-8000-00000000b407";
  const DESIGN_EVIDENCE_ID = "3d5b1a2e-0000-4000-8000-00000000c407";
  const reviewStage = (overrides: Partial<EvaluationStageRecord> = {}): EvaluationStageRecord => ({
    stage: "REVIEW_WRITE",
    state: "DONE",
    detail: {
      llm: "OK",
      llmError: null,
      promptVersion: "evidence-review@v1+00000000",
      model: "deepseek-flash",
      aiReviewId: AI_REVIEW_ID,
      aiReviewVersion: 1,
      targets: ["R-05"],
      interpretations: [
        {
          criterionId: "R-05",
          confidence: "HIGH",
          evidenceIds: [CAUSE_EVIDENCE_ID],
          minimalRepro: { summary: "같은 키로 두 번 주문한다", stepIds: ["idem#1", "idem#2"] },
        },
      ],
      designSuggestions: [],
      suggestions: [{ title: "요청 로그", detail: "구조화 로그를 남긴다", outsideSpec: true }],
      dropped: [],
    },
    ...overrides,
  });
  const cause: Evidence = {
    id: CAUSE_EVIDENCE_ID,
    evaluationId: FIXTURE_EVALUATION_ID,
    submissionSha: FIXTURE_SHA,
    source: { path: "src/domain/order-service.ts", startLine: 48, endLine: 52 },
    artifactRefs: [],
    kind: "LLM_INTERPRETATION",
    snippet: "async createOrder(",
    detail: {
      origin: "REVIEW_WRITE",
      role: "FAILURE_CAUSE",
      criterionId: "R-05",
      aiReviewId: AI_REVIEW_ID,
      aiReviewVersion: 1,
      confidence: "HIGH",
    },
  };
  const design: Evidence = {
    id: DESIGN_EVIDENCE_ID,
    evaluationId: FIXTURE_EVALUATION_ID,
    submissionSha: FIXTURE_SHA,
    artifactRefs: [],
    kind: "LLM_INTERPRETATION",
    detail: {
      origin: "REVIEW_WRITE",
      role: "DESIGN_SUGGESTION",
      criterionId: "R-12",
      aiReviewId: AI_REVIEW_ID,
      aiReviewVersion: 1,
      suggestedPoints: 7,
      maxPoints: 10,
      rationale: "멱등성 저장소 추상화가 없다",
    },
  };

  it("추정(주황)과 관측을 나눠 보이고, 확신 정도·최소 재현 설명·LLM 근거 위치를 보인다", () => {
    const { html } = render(
      { criterion: "R-05" },
      {
        stages: [reviewStage()],
        interpretations: { "R-05": "Idempotency-Key를 저장하지 않는다" },
        extraEvidences: [{ criterionId: "R-05", evidence: cause }],
      },
    );
    const panel = panelHtml(html);
    expect(panel).toMatch(/<span data-tone="ink"[^>]*>관측<\/span>/);
    expect(panel).toContain('data-testid="observation"');
    expect(panel).toMatch(
      /data-interpretation="true" class="contents"><span data-tone="pending"[^>]*>추정</,
    );
    expect(panel).toContain('data-testid="interpretation">Idempotency-Key를 저장하지 않는다<');
    expect(panel).toContain('data-testid="interpretation-confidence">확신 높음<');
    expect(panel).toContain("같은 키로 두 번 주문한다");
    expect(panel).toContain("(idem#1, idem#2)");
    expect(panel).toContain('data-evidence-kind="LLM_INTERPRETATION"');
    expect(panel).toContain("src/domain/order-service.ts:48-52");
    // 관측 문장과 추정 문장은 서로 다른 요소에 있다
    const observation = /data-testid="observation">([^<]*)</.exec(panel)![1]!;
    expect(observation).not.toContain("Idempotency-Key를 저장하지 않는다");
  });

  it("R-12의 설계 제안은 '제안 n/max · 사람 확인 전'으로 보이고 판정 점수는 ?/10 그대로다", () => {
    const { html, view } = render(
      { criterion: "R-12" },
      { stages: [reviewStage()], extraEvidences: [{ criterionId: "R-12", evidence: design }] },
    );
    const panel = panelHtml(html);
    expect(view.evidencePanel.pointsDisplay).toBe("?/10");
    expect(panel).toContain('data-testid="design-suggestion-points">제안 7/10 · 사람 확인 전<');
    expect(panel).toContain("멱등성 저장소 추상화가 없다");
  });

  it("기준을 고르지 않으면 명세 외 개선 제안을, 예산 초과면 추정 없음 사유를 보인다", () => {
    const none = render({}, { stages: [reviewStage()] });
    expect(panelHtml(none.html)).toContain('data-testid="review-suggestion"');
    expect(panelHtml(none.html)).toContain("구조화 로그를 남긴다");

    const budget = render(
      { criterion: "R-05" },
      {
        stages: [
          reviewStage({
            reason: "LLM 미실행(예산 초과)",
            detail: {
              ...reviewStage().detail,
              llm: "NOT_RUN",
              interpretations: [],
              suggestions: [],
            },
          }),
        ],
      },
    );
    expect(panelHtml(budget.html)).toContain(
      'data-testid="interpretation-empty">추정 없음. LLM 미실행(예산 초과)<',
    );
  });
});

describe("EvidencePanel: 검토 이력", () => {
  it("선택 기준의 이력만 시간순으로 나열하고 종류·검토자·시각·원래 값 → 새 값·사유를 보인다", () => {
    // 리포트 순서를 뒤섞어도 시각순으로 정렬한다
    const shuffled = [EVENTS[1]!, EVENTS[2]!, EVENTS[0]!];
    const { html, view } = render({ criterion: "R-05" }, { reviewEvents: shuffled });
    const panel = panelHtml(html);
    expect(view.evidencePanel.history.map((h) => h.id)).toEqual([EVENTS[0]!.id, EVENTS[1]!.id]);
    expect(panel).toContain("검토 이력 2건");
    const items = panel.match(/<li[^>]*data-testid="review-event"[\s\S]*?<\/li>/g) ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('data-review-kind="OVERRIDE"');
    expect(items[0]).toContain(REVIEW_EVENT_KIND_LABEL.OVERRIDE);
    expect(items[0]).toContain('data-testid="review-reviewer">reviewer@example.com<');
    expect(items[0]).toContain('dateTime="2026-09-18T10:00:00.000Z"');
    expect(items[0]).toContain("0/14 → 3/14");
    // verdict가 같으면(FAIL → FAIL) verdict 변화는 적지 않는다
    expect(items[0]).not.toContain("실패 → 실패");
    expect(items[0]).toContain("자동 판정 → 사람 확인");
    expect(items[0]).toContain('data-testid="review-reason">첫 번째 수정: 부분 인정<');
    expect(items[1]).toContain("3/14 → 14/14");
    expect(items[1]).toContain("실패 → 통과");
    expect(items[1]).toContain("other@example.com");
    // 다른 기준(R-12)의 이벤트는 여기 없다
    expect(panel).not.toContain('data-criterion="R-12"');
  });

  it("같은 기준을 두 번 수정하면 두 이벤트가 모두 남고, 이력에는 삭제·수정 액션이 없다", () => {
    const { html } = render({ criterion: "R-05" }, { reviewEvents: EVENTS });
    const history = panelHtml(html).slice(panelHtml(html).indexOf('data-testid="review-history"'));
    expect(history.match(/data-testid="review-event"/g)).toHaveLength(2);
    expect(history).not.toMatch(/<button/);
    expect(history).not.toMatch(/삭제|되돌리기|취소/);
    expect(history).not.toMatch(/<form/);
  });

  it("verdict가 바뀐 이력만 verdict 변화를, reviewState가 바뀐 이력만 상태 변화를 적는다", () => {
    const { view } = render({ criterion: "R-12" }, { reviewEvents: EVENTS });
    const [approve] = view.evidencePanel.history;
    expect(approve).toMatchObject({
      kind: "APPROVE_DESIGN",
      previous: { points: "?/10", verdict: "INCONCLUSIVE", reviewState: "PENDING" },
      next: { points: "10/10", verdict: "PASS", reviewState: "CONFIRMED" },
      pointsChanged: true,
      verdictChanged: true,
      reviewStateChanged: true,
    });
  });
});

describe("EvidencePanel: 액션과 토큰", () => {
  it("R-12(HUMAN_REVIEW + 하위 기준)에만 설계 점수 확정 버튼이 있고, 다른 기준에는 확인·수정·이의만 있다", () => {
    const design = render({ criterion: "R-12" });
    const designPanel = panelHtml(design.html);
    expect(design.view.evidencePanel.actions?.canApproveDesign).toBe(true);
    expect(design.view.evidencePanel.actions?.subCriteria.map((s) => s.id)).toEqual([
      "R-12a",
      "R-12b",
      "R-12c",
    ]);
    expect(designPanel).toContain('data-testid="review-action-APPROVE_DESIGN"');
    expect(designPanel).toContain('data-testid="review-action-CONFIRM"');
    expect(designPanel).toContain('data-testid="review-action-OVERRIDE"');
    expect(designPanel).toContain('data-testid="review-action-DISPUTE"');

    const exec = render({ criterion: "R-05" });
    expect(exec.view.evidencePanel.actions?.canApproveDesign).toBe(false);
    expect(panelHtml(exec.html)).not.toContain('data-testid="review-action-APPROVE_DESIGN"');
    // 모달은 열기 전에는 렌더링되지 않고, 브라우저 confirm()은 쓰지 않는다
    expect(panelHtml(exec.html)).not.toContain("<dialog");
  });

  it("브라우저 검사가 서버 규칙과 같다: 사유 없는 OVERRIDE, max 초과, 음수, 정수 아님을 거부한다", () => {
    const base = {
      reviewer: "r",
      reason: "사유",
      earnedPoints: "3",
      maxPoints: 14,
      deduction: false,
    };
    expect(validateReviewFields("OVERRIDE", base)).toEqual({});
    expect(validateReviewFields("OVERRIDE", { ...base, reason: " " })).toMatchObject({
      reason: "사유를 입력하세요",
    });
    expect(validateReviewFields("OVERRIDE", { ...base, earnedPoints: "15" })).toMatchObject({
      earnedPoints: "점수는 배점(14) 이하여야 합니다",
    });
    expect(validateReviewFields("OVERRIDE", { ...base, earnedPoints: "-1" })).toMatchObject({
      earnedPoints: "점수는 음수일 수 없습니다",
    });
    expect(validateReviewFields("OVERRIDE", { ...base, earnedPoints: "1.5" })).toMatchObject({
      earnedPoints: "점수는 정수여야 합니다",
    });
    expect(validateReviewFields("OVERRIDE", { ...base, reviewer: "" })).toMatchObject({
      reviewer: "검토자를 입력하세요",
    });
    expect(validateReviewFields("DISPUTE", { ...base, reason: "" })).toMatchObject({
      reason: "이의 메모를 입력하세요",
    });
    expect(validateReviewFields("CONFIRM", { ...base, reason: "" })).toEqual({});
    expect(
      validateReviewFields("APPROVE_DESIGN", { ...base, reason: "", deduction: true }),
    ).toMatchObject({
      reason: "감점하려면 사유를 입력하세요",
    });
    expect(
      validateReviewFields("APPROVE_DESIGN", { ...base, reason: "", deduction: false }),
    ).toEqual({});
  });

  it("추정 라벨만 pending 토큰을 쓰고 data-interpretation 래퍼 뒤에 온다. 이력·근거 목록에는 fail 토큰이 없다", () => {
    const { html } = render(
      { criterion: "R-05" },
      { reviewEvents: EVENTS, interpretations: { "R-05": "추정 문장" } },
    );
    const panel = panelHtml(html);
    const tags = [...panel.matchAll(/<([a-z][a-z0-9]*)((?:\s+[^>]*)?)>/g)].map((m) => ({
      attrs: m[2] ?? "",
    }));
    const PENDING = /(?:^|\s)(?:bg|text|border|ring)-pending(?:\/\d+)?(?:\s|$|")/;
    const FAIL = /(?:^|\s)(?:bg|text|border|ring)-fail(?:\/\d+)?(?:\s|$|")/;
    let pendingCount = 0;
    let failCount = 0;
    tags.forEach((tag, i) => {
      if (PENDING.test(tag.attrs)) {
        pendingCount += 1;
        expect(tags[i - 1]!.attrs).toMatch(
          /data-interpretation="true"|data-verdict="INCONCLUSIVE"|data-review-state="PENDING"/,
        );
      }
      if (FAIL.test(tag.attrs)) {
        failCount += 1;
        expect(tags[i - 1]!.attrs).toContain('data-verdict="FAIL"');
      }
    });
    // 추정 배지 하나. FAIL 배지는 요약의 판정 배지 하나뿐(이력의 `실패 → 통과`는 글자다)
    expect(pendingCount).toBe(1);
    expect(failCount).toBe(1);
  });

  it("패널 표시 모델은 점수를 계산하지 않는다", async () => {
    const files = [
      path.join(import.meta.dirname, "evidence-panel.tsx"),
      path.join(import.meta.dirname, "../../../lib/workbench/evidence-panel.ts"),
    ];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/aggregateScore/);
      expect(code, file).not.toMatch(/formatS(tored)?coreDisplay/);
      expect(code, file).not.toMatch(/\.reduce\(/);
      expect(code, file).not.toMatch(/maxPoints\s*[-+]|earnedPoints\s*[-+]|pendingPoints\s*[-+]/);
    }
    // 저장 경로(서비스)는 집계 엔진으로 평가 점수를 다시 쓴다
    const service = await readFile(
      path.join(import.meta.dirname, "../../../lib/reviews/service.ts"),
      "utf8",
    );
    expect(service).toContain("aggregateScore(");
    expect(service).toContain("setEvaluationScore(");
    expect(service).toContain("insertReviewEvent(");
  });

  it("buildEvidencePanelView는 형식이 틀린 기준 ID를 선택 없음으로 본다", () => {
    const report = reportFixture();
    const urlState = parseWorkbenchSearchParams({ criterion: "R-99" });
    const view = buildEvidencePanelView(report, urlState, (patch) =>
      workbenchHref(report.evaluation.id, urlState, patch),
    );
    expect(view.status).toBe("no-criterion");
  });
});
