/**
 * 워크벤치의 표시 모델 (TICKET.md T-301·T-302). `EvaluationReport`(T-207 API 응답과 같은 값)를 그대로 옮긴다.
 * 점수·검토 대기·SHA·기준 버전·영역 소계는 리포트 필드를 복사할 뿐이며 이 모듈은 어떤 점수도 계산하지 않는다
 * (`aggregateScore`·`formatScoreDisplay`를 부르지 않고 배점을 더하지 않는다. 테스트가 소스를 대조한다).
 * 필터 개수는 verdict를 세는 것이지 점수 계산이 아니다.
 */
import {
  RubricAreaSchema,
  STAGE_NOT_IMPLEMENTED_REASON,
  type CriterionResult,
  type EvaluationReport,
  type ExecutionRecord,
  type Method,
  type ReviewState,
  type RubricArea,
  type RubricGroup,
  type StoredAreaScore,
  type Verdict,
} from "@ohmyti/core";
import { sampleRunLabel } from "@/lib/demo/format";
import { buildCodeEvidenceView, type CodeEvidenceView } from "./code-evidence";
import {
  buildEvidencePanelView,
  type DesignSignalsInput,
  type EvidencePanelView,
} from "./evidence-panel";
import { buildGraphView, type FunctionGraphInput, type GraphView } from "./graph";
import {
  buildMutationPanelView,
  MUTATION_OUTCOME_LABEL,
  type MutationDetailInput,
  type MutationPanelView,
} from "./mutation";
import {
  buildReplayView,
  type ReplayView,
  type RerunStatusInput,
  type RunRecordInput,
} from "./replay";
import type { CriteriaFilter, WorkbenchTab, WorkbenchUrlState } from "./state";

export const SHORT_SHA_LENGTH = 12;

/** RubricArea 열거 순서. 영역 그룹과 저장된 소계가 같은 순서를 쓴다 */
export const RUBRIC_AREA_ORDER: readonly RubricArea[] = RubricAreaSchema.options;

export const AREA_LABEL: Record<RubricArea, string> = {
  REQUIRED_FEATURES: "요구 기능",
  EDGE_AND_FAILURE: "경계·실패",
  TEST_EFFECTIVENESS: "테스트 실효성",
  DESIGN: "설계·변경 용이성",
  REPRODUCIBILITY_AND_DOCS: "실행 재현성·문서",
};

export { METHOD_LABEL } from "./evidence-panel";

export interface WorkbenchHeaderView {
  evaluationId: string;
  submissionId: string;
  /** `score.display` 그대로. 판정 저장 전이면 null */
  scoreDisplay: string | null;
  /** `score.pendingPoints` 그대로. 판정 저장 전이면 null */
  pendingPoints: number | null;
  /** 검토 대기 배지를 보일지. `pendingPoints > 0` */
  showPendingBadge: boolean;
  submissionSha: string;
  shortSha: string;
  rubricVersion: string;
  harnessVersion: string;
  assignmentLabel: string;
  repoUrl: string;
  /** 제출 또는 평가가 샘플이면 `저장된 실행` 배지 (G-08) */
  isSample: boolean;
  /** 샘플 배지 문구. 끝난 평가는 `저장된 실행 · <시각>`(T-505), 샘플이 아니면 null */
  sampleLabel: string | null;
  submissionStatus: EvaluationReport["submission"]["status"];
  finishedAt: string | null;
}

export interface WorkbenchCriterionView {
  id: string;
  area: RubricArea;
  title: string;
  maxPoints: number;
  method: Method;
  groupId: string | null;
  /** 저장된 판정. 아직 없으면 null */
  result: CriterionResult | null;
  verdict: Verdict | null;
  earnedPoints: number | null;
  /** `earned/max` 또는 `?/max`. `?`는 미확정(INCONCLUSIVE 또는 판정 없음)이며 0점과 다르다 (G-04) */
  pointsDisplay: string;
  reviewState: ReviewState | null;
  /** 미확정: INCONCLUSIVE이거나 아직 판정이 없다 (둘 다 검토 대기 배점, 부록 C) */
  unresolved: boolean;
  selected: boolean;
  href: string;
}

