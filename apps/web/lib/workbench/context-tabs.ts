/**
 * 워크벤치 하단 탭 4개의 표시 모델 (TICKET.md T-504): 이력서 연결 · GitHub 근거 · 후속 질문 · 미평가 영역.
 *
 * - 맥락 연결은 점수를 바꾸지 않는다(T-503). 이 모듈은 점수·배점을 읽지 않고 표시하지도 않는다.
 *   상태 칩은 `EVIDENCE_FOUND`·`NEEDS_CHECK`·`NO_DATA` 세 종류뿐이며 합격·탈락·순위 성격의 문구가 없다 (G-13).
 * - GitHub 저장소의 선정 점수(`relevanceScore`)는 옮기지 않는다. 선정 사유는 겹친 키워드로만 보인다.
 * - 빈 상태는 이유를 그대로 보인다: 이력서 미제공, 단계 미완료, LLM 미실행 사유, GitHub 조회 사유 (G-09·G-14).
 * - 미평가 영역은 INCONCLUSIVE·판정 없는 기준, 완료되지 않은 단계(SKIPPED·UNSUPPORTED·FAILED 등),
 *   맥락 NO_DATA 항목과 단계가 남긴 미평가 영역, 분석 범위 한계(스냅샷 제외 항목·테스트 프레임워크·함수 그래프)를 모두 나열한다.
 */
import {
  CONTEXT_NO_RESUME_AREA,
  CONTEXT_NO_RESUME_CLAIM,
  ContextLinkSummarySchema,
  EVALUATION_STAGE_ORDER,
  STAGE_NOT_IMPLEMENTED_REASON,
  type ContextLink,
  type ContextLinkSummary,
  type ContextStatus,
  type EvaluationReport,
  type EvaluationStage,
  type EvaluationStageRecord,
  type GitHubRepoSource,
  type GitHubSources,
  type GitHubSourcesStatus,
  type StageState,
  type Verdict,
} from "@ohmyti/core";
import type { EvaluationContextInput } from "@/lib/context/service";
import { STAGE_LABEL, STAGE_STATE_LABEL } from "@/lib/submissions/service";
import type { FunctionGraphInput } from "./graph";
import type { WorkbenchTab, WorkbenchUrlState } from "./state";

export const CONTEXT_STATUS_LABEL: Record<ContextStatus, string> = {
  EVIDENCE_FOUND: "근거 있음",
  NEEDS_CHECK: "확인 필요",
  NO_DATA: "자료 없음",
};

export const GITHUB_SOURCES_STATUS_LABEL: Record<GitHubSourcesStatus, string> = {
  COLLECTED: "수집 완료",
  PARTIAL: "일부 수집",
  NO_DATA: "자료 없음",
};

const GITHUB_PART_LABEL: Record<GitHubRepoSource["missing"][number]["part"], string> = {
  readme: "README",
  languages: "언어",
  topLevelFiles: "최상위 파일",
  commits: "커밋",
  mergedPulls: "병합 PR",
};

/** 빈 상태 문구. 제목과 이유를 그대로 보인다 */
export interface TabEmptyView {
  title: string;
  description: string;
}

export interface ContextObservationView {
  criterionId: string;
  /** rubric의 기준 제목. rubric에 없는 기준이면 null */
  title: string | null;
  summary: string;
  /** 중앙 패널을 그 기준으로 옮기는 링크 (탭은 유지). rubric에 없으면 null */
  href: string | null;
}

export interface ClaimCardView {
  id: string;
  claim: string;
  status: ContextStatus;
  statusLabel: string;
  evidence: Array<{ repo: string; url: string; summary: string }>;
  observation: ContextObservationView | null;
  followUpQuestion: string | null;
}

export interface ResumeTabView {
  claims: ClaimCardView[];
  empty: TabEmptyView | null;
  /** 다른 평가가 같은 제출을 다시 연결해 여기서 보이지 않는 연결이 있으면 그 안내 */
  notice: string | null;
}

export interface RepoCardView {
  fullName: string;
  url: string;
  description: string | null;
  /** 선정 사유 (겹친 키워드 또는 최근 push 순) */
  selectionReason: string;
  /** 수집 요약 (언어·커밋 수·병합 PR 수·README·최상위 항목 수) */
  collected: string[];
  /** 수집하지 못한 항목과 사유 */
  missing: string[];
}

