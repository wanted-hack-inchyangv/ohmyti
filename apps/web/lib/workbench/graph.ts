/**
 * 관련 함수 그래프 탭의 표시 모델 (TICKET.md T-304). 워커가 저장한 `FunctionGraphAnalysis`(`readFunctionGraph`, `/api/evaluations/[id]/graph`와
 * 같은 값)에서 선택한 실행 기록의 하네스 케이스 서브그래프를 골라 dagre로 좌표만 붙인다.
 *
 * 이 모듈은 관측 여부를 추정하지 않는다: `observed`는 분석 결과의 값 그대로이며, 핸들러가 아닌 노드는 모두 `정적`이다.
 * 정적 노드에 실행을 뜻하는 문구를 붙이지 않는다 (PRD 6장: AST만 보고 실행됐다고 말하지 않는다).
 */
import { Graph, layout, type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import type {
  ApiErrorCode,
  CaseFunctionGraph,
  FunctionGraphNode,
  FunctionGraphNodeKind,
  FunctionGraphReport,
  SourceLocation,
} from "@ohmyti/core";
import type { WorkbenchUrlState } from "./state";

export type FunctionGraphInput =
  { ok: true; data: FunctionGraphReport } | { ok: false; code: ApiErrorCode; message: string };

export const NODE_KIND_LABEL: Record<FunctionGraphNodeKind, string> = {
  handler: "라우트 핸들러",
  function: "함수",
  method: "메서드",
};

/** 노드 상태 라벨. 관측은 timeline에 등장한 라우트의 핸들러에만 붙는다 */
export const OBSERVED_LABEL = "관측됨";
export const STATIC_LABEL = "정적";

export const GRAPH_LEGEND = [
  {
    key: "observed",
    label: OBSERVED_LABEL,
    description: "이 기록의 요청·상태 타임라인에 등장한 요청이 매치된 라우트 핸들러",
  },
  {
    key: "static",
    label: STATIC_LABEL,
    description: "코드(AST)의 호출 관계로만 연결된 함수. 실제로 실행됐는지는 관측하지 않았다",
  },
] as const;

export const NODE_HEIGHT = 44;
export const NODE_MIN_WIDTH = 120;
export const NODE_MAX_WIDTH = 260;
const CHAR_WIDTH = 7.2;
const NODE_PADDING_X = 20;

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphNodeView {
  id: string;
  name: string;
  kind: FunctionGraphNodeKind;
  kindLabel: string;
  location: SourceLocation;
  /** `path:startLine-endLine` */
  locationLabel: string;
  /** `POST /orders` 또는 null */
  routeLabel: string | null;
  observed: boolean;
  statusLabel: typeof OBSERVED_LABEL | typeof STATIC_LABEL;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 코드 근거 뷰어(T-305)로 이동하는 링크 (`?pane=code&source=path:start-end`) */
  href: string;
  /** `?source=`가 이 노드의 위치와 같다 */
  selected: boolean;
}

export interface GraphEdgeView {
  from: string;
  to: string;
  points: GraphPoint[];
  /** SVG path d */
  path: string;
}

export type GraphViewStatus =
  /** 서브그래프를 그린다 */
  | "ok"
  /** 워커가 "분석 불가"로 저장했다 */
  | "unavailable"
  /** 아티팩트가 없다 (판정 저장 전·분석 이전 평가) 또는 읽기 오류 */
  | "missing"
  /** 선택한 기록이 없다 */
  | "no-run"
  /** 선택한 기록이 하네스 케이스가 아니거나(기동·제출 테스트) 분석 결과에 그 케이스가 없다 */
  | "no-case";

export interface GraphView {
  status: GraphViewStatus;
  /** unavailable·missing의 사유 */
  reason: string | null;
  caseId: string | null;
  /** 루트 라우트 (`GET /products/:id`) */
  roots: string[];
  unmatchedRequests: string[];
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  width: number;
  height: number;
  truncated: boolean;
  omittedCount: number;
  /** 분석 결과에 기록된 라우트 수·함수 수 (있을 때) */
  summary: { routes: number; functions: number; files: number } | null;
  legend: typeof GRAPH_LEGEND;
}

export function sourceParam(location: SourceLocation): string {
  return `${location.path}:${location.startLine}-${location.endLine}`;
}

export function routeLabelOf(route: { method: string; path: string } | null): string | null {
  return route ? `${route.method} ${route.path}` : null;
}

function nodeWidth(name: string): number {
  const estimated = Math.round(name.length * CHAR_WIDTH + NODE_PADDING_X * 2);
  return Math.max(NODE_MIN_WIDTH, Math.min(NODE_MAX_WIDTH, estimated));
}

/** dagre 레이아웃. 노드 크기는 이름 길이로 어림하고 좌표는 dagre 결과 그대로다 */
export function layoutSubgraph(subgraph: Pick<CaseFunctionGraph, "nodes" | "edges">): {
  positions: Map<string, GraphPoint & { width: number; height: number }>;
  edges: GraphEdgeView[];
  width: number;
  height: number;
} {
  const g = new Graph<GraphLabel, NodeLabel, EdgeLabel>();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 56, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of subgraph.nodes) {
    g.setNode(node.id, { width: nodeWidth(node.name), height: NODE_HEIGHT });
  }
  for (const edge of subgraph.edges) g.setEdge(edge.from, edge.to);
  layout(g);
  const positions = new Map<string, GraphPoint & { width: number; height: number }>();
  for (const node of subgraph.nodes) {
    const label = g.node(node.id);
    positions.set(node.id, {
      x: label.x ?? 0,
      y: label.y ?? 0,
      width: label.width,
      height: label.height,
    });
  }
  const edges: GraphEdgeView[] = subgraph.edges.map((edge) => {
    const label = g.edge(edge.from, edge.to);
    const points = label?.points ?? [];
    const path = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");
    return { from: edge.from, to: edge.to, points, path };
  });
  const graphLabel = g.graph();
  return {
    positions,
    edges,
    width: Math.ceil(graphLabel.width ?? 0),
    height: Math.ceil(graphLabel.height ?? 0),
  };
}

