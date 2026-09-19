import { Badge, EmptyState } from "@/components/ui";
import type { GraphEdgeView, GraphNodeView, GraphView } from "@/lib/workbench/graph";

/**
 * 관련 함수 그래프 탭 (PRD 6장 ③, TICKET.md T-304). 선택한 실행 기록의 하네스 케이스에서 관측된 요청의 핸들러를 루트로,
 * 정적 호출 관계로 이어진 함수 최대 12개를 dagre 레이아웃의 SVG로 그린다.
 *
 * 노드는 `관측됨`(timeline에 등장한 라우트의 핸들러)과 `정적`(코드 관계로만 연결)으로 구분한다. 정적 노드에 실행을 뜻하는
 * 문구를 붙이지 않으며, 이 패널은 관측 여부를 추정하지 않는다. 노드를 누르면 코드 근거 뷰어(`?pane=code&source=`, T-305)로 간다.
 * 분석 실패는 "분석 불가 · 사유"로 그대로 보여 준다 (G-09·G-14).
 */

const ARROW_ID = "graph-arrow";

export function GraphPanel({ graph }: { graph: GraphView }) {
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      data-testid="graph-panel"
      data-graph-status={graph.status}
      data-graph-case={graph.caseId ?? undefined}
    >
      <GraphHeader graph={graph} />
      <GraphBody graph={graph} />
    </section>
  );
}

