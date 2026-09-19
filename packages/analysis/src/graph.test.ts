import {
  CaseFunctionGraphSchema,
  FunctionGraphAnalysisSchema,
  MAX_SUBGRAPH_NODES,
  type FunctionGraphAnalysis,
} from "@ohmyti/core";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { analyzeFunctionGraph } from "./function-graph";
import {
  analyzeFunctionGraphIsolated,
  CHILD_BUNDLE_NAME,
  CHILD_SOURCE_NAME,
  childEntry,
} from "./isolated";
import { withSnapshotProject, type AnalysisFiles } from "./project";
import { joinRoutePath, matchRoutePath, methodMatches, normalizeRequestPath } from "./routes";
import type { CaseInput } from "./subgraph";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const TEMPLATE_NODE_MODULES = path.join(REPO_ROOT, "templates/order-api-ts/node_modules");

/** 디렉터리를 메모리 파일 맵으로 (node_modules·링크 제외) */
async function readTree(dir: string, base = dir): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      for (const [k, v] of await readTree(full, base)) out.set(k, v);
    } else {
      out.set(path.relative(base, full).split(path.sep).join("/"), await readFile(full, "utf8"));
    }
  }
  return out;
}

function memoryFiles(map: Map<string, string>): AnalysisFiles {
  return {
    listFiles: () => Promise.resolve([...map.keys()].sort()),
    readText: (p) => Promise.resolve(map.get(p) ?? null),
  };
}

async function sampleFiles(impl: string): Promise<Map<string, string>> {
  return readTree(path.join(SAMPLES_DIR, impl));
}

/** 하네스 R-05 케이스의 timeline 요청 순서 (T-303 완료 기록) */
const R05_REQUESTS: CaseInput = {
  caseId: "R-05-idempotent-resend",
  requests: [
    { method: "POST", path: "/admin/reset", isSetup: true },
    { method: "GET", path: "/products/p1" },
    { method: "POST", path: "/orders" },
    { method: "GET", path: "/products/p1" },
    { method: "POST", path: "/orders" },
    { method: "GET", path: "/products/p1" },
    { method: "GET", path: "/orders/8f1c2d3e-0000-4000-8000-000000000001" },
  ],
};

/** 취소 케이스: 취소 라우트만 본 요청이고 나머지는 준비 요청이 아니지만 등장한다 */
const R09_REQUESTS: CaseInput = {
  caseId: "R-09-cancel",
  requests: [
    { method: "POST", path: "/admin/reset", isSetup: true },
    { method: "POST", path: "/orders" },
    { method: "POST", path: "/orders/o1/cancel" },
    { method: "GET", path: "/products/p1?verbose=1" },
    { method: "POST", path: "/orders/o1/cancel" },
  ],
};

function okAnalysis(analysis: FunctionGraphAnalysis) {
  if (analysis.status !== "ok") throw new Error(`분석 불가: ${analysis.reason}`);
  return analysis;
}

/** 파일의 실제 라인 범위 텍스트 */
function linesOf(map: Map<string, string>, file: string, start: number, end: number): string {
  return map
    .get(file)!
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
}

describe("라우트 경로 매칭", () => {
  it("`:param`·`*`·선택 세그먼트·쿼리 문자열을 다룬다", () => {
    expect(normalizeRequestPath("/orders/abc?x=1#y")).toBe("/orders/abc");
    expect(normalizeRequestPath("orders//abc/")).toBe("/orders/abc");
    expect(normalizeRequestPath("")).toBe("/");
    expect(matchRoutePath("/orders/:id", "/orders/abc-1?x=1")).toBe(true);
    expect(matchRoutePath("/orders/:id", "/orders")).toBe(false);
    expect(matchRoutePath("/orders/:id", "/orders/abc/cancel")).toBe(false);
    expect(matchRoutePath("/orders/:id/cancel", "/orders/abc/cancel")).toBe(true);
    expect(matchRoutePath("/orders", "/orders/")).toBe(true);
    expect(matchRoutePath("/products/:id{[a-z0-9]+}", "/products/p1")).toBe(true);
    expect(matchRoutePath("/files/*", "/files/a/b/c")).toBe(true);
    expect(matchRoutePath("/files/:name?", "/files")).toBe(true);
    expect(matchRoutePath("/files/:name?", "/files/x")).toBe(true);
    expect(matchRoutePath("/", "/")).toBe(true);
    expect(matchRoutePath("/", "/health")).toBe(false);
    expect(methodMatches("ALL", "delete")).toBe(true);
    expect(methodMatches("GET", "HEAD")).toBe(true);
    expect(methodMatches("POST", "GET")).toBe(false);
    expect(joinRoutePath("/api", "/")).toBe("/api");
    expect(joinRoutePath("", "/x")).toBe("/x");
    expect(joinRoutePath("/api/", "/v1/x/")).toBe("/api/v1/x");
  });
});