export interface GitHubTabView {
  login: string | null;
  status: GitHubSourcesStatus | null;
  statusLabel: string | null;
  /** PARTIAL·NO_DATA의 사유 원문 */
  reason: string | null;
  /** 조회 범위: 후보 수·요청 수 */
  scope: string | null;
  /** 선정에서 뺀 후보 안내: 제출 저장소, 범용 키워드만 겹친 후보 수 (T-603). 이전 기록이면 비어 있다 */
  selectionNotes: string[];
  repos: RepoCardView[];
  empty: TabEmptyView | null;
}

export interface QuestionGroupView {
  /** 연결된 기준이 없으면 null */
  criterionId: string | null;
  label: string;
  href: string | null;
  questions: Array<{ linkId: string; claim: string; question: string }>;
}

export interface QuestionsTabView {
  groups: QuestionGroupView[];
  /** 모든 질문을 줄 단위로 합친 복사용 텍스트 */
  allText: string;
  empty: TabEmptyView | null;
}

export interface UnevaluatedCriterionView {
  id: string;
  title: string;
  /** 판정이 아직 없으면 null */
  verdict: Verdict | null;
  /** INCONCLUSIVE면 저장된 관측, 판정이 없으면 안내 */
  note: string;
  href: string;
}

export interface UnevaluatedStageView {
  stage: EvaluationStage;
  label: string;
  /** 기록이 없는 단계는 null */
  state: StageState | null;
  stateLabel: string;
  reason: string | null;
}

export interface UnevaluatedTabView {
  criteria: UnevaluatedCriterionView[];
  stages: UnevaluatedStageView[];
  /** 맥락 NO_DATA 항목(claim)과 CONTEXT_LINK 단계가 남긴 미평가 영역 */
  context: string[];
  /** 분석 범위 한계 */
  analysisLimits: string[];
}

export interface ContextTabsView {
  tab: WorkbenchTab;
  /** 맥락을 읽지 못했으면 사유. 이때도 미평가 영역의 기준·단계는 리포트에서 보인다 */
  loadError: string | null;
  resume: ResumeTabView;
  github: GitHubTabView;
  questions: QuestionsTabView;
  unevaluated: UnevaluatedTabView;
}

function stageOf(report: EvaluationReport, stage: EvaluationStage) {
  return report.stages.find((s) => s.stage === stage);
}

function stageReasonLabel(reason: string | undefined): string | null {
  if (!reason) return null;
  return reason === STAGE_NOT_IMPLEMENTED_REASON ? "미구현" : reason;
}

function contextSummaryOf(record: EvaluationStageRecord | undefined): ContextLinkSummary | null {
  const parsed = ContextLinkSummarySchema.safeParse(record?.detail?.contextLink);
  return parsed.success ? parsed.data : null;
}

/** 연결이 하나도 없을 때의 이유. 이력서 미제공 → 단계 미완료 → 단계 사유 순으로 본다 */
function noLinksReason(
  report: EvaluationReport,
  context: Extract<EvaluationContextInput, { ok: true }>["data"],
): TabEmptyView {
  const systemRow = context.links.find(
    (l) => l.claimSource === "SYSTEM" && l.claim === CONTEXT_NO_RESUME_CLAIM,
  );
  const stage = stageOf(report, "CONTEXT_LINK");
  const resumeMissing = !context.resume.uploaded && context.resume.textStatus === "NONE";
  if (systemRow || (resumeMissing && (!stage || stage.state === "DONE"))) {
    return { title: CONTEXT_NO_RESUME_CLAIM, description: CONTEXT_NO_RESUME_AREA };
  }
  if (!stage) {
    return {
      title: "맥락 연결 기록 없음",
      description: "이 평가에는 맥락 연결 단계 기록이 없습니다",
    };
  }
  if (stage.state !== "DONE") {
    const reason = stageReasonLabel(stage.reason);
    return {
      title: `맥락 연결 ${STAGE_STATE_LABEL[stage.state]}`,
      description: reason
        ? `맥락 연결 단계가 완료되지 않았습니다: ${reason}`
        : "맥락 연결 단계가 아직 완료되지 않았습니다",
    };
  }
  if (stage.reason) {
    return { title: "연결 없음", description: stage.reason };
  }
  if (context.resume.textStatus === "IMAGE_ONLY" || context.resume.textStatus === "NONE") {
    return {
      title: "이력서 텍스트 없음",
      description: context.resume.reason ?? "이력서에서 텍스트를 추출하지 못했습니다",
    };
  }
  return {
    title: "연결 없음",
    description: "이력서 주장 중 제출 자료와 연결된 항목이 없습니다",
  };
}

