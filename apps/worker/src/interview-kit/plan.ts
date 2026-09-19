/**
 * 인터뷰 키트 질문 계획 (TICKET.md T-702, PRD 14.2). LLM을 부르기 전에 저장된 판정·변이·설계 신호·맥락 연결에서
 * 무엇을 물을지(슬롯), 우선순위, 예상 시간, 45분·60분 진행안을 결정적으로 정한다.
 *
 * - 같은 입력이면 결과가 바이트 단위로 같다. 입력 배열의 순서에 기대지 않도록 기준은 rubric 순서, 변이는 ID 순서,
 *   맥락 연결은 위치 순서로 다시 정렬한다.
 * - `FAILURE_DEBRIEF`: FAIL·PARTIAL 기준(EXECUTION·STATIC)을 잃은 배점이 큰 순으로 최대 4개. 같은 `issueId`는 하나로 묶되,
 *   rubric의 `independentReason`에 함께 적힌 기준은 따로 둔다(G-12의 별도 감점과 같은 기준). INCONCLUSIVE는 대상이 아니다(G-11).
 *   MUTATION 기준의 FAIL은 재생 기록이 아니라 살아남은 변이가 근거라 `TEST_DESIGN`으로 다룬다.
 * - 잃은 배점은 순서를 정할 때만 쓴다. LLM 입력(`prompt.ts`)에는 넘기지 않는다.
 */
import {
  competencyForCriterion,
  INTERVIEW_KIT_MAX_QUESTIONS,
  INTERVIEW_MAX_REFS,
  INTERVIEW_QUESTION_KIND_LABELS,
  InterviewQuestionKindSchema,
  type Competency,
  type DesignSignals,
  type InterviewPlan,
  type InterviewPlanDuration,
  type InterviewPriority,
  type InterviewQuestionKind,
  type Method,
  type MutationOutcome,
  type ObservationRef,
  type RubricArea,
  type SourceLocation,
  type Verdict,
} from "@ohmyti/core";

// ── 입력 ─────────────────────────────────────────────────────────────────────────

/** 실패·강점 슬롯의 근거로 쓰는 하네스 케이스 실행 기록 */
export interface KitCaseRun {
  runId: string;
  caseId: string;
  /** 관련 함수 그래프에서 이 케이스 요청이 매치된 핸들러 (깊이 0, 그래프 순서). 그래프가 없으면 빈 배열 */
  handlers: Array<{ name: string; location: SourceLocation }>;
}

export interface KitCriterionFact {
  id: string;
  title: string;
  condition: string;
  area: RubricArea;
  method: Method;
  /** MUTATION 기준이 참조하는 rubric 그룹 */
  groupId: string | null;
  verdict: Verdict;
  issueId: string | null;
  /** 배점 (강점 슬롯 순서) */
  maxPoints: number;
  /** 잃은 배점 (FAIL·PARTIAL 슬롯 순서). 미확정이면 0 */
  lostPoints: number;
  /** 저장된 관측 문장 (실행 기록에서 만든 템플릿 문장, 제출물 값이 들어 있다) */
  observation: string;
  /** 판정의 근거 중 하네스 케이스 실행 기록 (근거 순서) */
  runs: KitCaseRun[];
}

export interface KitMutationFact {
  mutationId: string;
  experimentId: string;
  groupId: string;
  outcome: MutationOutcome;
  /** 변이 카탈로그의 설명 (기업이 승인한 카탈로그 문장). 카탈로그에 없으면 null */
  description: string | null;
  target: SourceLocation | null;
}

export interface KitGroupFact {
  id: string;
  name: string;
  criterionIds: string[];
}

export interface KitContextLinkFact {
  id: string;
  /** CONTEXT_LINK 단계가 만든 후속 질문 (이력서 연결 질문). 이 단계의 LLM에는 넘기지 않는다 */
  question: string;
  /** 연결된 과제 관측의 기준 ID. 없으면 null */
  criterionId: string | null;
}

/** 설계 검토 초안이 있는 사람 검토 기준 (REVIEW_WRITE 단계 기록). 초안 문장은 쓰지 않는다 */
export interface KitDesignDraftFact {
  criterionId: string;
}