describe("analyzeFunctionGraph: 샘플 A·B·C", () => {
  it.each(["impl-a", "impl-b", "impl-c"])(
    "%s: `POST /orders` 핸들러를 찾고 파일·라인이 실제 코드와 일치한다",
    async (impl) => {
      const map = await sampleFiles(impl);
      const { analysis, handlerSnippets } = await analyzeFunctionGraph({
        files: memoryFiles(map),
        cases: [R05_REQUESTS],
        nodeModulesDir: TEMPLATE_NODE_MODULES,
      });
      const ok = okAnalysis(FunctionGraphAnalysisSchema.parse(analysis));
      const route = ok.routes.find((r) => r.method === "POST" && r.path === "/orders");
      expect(route, `${impl}: POST /orders 라우트`).toBeDefined();
      const { location } = route!.handler;
      const text = linesOf(map, location.path, location.startLine, location.endLine);
      // 실제 코드: 핸들러 등록 줄에 경로 문자열이 있고 본문은 함수다
      expect(map.get(location.path)!.split("\n")[location.startLine - 1]).toContain('"/orders"');
      expect(text).toMatch(/=>/);
      expect(handlerSnippets.get(route!.handler.id)!.length).toBeGreaterThan(10);
      // 스니펫은 위치 범위의 파일 줄 전체와 같다 (T-305 코드 근거 뷰어가 라인 번호와 함께 그대로 보여 준다)
      expect(handlerSnippets.get(route!.handler.id)).toBe(text);
      // 여섯 엔드포인트 모두 등록을 찾는다
      expect(ok.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
        [
          "GET /health",
          "POST /admin/reset",
          "GET /products/:id",
          "POST /orders",
          "GET /orders/:id",
          "POST /orders/:id/cancel",
        ].sort(),
      );
    },
  );

  it("A: 핸들러 위치가 routes.ts의 실제 줄이고 핸들러 → 서비스 → 검증 함수로 간선이 이어진다", async () => {
    const map = await sampleFiles("impl-a");
    const { analysis } = await analyzeFunctionGraph({
      files: memoryFiles(map),
      cases: [R05_REQUESTS],
    });
    const ok = okAnalysis(analysis);
    const post = ok.routes.find((r) => r.method === "POST" && r.path === "/orders")!;
    expect(post.handler.location).toEqual({
      path: "src/http/routes.ts",
      startLine: 25,
      endLine: 28,
    });
    const sub = ok.cases[0]!;
    const byName = new Map(sub.nodes.map((n) => [n.name, n]));
    expect(byName.get("POST /orders")?.depth).toBe(0);
    expect(byName.get("OrderService.createOrder")?.depth).toBe(1);
    expect(byName.get("validateIdempotencyKey")?.depth).toBe(2);
    const has = (from: string, to: string) =>
      sub.edges.some((e) => e.from === byName.get(from)!.id && e.to === byName.get(to)!.id);
    expect(has("POST /orders", "OrderService.createOrder")).toBe(true);
    expect(has("OrderService.createOrder", "validateIdempotencyKey")).toBe(true);
  });

  it("B(hono): 타입 리터럴 멤버 호출(`commands.place`)이 구현 함수로 풀린다", async () => {
    const map = await sampleFiles("impl-b");
    const { analysis } = await analyzeFunctionGraph({
      files: memoryFiles(map),
      cases: [R05_REQUESTS],
    });
    const ok = okAnalysis(analysis);
    const post = ok.routes.find((r) => r.method === "POST" && r.path === "/orders")!;
    expect(post.handler.location.path).toBe("src/api.ts");
    const sub = ok.cases[0]!;
    const names = sub.nodes.map((n) => n.name);
    expect(names).toContain("place");
    const place = sub.nodes.find((n) => n.name === "place")!;
    expect(place.location.path).toBe("src/core/commands.ts");
    expect(place.depth).toBe(1);
  });

  it("서브그래프 노드는 12개를 넘지 않고 넘친 수를 기록한다", async () => {
    for (const impl of ["impl-a", "impl-b"]) {
      const { analysis } = await analyzeFunctionGraph({
        files: memoryFiles(await sampleFiles(impl)),
        cases: [R05_REQUESTS, R09_REQUESTS],
      });
      const ok = okAnalysis(analysis);
      for (const sub of ok.cases) {
        expect(CaseFunctionGraphSchema.safeParse(sub).success).toBe(true);
        expect(sub.nodes.length).toBeLessThanOrEqual(MAX_SUBGRAPH_NODES);
        expect(sub.nodes.length).toBe(
          Math.min(MAX_SUBGRAPH_NODES, sub.nodes.length + sub.omittedCount),
        );
        expect(sub.truncated).toBe(sub.omittedCount > 0);
        // 깊이는 루트 0부터 단조롭게 커진다 (BFS 순)
        const depths = sub.nodes.map((n) => n.depth);
        expect(depths).toEqual([...depths].sort((a, b) => a - b));
        expect(depths[0]).toBe(0);
      }
    }
  });

  it("`관측됨` 노드는 timeline에 등장한 라우트의 핸들러와 정확히 일치한다", async () => {
    const map = await sampleFiles("impl-a");
    const { analysis } = await analyzeFunctionGraph({
      files: memoryFiles(map),
      cases: [R05_REQUESTS, R09_REQUESTS],
    });
    const ok = okAnalysis(analysis);
    const r05 = ok.cases[0]!;
    const observed = r05.nodes
      .filter((n) => n.observed)
      .map((n) => `${n.route!.method} ${n.route!.path}`);
    expect(observed.sort()).toEqual(["GET /orders/:id", "GET /products/:id", "POST /orders"]);
    // 핸들러가 아닌 노드는 모두 정적이다 (실행 여부를 관측하지 않았다)
    for (const node of r05.nodes) {
      if (node.route === null) expect(node.observed).toBe(false);
    }
    // 준비 요청(reset)의 핸들러는 루트가 아니다
    expect(r05.roots).toEqual([
      { method: "GET", path: "/products/:id" },
      { method: "POST", path: "/orders" },
      { method: "GET", path: "/orders/:id" },
    ]);
    expect(r05.unmatchedRequests).toEqual([]);

    // R-09: 쿼리 문자열이 붙은 요청도 매치되고, 취소 라우트가 관측된다
    const r09 = ok.cases[1]!;
    expect(r09.roots.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /orders",
      "POST /orders/:id/cancel",
      "GET /products/:id",
    ]);
    const cancel = r09.nodes.find((n) => n.name === "POST /orders/:id/cancel")!;
    expect(cancel.observed).toBe(true);
    // R-09에 등장하지 않은 GET /orders/:id 핸들러가 서브그래프에 있어도 관측 표시는 없다
    for (const node of r09.nodes) {
      if (node.route && node.route.path === "/orders/:id" && node.route.method === "GET") {
        expect(node.observed).toBe(false);
      }
    }
  });

  it("등록되지 않은 경로의 요청은 unmatchedRequests에 남고 루트가 되지 않는다", async () => {
    const { analysis } = await analyzeFunctionGraph({
      files: memoryFiles(await sampleFiles("impl-a")),
      cases: [
        {
          caseId: "unknown",
          requests: [
            { method: "GET", path: "/nope" },
            { method: "GET", path: "/nope?x=1" },
            { method: "DELETE", path: "/orders/1" },
          ],
        },
      ],
    });
    const sub = okAnalysis(analysis).cases[0]!;
    expect(sub.roots).toEqual([]);
    expect(sub.nodes).toEqual([]);
    expect(sub.unmatchedRequests).toEqual([
      { method: "GET", path: "/nope" },
      { method: "DELETE", path: "/orders/1" },
    ]);
  });

  it("같은 입력이면 결과가 같다 (결정성)", async () => {
    const map = await sampleFiles("impl-b");
    const run = () =>
      analyzeFunctionGraph({ files: memoryFiles(map), cases: [R05_REQUESTS, R09_REQUESTS] });
    const [a, b] = await Promise.all([run(), run()]);
    expect(JSON.stringify(a.analysis)).toBe(JSON.stringify(b.analysis));
  });
});

