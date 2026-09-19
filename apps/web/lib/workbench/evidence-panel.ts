/**
 * 평가 근거·검토 이력 패널(오른쪽)의 표시 모델 (TICKET.md T-306, PRD 6장 ③).
 * 선택한 기준의 `observation`(관측)·`interpretation`(추정)·method·근거 목록·reviewState와 `review_events` 이력을 리포트에서 옮긴다.
 * 점수는 계산하지 않는다 (`earnedPoints/maxPoints`는 저장값 그대로). 액션 가능 여부는 method·rubric 규칙으로만 정한다.
 */
import {
  designSignalItems,
  ReviewWriteSummarySchema,
  type ApiErrorCode,
  type DesignSignalsReport,
  type Evidence,
  type EvaluationReport,
  type Method,
  type ReviewConfidence,
  type ReviewEvent,
  type ReviewEventKind,
  type ReviewState,
  type ReviewSuggestion,
  type SourceLocation,
  type Verdict,
} from "@ohmyti/core";
import { sourceParam } from "./graph";
import {
  EVIDENCE_KIND_DESCRIPTION,
  evidenceLabelOf,
  type CodeEvidenceLabel,
} from "./code-evidence";
import type { WorkbenchUrlState } from "./state";

export const METHOD_LABEL: Record<Method, string> = {
  EXECUTION: "실행",
  STATIC: "정적",
  MUTATION: "mutation",
  HUMAN_REVIEW: "사람 검토",
};

export const REVIEW_EVENT_KIND_LABEL: Record<ReviewEventKind, string> = {
  CONFIRM: "확인",
  OVERRIDE: "점수 수정",
  DISPUTE: "이의 제기",
  APPROVE_DESIGN: "설계 점수 확정",
};

export interface EvidenceItemView {
  id: string;
  kind: Evidence["kind"] | null;
  label: CodeEvidenceLabel;
  labelDescription: string;
  /** `path:start-end`. 코드 위치가 없으면 null */
  locationLabel: string | null;
  testId: string | null;
  runId: string | null;
  /** 아티팩트 참조 수 (실행 기록 본문·로그) */
  artifactCount: number;
  /**
   * 클릭 시 중앙 패널로 이동하는 링크. 실행 기록이 있으면 `?run=`(실패 재생), 코드 위치만 있으면 `?source=`(코드 근거).
   * 둘 다 없으면(사람 검토 근거) null
   */
  href: string | null;
  hrefTarget: "run" | "source" | null;
  /** LLM 근거(T-407)의 내용. 추정 원인의 확신 정도 또는 설계 평가 초안의 제안 점수·근거. 그 밖의 근거는 null */
  llm: {
    confidence: ReviewConfidence | null;
    suggestion: { suggestedPoints: number; maxPoints: number; rationale: string } | null;
  } | null;
}

export const CONFIDENCE_LABEL: Record<ReviewConfidence, string> = {
  HIGH: "확신 높음",
  LOW: "확신 낮음",
  UNKNOWN: "원인 불명",
};

/** REVIEW_WRITE 단계(T-407) 요약. 단계 기록에서 옮기며 점수와 무관하다 */
export interface ReviewWriteView {
  /** 단계 상태 (`PENDING`·`RUNNING`·`DONE`·`SKIPPED`·`FAILED`) */
  state: string;
  /** "LLM 미실행(예산 초과)" 같은 사유. 정상 완료면 null */
  reason: string | null;
  /** 선택 기준의 추정 원인 확신 정도 */
  confidence: ReviewConfidence | null;
  /** 선택 기준의 최소 재현 설명 (기존 실패 재생 스텝만 참조) */
  minimalRepro: { summary: string; stepIds: string[] } | null;
  /** 명세 외 개선 제안 (평가 전체) */
  suggestions: ReviewSuggestion[];
  /** LLM 출력에서 형식 오류로 제외한 항목 수 (T-601, 평가 전체) */
  droppedItems: number;
}

/** 이력 한 줄. 값은 저장된 이벤트를 문자열로 옮긴 것이다 */
export interface ReviewHistoryItemView {
  id: string;
  criterionId: string;
  kind: ReviewEventKind;
  kindLabel: string;
  reviewer: string;
  createdAt: string;
  previous: { points: string; verdict: Verdict; reviewState: ReviewState };
  next: { points: string; verdict: Verdict; reviewState: ReviewState };
  /** 점수·판정·상태 중 무엇이 바뀌었는지 (`원래 값 → 새 값` 표시용) */
  pointsChanged: boolean;
  verdictChanged: boolean;
  reviewStateChanged: boolean;
  reason: string;
}