/** 영역 소계 표시. 저장된 `score.byArea` 항목을 옮기고, 없으면(0005 이전 평가·판정 저장 전) null */
export interface WorkbenchAreaSubtotalView {
  earned: number;
  min: number;
  max: number;
  pendingPoints: number;
  total: number;
  /** `earned/total` 또는 `min~max/total` (부록 C 표기를 영역에 적용) */
  display: string;
}

export interface WorkbenchAreaGroupView {
  area: RubricArea;
  label: string;
  /** 현재 필터를 통과한 기준 (rubric 순서) */
  criteria: WorkbenchCriterionView[];
  /** 필터와 무관한 이 영역의 기준 수 */
  totalCount: number;
  subtotal: WorkbenchAreaSubtotalView | null;
}

export interface WorkbenchFilterView {
  filter: CriteriaFilter;
  /** 필터별 기준 개수. verdict 분포를 센 값이다 */
  counts: Record<CriteriaFilter, number>;
  hrefFor: (filter: CriteriaFilter) => string;
}

export interface WorkbenchEffectivenessGroupView {
  id: string;
  name: string;
  criterionIds: string[];
  mutationIds: string[];
  /** 그룹을 참조하는 MUTATION 기준. rubric에 없으면 null */
  criterion: WorkbenchCriterionView | null;
  /** 판정 배지 옆 상태 문구. 4단계 전에는 `미구현`, 그 뒤에는 저장된 observation */
  statusLabel: string;
  /** 검증되지 않은 요구사항: 그룹의 SURVIVED 실험이 겨냥한 기준 ID (rubric 순서). 없으면 빈 배열 */
  unverifiedCriterionIds: string[];
  /** 그룹의 실험 결과 (`mutationIds` 순). 실험하지 않았으면 비어 있다 */
  experiments: Array<{ mutationId: string; outcome: string; outcomeLabel: string }>;
}

export interface WorkbenchEffectivenessView {
  groups: WorkbenchEffectivenessGroupView[];
  /** TEST_EFFECTIVENESS 단계가 `SKIPPED(not_implemented)`로 기록됐다 (4단계 전) */
  notImplemented: boolean;
  /** 저장된 테스트 실효성 영역 소계 */
  subtotal: WorkbenchAreaSubtotalView | null;
}

export interface WorkbenchView {
  header: WorkbenchHeaderView;
  urlState: WorkbenchUrlState;
  /** rubric 순서 그대로, 필터 적용 전 */
  criteria: WorkbenchCriterionView[];
  /** 영역별 그룹 (RubricArea 열거 순서, rubric에 등장하는 영역만). 기준 목록은 필터를 적용한 것 */
  areaGroups: WorkbenchAreaGroupView[];
  filter: WorkbenchFilterView;
  effectiveness: WorkbenchEffectivenessView;
  /** 영역 소계가 저장되지 않은 평가(마이그레이션 0005 이전) */
  subtotalsMissing: boolean;
  selectedCriterion: WorkbenchCriterionView | null;
  /** `?criterion=`이 rubric에 없는 값이면 그 값 */
  unknownCriterionId: string | null;
  /** 중앙 패널이 본문을 보여 줄 기록: `?run=`이 이 평가의 기록이면 그것, 아니면 선택 기준의 첫 기록 */
  selectedRun: ExecutionRecord | null;
  /** `?run=`이 이 평가의 기록이 아니면 그 값 */
  unknownRunId: string | null;
  /** 실패 재생 뷰 (T-303). 본문은 페이지가 `readRunRecord`로, 재실행 상태(T-307)는 `readRerunStatus`로 읽어 넘긴다 */
  replay: ReplayView;
  /** 관련 함수 그래프 (T-304). 분석 결과는 페이지가 `readFunctionGraph`로 읽어 넘긴다 (그래프 탭일 때만) */
  graph: GraphView;
  /** 테스트 실효성 변형 실험 (T-404). 선택 기준이 MUTATION이 아니면 null. diff·두 기록 본문은 페이지가 읽어 넘긴다 */
  mutation: MutationPanelView | null;
  /** 코드 근거 뷰어 (T-305). 리포트의 근거 `source`·`snippet`만 쓴다 (스냅샷을 읽지 않는다) */
  codeEvidence: CodeEvidenceView;
  /** 평가 근거·검토 이력 패널 (T-306). 관측·추정·근거 목록·`reviewEvents`를 리포트에서 옮긴다 */
  evidencePanel: EvidencePanelView;
  tab: WorkbenchTab | null;
  hrefForTab: (tab: WorkbenchTab | null) => string;
}

