/**
 * 케이스 서브그래프 (TICKET.md T-304). timeline 요청 → 매치된 라우트의 핸들러(루트) → 정적 호출 간선을 BFS 깊이 순으로 따라가
 * 최대 `MAX_SUBGRAPH_NODES`개 노드를 고른다. 순수 함수이며 입력 순서가 같으면 결과가 같다.
 *
 * `observed`는 이 케이스의 timeline 요청(초기화 요청 포함)이 매치된 라우트의 핸들러에만 붙는다. 루트 선정에서는 초기화 요청
 * (`isSetup`)을 뒤로 미룬다: 본 요청이 하나라도 매치되면 초기화 요청의 핸들러는 루트가 아니다(호출 관계로 닿으면 노드가 될 수 있다).
 */
import {
  MAX_SUBGRAPH_NODES,
  type CaseFunctionGraph,
  type FunctionGraphEdge,
  type FunctionGraphNode,
  type FunctionGraphRequest,
  type FunctionGraphRoute,
} from "@ohmyti/core";
import type { CallGraph, GraphFunction, RouteRegistration } from "./call-graph";
import { findMatchingRoute, normalizeRequestPath } from "./routes";

export interface CaseRequestInput extends FunctionGraphRequest {
  /** 케이스 시작 전 초기화 요청(하네스 `reset`) */
  isSetup?: boolean | undefined;
}

export interface CaseInput {
  caseId: string;
  /** timeline 순서 그대로 */
  requests: CaseRequestInput[];
}

function routeKey(route: FunctionGraphRoute): string {
  return `${route.method} ${route.path}`;
}

function requestKey(request: FunctionGraphRequest): string {
  return `${request.method.toUpperCase()} ${normalizeRequestPath(request.path)}`;
}

export function buildCaseSubgraph(
  graph: CallGraph,
  input: CaseInput,
  maxNodes: number = MAX_SUBGRAPH_NODES,
): CaseFunctionGraph {
  const functionsById = new Map(graph.functions.map((fn) => [fn.id, fn]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  // 요청 매칭 (등장 순, 중복 제거)
  const matched: Array<{ route: RouteRegistration; isSetup: boolean }> = [];
  const seenRoutes = new Set<string>();
  const unmatched: FunctionGraphRequest[] = [];
  const seenUnmatched = new Set<string>();
  const observedHandlerIds = new Set<string>();
  for (const request of input.requests) {
    const route = findMatchingRoute(graph.routes, request);
    if (!route) {
      const key = requestKey(request);
      if (!seenUnmatched.has(key)) {
        seenUnmatched.add(key);
        unmatched.push({
          method: request.method.toUpperCase(),
          path: normalizeRequestPath(request.path),
        });
      }
      continue;
    }
    observedHandlerIds.add(route.handlerId);
    const key = routeKey(route);
    const isSetup = request.isSetup === true;
    if (seenRoutes.has(key)) {
      // 준비 요청으로 먼저 봤던 라우트가 본 요청으로 다시 오면 본 요청으로 승격한다
      const existing = matched.find((m) => routeKey(m.route) === key);
      if (existing && !isSetup) existing.isSetup = false;
      continue;
    }
    seenRoutes.add(key);
    matched.push({ route, isSetup });
  }
  const primary = matched.filter((m) => !m.isSetup);
  const rootRoutes = (primary.length > 0 ? primary : matched).map((m) => m.route);

  // BFS (루트 순 → 호출 순). 전체 도달 집합을 먼저 세어 생략 수를 알고, 선택은 상한까지만
  const depthOf = new Map<string, number>();
  const order: string[] = [];
  const queue: string[] = [];
  for (const route of rootRoutes) {
    if (depthOf.has(route.handlerId)) continue;
    depthOf.set(route.handlerId, 0);
    order.push(route.handlerId);
    queue.push(route.handlerId);
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = depthOf.get(current)!;
    for (const next of outgoing.get(current) ?? []) {
      if (depthOf.has(next) || !functionsById.has(next)) continue;
      depthOf.set(next, depth + 1);
      order.push(next);
      queue.push(next);
    }
  }
  const selectedIds = order.slice(0, maxNodes);
  const selected = new Set(selectedIds);
  const nodes: FunctionGraphNode[] = selectedIds.map((id) => {
    const fn: GraphFunction = functionsById.get(id)!;
    return {
      id: fn.id,
      name: fn.name,
      kind: fn.kind,
      location: fn.location,
      route: fn.route,
      observed: fn.route !== null && observedHandlerIds.has(fn.id),
      depth: depthOf.get(id)!,
    };
  });
  const edges: FunctionGraphEdge[] = graph.edges.filter(
    (edge) => selected.has(edge.from) && selected.has(edge.to),
  );
  return {
    caseId: input.caseId,
    roots: rootRoutes.map((route) => ({ method: route.method, path: route.path })),
    unmatchedRequests: unmatched,
    nodes,
    edges,
    truncated: order.length > maxNodes,
    omittedCount: Math.max(0, order.length - maxNodes),
  };
}