export interface ReviewSubCriterionView {
  id: string;
  description: string;
  points: number;
  /** 현재 판정이 PARTIAL이면 저장된 `satisfiedSubCriterionIds` 포함 여부, PASS면 전부 true */
  satisfied: boolean;
}

export interface ReviewActionsView {
  evaluationId: string;
  criterionId: string;
  maxPoints: number;
  earnedPoints: number | null;
  /** APPROVE_DESIGN 가능: HUMAN_REVIEW 기준이고 rubric에 하위 기준 규칙이 있다 */
  canApproveDesign: boolean;
  subCriteria: ReviewSubCriterionView[];
}

/**
 * 설계 신호 입력 (T-605). 페이지가 `readDesignSignals`로 읽어 넘긴다 (`/api/evaluations/[id]/design-signals`와 같은 값).
 * `READ_FAILED`는 스토어·DB 연결 오류로 읽지 못한 경우다
 */
export type DesignSignalsInput =
  | { ok: true; data: DesignSignalsReport }
  | { ok: false; code: ApiErrorCode | "READ_FAILED"; message: string };

/** 신호 한 줄에 링크로 보이는 위치 수 상한. 나머지는 `외 n곳`으로 센다 */
export const MAX_SIGNAL_LINKS = 5;

export interface DesignSignalLocationView {
  /** `path:start` 또는 `path:start-end` */
  label: string;
  /** 코드 근거 뷰어로 가는 링크 (`?pane=code&source=`) */
  href: string;
}

export interface DesignSignalItemView {
  id: string;
  label: string;
  /** 센 사실 (`12곳 (as any 0곳)`) */
  value: string;
  locations: DesignSignalLocationView[];
  /** 링크로 보이지 않은 나머지 위치 수 */
  moreCount: number;
  /** 같은 모양의 문장 블록 묶음 (중복 블록 신호만) */
  groups: Array<{ statements: number; locations: DesignSignalLocationView[] }>;
}

/**
 * 사람 검토 기준의 근거 패널에 보이는 설계 신호 (T-605). 워커가 AST로 센 사실이며 근거 행이 아니고 점수·판정과 무관하다.
 * `missing`은 신호를 추출하기 전의 평가(아티팩트 없음), `unavailable`은 추출 실패(사유 표시)다.
 */
export interface DesignSignalsView {
  status: "ok" | "unavailable" | "missing";
  message: string | null;
  items: DesignSignalItemView[];
}

export type EvidencePanelStatus =
  /** 기준을 고르지 않았다 */
  | "no-criterion"
  /** 선택 기준의 판정이 아직 저장되지 않았다 */
  | "no-result"
  | "ok";

export interface EvidencePanelView {
  status: EvidencePanelStatus;
  criterionId: string | null;
  title: string | null;
  methodLabel: string | null;
  verdict: Verdict | null;
  reviewState: ReviewState | null;
  /** `earned/max` 또는 `?/max` (저장값) */
  pointsDisplay: string | null;
  observation: string | null;
  /** 추정 (REVIEW_WRITE, T-407). LLM을 실행하지 않았거나 FAIL 기준이 아니면 비어 있다 */
  interpretation: string | null;
  issueId: string | null;
  evidences: EvidenceItemView[];
  /** 선택 기준의 이력(시간순). 기준을 고르지 않았으면 평가 전체의 이력 */
  history: ReviewHistoryItemView[];
  historyScope: "criterion" | "evaluation";
  actions: ReviewActionsView | null;
  /** REVIEW_WRITE 단계 기록이 없으면(4단계 이전 평가) null */
  review: ReviewWriteView | null;
  /** 설계 신호 (T-605). 선택 기준이 사람 검토 기준이고 판정이 저장됐을 때만 있다 */
  designSignals: DesignSignalsView | null;
}

function signalLocationLabel(location: SourceLocation): string {
  return location.startLine === location.endLine
    ? `${location.path}:${location.startLine}`
    : sourceParam(location);
}