function GraphHeader({ graph }: { graph: GraphView }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
      <h3 className="text-sm font-bold text-ink">관련 함수 그래프</h3>
      {graph.caseId ? (
        <code className="font-mono text-[12px] text-neutral-600" data-testid="graph-case">
          {graph.caseId}
        </code>
      ) : null}
      {graph.summary ? (
        <span className="text-neutral-500" data-testid="graph-summary">
          라우트 {graph.summary.routes} · 함수 {graph.summary.functions} · 파일{" "}
          {graph.summary.files}
        </span>
      ) : null}
      <ul className="ml-auto flex items-center gap-3" aria-label="범례" data-testid="graph-legend">
        {graph.legend.map((item) => (
          <li key={item.key} className="flex items-center gap-1" title={item.description}>
            <span
              aria-hidden="true"
              data-legend={item.key}
              className={
                item.key === "observed"
                  ? "inline-block h-3 w-3 rounded-sm border-2 border-ink bg-ink/10"
                  : "inline-block h-3 w-3 rounded-sm border border-dashed border-neutral-400 bg-surface"
              }
            />
            <span className="text-neutral-600">{item.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GraphBody({ graph }: { graph: GraphView }) {
  switch (graph.status) {
    case "unavailable":
      return (
        <EmptyState
          title="분석 불가"
          description={graph.reason ?? "사유 없음"}
          testId="graph-unavailable"
        >
          <p className="text-[13px] text-neutral-400">
            정적 분석이 실패해도 실행 결과·판정에는 영향이 없습니다. 이 탭만 비어 있습니다.
          </p>
        </EmptyState>
      );
    case "missing":
      return (
        <EmptyState
          title="분석 결과 없음"
          description={graph.reason ?? undefined}
          testId="graph-missing"
        />
      );
    case "no-run":
      return (
        <EmptyState
          title="실행 기록을 선택하세요"
          description="그래프는 선택한 하네스 케이스 기록의 요청에서 시작합니다."
          testId="graph-no-run"
        />
      );
    case "no-case":
      return (
        <EmptyState
          title="이 기록의 그래프 없음"
          description={graph.reason ?? undefined}
          testId="graph-no-case"
        />
      );
    case "ok":
      return <GraphDrawing graph={graph} />;
  }
}

function GraphDrawing({ graph }: { graph: GraphView }) {
  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        title="매치된 라우트 없음"
        description={
          graph.unmatchedRequests.length > 0
            ? `등록된 라우트에 매치되지 않은 요청: ${graph.unmatchedRequests.join(", ")}`
            : "이 케이스의 요청이 코드의 라우트 등록과 대응되지 않았습니다."
        }
        testId="graph-no-match"
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p
        className="text-[13px] leading-relaxed break-words text-neutral-600"
        data-testid="graph-roots"
      >
        루트(관측 요청의 핸들러): {graph.roots.join(" · ")}
        {graph.truncated ? (
          <span className="ml-2 text-neutral-400" data-testid="graph-truncated">
            · 노드 {graph.nodes.length}개 표시, 호출 관계로 닿는 함수 {graph.omittedCount}개는 생략
          </span>
        ) : null}
      </p>
      {graph.unmatchedRequests.length > 0 ? (
        <p className="text-[13px] break-words text-neutral-500" data-testid="graph-unmatched">
          매치되지 않은 요청: {graph.unmatchedRequests.join(" · ")}
        </p>
      ) : null}
      <div className="overflow-auto rounded-lg border border-neutral-200 bg-neutral-50">
        <svg
          role="img"
          aria-label={`관련 함수 그래프: 노드 ${graph.nodes.length}개, 간선 ${graph.edges.length}개`}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          width={graph.width}
          height={graph.height}
          className="block max-w-none"
          data-testid="graph-svg"
        >
          <defs>
            <marker
              id={ARROW_ID}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-neutral-400" />
            </marker>
          </defs>
          <g data-testid="graph-edges">
            {graph.edges.map((edge) => (
              <GraphEdge key={`${edge.from}→${edge.to}`} edge={edge} />
            ))}
          </g>
          <g data-testid="graph-nodes">
            {graph.nodes.map((node) => (
              <GraphNode key={node.id} node={node} />
            ))}
          </g>
        </svg>
      </div>
      <ol
        className="flex flex-col divide-y divide-neutral-100 text-[13px]"
        aria-label="노드 목록"
        data-testid="graph-node-list"
      >
        {graph.nodes.map((node) => (
          <li
            key={node.id}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-2"
            data-node-id={node.id}
          >
            <span data-node-status={node.observed ? "observed" : "static"} className="contents">
              <Badge tone={node.observed ? "ink" : "neutral"}>{node.statusLabel}</Badge>
            </span>
            <span className="text-neutral-500">{node.kindLabel}</span>
            <a
              href={node.href}
              className="font-mono font-medium text-ink hover:text-primary hover:underline"
            >
              {node.name}
            </a>
            <code className="font-mono text-[12px] break-all text-neutral-400">
              {node.locationLabel}
            </code>
          </li>
        ))}
      </ol>
    </div>
  );
}

function GraphEdge({ edge }: { edge: GraphEdgeView }) {
  if (!edge.path) return null;
  return (
    <path
      d={edge.path}
      fill="none"
      className="stroke-neutral-400"
      strokeWidth={1.2}
      markerEnd={`url(#${ARROW_ID})`}
      data-edge-from={edge.from}
      data-edge-to={edge.to}
    />
  );
}

function GraphNode({ node }: { node: GraphNodeView }) {
  const left = node.x - node.width / 2;
  const top = node.y - node.height / 2;
  const title = `${node.kindLabel} · ${node.statusLabel} · ${node.locationLabel}`;
  return (
    <a
      href={node.href}
      data-node-id={node.id}
      data-node-status={node.observed ? "observed" : "static"}
      data-node-depth={node.depth}
      data-node-selected={node.selected ? "true" : undefined}
      aria-label={`${node.name} (${title})`}
    >
      <title>{title}</title>
      <rect
        x={left}
        y={top}
        width={node.width}
        height={node.height}
        rx={8}
        className={node.observed ? "fill-ink/10 stroke-ink" : "fill-surface stroke-neutral-400"}
        strokeWidth={node.observed ? 2 : 1}
        strokeDasharray={node.observed ? undefined : "4 3"}
      />
      <text
        x={node.x}
        y={node.y - 4}
        textAnchor="middle"
        className="fill-ink font-mono"
        fontSize={12}
      >
        {node.name.length > 30 ? `${node.name.slice(0, 29)}…` : node.name}
      </text>
      <text
        x={node.x}
        y={node.y + 12}
        textAnchor="middle"
        className={node.observed ? "fill-ink" : "fill-neutral-500"}
        fontSize={10}
      >
        {node.statusLabel} · {node.location.path.split("/").pop()}:{node.location.startLine}
      </text>
    </a>
  );
}