export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

export function buildWorkbenchHeader(report: EvaluationReport): WorkbenchHeaderView {
  const { evaluation, submission, assignment, score } = report;
  return {
    evaluationId: evaluation.id,
    submissionId: evaluation.submissionId,
    scoreDisplay: score ? score.display : null,
    pendingPoints: score ? score.pendingPoints : null,
    showPendingBadge: score !== null && score.pendingPoints > 0,
    submissionSha: evaluation.submissionSha,
    shortSha: shortSha(evaluation.submissionSha),
    rubricVersion: evaluation.rubricVersion,
    harnessVersion: evaluation.harnessVersion,
    assignmentLabel: `${assignment.name} v${assignment.version} · ${assignment.title}`,
    repoUrl: submission.repoUrl,
    isSample: evaluation.isSample || submission.isSample,
    sampleLabel:
      evaluation.isSample || submission.isSample ? sampleRunLabel(evaluation.finishedAt) : null,
    submissionStatus: submission.status,
    finishedAt: evaluation.finishedAt,
  };
}

/** 저장된 영역 소계를 부록 C 표기로 옮긴다. `min`·`max`는 저장된 값이며 더하지 않는다 */
export function areaSubtotalView(stored: StoredAreaScore): WorkbenchAreaSubtotalView {
  const display =
    stored.pendingPoints === 0
      ? `${stored.earned}/${stored.total}`
      : `${stored.min}~${stored.max}/${stored.total}`;
  return {
    earned: stored.earned,
    min: stored.min,
    max: stored.max,
    pendingPoints: stored.pendingPoints,
    total: stored.total,
    display,
  };
}

export function matchesFilter(criterion: WorkbenchCriterionView, filter: CriteriaFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "fail":
      return criterion.verdict === "FAIL";
    case "inconclusive":
      return criterion.unresolved;
  }
}

function effectivenessStatusLabel(
  criterion: WorkbenchCriterionView | null,
  notImplemented: boolean,
): string {
  if (!criterion) return "기준 없음";
  if (notImplemented) return "미구현";
  if (!criterion.result) return "판정 없음";
  return criterion.result.observation;
}

/**
 * 기준을 고르지 않고 들어왔을 때 먼저 열 기준. 실제 실패 → 미확정 → 결과 없음 → 첫 기준 순서다.
 * 중앙 패널이 빈 채로 시작하지 않게 한다. 기준이 없으면 null
 */
export function defaultCriterionId(report: EvaluationReport): string | null {
  const resultById = new Map(report.criterionResults.map((r) => [r.criterionId, r]));
  const ids = report.rubric.criteria.map((c) => c.id);
  return (
    ids.find((id) => resultById.get(id)?.verdict === "FAIL") ??
    ids.find((id) => resultById.get(id)?.verdict === "INCONCLUSIVE") ??
    ids.find((id) => !resultById.has(id)) ??
    ids[0] ??
    null
  );
}

