/**
 * 관련 함수 그래프 분석 진입점 (TICKET.md T-304). 스냅샷 파일 + 케이스별 timeline 요청 → `FunctionGraphAnalysis`.
 *
 * 실패는 던지지 않고 `status: "unavailable"`로 돌려준다: 파일 한도 초과, 문법 오류(파싱 진단이 하나라도 있으면 분석하지 않는다.
 * 호출 해석이 틀린 그래프를 보여 주느니 "분석 불가"가 낫다), 라우트 등록을 하나도 못 찾음, 그 밖의 예외.
 * 결과는 스냅샷과 요청 목록에만 의존하므로 같은 입력이면 같다 (재시도에서 같은 키에 다시 써도 내용이 같다).
 */
import {
  FUNCTION_GRAPH_ANALYZER_VERSION,
  FunctionGraphAnalysisSchema,
  type FunctionGraphAnalysis,
  type FunctionGraphRouteEntry,
  type SourceLocation,
} from "@ohmyti/core";
import { buildCallGraph, type CallGraph } from "./call-graph";
import {
  ProjectLimitError,
  withSnapshotProject,
  type AnalysisFiles,
  type LoadProjectOptions,
} from "./project";
import { buildCaseSubgraph, type CaseInput } from "./subgraph";

export interface AnalyzeFunctionGraphInput {
  files: AnalysisFiles;
  cases: CaseInput[];
  /** 템플릿 `node_modules` 절대 경로 (외부 타입 참조용). 없어도 프로젝트 내부 호출은 해석된다 */
  nodeModulesDir?: string | undefined;
  limits?: LoadProjectOptions["limits"];
  /** 케이스 서브그래프 노드 상한 (기본 12) */
  maxSubgraphNodes?: number | undefined;
}

export interface AnalyzeFunctionGraphResult {
  analysis: FunctionGraphAnalysis;
  /** 라우트 핸들러 코드 원문 (노드 id → 텍스트). 정적 관계 근거의 스니펫용. unavailable이면 비어 있다 */
  handlerSnippets: Map<string, string>;
}

/** 스니펫 상한 (라인·문자). 넘으면 잘라 표시한다 */
export const SNIPPET_MAX_LINES = 60;
export const SNIPPET_MAX_CHARS = 4000;

export class SyntaxErrorsFound extends Error {
  override readonly name = "SyntaxErrorsFound";
  constructor(readonly locations: Array<SourceLocation & { message: string }>) {
    super(
      `문법 오류: ${locations
        .slice(0, 3)
        .map((l) => `${l.path}:${l.startLine} ${l.message}`)
        .join(" · ")}${locations.length > 3 ? ` (외 ${locations.length - 3}건)` : ""}`,
    );
  }
}

function unavailable(reason: string): FunctionGraphAnalysis {
  return { status: "unavailable", analyzerVersion: FUNCTION_GRAPH_ANALYZER_VERSION, reason };
}

function diagnosticText(message: string | { getMessageText(): string }): string {
  return typeof message === "string" ? message : message.getMessageText();
}

/**
 * `location` 범위의 파일 줄 전체. 노드 텍스트(`node.getText()`)는 첫 줄 중간부터 시작하므로(`router.post("/orders", async (req, res) => {`의
 * 화살표 함수만) 코드 근거 뷰어(T-305)가 라인 번호와 함께 보여 줄 때 스냅샷 파일의 해당 줄과 같아지도록 줄 단위로 자른다.
 */
export function sourceLines(fullText: string, location: SourceLocation): string {
  return fullText
    .split(/\r?\n/)
    .slice(location.startLine - 1, location.endLine)
    .join("\n");
}

export function clipSnippet(text: string): string {
  const lines = text.split("\n");
  let clipped =
    lines.length > SNIPPET_MAX_LINES ? lines.slice(0, SNIPPET_MAX_LINES).join("\n") + "\n…" : text;
  if (clipped.length > SNIPPET_MAX_CHARS) clipped = `${clipped.slice(0, SNIPPET_MAX_CHARS)}…`;
  return clipped;
}

function routeEntriesOf(graph: CallGraph): FunctionGraphRouteEntry[] {
  const byId = new Map(graph.functions.map((fn) => [fn.id, fn]));
  return graph.routes.flatMap((route) => {
    const handler = byId.get(route.handlerId);
    if (!handler) return [];
    return [
      {
        method: route.method,
        path: route.path,
        handler: { id: handler.id, name: handler.name, location: handler.location },
      },
    ];
  });
}

export async function analyzeFunctionGraph(
  input: AnalyzeFunctionGraphInput,
): Promise<AnalyzeFunctionGraphResult> {
  const empty = new Map<string, string>();
  try {
    return await withSnapshotProject(
      input.files,
      { nodeModulesDir: input.nodeModulesDir, limits: input.limits },
      (loaded) => {
        if (loaded.sourcePaths.length === 0) {
          return {
            analysis: unavailable("분석할 TypeScript·JavaScript 소스 파일이 없음"),
            handlerSnippets: empty,
          };
        }
        const syntaxErrors = loaded.project
          .getProgram()
          .getSyntacticDiagnostics()
          .map((d) => {
            const file = d.getSourceFile();
            const relative = file
              ? file.getFilePath().startsWith(loaded.rootDir)
                ? file.getFilePath().slice(loaded.rootDir.length + 1)
                : file.getFilePath()
              : "(파일 없음)";
            const line = d.getLineNumber();
            return {
              path: relative,
              startLine: line,
              endLine: line,
              message: diagnosticText(d.getMessageText()),
            };
          });
        if (syntaxErrors.length > 0) throw new SyntaxErrorsFound(syntaxErrors);

        const graph = buildCallGraph(loaded);
        if (graph.routes.length === 0) {
          return {
            analysis: unavailable(
              `라우트 등록을 찾지 못함 (express \`app.post("/path", handler)\` 또는 hono 패턴만 인식, 파일 ${graph.fileCount}개 분석)`,
            ),
            handlerSnippets: empty,
          };
        }
        const cases = input.cases.map((c) => buildCaseSubgraph(graph, c, input.maxSubgraphNodes));
        const handlerSnippets = new Map<string, string>();
        for (const route of graph.routes) {
          if (handlerSnippets.has(route.handlerId)) continue;
          const fn = graph.functions.find((f) => f.id === route.handlerId);
          if (fn) {
            handlerSnippets.set(
              fn.id,
              clipSnippet(sourceLines(fn.node.getSourceFile().getFullText(), fn.location)),
            );
          }
        }
        const analysis = FunctionGraphAnalysisSchema.parse({
          status: "ok",
          analyzerVersion: FUNCTION_GRAPH_ANALYZER_VERSION,
          fileCount: graph.fileCount,
          functionCount: graph.functions.length,
          routes: routeEntriesOf(graph),
          cases,
        } satisfies FunctionGraphAnalysis);
        return { analysis, handlerSnippets };
      },
    );
  } catch (error) {
    if (error instanceof SyntaxErrorsFound || error instanceof ProjectLimitError) {
      return { analysis: unavailable(error.message), handlerSnippets: empty };
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { analysis: unavailable(`분석 중 오류: ${message}`), handlerSnippets: empty };
  }
}