function emptyView(
  status: GraphViewStatus,
  reason: string | null,
  caseId: string | null,
): GraphView {
  return {
    status,
    reason,
    caseId,
    roots: [],
    unmatchedRequests: [],
    nodes: [],
    edges: [],
    width: 0,
    height: 0,
    truncated: false,
    omittedCount: 0,
    summary: null,
    legend: GRAPH_LEGEND,
  };
}

export interface GraphViewSelection {
  /** 중앙 패널이 선택한 기록의 하네스 케이스 ID (근거 `testId`). 기록이 없으면 null */
  selectedRunId: string | null;
  caseId: string | null;
}

export function buildGraphView(
  input: FunctionGraphInput | null,
  selection: GraphViewSelection,
  urlState: WorkbenchUrlState,
  href: (patch: Partial<WorkbenchUrlState>) => string,
): GraphView {
  if (input === null)
    return emptyView("missing", "이 화면은 분석 결과를 아직 읽지 않았습니다", selection.caseId);
  if (!input.ok) return emptyView("missing", `${input.code}: ${input.message}`, selection.caseId);
  const { analysis } = input.data;
  if (analysis.status === "unavailable")
    return emptyView("unavailable", analysis.reason, selection.caseId);
  const summary = {
    routes: analysis.routes.length,
    functions: analysis.functionCount,
    files: analysis.fileCount,
  };
  if (!selection.selectedRunId) return { ...emptyView("no-run", null, null), summary };
  if (!selection.caseId) {
    return {
      ...emptyView("no-case", "이 실행 기록은 하네스 케이스가 아니어서 요청이 없습니다", null),
      summary,
    };
  }
  const subgraph = analysis.cases.find((c) => c.caseId === selection.caseId);
  if (!subgraph) {
    return {
      ...emptyView(
        "no-case",
        `분석 결과에 케이스 ${selection.caseId}의 서브그래프가 없습니다`,
        selection.caseId,
      ),
      summary,
    };
  }
  const { positions, edges, width, height } = layoutSubgraph(subgraph);
  const nodes: GraphNodeView[] = subgraph.nodes.map((node: FunctionGraphNode) => {
    const position = positions.get(node.id)!;
    const source = sourceParam(node.location);
    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      kindLabel: NODE_KIND_LABEL[node.kind],
      location: node.location,
      locationLabel: source,
      routeLabel: routeLabelOf(node.route),
      observed: node.observed,
      statusLabel: node.observed ? OBSERVED_LABEL : STATIC_LABEL,
      depth: node.depth,
      x: position.x,
      y: position.y,
      width: position.width,
      height: position.height,
      href: href({ pane: "code", source }),
      selected: urlState.source === source,
    };
  });
  return {
    status: "ok",
    reason: null,
    caseId: subgraph.caseId,
    roots: subgraph.roots.map((r) => `${r.method} ${r.path}`),
    unmatchedRequests: subgraph.unmatchedRequests.map((r) => `${r.method} ${r.path}`),
    nodes,
    edges,
    width,
    height,
    truncated: subgraph.truncated,
    omittedCount: subgraph.omittedCount,
    summary,
    legend: GRAPH_LEGEND,
  };
}