export interface InterviewKitFacts {
  spec: { title: string; summary: string };
  /** 실행 계약의 상태 초기화 경로. 요구사항 확장 시나리오의 근거 문장에 쓴다 */
  resetPath: string | null;
  /** rubric 순서 */
  criteria: KitCriterionFact[];
  /** rubric `independentReasons`에 적힌 기준 ID 묶음 */
  independentGroups: string[][];
  groups: KitGroupFact[];
  mutations: KitMutationFact[];
  designSignals: DesignSignals | null;
  designDrafts: KitDesignDraftFact[];
  contextLinks: KitContextLinkFact[];
}

// ── 출력 ─────────────────────────────────────────────────────────────────────────

/** 슬롯마다 LLM 입력과 기본 질문이 쓰는 근거 요약. 값은 모두 입력에서 그대로 옮긴다 */
export interface SlotBrief {
  /** 기업이 승인한 rubric의 기준 (ID·제목·판정 조건·판정) */
  criteria: Array<{ id: string; title: string; condition: string; verdict: Verdict }>;
  /** 저장된 관측 문장 (제출물 값이 들어 있어 비신뢰 텍스트다) */
  observations: string[];
  /** 살아남은 변이 (카탈로그 설명) */
  mutations: Array<{ id: string; description: string | null }>;
  /** 변이 그룹 이름 (rubric) */
  groupName: string | null;
  /** 설계 신호 한 항목 (값과 위치에 제출물의 경로·이름이 들어 있어 비신뢰 텍스트다) */
  signal: { id: string; label: string; value: string; locations: string[] } | null;
  /** 요구사항 확장 시나리오 */
  scenario: { id: string; situation: string; note: string | null } | null;
  /** 관련 함수 (제출물의 이름·경로라 비신뢰 텍스트다) */
  handlers: string[];
}

export interface InterviewSlot {
  /** `<kind>:<기준 ID·그룹 ID·신호 ID·시나리오 ID·순번>` */
  id: string;
  kind: InterviewQuestionKind;
  competency: Competency;
  priority: InterviewPriority;
  minutes: number;
  refs: ObservationRef[];
  brief: SlotBrief;
  /** `RESUME_BRIDGE`만: 맥락 연결 단계가 만든 질문. LLM에 넘기지 않고 그대로 쓴다 */
  resumeBridge?: { contextLinkId: string; question: string } | undefined;
}

export interface InterviewSlotPlan {
  /** 키트 순서: 우선순위(필수 → 권장 → 선택), 같은 우선순위 안에서는 유형 순서, 같은 유형 안에서는 슬롯 순서 */
  slots: InterviewSlot[];
  plans: InterviewPlan[];
}

// ── 상수 ─────────────────────────────────────────────────────────────────────────

/** 유형별 슬롯 상한 (합 15 = `INTERVIEW_KIT_MAX_QUESTIONS`) */
export const SLOT_LIMITS: Readonly<Record<InterviewQuestionKind, number>> = {
  FAILURE_DEBRIEF: 4,
  TEST_DESIGN: 2,
  DESIGN_TRADEOFF: 2,
  STRENGTH_DEPTH: 2,
  EXTENSION: 2,
  RESUME_BRIDGE: 3,
};

/** 유형별 예상 시간 (분) */
export const SLOT_MINUTES: Readonly<Record<InterviewQuestionKind, number>> = {
  FAILURE_DEBRIEF: 8,
  TEST_DESIGN: 6,
  DESIGN_TRADEOFF: 6,
  STRENGTH_DEPTH: 6,
  EXTENSION: 6,
  RESUME_BRIDGE: 5,
};

/** 유형 순서 (enum 순서와 같다) */
export const KIND_ORDER: readonly InterviewQuestionKind[] = InterviewQuestionKindSchema.options;

/** 진행안의 고정 구간 */
export const PLAN_INTRO = { name: "도입", minutes: 5 } as const;
export const PLAN_CLOSING = { name: "지원자 질문", minutes: 5 } as const;
export const PLAN_DURATIONS: readonly InterviewPlanDuration[] = [45, 60];

