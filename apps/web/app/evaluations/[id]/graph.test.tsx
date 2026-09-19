import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MAX_SUBGRAPH_NODES, type CaseFunctionGraph } from "@ohmyti/core";
import { layoutSubgraph, type FunctionGraphInput } from "@/lib/workbench/graph";
import {
  functionGraphAnalysisFixture,
  functionGraphReportFixture,
  R05_CASE_ID,
  R10_CASE_ID,
  unavailableAnalysisFixture,
} from "@/lib/workbench/graph-fixtures";
import { reportFixture, type ReportFixtureOptions } from "@/lib/workbench/fixtures";
import { parseWorkbenchSearchParams, workbenchHref } from "@/lib/workbench/state";
import { buildWorkbenchView } from "@/lib/workbench/view";
import { WorkbenchShell } from "./workbench-shell";

/**
 * 관련 함수 그래프 탭 (T-304). 샘플 A를 실제로 분석한 픽스처(`functionGraphAnalysisFixture`)로 정적 HTML을 렌더링해
 * 노드 수·관측/정적 구분·범례·링크가 분석 결과에서 그대로 오는지 검사한다.
 */

function build(
  query: Record<string, string>,
  graph: FunctionGraphInput | null,
  options: ReportFixtureOptions = { evidenceTestId: R05_CASE_ID },
) {
  const report = reportFixture(options);
  const urlState = parseWorkbenchSearchParams(query);
  const view = buildWorkbenchView(
    report,
    urlState,
    (patch) => workbenchHref(report.evaluation.id, urlState, patch),
    null,
    graph,
  );
  return { report, view, html: renderToStaticMarkup(<WorkbenchShell view={view} />) };
}

const okInput = (): FunctionGraphInput => ({ ok: true, data: functionGraphReportFixture() });

/** 픽스처의 케이스 서브그래프 */
function fixtureCase(caseId: string): CaseFunctionGraph {
  const analysis = functionGraphAnalysisFixture();
  if (analysis.status !== "ok") throw new Error("픽스처는 ok여야 한다");
  return analysis.cases.find((c) => c.caseId === caseId)!;
}

