/**
 * 워크벤치 URL 상태 (TICKET.md T-301). `/evaluations/<id>?criterion=R-05&run=<runId>&tab=resume`로 딥링크한다.
 * 상태는 URL에만 있고 서버 컴포넌트가 읽어 그린다. 클라이언트 상태 저장소는 두지 않는다.
 * 왼쪽 패널의 실패 필터(T-302)는 `?filter=fail|inconclusive`이며 `all`은 키를 지운 상태다.
 * 중앙 하단 탭(T-303)은 `?pane=graph`이며 기본 `code`는 키를 지운 상태다.
 * 코드 위치(T-304 그래프 노드 클릭 → T-305 코드 근거 뷰어)는 `?source=<path>:<startLine>-<endLine>`이다.
 * 테스트 실효성 그룹에서 펼칠 변형 실험(T-404)은 `?mutation=M-01`이다.
 */
import { z } from "zod";

export const WORKBENCH_TABS = ["resume", "github", "questions", "unevaluated"] as const;
export type WorkbenchTab = (typeof WORKBENCH_TABS)[number];

export const WORKBENCH_TAB_LABEL: Record<WorkbenchTab, string> = {
  resume: "이력서 연결",
  github: "GitHub 근거",
  questions: "후속 질문",
  unevaluated: "미평가 영역",
};

export const CRITERIA_FILTERS = ["all", "fail", "inconclusive"] as const;
export type CriteriaFilter = (typeof CRITERIA_FILTERS)[number];

export const CRITERIA_FILTER_LABEL: Record<CriteriaFilter, string> = {
  all: "전체",
  fail: "실패만",
  inconclusive: "미확정만",
};

export const CENTER_PANES = ["code", "graph"] as const;
export type CenterPane = (typeof CENTER_PANES)[number];

export const CENTER_PANE_LABEL: Record<CenterPane, string> = {
  code: "코드 근거",
  graph: "관련 함수 그래프",
};

export interface WorkbenchUrlState {
  /** 선택한 기준 ID. rubric에 없는 값이어도 그대로 두고 화면이 "찾을 수 없음"으로 알린다 */
  criterionId: string | null;
  /** 선택한 실행 기록 ID (uuid) */
  runId: string | null;
  /** 하단 탭. 없으면 닫힌 상태 */
  tab: WorkbenchTab | null;
  /** 왼쪽 패널 기준 필터. 기본 `all` */
  filter: CriteriaFilter;
  /** 중앙 하단 탭. 기본 `code` */
  pane: CenterPane;
  /** 코드 위치 `path:startLine-endLine`. 그래프 노드 클릭으로 정해지며 코드 근거 뷰어(T-305)가 읽는다 */
  source: string | null;
  /** 테스트 실효성 그룹에서 펼칠 변형 실험 ID (T-404). 없으면 그룹의 첫 실험 */
  mutationId: string | null;
}

export type SearchParamsInput = Record<string, string | string[] | undefined>;

const CRITERION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** `src/http/routes.ts:25-28`. 경로는 스냅샷 상대 경로(`..`·선행 `/` 없음) */
const SOURCE_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|:))[^\s:?#]{1,512}:[1-9]\d{0,6}-[1-9]\d{0,6}$/;

/** `?source=` 값을 위치로 푼다. 형식이 맞지 않으면 null */
export function parseSourceParam(
  value: string | null,
): { path: string; startLine: number; endLine: number } | null {
  if (!value || !SOURCE_PATTERN.test(value)) return null;
  const separator = value.lastIndexOf(":");
  const [start, end] = value
    .slice(separator + 1)
    .split("-")
    .map(Number);
  if (start === undefined || end === undefined || end < start) return null;
  return { path: value.slice(0, separator), startLine: start, endLine: end };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** 형식이 맞지 않는 값은 무시한다(없는 것으로 본다). 예외를 던지지 않는다 */
export function parseWorkbenchSearchParams(params: SearchParamsInput): WorkbenchUrlState {
  const criterion = first(params.criterion);
  const run = first(params.run);
  const tab = first(params.tab);
  const filter = first(params.filter);
  const pane = first(params.pane);
  const source = first(params.source);
  const mutation = first(params.mutation);
  return {
    criterionId: criterion && CRITERION_ID_PATTERN.test(criterion) ? criterion : null,
    runId: run && z.uuid().safeParse(run).success ? run : null,
    tab: tab && (WORKBENCH_TABS as readonly string[]).includes(tab) ? (tab as WorkbenchTab) : null,
    filter:
      filter && (CRITERIA_FILTERS as readonly string[]).includes(filter)
        ? (filter as CriteriaFilter)
        : "all",
    pane:
      pane && (CENTER_PANES as readonly string[]).includes(pane) ? (pane as CenterPane) : "code",
    source: source && parseSourceParam(source) ? source : null,
    mutationId: mutation && CRITERION_ID_PATTERN.test(mutation) ? mutation : null,
  };
}

/** 상태 일부만 바꾼 URL. `null`을 주면 그 키를 지운다 */
export function workbenchHref(
  evaluationId: string,
  state: WorkbenchUrlState,
  patch: Partial<WorkbenchUrlState> = {},
): string {
  const next: WorkbenchUrlState = { ...state, ...patch };
  const query = new URLSearchParams();
  if (next.criterionId) query.set("criterion", next.criterionId);
  if (next.runId) query.set("run", next.runId);
  if (next.tab) query.set("tab", next.tab);
  if (next.filter !== "all") query.set("filter", next.filter);
  if (next.pane !== "code") query.set("pane", next.pane);
  if (next.source) query.set("source", next.source);
  if (next.mutationId) query.set("mutation", next.mutationId);
  const qs = query.toString();
  return `/evaluations/${evaluationId}${qs ? `?${qs}` : ""}`;
}
