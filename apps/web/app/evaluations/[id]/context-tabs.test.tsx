import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONTEXT_NO_RESUME_AREA,
  CONTEXT_NO_RESUME_CLAIM,
  ContextStatusSchema,
  EVALUATION_STAGE_ORDER,
  GitHubSourcesSchema,
  STAGE_NOT_IMPLEMENTED_REASON,
  type ContextLink,
  type ContextLinkSummary,
  type CriterionResult,
  type EvaluationStageRecord,
  type GitHubSources,
  type StageState,
} from "@ohmyti/core";
import {
  createTestDatabase,
  replaceContextLinks,
  seedEvaluation,
  setGitHubSources,
  setResumeText,
  upsertSubmissionContext,
  type TestDatabase,
} from "@ohmyti/db";
import {
  readEvaluationContext,
  type EvaluationContextData,
  type EvaluationContextInput,
} from "@/lib/context/service";
import {
  buildContextTabsView,
  CONTEXT_STATUS_LABEL,
  ORG_PROFILE_AUTHOR_NOTE,
} from "@/lib/workbench/context-tabs";
import {
  DEFECTIVE_SAMPLE_VERDICTS,
  FIXTURE_EVALUATION_ID,
  FIXTURE_SUBMISSION_ID,
  reportFixture,
} from "@/lib/workbench/fixtures";
import {
  parseWorkbenchSearchParams,
  workbenchHref,
  WORKBENCH_TABS,
  type WorkbenchTab,
} from "@/lib/workbench/state";
import { buildWorkbenchView } from "@/lib/workbench/view";
import { ContextTabPanel } from "./context-tabs";
import { WorkbenchShell } from "./workbench-shell";

/**
 * 워크벤치 하단 탭 (T-504). 이력서 연결·GitHub 근거·후속 질문·미평가 영역의 표시 모델과 렌더링을 검사한다.
 * 인수 기준: 미평가 영역에 INCONCLUSIVE 기준·SKIPPED 단계가 빠짐없이 나온다, 상태 칩은 세 종류이고 점수·합격 성격 표시가 없다,
 * 이력서 미제공 평가에서 "미제공"이 보인다. 복사 동작은 E2E(`e2e/workbench.spec.ts`)가 확인한다.
 */

const E = FIXTURE_EVALUATION_ID;
const uuid = (n: number) => `c${String(n).padStart(7, "0")}-cccc-4ccc-8ccc-cccccccccccc`;

function link(n: number, overrides: Partial<ContextLink>): ContextLink {
  return {
    id: uuid(n),
    submissionId: FIXTURE_SUBMISSION_ID,
    evaluationId: E,
    claim: `claim ${n}`,
    claimSource: "RESUME",
    status: "NEEDS_CHECK",
    createdAt: `2026-09-19T00:00:0${n % 10}.000Z`,
    ...overrides,
  };
}

const GITHUB: GitHubSources = GitHubSourcesSchema.parse({
  status: "PARTIAL",
  reason: "REQUEST_LIMIT_REACHED: 요청 상한에 닿아 일부만 수집했습니다",
  login: "octo",
  collectedAt: "2026-09-19T00:00:00.000Z",
  selection: "KEYWORD_OVERLAP",
  candidateCount: 7,
  candidateListTruncated: false,
  repos: [
    {
      fullName: "octo/payments",
      url: "https://github.com/octo/payments",
      description: "idempotent payment API",
      language: "TypeScript",
      topics: [],
      pushedAt: "2026-09-01T00:00:00.000Z",
      matchedKeywords: ["idempotent", "payment"],
      relevanceScore: 987,
      readme: "# payments",
      readmeTruncated: true,
      languages: [
        { name: "TypeScript", bytes: 1000 },
        { name: "Shell", bytes: 10 },
      ],
      topLevelFiles: [
        { name: "src", type: "dir" },
        { name: "package.json", type: "file" },
      ],
      commits: [{ sha: "a".repeat(40), message: "add idempotency", committedAt: null }],
      mergedPulls: [{ number: 3, title: "Add retry", mergedAt: null }],
      missing: [{ part: "mergedPulls", reason: "요청 상한" }],
    },
  ],
  requestCount: 10,
  requestLimit: 10,
});