/** 강점 확인 후보: 경계·실패 영역이거나 제목·조건이 동시성을 다루는 기준 */
const CONCURRENCY_PATTERN = /동시|경쟁 조건|concurren|race/i;

/** 슬롯 근거 위치 상한 (기준·실행 기록 참조를 뺀 코드 위치) */
const MAX_LOCATION_REFS = 5;

/**
 * 요구사항 확장 시나리오 (PRD 14.2 "명세가 바뀌면 무엇을 바꾸는지"). 관련 기준은 제목·조건에서 결정적으로 찾는다.
 * 관련 기준이 있는 시나리오를 순서대로 최대 2개 고르고, 하나도 없으면 마지막 시나리오를 첫 기준과 묶는다.
 */
export const EXTENSION_SCENARIOS: ReadonlyArray<{
  id: string;
  situation: string;
  pattern: RegExp;
  note: (facts: InterviewKitFacts) => string | null;
}> = [
  {
    id: "multi-instance",
    situation: "같은 서비스를 여러 인스턴스로 띄워 요청이 서로 다른 인스턴스로 들어오는 상황",
    pattern: /동시|경쟁|멱등|concurren|idempot/i,
    note: () => null,
  },
  {
    id: "persistent-store",
    situation: "프로세스를 다시 시작해도 주문과 상태가 남아야 하는 상황",
    pattern: /재고|저장|취소|멱등|stock|persist/i,
    note: (facts) =>
      facts.resetPath ? `실행 계약에 상태 초기화 경로(${facts.resetPath})가 있다` : null,
  },
  {
    id: "traffic-growth",
    situation: "요청량이 지금보다 크게 늘어나는 상황",
    pattern: /조회|목록|생성|list|query/i,
    note: () => null,
  },
];

// ── 계획 ─────────────────────────────────────────────────────────────────────────

type DraftSlot = Omit<InterviewSlot, "priority">;

function emptyBrief(): SlotBrief {
  return {
    criteria: [],
    observations: [],
    mutations: [],
    groupName: null,
    signal: null,
    scenario: null,
    handlers: [],
  };
}

function criterionBrief(c: KitCriterionFact): SlotBrief["criteria"][number] {
  return { id: c.id, title: c.title, condition: c.condition, verdict: c.verdict };
}

function locationText(location: SourceLocation): string {
  return location.startLine === location.endLine
    ? `${location.path}:${location.startLine}`
    : `${location.path}:${location.startLine}-${location.endLine}`;
}

function sameLocation(a: SourceLocation, b: SourceLocation): boolean {
  return a.path === b.path && a.startLine === b.startLine && a.endLine === b.endLine;
}

/** 근거 참조를 중복 없이 상한까지 모은다 */
function capRefs(refs: ObservationRef[]): ObservationRef[] {
  const seen = new Set<string>();
  const out: ObservationRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= INTERVIEW_MAX_REFS) break;
  }
  return out;
}

function sourceRefs(locations: readonly SourceLocation[]): ObservationRef[] {
  const unique: SourceLocation[] = [];
  for (const location of locations) {
    if (!unique.some((u) => sameLocation(u, location))) unique.push(location);
    if (unique.length >= MAX_LOCATION_REFS) break;
  }
  return unique.map((location) => ({ kind: "SOURCE", location }));
}

function handlerText(handler: KitCaseRun["handlers"][number]): string {
  return `${handler.name} · ${locationText(handler.location)}`;
}