describe("analyzeFunctionGraph: 분석 불가", () => {
  it("문법 오류가 있으면 `unavailable`이며 사유에 파일·라인이 있다", async () => {
    const map = await sampleFiles("impl-a");
    map.set("src/broken.ts", "export function broken( {\n  return 1\n");
    const { analysis, handlerSnippets } = await analyzeFunctionGraph({
      files: memoryFiles(map),
      cases: [R05_REQUESTS],
    });
    expect(analysis.status).toBe("unavailable");
    if (analysis.status !== "unavailable") throw new Error("unreachable");
    expect(analysis.reason).toMatch(/^문법 오류: src\/broken\.ts:\d+ /);
    expect(handlerSnippets.size).toBe(0);
    expect(FunctionGraphAnalysisSchema.safeParse(analysis).success).toBe(true);
  });

  it("라우트 등록이 없으면 `unavailable`", async () => {
    const map = new Map([["src/index.ts", "export const x = () => 1;\n"]]);
    const { analysis } = await analyzeFunctionGraph({ files: memoryFiles(map), cases: [] });
    expect(analysis.status).toBe("unavailable");
    if (analysis.status === "unavailable")
      expect(analysis.reason).toContain("라우트 등록을 찾지 못함");
  });

  it("소스 파일이 없거나 한도를 넘으면 `unavailable`", async () => {
    const none = await analyzeFunctionGraph({
      files: memoryFiles(new Map([["README.md", "# hi"]])),
      cases: [],
    });
    expect(none.analysis.status).toBe("unavailable");
    const many = new Map<string, string>();
    for (let i = 0; i < 5; i += 1) many.set(`src/f${i}.ts`, "export const a = 1;\n");
    const limited = await analyzeFunctionGraph({
      files: memoryFiles(many),
      cases: [],
      limits: { maxFiles: 3 },
    });
    expect(limited.analysis.status).toBe("unavailable");
    if (limited.analysis.status === "unavailable") {
      expect(limited.analysis.reason).toContain("상한 3개");
    }
  });

  it("스냅샷 경로가 임시 디렉터리를 벗어나면 거절한다 (분석 불가 결과)", async () => {
    const { analysis } = await analyzeFunctionGraph({
      files: memoryFiles(new Map([["../escape.ts", "export const x = 1;\n"]])),
      cases: [],
    });
    expect(analysis.status).toBe("unavailable");
    if (analysis.status === "unavailable")
      expect(analysis.reason).toContain("InvalidSnapshotPathError");
  });
});