function contextData(overrides: Partial<EvaluationContextData> = {}): EvaluationContextData {
  return {
    links: [
      link(1, {
        claim: "Designed idempotent payment endpoints",
        status: "EVIDENCE_FOUND",
        githubEvidence: [
          {
            repo: "octo/payments",
            url: "https://github.com/octo/payments",
            summary: "멱등 키 저장소가 있다",
          },
        ],
        assignmentObservation: { criterionId: "R-05", summary: "재전송 시 재고가 두 번 차감됨" },
        followUpQuestion: "과제에서 멱등 키를 저장하지 않은 이유는 무엇인가요?",
      }),
      link(2, {
        claim: "Wrote tests for every endpoint",
        status: "NEEDS_CHECK",
        assignmentObservation: { criterionId: "G1", summary: "G1 관측" },
        followUpQuestion: "경계값 테스트는 어떻게 골랐나요?",
      }),
      link(3, {
        claim: "Operated Kafka clusters",
        status: "NO_DATA",
        followUpQuestion: "Kafka 운영에서 겪은 장애를 설명해 주세요",
      }),
      link(4, {
        claim: "Led API design reviews",
        status: "NEEDS_CHECK",
        assignmentObservation: { criterionId: "R-05", summary: "재전송 시 재고가 두 번 차감됨" },
        followUpQuestion: "설계 리뷰에서 멱등성을 어떻게 다뤘나요?",
      }),
    ],
    otherEvaluationLinkCount: 0,
    resume: { uploaded: true, textStatus: "EXTRACTED", reason: null },
    github: { login: "octo", sources: GITHUB, invalid: false },
    ...overrides,
  };
}

const NO_RESUME: EvaluationContextData = {
  links: [link(9, { claim: CONTEXT_NO_RESUME_CLAIM, claimSource: "SYSTEM", status: "NO_DATA" })],
  otherEvaluationLinkCount: 0,
  resume: { uploaded: false, textStatus: "NONE", reason: null },
  github: {
    login: null,
    sources: GitHubSourcesSchema.parse({
      status: "NO_DATA",
      reason: "NO_PROFILE: GitHub 프로필이 입력되지 않았습니다",
      login: null,
      collectedAt: "2026-09-19T00:00:00.000Z",
      selection: null,
      candidateCount: 0,
      candidateListTruncated: false,
      repos: [],
      requestCount: 0,
      requestLimit: 10,
    }),
    invalid: false,
  },
};

function contextSummary(unassessedAreas: string[]): ContextLinkSummary {
  return {
    llm: "NOT_NEEDED",
    llmError: null,
    promptVersion: "context-link@v1",
    model: null,
    aiReviewId: null,
    aiReviewVersion: null,
    inputs: { resume: false, jd: false, githubRepos: 0, observations: 15 },
    linkCount: 1,
    statusCounts: { EVIDENCE_FOUND: 0, NEEDS_CHECK: 0, NO_DATA: 1 },
    unassessedAreas,
    dropped: [],
  };
}

const ALL_DONE: EvaluationStageRecord[] = EVALUATION_STAGE_ORDER.map((stage) => ({
  stage,
  state: "DONE",
}));

function stagesWith(
  states: Partial<Record<(typeof EVALUATION_STAGE_ORDER)[number], StageState>>,
  extra: Partial<
    Record<(typeof EVALUATION_STAGE_ORDER)[number], Partial<EvaluationStageRecord>>
  > = {},
): EvaluationStageRecord[] {
  return ALL_DONE.map((s) => ({ ...s, state: states[s.stage] ?? s.state, ...extra[s.stage] }));
}