function planFailureDebrief(facts: InterviewKitFacts): DraftSlot[] {
  const independent = new Set(facts.independentGroups.flat());
  const failing = facts.criteria.filter(
    (c) =>
      (c.verdict === "FAIL" || c.verdict === "PARTIAL") &&
      (c.method === "EXECUTION" || c.method === "STATIC"),
  );
  // 같은 결함(issueId)은 하나로 묶는다. 별도 감점 근거가 있는 기준은 각자 슬롯이다 (G-12)
  const buckets = new Map<string, KitCriterionFact[]>();
  for (const c of failing) {
    const key = c.issueId && !independent.has(c.id) ? `issue:${c.issueId}` : `criterion:${c.id}`;
    buckets.set(key, [...(buckets.get(key) ?? []), c]);
  }
  const order = new Map(facts.criteria.map((c, i) => [c.id, i]));
  const groups = [...buckets.values()].map((members) => ({
    members,
    lost: members.reduce((sum, c) => sum + c.lostPoints, 0),
    first: Math.min(...members.map((c) => order.get(c.id)!)),
  }));
  groups.sort((a, b) => b.lost - a.lost || a.first - b.first);
  return groups.slice(0, SLOT_LIMITS.FAILURE_DEBRIEF).map(({ members }) => {
    const lead = members[0]!;
    const refs: ObservationRef[] = [];
    for (const c of members) refs.push({ kind: "CRITERION", criterionId: c.id });
    for (const c of members) {
      const run = c.runs[0];
      if (run) refs.push({ kind: "EXECUTION_RECORD", runId: run.runId, criterionId: c.id });
    }
    const handlers = members.flatMap((c) => c.runs.flatMap((r) => r.handlers));
    refs.push(...sourceRefs(handlers.map((h) => h.location)));
    return {
      id: `FAILURE_DEBRIEF:${lead.id}`,
      kind: "FAILURE_DEBRIEF",
      competency: "DEBUGGING",
      minutes: SLOT_MINUTES.FAILURE_DEBRIEF,
      refs: capRefs(refs),
      brief: {
        ...emptyBrief(),
        criteria: members.map(criterionBrief),
        observations: members.map((c) => c.observation),
        handlers: [...new Set(handlers.map(handlerText))].slice(0, MAX_LOCATION_REFS),
      },
    };
  });
}

function planTestDesign(facts: InterviewKitFacts): DraftSlot[] {
  const slots: DraftSlot[] = [];
  const mutations = [...facts.mutations].sort((a, b) =>
    a.mutationId < b.mutationId ? -1 : a.mutationId > b.mutationId ? 1 : 0,
  );
  for (const group of facts.groups) {
    const survived = mutations.filter((m) => m.groupId === group.id && m.outcome === "SURVIVED");
    if (survived.length === 0) continue;
    const groupCriteria = facts.criteria.filter(
      (c) => c.method === "MUTATION" && c.groupId === group.id,
    );
    const refs: ObservationRef[] = [
      ...groupCriteria.map((c): ObservationRef => ({ kind: "CRITERION", criterionId: c.id })),
      ...survived.map((m): ObservationRef => ({
        kind: "MUTATION",
        mutationId: m.mutationId,
        experimentId: m.experimentId,
      })),
      ...sourceRefs(survived.flatMap((m) => (m.target ? [m.target] : []))),
    ];
    slots.push({
      id: `TEST_DESIGN:${group.id}`,
      kind: "TEST_DESIGN",
      competency: "TESTING",
      minutes: SLOT_MINUTES.TEST_DESIGN,
      refs: capRefs(refs),
      brief: {
        ...emptyBrief(),
        criteria: groupCriteria.map(criterionBrief),
        groupName: group.name,
        mutations: survived.map((m) => ({ id: m.mutationId, description: m.description })),
        handlers: survived.flatMap((m) => (m.target ? [locationText(m.target)] : [])),
      },
    });
  }
  const signals = facts.designSignals;
  if (signals?.status === "ok" && signals.weakAssertions.count > 0) {
    const weak = signals.weakAssertions;
    slots.push({
      id: "TEST_DESIGN:weak-assertions",
      kind: "TEST_DESIGN",
      competency: "TESTING",
      minutes: SLOT_MINUTES.TEST_DESIGN,
      refs: capRefs(sourceRefs(weak.locations)),
      brief: {
        ...emptyBrief(),
        signal: {
          id: "weak-assertions",
          label: "제출 테스트의 약한 단언",
          value: `expect 단언 ${weak.total}개 중 ${weak.count}개`,
          locations: weak.locations.slice(0, MAX_LOCATION_REFS).map(locationText),
        },
      },
    });
  }
  return slots.filter((slot) => slot.refs.length > 0).slice(0, SLOT_LIMITS.TEST_DESIGN);
}