function observationView(
  link: ContextLink,
  report: EvaluationReport,
  href: (patch: Partial<WorkbenchUrlState>) => string,
): ContextObservationView | null {
  const observed = link.assignmentObservation;
  if (!observed?.criterionId) return null;
  const criterion = report.rubric.criteria.find((c) => c.id === observed.criterionId) ?? null;
  return {
    criterionId: observed.criterionId,
    title: criterion?.title ?? null,
    summary: observed.summary,
    // 기준을 바꾸면 이전 기준의 실행 기록·코드 위치·변형 실험 선택은 풀어 둔다
    href: criterion
      ? href({ criterionId: criterion.id, runId: null, source: null, mutationId: null })
      : null,
  };
}

function buildResumeTab(
  report: EvaluationReport,
  context: Extract<EvaluationContextInput, { ok: true }>["data"],
  href: (patch: Partial<WorkbenchUrlState>) => string,
): ResumeTabView {
  const claims: ClaimCardView[] = context.links
    .filter((l) => l.claimSource === "RESUME")
    .map((link) => ({
      id: link.id,
      claim: link.claim,
      status: link.status,
      statusLabel: CONTEXT_STATUS_LABEL[link.status],
      evidence: link.githubEvidence ?? [],
      observation: observationView(link, report, href),
      followUpQuestion: link.followUpQuestion ?? null,
    }));
  return {
    claims,
    empty: claims.length === 0 ? noLinksReason(report, context) : null,
    notice:
      context.otherEvaluationLinkCount > 0
        ? `이 제출의 맥락 연결 ${context.otherEvaluationLinkCount}건은 다른 평가에서 다시 만들어 여기에는 보이지 않습니다`
        : null,
  };
}

function selectionReason(sources: GitHubSources, repo: GitHubRepoSource): string {
  if (sources.selection === "RECENT_PUSH") {
    return "이력서·JD 키워드와 겹치는 저장소가 없어 최근 push 순으로 골랐습니다";
  }
  if (sources.selection === "RESUME_LINK") {
    return repo.matchedKeywords.length === 0
      ? "이력서·JD에 저장소 주소가 있음"
      : `이력서·JD에 저장소 주소가 있음 · 겹친 키워드: ${repo.matchedKeywords.join(", ")}`;
  }
  if (repo.matchedKeywords.length === 0) return "이력서·JD 키워드와 겹침";
  return `이력서·JD 키워드와 겹침: ${repo.matchedKeywords.join(", ")}`;
}

function selectionNotes(sources: GitHubSources): string[] {
  const notes: string[] = [];
  if (sources.excludedRepos && sources.excludedRepos.length > 0) {
    notes.push(`제출 저장소는 근거 후보에서 뺐습니다: ${sources.excludedRepos.join(", ")}`);
  }
  if (sources.genericOnlyCount && sources.genericOnlyCount > 0) {
    notes.push(
      `범용 키워드(api, express, typescript 등)만 겹친 저장소 ${sources.genericOnlyCount}개는 고르지 않았습니다`,
    );
  }
  return notes;
}

function collectedSummary(repo: GitHubRepoSource): string[] {
  const missing = new Set(repo.missing.map((m) => m.part));
  const items: string[] = [];
  if (!missing.has("languages") && repo.languages.length > 0) {
    items.push(
      `언어 ${repo.languages
        .slice(0, 3)
        .map((l) => l.name)
        .join(", ")}`,
    );
  } else if (repo.language) {
    items.push(`언어 ${repo.language}`);
  }
  if (!missing.has("commits")) items.push(`최근 커밋 ${repo.commits.length}개`);
  if (!missing.has("mergedPulls")) items.push(`병합 PR ${repo.mergedPulls.length}개`);
  if (!missing.has("readme")) {
    items.push(
      repo.readme === null ? "README 없음" : repo.readmeTruncated ? "README 앞부분" : "README",
    );
  }
  if (!missing.has("topLevelFiles")) items.push(`최상위 항목 ${repo.topLevelFiles.length}개`);
  return items;
}

