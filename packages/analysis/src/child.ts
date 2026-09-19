/**
 * 관련 함수 그래프 분석 자식 프로세스 진입점 (TICKET.md T-304). `analyzeFunctionGraphIsolated`가 `child_process.fork`로 띄운다.
 * ts-morph 분석은 수백 ms~수 초를 동기로 점유하므로 워커 프로세스(heartbeat·`/healthz`)를 막지 않도록 별도 프로세스에서 돌린다.
 *
 * 프로토콜(IPC, advanced 직렬화): 부모 → `{ type: "analyze", input: IsolatedAnalysisInput }` 한 번, 자식 → `{ type: "result", result }`
 * 한 번 뒤 종료. 예외는 `{ type: "error", message }`. 입력의 `designSignals`가 true면 같은 프로세스에서 설계 신호(T-605)도 추출해
 * 결과에 넣는다(자식 프로세스를 하나 더 띄우지 않는다).
 *
 * 워커 번들(esbuild)은 이 파일을 `dist/analysis-child.js`로 따로 묶는다 (`apps/worker/scripts/build.mjs`).
 */
import {
  DESIGN_SIGNALS_ANALYZER_VERSION,
  type DesignSignals,
  type FunctionGraphAnalysis,
} from "@ohmyti/core";
import { extractDesignSignals } from "./design-signals";
import { analyzeFunctionGraph } from "./function-graph";
import type { AnalysisFiles, ProjectLimits } from "./project";
import type { CaseInput } from "./subgraph";

export interface IsolatedAnalysisInput {
  /** `[상대 경로, 본문]`. 부모가 미리 읽는다 */
  files: Array<[string, string]>;
  cases: CaseInput[];
  nodeModulesDir?: string | undefined;
  limits?: Partial<ProjectLimits> | undefined;
  maxSubgraphNodes?: number | undefined;
  /** 설계 신호(T-605)도 추출한다. `files`에 루트 `tsconfig.json`이 있으면 strict 값을 읽는다 */
  designSignals?: boolean | undefined;
}

export interface IsolatedAnalysisResult {
  analysis: FunctionGraphAnalysis;
  handlerSnippets: Array<[string, string]>;
  /** 입력의 `designSignals`가 true일 때만 있다 */
  designSignals?: DesignSignals | undefined;
}

export type ChildRequest = { type: "analyze"; input: IsolatedAnalysisInput };
export type ChildResponse =
  { type: "result"; result: IsolatedAnalysisResult } | { type: "error"; message: string };

export function filesFromEntries(entries: ReadonlyArray<[string, string]>): AnalysisFiles {
  const map = new Map(entries);
  return {
    listFiles: () => Promise.resolve([...map.keys()].sort()),
    readText: (relativePath) => Promise.resolve(map.get(relativePath) ?? null),
  };
}

export async function runIsolatedAnalysis(
  input: IsolatedAnalysisInput,
): Promise<IsolatedAnalysisResult> {
  const { analysis, handlerSnippets } = await analyzeFunctionGraph({
    files: filesFromEntries(input.files),
    cases: input.cases,
    nodeModulesDir: input.nodeModulesDir,
    limits: input.limits,
    maxSubgraphNodes: input.maxSubgraphNodes,
  });
  if (!input.designSignals) return { analysis, handlerSnippets: [...handlerSnippets.entries()] };
  let designSignals: DesignSignals;
  try {
    designSignals = await extractDesignSignals({
      files: filesFromEntries(input.files),
      limits: input.limits,
    });
  } catch (error) {
    // 신호 추출 실패가 관련 함수 그래프 결과를 버리게 하지 않는다
    designSignals = {
      status: "unavailable",
      analyzerVersion: DESIGN_SIGNALS_ANALYZER_VERSION,
      reason: `신호 추출 중 오류: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { analysis, handlerSnippets: [...handlerSnippets.entries()], designSignals };
}

// fork로 띄워졌을 때만 IPC를 기다린다 (import만 해서는 아무것도 하지 않는다)
if (process.send && process.env.OHMYTI_ANALYSIS_CHILD === "1") {
  process.once("message", (message: ChildRequest) => {
    if (message?.type !== "analyze") return;
    runIsolatedAnalysis(message.input)
      .then((result) => {
        process.send!({ type: "result", result } satisfies ChildResponse, () => process.exit(0));
      })
      .catch((error: unknown) => {
        const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        process.send!({ type: "error", message: text } satisfies ChildResponse, () =>
          process.exit(1),
        );
      });
  });
}