function build(
  tab: WorkbenchTab,
  options: {
    context?: EvaluationContextInput | null;
    stages?: EvaluationStageRecord[];
    verdicts?: Record<string, CriterionResult["verdict"]>;
    functionGraph?: Parameters<typeof buildContextTabsView>[3];
  } = {},
) {
  const report = reportFixture({
    verdicts: options.verdicts ?? DEFECTIVE_SAMPLE_VERDICTS,
    stages: options.stages ?? ALL_DONE,
  });
  const urlState = parseWorkbenchSearchParams({ tab });
  const context =
    options.context === undefined ? { ok: true as const, data: contextData() } : options.context;
  return {
    report,
    view: buildContextTabsView(report, tab, context, options.functionGraph ?? null, (patch) =>
      workbenchHref(E, urlState, patch),
    ),
  };
}

function render(tab: WorkbenchTab, options: Parameters<typeof build>[1] = {}): string {
  return renderToStaticMarkup(<ContextTabPanel view={build(tab, options).view} />);
}

/** 태그를 뺀 화면 문구 */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
}

describe("미평가 영역 탭", () => {
  it("모든 INCONCLUSIVE 기준과 판정 없는 기준을 rubric 순서로 빠짐없이 나열한다", () => {
    const verdicts = { ...DEFECTIVE_SAMPLE_VERDICTS };
    delete verdicts["R-11"];
    const { report, view } = build("unevaluated", { verdicts });
    const expected = report.rubric.criteria
      .map((c) => c.id)
      .filter((id) => verdicts[id] === undefined || verdicts[id] === "INCONCLUSIVE");
    expect(expected).toEqual(["G1", "G2", "G3", "R-12", "R-11"]);
    expect(view.unevaluated.criteria.map((c) => c.id)).toEqual(expected);
    expect(view.unevaluated.criteria.find((c) => c.id === "R-11")).toMatchObject({
      verdict: null,
      note: "판정이 아직 저장되지 않았습니다",
    });
    expect(view.unevaluated.criteria.find((c) => c.id === "G2")!.note).toBe("G2 관측");

    const html = render("unevaluated", { verdicts });
    for (const id of expected) expect(html).toContain(`data-unevaluated-criterion="${id}"`);
    expect(html.match(/data-unevaluated-criterion=/g)).toHaveLength(expected.length);
    // 기준 링크는 탭을 유지한 채 그 기준을 고른다
    expect(html).toContain(`href="/evaluations/${E}?criterion=G2&amp;tab=unevaluated"`);
  });

  it("SKIPPED·UNSUPPORTED·FAILED·진행 중 단계와 기록이 없는 단계를 모두 사유와 함께 나열한다 (모든 조합)", () => {
    const states: StageState[] = ["DONE", "SKIPPED", "UNSUPPORTED", "FAILED", "PENDING", "RUNNING"];
    // 일곱 단계 각각에 상태를 돌려 가며 배치한다 (6가지 회전 × 상태 6개)
    for (let shift = 0; shift < states.length; shift += 1) {
      const stages: EvaluationStageRecord[] = EVALUATION_STAGE_ORDER.map((stage, i) => {
        const state = states[(i + shift) % states.length]!;
        return { stage, state, ...(state !== "DONE" ? { reason: `${stage} 사유` } : {}) };
      });
      const { view } = build("unevaluated", { stages });
      const notDone = stages.filter((s) => s.state !== "DONE");
      expect(view.unevaluated.stages.map((s) => s.stage)).toEqual(notDone.map((s) => s.stage));
      for (const s of notDone) {
        expect(view.unevaluated.stages.find((v) => v.stage === s.stage)).toMatchObject({
          state: s.state,
          reason: `${s.stage} 사유`,
        });
      }
    }
    // 기록 자체가 없는 단계도 빠뜨리지 않는다
    const { view } = build("unevaluated", {
      stages: [{ stage: "REPO_CHECK", state: "DONE" }],
    });
    expect(view.unevaluated.stages.map((s) => s.stage)).toEqual(EVALUATION_STAGE_ORDER.slice(1));
    expect(view.unevaluated.stages.every((s) => s.stateLabel === "기록 없음")).toBe(true);
  });

  it("not_implemented 사유는 `미구현`으로 보이고 SKIPPED 단계가 화면에 모두 나온다", () => {
    const stages = stagesWith(
      { TEST_EFFECTIVENESS: "SKIPPED", REVIEW_WRITE: "SKIPPED" },
      {
        TEST_EFFECTIVENESS: { reason: STAGE_NOT_IMPLEMENTED_REASON },
        REVIEW_WRITE: { reason: "LLM 미실행(설정 없음)" },
      },
    );
    const html = render("unevaluated", { stages });
    expect(html).toContain(
      'data-unevaluated-stage="TEST_EFFECTIVENESS" data-stage-state="SKIPPED"',
    );
    expect(html).toContain('data-unevaluated-stage="REVIEW_WRITE" data-stage-state="SKIPPED"');
    expect(textOf(html)).toContain("미구현");
    expect(textOf(html)).toContain("LLM 미실행(설정 없음)");
    expect(html.match(/data-unevaluated-stage=/g)).toHaveLength(2);
  });

  it("맥락 NO_DATA 항목, 단계의 미평가 영역, 분석 범위 한계를 보인다", () => {
    const stages = stagesWith(
      {},
      {
        REPO_CHECK: { detail: { dropped: { gitEntries: 3, links: 2, unsupported: 1 } } },
        ENV_PREP: { detail: { testFramework: "jest", testFrameworkSupported: false } },
        CONTEXT_LINK: {
          detail: { contextLink: contextSummary(["대용량 트래픽 운영 경험은 확인할 수 없음"]) },
        },
      },
    );
    const { view } = build("unevaluated", {
      stages,
      functionGraph: {
        ok: true,
        data: {
          evaluationId: E,
          artifactKey: `evaluations/${E}/analysis/function-graph.json`,
          analysis: {
            status: "unavailable",
            analyzerVersion: "1",
            reason: "파일 한도 초과: 600개",
          },
        },
      },
    });
    expect(view.unevaluated.context).toEqual([
      "자료 없음: Operated Kafka clusters",
      "대용량 트래픽 운영 경험은 확인할 수 없음",
    ]);
    expect(view.unevaluated.analysisLimits).toEqual([
      "스냅샷 수집: 심볼릭·하드 링크 2개를 제외했습니다",
      "스냅샷 수집: 일반 파일이 아닌 항목 1개를 제외했습니다",
      "제출 테스트: 테스트 프레임워크(jest)를 실행기가 지원하지 않습니다 (vitest만 지원)",
      "관련 함수 그래프 분석 불가: 파일 한도 초과: 600개",
    ]);
  });

  it("맥락을 읽지 못해도 기준·단계는 리포트에서 보이고 사유를 적는다", () => {
    const context = { ok: false as const, message: "맥락을 읽지 못했습니다: connection refused" };
    const { view } = build("unevaluated", { context });
    expect(view.unevaluated.criteria.map((c) => c.id)).toEqual(["G1", "G2", "G3", "R-12"]);
    expect(view.unevaluated.context).toEqual([context.message]);
    for (const tab of WORKBENCH_TABS) {
      expect(() => render(tab, { context })).not.toThrow();
    }
    expect(textOf(render("resume", { context }))).toContain("connection refused");
  });
});

