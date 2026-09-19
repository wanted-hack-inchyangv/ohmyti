/**
 * 관련 함수 그래프 분석 결과 (TICKET.md T-304). 워커가 `@ohmyti/analysis`로 만들어 `evaluations/<id>/analysis/function-graph.json`에
 * 저장하고, 워크벤치 중앙 하단 탭(web)이 읽어 그린다. web은 analysis 패키지에 의존할 수 없으므로(G-05) 형태만 여기에 둔다.
 *
 * - 노드와 간선은 TypeScript AST에서 얻은 **정적** 관계다. `observed`는 하네스 timeline에 등장한 요청이 그 노드의 라우트에
 *   매치됐다는 뜻이며 핸들러 노드에만 붙을 수 있다. 핸들러가 부른 함수가 실제로 실행됐는지는 관측하지 않았으므로 표시하지 않는다
 *   (PRD 6장: AST만 보고 실행 경로라고 부르지 않는다).
 * - 케이스별 서브그래프는 `MAX_SUBGRAPH_NODES`(12)개를 넘지 않는다. 넘치면 `truncated`와 `omittedCount`에 남긴다.
 * - 분석 실패(문법 오류·파일 한도·예외)는 단계 실패가 아니라 `status: "unavailable"` 결과다.
 */
import { z } from "zod";
import { SourceLocationSchema } from "./common";

export const FUNCTION_GRAPH_ANALYZER_VERSION = "1";
/** 케이스 서브그래프의 노드 상한 (PRD 6장 ③: 최대 12개) */
export const MAX_SUBGRAPH_NODES = 12;

export const FunctionGraphRouteMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
  /** express `app.all`·hono `app.all`: 모든 method */
  "ALL",
]);
export type FunctionGraphRouteMethod = z.infer<typeof FunctionGraphRouteMethodSchema>;

/** 코드에 등록된 라우트 (`app.post("/orders", h)`). `path`는 등록 문자열 그대로(`/orders/:id`) */
export const FunctionGraphRouteSchema = z.strictObject({
  method: FunctionGraphRouteMethodSchema,
  path: z.string().min(1),
});
export type FunctionGraphRoute = z.infer<typeof FunctionGraphRouteSchema>;

export const FunctionGraphNodeKindSchema = z.enum(["handler", "function", "method"]);
export type FunctionGraphNodeKind = z.infer<typeof FunctionGraphNodeKindSchema>;

export const FunctionGraphNodeSchema = z.strictObject({
  /** `<path>:<startLine>-<endLine>` */
  id: z.string().min(1),
  name: z.string().min(1),
  kind: FunctionGraphNodeKindSchema,
  location: SourceLocationSchema,
  /** 라우트 핸들러면 등록된 method·path. 아니면 null */
  route: FunctionGraphRouteSchema.nullable(),
  /** timeline에 등장한 요청이 이 핸들러의 라우트에 매치됐다. 핸들러가 아닌 노드는 항상 false */
  observed: z.boolean(),
  /** 루트(핸들러)로부터의 BFS 깊이. 루트는 0 */
  depth: z.int().min(0),
});
export type FunctionGraphNode = z.infer<typeof FunctionGraphNodeSchema>;

/** 정적 호출 간선. `from`이 `to`를 호출하는 식이 본문에 있다 */
export const FunctionGraphEdgeSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type FunctionGraphEdge = z.infer<typeof FunctionGraphEdgeSchema>;

/** timeline의 요청 (method·path). 경로는 쿼리 문자열을 뺀 실제 요청 경로다 */
export const FunctionGraphRequestSchema = z.strictObject({
  method: z.string().min(1),
  path: z.string().min(1),
});
export type FunctionGraphRequest = z.infer<typeof FunctionGraphRequestSchema>;

export const CaseFunctionGraphSchema = z
  .strictObject({
    caseId: z.string().min(1),
    /** 관측 요청이 매치된 라우트 (timeline 등장 순, 중복 제거). 이 라우트의 핸들러가 서브그래프의 루트다 */
    roots: z.array(FunctionGraphRouteSchema),
    /** 어떤 라우트에도 매치되지 않은 요청 (등장 순, 중복 제거) */
    unmatchedRequests: z.array(FunctionGraphRequestSchema),
    nodes: z.array(FunctionGraphNodeSchema).max(MAX_SUBGRAPH_NODES),
    edges: z.array(FunctionGraphEdgeSchema),
    truncated: z.boolean(),
    omittedCount: z.int().min(0),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.nodes.map((n) => n.id));
    if (ids.size !== value.nodes.length) {
      ctx.addIssue({ code: "custom", path: ["nodes"], message: "노드 id가 중복됩니다" });
    }
    for (const [index, edge] of value.edges.entries()) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "간선의 양 끝은 서브그래프의 노드여야 합니다",
        });
      }
    }
    for (const [index, node] of value.nodes.entries()) {
      if (node.observed && node.route === null) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "observed"],
          message: "observed는 라우트 핸들러 노드에만 붙을 수 있습니다",
        });
      }
    }
  });
export type CaseFunctionGraph = z.infer<typeof CaseFunctionGraphSchema>;

export const FunctionGraphRouteEntrySchema = z.strictObject({
  method: FunctionGraphRouteMethodSchema,
  path: z.string().min(1),
  handler: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    location: SourceLocationSchema,
  }),
});
export type FunctionGraphRouteEntry = z.infer<typeof FunctionGraphRouteEntrySchema>;

export const FunctionGraphAnalysisSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    analyzerVersion: z.string().min(1),
    /** 분석한 소스 파일 수 (테스트·설정 파일 포함, node_modules 제외) */
    fileCount: z.int().min(0),
    functionCount: z.int().min(0),
    /** 코드에서 찾은 라우트 등록 (파일·라인 순) */
    routes: z.array(FunctionGraphRouteEntrySchema),
    /** 하네스 케이스별 서브그래프 (케이스 순) */
    cases: z.array(CaseFunctionGraphSchema),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    analyzerVersion: z.string().min(1),
    /** 사람이 읽을 사유 (`문법 오류: src/x.ts:3 ...`) */
    reason: z.string().min(1),
  }),
]);
export type FunctionGraphAnalysis = z.infer<typeof FunctionGraphAnalysisSchema>;

/** 노드 id 규약 */
export function functionGraphNodeId(location: {
  path: string;
  startLine: number;
  endLine: number;
}): string {
  return `${location.path}:${location.startLine}-${location.endLine}`;
}