function planDesignTradeoff(facts: InterviewKitFacts): DraftSlot[] {
  const designCriteria = facts.criteria.filter(
    (c) => c.method === "HUMAN_REVIEW" && c.area === "DESIGN",
  );
  const criterionRefs = designCriteria.map((c): ObservationRef => ({
    kind: "CRITERION",
    criterionId: c.id,
  }));
  const slots: DraftSlot[] = [];
  const signals = facts.designSignals;
  const signalSlot = (
    id: string,
    label: string,
    value: string,
    locations: readonly SourceLocation[],
  ): DraftSlot => ({
    id: `DESIGN_TRADEOFF:${id}`,
    kind: "DESIGN_TRADEOFF",
    competency: "DESIGN",
    minutes: SLOT_MINUTES.DESIGN_TRADEOFF,
    refs: capRefs([...sourceRefs(locations), ...criterionRefs]),
    brief: {
      ...emptyBrief(),
      criteria: designCriteria.map(criterionBrief),
      signal: {
        id,
        label,
        value,
        locations: locations.slice(0, MAX_LOCATION_REFS).map(locationText),
      },
    },
  });
  if (signals?.status === "ok") {
    // 티켓 순서: 바쁜 대기, 가장 긴 함수, 명시적 any, 중복 블록
    if (signals.busyWaits.count > 0) {
      slots.push(
        signalSlot(
          "busy-waits",
          "바쁜 대기",
          `플래그 조건 반복문 안의 await ${signals.busyWaits.count}곳`,
          signals.busyWaits.locations,
        ),
      );
    }
    if (signals.maxFunctionLines) {
      slots.push(
        signalSlot(
          "max-function",
          "가장 긴 함수",
          `${signals.maxFunctionLines.name} · ${signals.maxFunctionLines.lines}줄`,
          [signals.maxFunctionLines.location],
        ),
      );
    }
    if (signals.explicitAny.count > 0) {
      slots.push(
        signalSlot(
          "explicit-any",
          "명시적 any",
          `${signals.explicitAny.count}곳 (as any ${signals.explicitAny.asAny}곳)`,
          signals.explicitAny.locations,
        ),
      );
    }
    if (signals.duplicateBlocks.count > 0) {
      const group = signals.duplicateBlocks.groups[0];
      slots.push(
        signalSlot(
          "duplicate-blocks",
          "같은 모양의 연속 문장 블록",
          `${signals.duplicateBlocks.count}건`,
          group ? group.locations : [],
        ),
      );
    }
  }
  // 신호가 없을 때만 설계 검토 초안이 있는 기준을 슬롯으로 쓴다. 초안 문장은 LLM 출력이라 실행마다 달라질 수 있어 넘기지 않는다
  for (const draft of facts.designDrafts) {
    const criterion = designCriteria.find((c) => c.id === draft.criterionId);
    if (!criterion) continue;
    slots.push({
      id: `DESIGN_TRADEOFF:${criterion.id}`,
      kind: "DESIGN_TRADEOFF",
      competency: "DESIGN",
      minutes: SLOT_MINUTES.DESIGN_TRADEOFF,
      refs: [{ kind: "CRITERION", criterionId: criterion.id }],
      brief: { ...emptyBrief(), criteria: [criterionBrief(criterion)] },
    });
  }
  return slots.filter((slot) => slot.refs.length > 0).slice(0, SLOT_LIMITS.DESIGN_TRADEOFF);
}

function strengthCompetency(c: KitCriterionFact): Competency {
  if (CONCURRENCY_PATTERN.test(`${c.title} ${c.condition}`)) return "DATA_INTEGRITY";
  return competencyForCriterion(c);
}