describe("상태 칩과 표시 문구", () => {
  it("상태 칩은 세 종류뿐이고 각 연결의 상태와 같다", () => {
    expect(Object.keys(CONTEXT_STATUS_LABEL).sort()).toEqual(
      [...ContextStatusSchema.options].sort(),
    );
    const html = render("resume");
    const chips = [...html.matchAll(/data-context-status="([A-Z_]+)"/g)].map((m) => m[1]);
    expect(chips).toEqual(["EVIDENCE_FOUND", "NEEDS_CHECK", "NO_DATA", "NEEDS_CHECK"]);
    expect(new Set(chips).size).toBeLessThanOrEqual(3);
    const labels = new Set(Object.values(CONTEXT_STATUS_LABEL));
    for (const m of html.matchAll(/data-context-status="[A-Z_]+"[^>]*><span[^>]*>([^<]+)</g)) {
      expect(labels.has(m[1]!)).toBe(true);
    }
    // 칩은 실패·미확정 토큰(빨강·주황)을 쓰지 않는다
    expect(html).not.toMatch(/data-tone="(fail|pending)"/);
  });

  it("네 탭 어디에도 합격·탈락·순위·점수 성격의 표시가 없다", () => {
    const forbidden = /합격|탈락|순위|랭킹|점수|\d+\s*점|\/100|score|relevance|987|진위|기여율/i;
    for (const tab of WORKBENCH_TABS) {
      for (const context of [
        { ok: true as const, data: contextData() },
        { ok: true as const, data: NO_RESUME },
      ]) {
        const text = textOf(
          render(tab, { context, verdicts: { "R-01": "PASS", G1: "INCONCLUSIVE" } }),
        );
        expect(text, tab).not.toMatch(forbidden);
      }
    }
  });

  it("표시 모델 코드는 점수·배점 필드를 읽지 않는다", async () => {
    for (const file of [
      path.join(import.meta.dirname, "../../../lib/workbench/context-tabs.ts"),
      path.join(import.meta.dirname, "context-tabs.tsx"),
      path.join(import.meta.dirname, "../../../lib/context/service.ts"),
    ]) {
      const code = (await readFile(file, "utf8"))
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(
        /earnedPoints|maxPoints|pendingPoints|\.score\b|relevanceScore/,
      );
      expect(code, file).not.toMatch(/resumeText\b/);
    }
  });
});