export function buildWorkbenchView(
  report: EvaluationReport,
  urlState: WorkbenchUrlState,
  href: (patch: Partial<WorkbenchUrlState>) => string,
  runRecord: RunRecordInput | null = null,
  functionGraph: FunctionGraphInput | null = null,
  rerunStatus: RerunStatusInput | null = null,
  mutationDetail: MutationDetailInput | null = null,
  designSignals: DesignSignalsInput | null = null,
): WorkbenchView {
  const resultById = new Map(report.criterionResults.map((r) => [r.criterionId, r]));
  const criteria: WorkbenchCriterionView[] = report.rubric.criteria.map((criterion) => {
    const result = resultById.get(criterion.id) ?? null;
    const earnedPoints = result ? result.earnedPoints : null;
    return {
      id: criterion.id,
      area: criterion.area,
      title: criterion.title,
      maxPoints: criterion.maxPoints,
      method: criterion.method,
      groupId: criterion.groupId ?? null,
      result,
      verdict: result ? result.verdict : null,
      earnedPoints,
      pointsDisplay: `${earnedPoints === null ? "?" : earnedPoints}/${criterion.maxPoints}`,
      reviewState: result ? result.reviewState : null,
      unresolved: result === null || result.verdict === "INCONCLUSIVE",
      selected: criterion.id === urlState.criterionId,
      href: href({ criterionId: criterion.id }),
    };
  });

  const storedByArea = new Map<RubricArea, StoredAreaScore>(
    (report.score?.byArea ?? []).map((area) => [area.area, area]),
  );
  const subtotalOf = (area: RubricArea): WorkbenchAreaSubtotalView | null => {
    const stored = storedByArea.get(area);
    return stored ? areaSubtotalView(stored) : null;
  };
  const areaGroups: WorkbenchAreaGroupView[] = RUBRIC_AREA_ORDER.filter((area) =>
    criteria.some((c) => c.area === area),
  ).map((area) => {
    const inArea = criteria.filter((c) => c.area === area);
    return {
      area,
      label: AREA_LABEL[area],
      criteria: inArea.filter((c) => matchesFilter(c, urlState.filter)),
      totalCount: inArea.length,
      subtotal: subtotalOf(area),
    };
  });

  const filter: WorkbenchFilterView = {
    filter: urlState.filter,
    counts: {
      all: criteria.length,
      fail: criteria.filter((c) => matchesFilter(c, "fail")).length,
      inconclusive: criteria.filter((c) => matchesFilter(c, "inconclusive")).length,
    },
    hrefFor: (next) => href({ filter: next }),
  };

  const effectivenessStage = report.stages.find((s) => s.stage === "TEST_EFFECTIVENESS");
  const notImplemented =
    effectivenessStage !== undefined &&
    effectivenessStage.state === "SKIPPED" &&
    effectivenessStage.reason === STAGE_NOT_IMPLEMENTED_REASON;
  const effectiveness: WorkbenchEffectivenessView = {
    groups: report.rubric.groups.map((group: RubricGroup) => {
      const criterion =
        criteria.find((c) => c.method === "MUTATION" && c.groupId === group.id) ?? null;
      const experiments = group.mutationIds.flatMap((mutationId) => {
        const experiment = report.mutationExperiments.find((e) => e.mutationId === mutationId);
        return experiment
          ? [
              {
                mutationId,
                outcome: experiment.outcome,
                outcomeLabel: MUTATION_OUTCOME_LABEL[experiment.outcome],
              },
            ]
          : [];
      });
      const survived = new Set(
        report.mutationExperiments
          .filter((e) => e.groupId === group.id && e.outcome === "SURVIVED")
          .map((e) => e.targetCriterionId),
      );
      return {
        id: group.id,
        name: group.name,
        criterionIds: group.criterionIds,
        mutationIds: group.mutationIds,
        criterion,
        statusLabel: effectivenessStatusLabel(criterion, notImplemented),
        unverifiedCriterionIds: report.rubric.criteria
          .map((c) => c.id)
          .filter((id) => survived.has(id)),
        experiments,
      };
    }),
    notImplemented,
    subtotal: subtotalOf("TEST_EFFECTIVENESS"),
  };

  const selectedCriterion = criteria.find((c) => c.selected) ?? null;
  const urlRun = urlState.runId
    ? (report.executionRecords.find((r) => r.id === urlState.runId) ?? null)
    : null;
  const replay = buildReplayView(report, urlState, href, runRecord, rerunStatus);
  const selectedRun = replay.selectedRun
    ? (report.executionRecords.find((r) => r.id === replay.selectedRun!.id) ?? null)
    : null;
  const graph = buildGraphView(
    functionGraph,
    {
      selectedRunId: replay.selectedRun?.id ?? null,
      caseId: replay.selectedRun?.testId ?? null,
    },
    urlState,
    href,
  );
  const codeEvidence = buildCodeEvidenceView(report, urlState, href);
  const mutation = buildMutationPanelView(report, urlState, href, mutationDetail);
  const evidencePanel = buildEvidencePanelView(report, urlState, href, designSignals);
  return {
    header: buildWorkbenchHeader(report),
    urlState,
    criteria,
    areaGroups,
    filter,
    effectiveness,
    subtotalsMissing: report.score !== null && report.score.byArea === null,
    selectedCriterion,
    unknownCriterionId: urlState.criterionId && !selectedCriterion ? urlState.criterionId : null,
    selectedRun,
    unknownRunId: urlState.runId && !urlRun ? urlState.runId : null,
    replay,
    graph,
    mutation,
    codeEvidence,
    evidencePanel,
    tab: urlState.tab,
    hrefForTab: (tab) => href({ tab }),
  };
}