function planStrengthDepth(facts: InterviewKitFacts): DraftSlot[] {
  const order = new Map(facts.criteria.map((c, i) => [c.id, i]));
  const candidates = facts.criteria
    .filter(
      (c) =>
        c.verdict === "PASS" &&
        c.method === "EXECUTION" &&
        (c.area === "EDGE_AND_FAILURE" || CONCURRENCY_PATTERN.test(c.title)),
    )
    .sort((a, b) => b.maxPoints - a.maxPoints || order.get(a.id)! - order.get(b.id)!);
  return candidates.slice(0, SLOT_LIMITS.STRENGTH_DEPTH).map((c) => {
    const run = c.runs[0];
    const handlers = c.runs.flatMap((r) => r.handlers);
    return {
      id: `STRENGTH_DEPTH:${c.id}`,
      kind: "STRENGTH_DEPTH",
      competency: strengthCompetency(c),
      minutes: SLOT_MINUTES.STRENGTH_DEPTH,
      refs: capRefs([
        { kind: "CRITERION", criterionId: c.id },
        ...(run
          ? [{ kind: "EXECUTION_RECORD" as const, runId: run.runId, criterionId: c.id }]
          : []),
        ...sourceRefs(handlers.map((h) => h.location)),
      ]),
      brief: {
        ...emptyBrief(),
        criteria: [criterionBrief(c)],
        handlers: [...new Set(handlers.map(handlerText))].slice(0, MAX_LOCATION_REFS),
      },
    };
  });
}

function planExtension(facts: InterviewKitFacts): DraftSlot[] {
  const executable = facts.criteria.filter((c) => c.method === "EXECUTION");
  const slotFor = (
    scenario: (typeof EXTENSION_SCENARIOS)[number],
    related: KitCriterionFact[],
  ): DraftSlot => ({
    id: `EXTENSION:${scenario.id}`,
    kind: "EXTENSION",
    competency: "TRADEOFFS",
    minutes: SLOT_MINUTES.EXTENSION,
    refs: related.map((c): ObservationRef => ({ kind: "CRITERION", criterionId: c.id })),
    brief: {
      ...emptyBrief(),
      criteria: related.map(criterionBrief),
      scenario: { id: scenario.id, situation: scenario.situation, note: scenario.note(facts) },
    },
  });
  const slots: DraftSlot[] = [];
  for (const scenario of EXTENSION_SCENARIOS) {
    const related = executable
      .filter((c) => scenario.pattern.test(`${c.title} ${c.condition}`))
      .slice(0, 3);
    if (related.length > 0) slots.push(slotFor(scenario, related));
  }
  const fallback = executable[0] ?? facts.criteria[0];
  if (slots.length === 0 && fallback) {
    slots.push(slotFor(EXTENSION_SCENARIOS[EXTENSION_SCENARIOS.length - 1]!, [fallback]));
  }
  return slots.slice(0, SLOT_LIMITS.EXTENSION);
}

function planResumeBridge(facts: InterviewKitFacts): DraftSlot[] {
  const byId = new Map(facts.criteria.map((c) => [c.id, c]));
  // 관측 기준이 있는 연결을 먼저, 같은 조건이면 연결 순서대로
  const links = facts.contextLinks
    .map((link, index) => ({ link, index }))
    .filter(({ link }) => link.question.trim().length > 0)
    .sort(
      (a, b) =>
        Number(b.link.criterionId !== null) - Number(a.link.criterionId !== null) ||
        a.index - b.index,
    )
    .slice(0, SLOT_LIMITS.RESUME_BRIDGE);
  return links.map(({ link }, i) => {
    const criterion = link.criterionId ? byId.get(link.criterionId) : undefined;
    return {
      id: `RESUME_BRIDGE:${i + 1}`,
      kind: "RESUME_BRIDGE",
      competency: criterion ? competencyForCriterion(criterion) : "DESIGN",
      minutes: SLOT_MINUTES.RESUME_BRIDGE,
      refs: capRefs([
        { kind: "CONTEXT_LINK", contextLinkId: link.id },
        ...(criterion ? [{ kind: "CRITERION" as const, criterionId: criterion.id }] : []),
      ]),
      brief: { ...emptyBrief(), criteria: criterion ? [criterionBrief(criterion)] : [] },
      resumeBridge: { contextLinkId: link.id, question: link.question.trim() },
    };
  });
}