describe("이력서 미제공 평가", () => {
  it("네 탭 모두 오류 없이 미제공을 보인다", () => {
    const context = { ok: true as const, data: NO_RESUME };
    const stages = stagesWith(
      {},
      { CONTEXT_LINK: { detail: { contextLink: contextSummary([CONTEXT_NO_RESUME_AREA]) } } },
    );
    const resume = textOf(render("resume", { context, stages }));
    expect(resume).toContain(CONTEXT_NO_RESUME_CLAIM);
    expect(resume).toContain(CONTEXT_NO_RESUME_AREA);
    expect(render("resume", { context, stages })).not.toContain("data-claim-id");
    expect(textOf(render("questions", { context, stages }))).toContain(CONTEXT_NO_RESUME_CLAIM);
    const github = textOf(render("github", { context, stages }));
    expect(github).toContain("GitHub 프로필 미제공");
    expect(github).toContain("NO_PROFILE: GitHub 프로필이 입력되지 않았습니다");
    const { view } = build("unevaluated", { context, stages });
    // SYSTEM 행과 단계의 같은 뜻 문구는 한 번만
    expect(view.unevaluated.context).toEqual([CONTEXT_NO_RESUME_CLAIM]);
  });

  it("맥락 행이 없는 이전 평가도 이력서가 없으면 미제공으로 본다", () => {
    const context = {
      ok: true as const,
      data: {
        links: [],
        otherEvaluationLinkCount: 0,
        resume: { uploaded: false, textStatus: "NONE" as const, reason: null },
        github: { login: null, sources: null, invalid: false },
      },
    };
    const stages = stagesWith(
      { CONTEXT_LINK: "SKIPPED" },
      { CONTEXT_LINK: { reason: STAGE_NOT_IMPLEMENTED_REASON } },
    );
    // 단계가 끝나지 않았으면 단계 상태를 이유로 보인다
    expect(textOf(render("resume", { context, stages }))).toContain(
      "맥락 연결 단계가 완료되지 않았습니다: 미구현",
    );
    expect(textOf(render("resume", { context }))).toContain(CONTEXT_NO_RESUME_CLAIM);
    expect(textOf(render("github", { context }))).toContain("GitHub 프로필 미제공");
  });
});