function githubEmpty(
  report: EvaluationReport,
  github: Extract<EvaluationContextInput, { ok: true }>["data"]["github"],
): TabEmptyView | null {
  if (github.invalid) {
    return {
      title: "GitHub 근거를 읽지 못함",
      description: "저장된 GitHub 조회 결과의 형태가 맞지 않습니다",
    };
  }
  const sources = github.sources;
  if (!sources) {
    if (!github.login) {
      return {
        title: "GitHub 프로필 미제공",
        description: "제출할 때 GitHub 프로필을 입력하지 않았습니다",
      };
    }
    const stage = stageOf(report, "CONTEXT_LINK");
    const state = stage ? STAGE_STATE_LABEL[stage.state] : "기록 없음";
    return {
      title: "아직 조회하지 않음",
      description: `GitHub 보충 조회 결과가 없습니다 (맥락 연결 단계: ${state})`,
    };
  }
  if (sources.repos.length > 0) return null;
  if (sources.reason?.startsWith("NO_PROFILE")) {
    return { title: "GitHub 프로필 미제공", description: sources.reason };
  }
  return {
    title: GITHUB_SOURCES_STATUS_LABEL[sources.status],
    description: sources.reason ?? "관련 저장소를 찾지 못했습니다",
  };
}

function buildGitHubTab(
  report: EvaluationReport,
  github: Extract<EvaluationContextInput, { ok: true }>["data"]["github"],
): GitHubTabView {
  const sources = github.sources;
  return {
    login: sources?.login ?? github.login,
    status: sources?.status ?? null,
    statusLabel: sources ? GITHUB_SOURCES_STATUS_LABEL[sources.status] : null,
    reason: sources?.reason ?? null,
    scope: sources
      ? `공개 저장소 ${sources.candidateCount}개${sources.candidateListTruncated ? "(목록 첫 페이지까지)" : ""} 중 최대 ${sources.repos.length}개 선정 · GitHub 요청 ${sources.requestCount}/${sources.requestLimit}`
      : null,
    selectionNotes: sources ? selectionNotes(sources) : [],
    repos: (sources?.repos ?? []).map((repo) => ({
      fullName: repo.fullName,
      url: repo.url,
      description: repo.description,
      selectionReason: selectionReason(sources!, repo),
      collected: collectedSummary(repo),
      missing: repo.missing.map((m) => `${GITHUB_PART_LABEL[m.part]}: ${m.reason}`),
    })),
    empty: githubEmpty(report, github),
  };
}

function buildQuestionsTab(
  report: EvaluationReport,
  context: Extract<EvaluationContextInput, { ok: true }>["data"],
  href: (patch: Partial<WorkbenchUrlState>) => string,
): QuestionsTabView {
  const byCriterion = new Map<string | null, QuestionGroupView["questions"]>();
  for (const link of context.links) {
    if (link.claimSource !== "RESUME" || !link.followUpQuestion) continue;
    const key = link.assignmentObservation?.criterionId ?? null;
    const list = byCriterion.get(key) ?? [];
    list.push({ linkId: link.id, claim: link.claim, question: link.followUpQuestion });
    byCriterion.set(key, list);
  }
  const rubricOrder = report.rubric.criteria.map((c) => c.id);
  const keys = [...byCriterion.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    const ia = rubricOrder.indexOf(a);
    const ib = rubricOrder.indexOf(b);
    return (ia < 0 ? rubricOrder.length : ia) - (ib < 0 ? rubricOrder.length : ib);
  });
  const groups: QuestionGroupView[] = keys.map((key) => {
    const criterion = key ? report.rubric.criteria.find((c) => c.id === key) : undefined;
    return {
      criterionId: key,
      label: key === null ? "연결된 기준 없음" : criterion ? `${key} · ${criterion.title}` : key,
      href: criterion
        ? href({ criterionId: criterion.id, runId: null, source: null, mutationId: null })
        : null,
      questions: byCriterion.get(key)!,
    };
  });
  const allText = groups.flatMap((g) => g.questions.map((q) => q.question)).join("\n");
  let empty: TabEmptyView | null = null;
  if (groups.length === 0) {
    const reason = noLinksReason(report, context);
    const hasClaims = context.links.some((l) => l.claimSource === "RESUME");
    empty = hasClaims
      ? { title: "후속 질문 없음", description: "연결 항목에 후속 질문이 없습니다" }
      : reason;
  }
  return { groups, allText, empty };
}