/**
 * 우선순위: 실패가 있으면 `FAILURE_DEBRIEF` 상위 2개, `TEST_DESIGN` 1개, `STRENGTH_DEPTH` 1개가 필수다. 실패가 없으면
 * `STRENGTH_DEPTH` 2개와 `EXTENSION` 1개가 필수다. 나머지는 유형마다 첫 슬롯이 권장, 그 뒤는 선택이다.
 */
function assignPriorities(byKind: Map<InterviewQuestionKind, DraftSlot[]>): InterviewSlot[] {
  const take = (kind: InterviewQuestionKind, n: number) => (byKind.get(kind) ?? []).slice(0, n);
  const must = new Set<DraftSlot>(
    (byKind.get("FAILURE_DEBRIEF") ?? []).length > 0
      ? [...take("FAILURE_DEBRIEF", 2), ...take("TEST_DESIGN", 1), ...take("STRENGTH_DEPTH", 1)]
      : [...take("STRENGTH_DEPTH", 2), ...take("EXTENSION", 1)],
  );
  const out: InterviewSlot[] = [];
  for (const kind of KIND_ORDER) {
    let shouldGiven = false;
    for (const slot of byKind.get(kind) ?? []) {
      let priority: InterviewPriority;
      if (must.has(slot)) priority = "MUST";
      else if (!shouldGiven) {
        priority = "SHOULD";
        shouldGiven = true;
      } else priority = "OPTIONAL";
      out.push({ ...slot, priority });
    }
  }
  const rank: Record<InterviewPriority, number> = { MUST: 0, SHOULD: 1, OPTIONAL: 2 };
  // 정렬은 안정적이라 같은 우선순위 안에서는 유형 순서·슬롯 순서가 유지된다
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/**
 * 진행안: 도입 5분과 지원자 질문 5분을 고정하고, 남은 시간을 필수 → 권장 순서로 채운다(들어가지 않는 질문은 건너뛴다).
 * 고른 질문은 유형 순서로 묶어 구간을 만든다.
 */
export function buildInterviewPlans(slots: readonly InterviewSlot[]): InterviewPlan[] {
  return PLAN_DURATIONS.map((durationMinutes) => {
    let remaining = durationMinutes - PLAN_INTRO.minutes - PLAN_CLOSING.minutes;
    const chosen: InterviewSlot[] = [];
    for (const priority of ["MUST", "SHOULD"] as const) {
      for (const slot of slots) {
        if (slot.priority !== priority || slot.minutes > remaining) continue;
        chosen.push(slot);
        remaining -= slot.minutes;
      }
    }
    const segments: InterviewPlan["segments"] = [
      { name: PLAN_INTRO.name, minutes: PLAN_INTRO.minutes, questionIds: [] },
    ];
    for (const kind of KIND_ORDER) {
      const inKind = chosen.filter((slot) => slot.kind === kind);
      if (inKind.length === 0) continue;
      segments.push({
        name: INTERVIEW_QUESTION_KIND_LABELS[kind],
        minutes: inKind.reduce((sum, slot) => sum + slot.minutes, 0),
        questionIds: inKind.map((slot) => slot.id),
      });
    }
    segments.push({ name: PLAN_CLOSING.name, minutes: PLAN_CLOSING.minutes, questionIds: [] });
    return { durationMinutes, segments };
  });
}

/** 질문 계획 (결정적, LLM 호출 전) */
export function planInterviewSlots(facts: InterviewKitFacts): InterviewSlotPlan {
  const byKind = new Map<InterviewQuestionKind, DraftSlot[]>([
    ["FAILURE_DEBRIEF", planFailureDebrief(facts)],
    ["TEST_DESIGN", planTestDesign(facts)],
    ["DESIGN_TRADEOFF", planDesignTradeoff(facts)],
    ["STRENGTH_DEPTH", planStrengthDepth(facts)],
    ["EXTENSION", planExtension(facts)],
    ["RESUME_BRIDGE", planResumeBridge(facts)],
  ]);
  const slots = assignPriorities(byKind).slice(0, INTERVIEW_KIT_MAX_QUESTIONS);
  return { slots, plans: buildInterviewPlans(slots) };
}