describe("이력서 연결 · GitHub 근거 · 후속 질문", () => {
  it("claim 카드의 연결 기준은 탭을 유지한 채 중앙 패널을 그 기준으로 옮긴다", () => {
    const report = reportFixture({ verdicts: DEFECTIVE_SAMPLE_VERDICTS, stages: ALL_DONE });
    const urlState = parseWorkbenchSearchParams({
      tab: "resume",
      criterion: "R-01",
      run: "5e5e5e5e-5555-4555-8555-555555555555",
      source: "src/app.ts:1-3",
    });
    const view = buildContextTabsView(
      report,
      "resume",
      { ok: true, data: contextData() },
      null,
      (patch) => workbenchHref(E, urlState, patch),
    );
    const card = view.resume.claims[0]!;
    expect(card.observation).toMatchObject({ criterionId: "R-05", title: "멱등 재전송" });
    expect(card.observation!.href).toBe(`/evaluations/${E}?criterion=R-05&tab=resume`);
    expect(view.resume.claims[2]!.observation).toBeNull();
    const html = renderToStaticMarkup(<ContextTabPanel view={view} />);
    expect(html).toContain(`data-claim-criterion="R-05"`);
    expect(html).toContain('href="https://github.com/octo/payments"');
  });

  it("다른 평가가 만든 연결은 숨기고 그 수를 안내한다", () => {
    const html = render("resume", {
      context: { ok: true, data: contextData({ otherEvaluationLinkCount: 3 }) },
    });
    expect(textOf(html)).toContain("맥락 연결 3건은 다른 평가에서 다시 만들어");
  });

  it("GitHub 저장소 카드는 선정 사유·링크·수집 요약을 보이고 선정 점수는 보이지 않는다", () => {
    const { view } = build("github");
    expect(view.github.repos).toEqual([
      {
        fullName: "octo/payments",
        url: "https://github.com/octo/payments",
        description: "idempotent payment API",
        selectionReason: "이력서·JD 키워드와 겹침: idempotent, payment",
        collected: ["언어 TypeScript, Shell", "최근 커밋 1개", "README 앞부분", "최상위 항목 2개"],
        missing: ["병합 PR: 요청 상한"],
      },
    ]);
    expect(view.github.statusLabel).toBe("일부 수집");
    const html = render("github");
    expect(html).toContain('data-repo="octo/payments"');
    expect(textOf(html)).toContain("REQUEST_LIMIT_REACHED");
    expect(textOf(html)).not.toContain("987");
    // T-603 이전 기록(제외·범용 필드 없음)도 그대로 열리고 안내는 없다
    expect(GITHUB.excludedRepos).toBeUndefined();
    expect(GITHUB.genericOnlyCount).toBeUndefined();
    expect(view.github.selectionNotes).toEqual([]);
    expect(html).not.toContain('data-testid="github-selection-notes"');
  });

  it("제출 저장소 제외와 범용 키워드만 겹친 후보 수를 탭 상단에 보인다 (T-603)", () => {
    const base = contextData();
    const sources: GitHubSources = GitHubSourcesSchema.parse({
      ...GITHUB,
      status: "COLLECTED",
      reason: null,
      selection: "RESUME_LINK",
      excludedRepos: ["octo/order-api"],
      genericOnlyCount: 4,
    });
    const context = {
      ok: true as const,
      data: { ...base, github: { login: "octo", sources, invalid: false } },
    };
    const { view } = build("github", { context });
    expect(view.github.selectionNotes).toEqual([
      "제출 저장소는 근거 후보에서 뺐습니다: octo/order-api",
      "범용 키워드(api, express, typescript 등)만 겹친 저장소 4개는 고르지 않았습니다",
    ]);
    expect(view.github.repos[0]!.selectionReason).toBe(
      "이력서·JD에 저장소 주소가 있음 · 겹친 키워드: idempotent, payment",
    );
    const html = render("github", { context });
    expect(html).toContain('data-testid="github-selection-notes"');
    const text = textOf(html);
    expect(text).toContain("octo/order-api");
    expect(text).toContain("저장소 4개는 고르지 않았습니다");
    // 안내는 저장소 목록보다 위에 있다
    expect(html.indexOf("github-selection-notes")).toBeLessThan(
      html.indexOf('data-testid="repo-list"'),
    );
  });

  it("조직 프로필에서 작성자 구분 없이 모은 커밋·PR이면 탭 상단에 알린다 (T-604)", () => {
    const base = contextData();
    const sources: GitHubSources = GitHubSourcesSchema.parse({
      ...GITHUB,
      repos: GITHUB.repos.map((r) => ({ ...r, authorFilter: "NONE" })),
    });
    const context = {
      ok: true as const,
      data: { ...base, github: { login: "octo", sources, invalid: false } },
    };
    const { view } = build("github", { context });
    expect(view.github.selectionNotes).toEqual([ORG_PROFILE_AUTHOR_NOTE]);
    const text = textOf(render("github", { context }));
    expect(text).toContain("조직 프로필: 작성자 구분 없이 수집");
    // 사용자 프로필(LOGIN)이나 T-604 이전 기록(필드 없음)은 안내가 없다
    const userSources = GitHubSourcesSchema.parse({
      ...GITHUB,
      repos: GITHUB.repos.map((r) => ({ ...r, authorFilter: "LOGIN" })),
    });
    const userView = build("github", {
      context: {
        ok: true as const,
        data: { ...base, github: { login: "octo", sources: userSources, invalid: false } },
      },
    }).view;
    expect(userView.github.selectionNotes).toEqual([]);
  });

  it("GitHub 조회 전·형태 오류·자료 없음은 이유를 그대로 보인다", () => {
    const base = contextData();
    const cases: Array<[EvaluationContextData["github"], string]> = [
      [{ login: "octo", sources: null, invalid: false }, "아직 조회하지 않음"],
      [{ login: "octo", sources: null, invalid: true }, "GitHub 근거를 읽지 못함"],
      [
        {
          login: "octo",
          sources: { ...GITHUB, status: "NO_DATA", reason: "RATE_LIMITED: 한도 초과", repos: [] },
          invalid: false,
        },
        "RATE_LIMITED: 한도 초과",
      ],
    ];
    for (const [github, text] of cases) {
      const html = render("github", { context: { ok: true, data: { ...base, github } } });
      expect(textOf(html)).toContain(text);
      expect(html).toContain('data-testid="github-empty"');
    }
  });

  it("후속 질문은 rubric 순서로 기준별로 묶고 기준 없는 질문은 마지막에 둔다", () => {
    const { view } = build("questions");
    expect(view.questions.groups.map((g) => g.criterionId)).toEqual(["R-05", "G1", null]);
    expect(view.questions.groups[0]!.questions.map((q) => q.linkId)).toEqual([uuid(1), uuid(4)]);
    expect(view.questions.groups[0]!.label).toBe("R-05 · 멱등 재전송");
    expect(view.questions.groups[2]!.label).toBe("연결된 기준 없음");
    expect(view.questions.allText.split("\n")).toHaveLength(4);
    const html = render("questions");
    expect(html.match(/aria-label="후속 질문 복사"/g)).toHaveLength(4);
    expect(html).toContain('aria-label="후속 질문 전체 복사"');
  });

  it("연결은 있지만 질문이 없거나 LLM을 부르지 않았으면 사유를 보인다", () => {
    const noQuestions = contextData({
      links: contextData().links.map(({ followUpQuestion: _q, ...rest }) => rest),
    });
    expect(textOf(render("questions", { context: { ok: true, data: noQuestions } }))).toContain(
      "후속 질문 없음",
    );
    const stages = stagesWith({}, { CONTEXT_LINK: { reason: "LLM 미실행(예산 초과)" } });
    const empty = contextData({ links: [] });
    for (const tab of ["resume", "questions"] as const) {
      expect(textOf(render(tab, { context: { ok: true, data: empty }, stages }))).toContain(
        "LLM 미실행(예산 초과)",
      );
    }
  });

  it("워크벤치 셸이 열린 탭의 본문을 그린다", () => {
    const report = reportFixture({ verdicts: DEFECTIVE_SAMPLE_VERDICTS, stages: ALL_DONE });
    const urlState = parseWorkbenchSearchParams({ tab: "questions" });
    const href = (patch: Parameters<typeof workbenchHref>[2]) => workbenchHref(E, urlState, patch);
    const view = buildWorkbenchView(report, urlState, href);
    const tabs = buildContextTabsView(
      report,
      "questions",
      { ok: true, data: contextData() },
      null,
      href,
    );
    const html = renderToStaticMarkup(<WorkbenchShell view={view} contextTabs={tabs} />);
    expect(html).toContain('data-testid="tab-panel-questions"');
    expect(html).toContain('data-question-group="R-05"');
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

describe.skipIf(!hasTestDb)("readEvaluationContext (통합)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
  });

  it("이 평가의 연결과 GitHub 근거를 읽고 이력서 본문은 넘기지 않는다", async () => {
    const seeded = await seedEvaluation(tdb.db, `web-t504-${Date.now()}`);
    const other = await seedEvaluation(tdb.db, `web-t504-other-${Date.now()}`);
    await upsertSubmissionContext(tdb.db, seeded.submissionId, {
      resumeRef: `submissions/${seeded.submissionId}/resume.pdf`,
      githubLogin: "octo",
    });
    await setResumeText(tdb.db, seeded.submissionId, {
      status: "EXTRACTED",
      text: "SECRET RESUME BODY Designed idempotent payment endpoints",
      reason: null,
    });
    await setGitHubSources(tdb.db, seeded.submissionId, GITHUB);
    await replaceContextLinks(tdb.db, {
      submissionId: seeded.submissionId,
      evaluationId: seeded.evaluationId,
      links: [
        {
          claim: "Designed idempotent payment endpoints",
          claimSource: "RESUME",
          status: "EVIDENCE_FOUND",
          githubEvidence: [
            { repo: "octo/payments", url: "https://github.com/octo/payments", summary: "멱등 키" },
          ],
          assignmentObservation: { criterionId: "R-05", summary: "관측" },
          followUpQuestion: "왜 멱등 키를 저장하지 않았나요?",
        },
      ],
    });

    const result = await readEvaluationContext(
      { db: tdb.db },
      { submissionId: seeded.submissionId, evaluationId: seeded.evaluationId },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.links).toHaveLength(1);
    expect(result.data.links[0]).toMatchObject({ status: "EVIDENCE_FOUND", claimSource: "RESUME" });
    expect(result.data.resume).toEqual({ uploaded: true, textStatus: "EXTRACTED", reason: null });
    expect(result.data.github.sources).toEqual(GITHUB);
    expect(JSON.stringify(result)).not.toContain("SECRET RESUME BODY");

    // 같은 제출을 다른 평가 ID로 본다면(재평가 전 평가) 연결은 숨기고 개수만 알린다
    const stale = await readEvaluationContext(
      { db: tdb.db },
      { submissionId: seeded.submissionId, evaluationId: other.evaluationId },
    );
    expect(stale.ok && stale.data.links).toEqual([]);
    expect(stale.ok && stale.data.otherEvaluationLinkCount).toBe(1);

    // 맥락 행이 없는 제출은 미제공 상태로 읽힌다
    const empty = await readEvaluationContext(
      { db: tdb.db },
      { submissionId: other.submissionId, evaluationId: other.evaluationId },
    );
    expect(empty).toEqual({
      ok: true,
      data: {
        links: [],
        otherEvaluationLinkCount: 0,
        resume: { uploaded: false, textStatus: "NONE", reason: null },
        github: { login: null, sources: null, invalid: false },
      },
    });
  });
});