describe("관련 함수 그래프 탭", () => {
  it("선택 기록의 케이스 서브그래프를 그리고 노드는 12개를 넘지 않는다", () => {
    const { view, html } = build({ criterion: "R-05", pane: "graph" }, okInput());
    expect(view.graph.status).toBe("ok");
    expect(view.graph.caseId).toBe(R05_CASE_ID);
    expect(view.graph.nodes.length).toBeLessThanOrEqual(MAX_SUBGRAPH_NODES);
    expect(view.graph.nodes.length).toBe(MAX_SUBGRAPH_NODES);
    expect(view.graph.truncated).toBe(true);
    expect(html).toContain('data-graph-status="ok"');
    expect(html).toContain(`data-graph-case="${R05_CASE_ID}"`);
    // SVG 노드 수 = 서브그래프 노드 수
    expect(html.match(/<a href="[^"]*" data-node-id=/g)?.length).toBe(view.graph.nodes.length);
    expect(html).toContain('data-testid="graph-truncated"');
    expect(html).toContain(
      "루트(관측 요청의 핸들러): GET /products/:id · POST /orders · GET /orders/:id",
    );
  });

  it("`관측됨`은 분석 결과의 observed 그대로이며 핸들러가 아닌 노드는 모두 `정적`이다", () => {
    const sub = fixtureCase(R05_CASE_ID);
    const { view, html } = build({ criterion: "R-05", pane: "graph" }, okInput());
    for (const node of view.graph.nodes) {
      const source = sub.nodes.find((n) => n.id === node.id)!;
      expect(node.observed).toBe(source.observed);
      expect(node.statusLabel).toBe(source.observed ? "관측됨" : "정적");
      if (source.route === null) expect(node.observed).toBe(false);
    }
    const observed = view.graph.nodes.filter((n) => n.observed).map((n) => n.routeLabel);
    expect(observed.sort()).toEqual(["GET /orders/:id", "GET /products/:id", "POST /orders"]);
    expect(html.match(/data-node-status="observed"/g)?.length).toBe(3 * 2); // SVG + 목록
    expect(html.match(/data-node-status="static"/g)?.length).toBe(9 * 2);
    // 범례 두 항목
    expect(html).toContain('data-legend="observed"');
    expect(html).toContain('data-legend="static"');
  });

  it("UI 어디에도 `실행 경로` 문구가 없다 (정적 노드에 실행을 암시하지 않는다)", () => {
    const { html } = build({ criterion: "R-05", pane: "graph" }, okInput());
    expect(html).not.toContain("실행 경로");
    expect(html).not.toContain("실행됨");
    // 정적 노드 라벨은 `정적`뿐이다
    const staticLabels = html.match(/data-node-status="static"[^>]*>(?:<title>)?([^<]*)/g) ?? [];
    for (const label of staticLabels) expect(label).not.toContain("관측");
  });

  it("노드 클릭 링크는 코드 근거 뷰어(`?pane=code&source=path:start-end`)로 간다", () => {
    const { view, html } = build({ criterion: "R-05", pane: "graph" }, okInput());
    const post = view.graph.nodes.find((n) => n.name === "POST /orders")!;
    expect(post.location).toEqual({ path: "src/http/routes.ts", startLine: 25, endLine: 28 });
    expect(post.href).toBe(
      `/evaluations/${view.header.evaluationId}?criterion=R-05&source=src%2Fhttp%2Froutes.ts%3A25-28`,
    );
    expect(html).toContain(`href="${post.href.replace(/&/g, "&amp;")}"`);
    // `?source=`가 노드 위치와 같으면 선택 표시
    const selected = build(
      { criterion: "R-05", pane: "graph", source: "src/http/routes.ts:25-28" },
      okInput(),
    );
    expect(selected.view.graph.nodes.find((n) => n.name === "POST /orders")!.selected).toBe(true);
    expect(selected.html).toContain('data-node-selected="true"');
  });

  it("좌표는 dagre 레이아웃에서 오고 간선의 양 끝은 노드다", () => {
    const sub = fixtureCase(R05_CASE_ID);
    const { positions, edges, width, height } = layoutSubgraph(sub);
    expect(positions.size).toBe(sub.nodes.length);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    for (const p of positions.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(width);
      expect(p.y).toBeLessThanOrEqual(height);
    }
    expect(edges.length).toBe(sub.edges.length);
    for (const e of edges) {
      expect(positions.has(e.from)).toBe(true);
      expect(positions.has(e.to)).toBe(true);
      expect(e.path).toMatch(/^M/);
    }
    // LR 레이아웃: 호출하는 쪽이 호출받는 쪽보다 왼쪽이다
    for (const e of edges) {
      expect(positions.get(e.from)!.x).toBeLessThan(positions.get(e.to)!.x);
    }
  });

  it("분석 불가면 `분석 불가 · 사유`를 보여 주고 그래프는 없다", () => {
    const reason = "문법 오류: src/domain/broken-draft.ts:1 '{' expected.";
    const { view, html } = build(
      { criterion: "R-05", pane: "graph" },
      {
        ok: true,
        data: functionGraphReportFixture(unavailableAnalysisFixture(reason)),
      },
    );
    expect(view.graph.status).toBe("unavailable");
    expect(view.graph.reason).toBe(reason);
    expect(html).toContain('data-testid="graph-unavailable"');
    expect(html).toContain("분석 불가");
    expect(html).toContain("broken-draft.ts:1");
    expect(html).not.toContain('data-testid="graph-svg"');
  });

  it("아티팩트가 없거나 읽기 오류면 사유를, 기록이 하네스 케이스가 아니면 안내를 보여 준다", () => {
    const missing = build(
      { criterion: "R-05", pane: "graph" },
      {
        ok: false,
        code: "ARTIFACT_NOT_FOUND",
        message: "분석 결과가 없습니다",
      },
    );
    expect(missing.view.graph.status).toBe("missing");
    expect(missing.html).toContain('data-testid="graph-missing"');
    expect(missing.html).toContain("ARTIFACT_NOT_FOUND: 분석 결과가 없습니다");

    // 기준을 고르지 않아 기록이 없다
    const noRun = build({ pane: "graph" }, okInput());
    expect(noRun.view.graph.status).toBe("no-run");
    expect(noRun.html).toContain('data-testid="graph-no-run"');

    // 근거의 testId가 분석 결과에 없는 케이스
    const noCase = build({ criterion: "R-05", pane: "graph" }, okInput(), {
      evidenceTestId: "R-99-unknown",
    });
    expect(noCase.view.graph.status).toBe("no-case");
    expect(noCase.html).toContain('data-testid="graph-no-case"');
    expect(noCase.html).toContain("R-99-unknown");

    // 코드 탭이면 그래프를 읽지 않았다는 안내만 (페이지가 읽지 않는다)
    const codePane = build({ criterion: "R-05" }, null);
    expect(codePane.view.graph.status).toBe("missing");
    expect(codePane.html).not.toContain('data-testid="graph-panel"');
  });

  it("다른 케이스(R-10)를 고르면 그 케이스의 루트와 관측 노드가 바뀐다", () => {
    const { view } = build({ criterion: "R-05", pane: "graph" }, okInput(), {
      evidenceTestId: R10_CASE_ID,
    });
    expect(view.graph.caseId).toBe(R10_CASE_ID);
    // 준비 요청으로 먼저 등장한 reset 라우트가 본 요청으로 다시 오면 루트가 된다 (등장 순)
    expect(view.graph.roots).toEqual(["POST /admin/reset", "GET /health"]);
    expect(
      view.graph.nodes
        .filter((n) => n.observed)
        .map((n) => n.name)
        .sort(),
    ).toEqual(["GET /health", "POST /admin/reset"]);
    expect(view.graph.truncated).toBe(false);
  });

  it("그래프 모듈은 관측 여부를 추정하거나 요청을 보내지 않는다 (소스 대조)", async () => {
    const dir = path.resolve(import.meta.dirname, "../../../lib/workbench");
    const sources = await Promise.all([
      readFile(path.join(dir, "graph.ts"), "utf8"),
      readFile(path.join(import.meta.dirname, "graph-panel.tsx"), "utf8"),
    ]);
    for (const source of sources) {
      expect(source).not.toMatch(/fetch\(/);
      expect(source).not.toMatch(/observed\s*[:=]\s*true/);
      expect(source).not.toContain("실행 경로");
    }
  });
});