export function buildDesignSignalsView(
  input: DesignSignalsInput | null,
  href: (patch: Partial<WorkbenchUrlState>) => string,
): DesignSignalsView {
  if (!input || (!input.ok && input.code === "ARTIFACT_NOT_FOUND")) {
    return {
      status: "missing",
      message:
        input && !input.ok ? input.message : "코드 신호가 없습니다 (신호를 추출하기 전의 평가).",
      items: [],
    };
  }
  if (!input.ok) return { status: "unavailable", message: input.message, items: [] };
  const signals = input.data.signals;
  if (signals.status === "unavailable") {
    return {
      status: "unavailable",
      message: `코드 신호를 추출하지 못했습니다: ${signals.reason}`,
      items: [],
    };
  }
  const locationView = (location: SourceLocation): DesignSignalLocationView => ({
    label: signalLocationLabel(location),
    href: href({ pane: "code", source: sourceParam(location) }),
  });
  return {
    status: "ok",
    message: null,
    items: designSignalItems(signals).map((item) => {
      const groups = (item.groups ?? []).map((g) => ({
        statements: g.statements,
        locations: g.locations.map(locationView),
      }));
      const shown = groups.length > 0 ? [] : item.locations.slice(0, MAX_SIGNAL_LINKS);
      const total = groups.length > 0 ? 0 : (item.count ?? item.locations.length);
      return {
        id: item.id,
        label: item.label,
        value: item.value,
        locations: shown.map(locationView),
        moreCount: Math.max(0, total - shown.length),
        groups,
      };
    }),
  };
}

/** 단계 기록에서 REVIEW_WRITE 요약을 옮긴다. 형식이 다르면 제안·재현 설명 없이 상태만 보인다 */
export function reviewWriteViewOf(
  report: EvaluationReport,
  criterionId: string | null,
): ReviewWriteView | null {
  const stage = report.stages.find((s) => s.stage === "REVIEW_WRITE");
  if (!stage) return null;
  const parsed = ReviewWriteSummarySchema.safeParse(stage.detail);
  const summary = parsed.success ? parsed.data : null;
  const interpretation = criterionId
    ? (summary?.interpretations.find((i) => i.criterionId === criterionId) ?? null)
    : null;
  return {
    state: stage.state,
    reason: stage.reason ?? null,
    confidence: interpretation?.confidence ?? null,
    minimalRepro: interpretation?.minimalRepro ?? null,
    suggestions: summary?.suggestions ?? [],
    droppedItems: summary?.droppedItems ?? 0,
  };
}

function pointsOf(earned: number | null, max: number): string {
  return `${earned === null ? "?" : earned}/${max}`;
}

export function historyItemOf(event: ReviewEvent, maxPoints: number): ReviewHistoryItemView {
  return {
    id: event.id,
    criterionId: event.criterionId,
    kind: event.kind,
    kindLabel: REVIEW_EVENT_KIND_LABEL[event.kind],
    reviewer: event.reviewer,
    createdAt: event.createdAt,
    previous: {
      points: pointsOf(event.previous.earnedPoints, maxPoints),
      verdict: event.previous.verdict,
      reviewState: event.previous.reviewState,
    },
    next: {
      points: pointsOf(event.next.earnedPoints, maxPoints),
      verdict: event.next.verdict,
      reviewState: event.next.reviewState,
    },
    pointsChanged: event.previous.earnedPoints !== event.next.earnedPoints,
    verdictChanged: event.previous.verdict !== event.next.verdict,
    reviewStateChanged: event.previous.reviewState !== event.next.reviewState,
    reason: event.reason,
  };
}

