/**
 * 관련 함수 그래프 분석 실행 (TICKET.md T-304). REQUIREMENT_VERIFY 단계가 끝난 뒤 판정 저장과 함께 돈다.
 *
 * - 하네스 케이스의 timeline 요청(method·path, reset은 준비 요청)을 케이스별 입력으로 넘겨 `@ohmyti/analysis`가 서브그래프를 만든다.
 * - 분석은 자식 프로세스에서 돈다(`analyzeFunctionGraphIsolated`). ts-morph가 동기로 수백 ms~수 초를 점유해 heartbeat·`/healthz`를
 *   막지 않게 하고, 큰 프로젝트의 메모리 폭주가 워커 전체를 죽이지 않게 한다. 제한 시간은 `ANALYSIS_TIMEOUT_MS`(기본 120초).
 * - 결과는 항상 아티팩트(`artifactKeys.functionGraph`)로 저장한다. 분석 실패는 단계 실패가 아니라 `status: "unavailable"`이다.
 * - 케이스 루트 라우트의 핸들러 위치는 정적 관계 근거(`kind: STATIC_RELATION`)가 되어 실행 근거 옆에 붙는다 (`buildRequirementResults`).
 *   관측이 아닌 AST 관계이므로 판정·점수에는 쓰지 않는다 (G-01).
 */
import {
  analyzeFunctionGraphIsolated,
  type AnalysisFiles,
  type CaseInput,
  type IsolatedOptions,
} from "@ohmyti/analysis";
import type { FunctionGraphAnalysis, SourceLocation } from "@ohmyti/core";
import type { HarnessReport } from "@ohmyti/harness";
import path from "node:path";

/** 케이스 하나의 정적 관계 근거 입력 (루트 라우트의 핸들러마다 하나) */
export interface StaticRelationInput {
  caseId: string;
  route: { method: string; path: string };
  source: SourceLocation;
  snippet: string;
}

export interface FunctionGraphRunResult {
  analysis: FunctionGraphAnalysis;
  staticRelations: StaticRelationInput[];
}

/** 하네스 보고서의 케이스 timeline → 분석 입력. 보고서가 없으면(기동 실패) 케이스 없이 라우트만 분석한다 */
export function caseInputsOf(harness: HarnessReport | null): CaseInput[] {
  return (harness?.results ?? []).map((result) => ({
    caseId: result.caseId,
    requests: result.timeline.map((entry) => ({
      method: entry.request.method,
      path: entry.request.path,
      isSetup: entry.kind === "reset",
    })),
  }));
}

export function templateNodeModulesDir(templateRoot: string, templateName: string): string {
  return path.join(path.resolve(templateRoot), templateName, "node_modules");
}

export async function runFunctionGraphAnalysis(input: {
  files: AnalysisFiles;
  harness: HarnessReport | null;
  templateRoot: string;
  templateName: string;
  isolation?: IsolatedOptions | undefined;
}): Promise<FunctionGraphRunResult> {
  const { analysis, handlerSnippets } = await analyzeFunctionGraphIsolated(
    {
      files: input.files,
      cases: caseInputsOf(input.harness),
      nodeModulesDir: templateNodeModulesDir(input.templateRoot, input.templateName),
    },
    input.isolation ?? {},
  );
  const staticRelations: StaticRelationInput[] = [];
  if (analysis.status === "ok") {
    const handlerByRoute = new Map(
      analysis.routes.map((r) => [`${r.method} ${r.path}`, r.handler] as const),
    );
    for (const sub of analysis.cases) {
      const seen = new Set<string>();
      for (const route of sub.roots) {
        const handler = handlerByRoute.get(`${route.method} ${route.path}`);
        if (!handler || seen.has(handler.id)) continue;
        seen.add(handler.id);
        staticRelations.push({
          caseId: sub.caseId,
          route,
          source: handler.location,
          snippet: handlerSnippets.get(handler.id) ?? "",
        });
      }
    }
  }
  return { analysis, staticRelations };
}