function analysisLimitsOf(
  report: EvaluationReport,
  functionGraph: FunctionGraphInput | null,
): string[] {
  const limits: string[] = [];
  const dropped = stageOf(report, "REPO_CHECK")?.detail?.dropped as
    { links?: unknown; unsupported?: unknown } | undefined;
  if (dropped && typeof dropped.links === "number" && dropped.links > 0) {
    limits.push(`스냅샷 수집: 심볼릭·하드 링크 ${dropped.links}개를 제외했습니다`);
  }
  if (dropped && typeof dropped.unsupported === "number" && dropped.unsupported > 0) {
    limits.push(`스냅샷 수집: 일반 파일이 아닌 항목 ${dropped.unsupported}개를 제외했습니다`);
  }
  const support = stageOf(report, "ENV_PREP")?.detail;
  if (support && support.testFrameworkSupported === false) {
    const framework =
      typeof support.testFramework === "string" ? support.testFramework : "알 수 없음";
    limits.push(
      `제출 테스트: 테스트 프레임워크(${framework})를 실행기가 지원하지 않습니다 (vitest만 지원)`,
    );
  }
  if (functionGraph) {
    if (!functionGraph.ok) {
      limits.push(`관련 함수 그래프: ${functionGraph.message}`);
    } else if (functionGraph.data.analysis.status === "unavailable") {
      limits.push(`관련 함수 그래프 분석 불가: ${functionGraph.data.analysis.reason}`);
    }
  }
  return limits;
}

function buildUnevaluatedTab(
  report: EvaluationReport,
  context: EvaluationContextInput | null,
  functionGraph: FunctionGraphInput | null,
  href: (patch: Partial<WorkbenchUrlState>) => string,
): UnevaluatedTabView {
  const resultById = new Map(report.criterionResults.map((r) => [r.criterionId, r]));
  const criteria: UnevaluatedCriterionView[] = report.rubric.criteria.flatMap((criterion) => {
    const result = resultById.get(criterion.id);
    if (result && result.verdict !== "INCONCLUSIVE") return [];
    return [
      {
        id: criterion.id,
        title: criterion.title,
        verdict: result ? result.verdict : null,
        note: result ? result.observation : "판정이 아직 저장되지 않았습니다",
        href: href({ criterionId: criterion.id, runId: null, source: null, mutationId: null }),
      },
    ];
  });

  const stages: UnevaluatedStageView[] = EVALUATION_STAGE_ORDER.flatMap((stage) => {
    const record = stageOf(report, stage);
    if (record?.state === "DONE") return [];
    return [
      {
        stage,
        label: STAGE_LABEL[stage],
        state: record?.state ?? null,
        stateLabel: record ? STAGE_STATE_LABEL[record.state] : "기록 없음",
        reason: stageReasonLabel(record?.reason),
      },
    ];
  });

  const contextItems: string[] = [];
  if (context?.ok) {
    for (const link of context.data.links) {
      if (link.status !== "NO_DATA") continue;
      contextItems.push(
        link.claimSource === "SYSTEM"
          ? link.claim
          : `${CONTEXT_STATUS_LABEL.NO_DATA}: ${link.claim}`,
      );
    }
  } else if (context && !context.ok) {
    contextItems.push(context.message);
  }
  const summary = contextSummaryOf(stageOf(report, "CONTEXT_LINK"));
  for (const area of summary?.unassessedAreas ?? []) {
    // "이력서 미제공" 행과 같은 뜻의 문구는 한 번만 보인다
    if (area === CONTEXT_NO_RESUME_AREA && contextItems.includes(CONTEXT_NO_RESUME_CLAIM)) continue;
    if (!contextItems.includes(area)) contextItems.push(area);
  }

  return {
    criteria,
    stages,
    context: contextItems,
    analysisLimits: analysisLimitsOf(report, functionGraph),
  };
}

export function buildContextTabsView(
  report: EvaluationReport,
  tab: WorkbenchTab,
  context: EvaluationContextInput | null,
  functionGraph: FunctionGraphInput | null,
  href: (patch: Partial<WorkbenchUrlState>) => string,
): ContextTabsView {
  const loadError =
    context === null ? "맥락을 읽지 않았습니다" : context.ok ? null : context.message;
  const data = context?.ok ? context.data : null;
  const unavailable: TabEmptyView = {
    title: "맥락을 읽지 못함",
    description: loadError ?? "",
  };
  return {
    tab,
    loadError,
    resume: data
      ? buildResumeTab(report, data, href)
      : { claims: [], empty: unavailable, notice: null },
    github: data
      ? buildGitHubTab(report, data.github)
      : {
          login: null,
          status: null,
          statusLabel: null,
          reason: null,
          scope: null,
          selectionNotes: [],
          repos: [],
          empty: unavailable,
        },
    questions: data
      ? buildQuestionsTab(report, data, href)
      : { groups: [], allText: "", empty: unavailable },
    unevaluated: buildUnevaluatedTab(report, context, functionGraph, href),
  };
}