export function buildEvidencePanelView(
  report: EvaluationReport,
  urlState: WorkbenchUrlState,
  href: (patch: Partial<WorkbenchUrlState>) => string,
  designSignals: DesignSignalsInput | null = null,
): EvidencePanelView {
  const maxPointsById = new Map(report.rubric.criteria.map((c) => [c.id, c.maxPoints]));
  const sortedEvents = [...report.reviewEvents].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1,
  );
  const criterion = urlState.criterionId
    ? (report.rubric.criteria.find((c) => c.id === urlState.criterionId) ?? null)
    : null;
  if (!criterion) {
    return {
      status: "no-criterion",
      criterionId: null,
      title: null,
      methodLabel: null,
      verdict: null,
      reviewState: null,
      pointsDisplay: null,
      observation: null,
      interpretation: null,
      issueId: null,
      evidences: [],
      history: sortedEvents.map((e) => historyItemOf(e, maxPointsById.get(e.criterionId) ?? 0)),
      historyScope: "evaluation",
      actions: null,
      review: reviewWriteViewOf(report, null),
      designSignals: null,
    };
  }
  const result = report.criterionResults.find((r) => r.criterionId === criterion.id) ?? null;
  const history = sortedEvents
    .filter((e) => e.criterionId === criterion.id)
    .map((e) => historyItemOf(e, criterion.maxPoints));
  if (!result) {
    return {
      status: "no-result",
      criterionId: criterion.id,
      title: criterion.title,
      methodLabel: METHOD_LABEL[criterion.method],
      verdict: null,
      reviewState: null,
      pointsDisplay: pointsOf(null, criterion.maxPoints),
      observation: null,
      interpretation: null,
      issueId: null,
      evidences: [],
      history,
      historyScope: "criterion",
      actions: null,
      review: reviewWriteViewOf(report, criterion.id),
      designSignals: null,
    };
  }
  const evidenceById = new Map(report.evidences.map((e) => [e.id, e]));
  const evidences: EvidenceItemView[] = result.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((e): e is Evidence => e !== undefined)
    .map((e) => {
      const kind = e.kind ?? null;
      const locationLabel = e.source ? sourceParam(e.source) : null;
      const hrefTarget: EvidenceItemView["hrefTarget"] = e.runId
        ? "run"
        : e.source
          ? "source"
          : null;
      return {
        id: e.id,
        kind,
        label: evidenceLabelOf(kind ?? undefined),
        labelDescription: EVIDENCE_KIND_DESCRIPTION[kind ?? "none"],
        locationLabel,
        testId: e.testId ?? null,
        runId: e.runId ?? null,
        artifactCount: e.artifactRefs.length,
        href:
          hrefTarget === "run"
            ? href({ runId: e.runId! })
            : hrefTarget === "source"
              ? href({ pane: "code", source: locationLabel })
              : null,
        hrefTarget,
        llm:
          e.detail?.origin === "REVIEW_WRITE"
            ? {
                confidence: e.detail.confidence ?? null,
                suggestion:
                  e.detail.suggestedPoints !== undefined &&
                  e.detail.maxPoints !== undefined &&
                  e.detail.rationale
                    ? {
                        suggestedPoints: e.detail.suggestedPoints,
                        maxPoints: e.detail.maxPoints,
                        rationale: e.detail.rationale,
                      }
                    : null,
              }
            : null,
      };
    });
  const rule = report.rubric.partialRules.find((r) => r.criterionId === criterion.id) ?? null;
  const approvableRule =
    criterion.method === "HUMAN_REVIEW" &&
    criterion.allowPartial &&
    rule &&
    rule.subCriteria.length > 0
      ? rule
      : null;
  const canApproveDesign = approvableRule !== null;
  const satisfiedIds = new Set(result.satisfiedSubCriterionIds ?? []);
  return {
    status: "ok",
    criterionId: criterion.id,
    title: criterion.title,
    methodLabel: METHOD_LABEL[criterion.method],
    verdict: result.verdict,
    reviewState: result.reviewState,
    pointsDisplay: pointsOf(result.earnedPoints, criterion.maxPoints),
    observation: result.observation,
    interpretation: result.interpretation ?? null,
    issueId: result.issueId ?? null,
    evidences,
    history,
    historyScope: "criterion",
    review: reviewWriteViewOf(report, criterion.id),
    designSignals:
      criterion.method === "HUMAN_REVIEW" ? buildDesignSignalsView(designSignals, href) : null,
    actions: {
      evaluationId: report.evaluation.id,
      criterionId: criterion.id,
      maxPoints: criterion.maxPoints,
      earnedPoints: result.earnedPoints,
      canApproveDesign,
      subCriteria: approvableRule
        ? approvableRule.subCriteria.map((sub) => ({
            id: sub.id,
            description: sub.description,
            points: sub.points,
            satisfied: result.verdict === "PASS" || satisfiedIds.has(sub.id),
          }))
        : [],
    },
  };
}