describe("withSnapshotProject", () => {
  it("임시 디렉터리를 만들고 끝나면 지운다. node_modules 링크가 없어도 진행한다", async () => {
    const map = new Map([["src/a.ts", "export const a = () => 1;\n"]]);
    let root = "";
    const result = await withSnapshotProject(
      memoryFiles(map),
      { nodeModulesDir: "/nonexistent/node_modules" },
      (loaded) => {
        root = loaded.rootDir;
        expect(loaded.nodeModulesLinked).toBe(false);
        expect(loaded.sourcePaths).toEqual(["src/a.ts"]);
        return loaded.project.getSourceFiles().length;
      },
    );
    expect(result).toBe(1);
    await expect(readdir(root)).rejects.toThrow();
  });
});

describe("analyzeFunctionGraphIsolated (자식 프로세스)", () => {
  it("같은 입력이면 프로세스 안 분석과 같은 결과를 내고, 부모의 이벤트 루프를 오래 막지 않는다", async () => {
    const map = await sampleFiles("impl-a");
    const input = {
      files: memoryFiles(map),
      cases: [R05_REQUESTS, R09_REQUESTS],
      nodeModulesDir: TEMPLATE_NODE_MODULES,
    };
    const inProcess = await analyzeFunctionGraph(input);
    const monitor = monitorEventLoopDelay({ resolution: 5 });
    monitor.enable();
    const isolated = await analyzeFunctionGraphIsolated(input);
    monitor.disable();
    expect(JSON.stringify(isolated.analysis)).toBe(JSON.stringify(inProcess.analysis));
    expect([...isolated.handlerSnippets.entries()]).toEqual([
      ...inProcess.handlerSnippets.entries(),
    ]);
    // 프로세스 안 분석은 수백 ms를 동기로 점유하지만, 자식 프로세스 경로는 부모 루프를 100ms 넘게 막지 않는다
    expect(monitor.max / 1e6).toBeLessThan(100);
  }, 60_000);

  it("제한 시간을 넘기면 자식을 죽이고 `unavailable`(시간 초과)이다", async () => {
    const map = await sampleFiles("impl-b");
    const { analysis } = await analyzeFunctionGraphIsolated(
      { files: memoryFiles(map), cases: [R05_REQUESTS] },
      { timeoutMs: 1 },
    );
    expect(analysis.status).toBe("unavailable");
    if (analysis.status === "unavailable") expect(analysis.reason).toContain("시간 초과");
  }, 30_000);

  it("자식 진입 파일은 소스 실행이면 child.ts(+tsx), 번들이면 analysis-child.js다", () => {
    const entry = childEntry();
    expect(entry.modulePath.endsWith(`/${CHILD_SOURCE_NAME}`)).toBe(true);
    expect(entry.execArgv).toEqual(["--import", "tsx"]);
    expect(CHILD_BUNDLE_NAME).toBe("analysis-child.js");
  });
});
