/**
 * Mutation 적용기 (TICKET.md T-402). 스냅샷에 카탈로그 변형을 결정적으로 적용하고 diff·`patchDigest`와 사전 검사 결과를 낸다.
 *
 * 흐름 (변형마다)
 * 1. 위치 탐색: AST 휴리스틱(도달 가능한 함수 안) → 실패하면 LLM 후보 + AST 검증. 후보는 첫 유효 후보 1개만 쓴다.
 * 2. 변형: 원문 텍스트 편집 → 변형 파일 텍스트, unified diff, `patchDigest`(diff의 sha256).
 * 3. 사전 검사: diff가 비면 NOT_APPLICABLE. 타입 검사에서 변형 전에 없던 오류가 생기면 BUILD_FAIL.
 *
 * 테스트 파일(`isTestPath`)은 탐색 대상에서 빠지고, 변형 직전에도 한 번 더 확인해 절대 바꾸지 않는다.
 * 제출 코드를 실행하지 않는다(파싱·타입 검사만). 실행과 KILLED/SURVIVED 판정은 T-403이 한다.
 */
import { cp, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceLocation } from "@ohmyti/core";
import type { LlmClient } from "@ohmyti/llm";
import { DiagnosticCategory, ts, type Node, type Project } from "ts-morph";
import { buildCallGraph, type CallGraph, type GraphFunction } from "../call-graph";
import {
  assertSafeRelativePath,
  relativeSourcePath,
  withSnapshotProject,
  type AnalysisFiles,
  type ProjectLimits,
} from "../project";
import { matchRoutePath, methodMatches } from "../routes";
import { isMutablePath } from "./ast";
import {
  MAX_MUTATIONS_PER_EVALUATION,
  MUTATION_CATALOG,
  type MutationDefinition,
  type MutationEntryRequest,
} from "./catalog";
import {
  locateWithLlm,
  type DiscardedCandidate,
  type LocateSourceFile,
  type MutationCandidate,
  type MutationLogger,
} from "./llm-locate";
import { applyTextEdits, patchDigestOf, unifiedDiff } from "./text";

export type MutationApplyStatus = "APPLIED" | "NOT_APPLICABLE" | "BUILD_FAIL";

/**
 * - `NO_TARGET`: 대상 로직 없음 (휴리스틱 후보 없음, LLM도 유효 후보 없음 또는 LLM 미사용)
 * - `LOCATE_FAILED`: 휴리스틱 후보가 없고 LLM 탐색이 실패(미실행·미확정)해 대상 유무를 판단하지 못했다
 * - `EMPTY_DIFF`: 변형 결과가 원본과 같다
 * - `BUILD_FAIL`: 변형 뒤 타입 검사에서 새 오류가 생겼다
 * - `OVER_LIMIT`: evaluation당 상한(5개)을 넘었다
 * - `UNKNOWN_MUTATION`: 카탈로그에 없는 id
 */
export type MutationReasonCode =
  "NO_TARGET" | "LOCATE_FAILED" | "EMPTY_DIFF" | "BUILD_FAIL" | "OVER_LIMIT" | "UNKNOWN_MUTATION";

export const MUTATION_REASON_TEXT: Record<MutationReasonCode, string> = {
  NO_TARGET: "대상 로직 없음",
  LOCATE_FAILED: "대상 위치 탐색 불가",
  EMPTY_DIFF: "변형 결과가 원본과 같음",
  BUILD_FAIL: "변형 후 타입 검사 실패",
  OVER_LIMIT: `evaluation당 mutation 상한(${MAX_MUTATIONS_PER_EVALUATION}개) 초과`,
  UNKNOWN_MUTATION: "카탈로그에 없는 mutation",
};

export interface MutationLlmSummary {
  status: "OK" | "INCONCLUSIVE" | "NOT_RUN";
  reason?: string | undefined;
  /** 채택한 후보 (없으면 undefined) */
  accepted?: MutationCandidate | undefined;
}

export interface MutationApplyResult {
  mutationId: string;
  group: string;
  targetCriterionIds: string[];
  status: MutationApplyStatus;
  reasonCode: MutationReasonCode | null;
  /** 사람이 읽는 사유 (`MUTATION_REASON_TEXT`). APPLIED면 null */
  reason: string | null;
  /** 사유의 세부 설명 */
  detail: string | null;
  locatedBy: "heuristic" | "llm" | null;
  /** 변형한 노드의 위치 */
  target: SourceLocation | null;
  /** unified diff. 변형을 만들지 못했으면 null */
  diff: string | null;
  patchDigest: string | null;
  /** diff의 지운 줄 + 추가한 줄 수 */
  changedLines: number;
  /** 바뀐 파일의 상대 경로 → 변형 후 전체 텍스트 */
  mutatedFiles: Record<string, string>;
  /** BUILD_FAIL이면 새로 생긴 타입 오류 (최대 10개) */
  buildErrors: string[];
  /** LLM 후보 중 검증에서 버린 것과 사유 */
  discardedCandidates: DiscardedCandidate[];
  /** LLM을 호출했으면 그 결과, 아니면 null */
  llm: MutationLlmSummary | null;
}

export interface ApplyMutationsInput {
  files: AnalysisFiles;
  /** 적용할 변형 id (기본: 카탈로그 전체, 카탈로그 순서) */
  mutationIds?: readonly string[] | undefined;
  /** 테스트용 카탈로그 교체 */
  catalog?: readonly MutationDefinition[] | undefined;
  /** 2차 위치 탐색용. 없으면 휴리스틱만 쓴다 */
  llm?: LlmClient | undefined;
  logger?: MutationLogger | undefined;
  /** 템플릿의 `node_modules` (외부 타입 해석용) */
  nodeModulesDir?: string | undefined;
  limits?: Partial<ProjectLimits> | undefined;
}

const MAX_BUILD_ERRORS = 10;

function emptyResult(definition: {
  id: string;
  group: string;
  targetCriterionIds: readonly string[];
}): MutationApplyResult {
  return {
    mutationId: definition.id,
    group: definition.group,
    targetCriterionIds: [...definition.targetCriterionIds],
    status: "NOT_APPLICABLE",
    reasonCode: null,
    reason: null,
    detail: null,
    locatedBy: null,
    target: null,
    diff: null,
    patchDigest: null,
    changedLines: 0,
    mutatedFiles: {},
    buildErrors: [],
    discardedCandidates: [],
    llm: null,
  };
}

function notApplicable(
  result: MutationApplyResult,
  code: MutationReasonCode,
  detail: string | null,
): MutationApplyResult {
  return {
    ...result,
    status: "NOT_APPLICABLE",
    reasonCode: code,
    reason: MUTATION_REASON_TEXT[code],
    detail,
  };
}

/** LLM 후보를 모두 버렸을 때의 사유. 거절 코드를 처음 나온 순서대로 중복 없이 붙인다 */
function llmDiscardNote(discarded: readonly DiscardedCandidate[]): string {
  if (discarded.length === 0) return "LLM 후보 없음";
  const codes = [...new Set(discarded.map((d) => d.code))];
  return `LLM 후보 ${discarded.length}개 모두 검증 실패 (거절 코드: ${codes.join(", ")})`;
}

/** 대상 요청이 매치된 라우트 핸들러에서 호출 간선으로 도달 가능한 함수 (BFS 순) */
export function reachableFunctions(
  graph: CallGraph,
  requests: readonly MutationEntryRequest[],
): GraphFunction[] {
  const byId = new Map(graph.functions.map((fn) => [fn.id, fn]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const queue = graph.routes
    .filter((route) =>
      requests.some(
        (request) =>
          methodMatches(route.method, request.method) && matchRoutePath(route.path, request.path),
      ),
    )
    .map((route) => route.handlerId);
  const seen = new Set<string>();
  const out: GraphFunction[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const fn = byId.get(id);
    if (!fn) continue;
    out.push(fn);
    for (const next of outgoing.get(id) ?? []) if (!seen.has(next)) queue.push(next);
  }
  return out;
}

interface Located {
  node: Node;
  path: string;
}

interface HeuristicLocated extends Located {
  /** 도달 가능한 함수 목록(BFS 순)에서의 순번. 핸들러에 가까울수록 작다 */
  order: number;
}

/**
 * 1차 탐색: 도달 가능한 함수 본문(안에 등록된 다른 함수 노드는 건너뛴다)에서 휴리스틱에 맞는 노드.
 * 핸들러에서 가까운 함수(BFS 순) → 파일 경로 → 위치 순으로 정렬한다
 */
function locateHeuristic(
  definition: MutationDefinition,
  graph: CallGraph,
  rootDir: string,
): Located[] {
  const functionNodes = new Set<Node>(graph.functions.map((fn) => fn.node));
  const found = new Map<Node, HeuristicLocated>();
  const reachable = reachableFunctions(graph, definition.locate.entryRequests);
  for (const [order, fn] of reachable.entries()) {
    if (!isMutablePath(fn.location.path)) continue;
    fn.node.forEachDescendant((node, traversal) => {
      if (functionNodes.has(node)) {
        traversal.skip();
        return;
      }
      const target = definition.locate.heuristic(node);
      if (!target || found.has(target)) return;
      const relative = relativeSourcePath(rootDir, target.getSourceFile().getFilePath());
      if (relative !== null) found.set(target, { node: target, path: relative, order });
    });
  }
  return [...found.values()].sort(
    (a, b) =>
      a.order - b.order || a.path.localeCompare(b.path) || a.node.getStart() - b.node.getStart(),
  );
}

function diagnosticKeys(project: Project, rootDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of project.getPreEmitDiagnostics()) {
    if (diagnostic.getCategory() !== DiagnosticCategory.Error) continue;
    const file = diagnostic.getSourceFile();
    const where = file
      ? (relativeSourcePath(rootDir, file.getFilePath()) ?? "(external)")
      : "(global)";
    const message = ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, " ");
    const key = `${where}: TS${diagnostic.getCode()} ${message}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function newDiagnostics(before: Map<string, number>, after: Map<string, number>): string[] {
  const added: string[] = [];
  for (const [key, count] of [...after.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > (before.get(key) ?? 0)) added.push(key);
  }
  return added;
}

/**
 * 변형을 적용한다. 결과는 요청한 순서(기본: 카탈로그 순서)이며 같은 스냅샷·같은 LLM 응답이면 같다.
 */
export async function applyMutations(input: ApplyMutationsInput): Promise<MutationApplyResult[]> {
  const catalog = input.catalog ?? MUTATION_CATALOG;
  const ids = input.mutationIds ?? catalog.map((entry) => entry.id);
  const logger = input.logger;

  return withSnapshotProject(
    input.files,
    { nodeModulesDir: input.nodeModulesDir, limits: input.limits },
    async (loaded) => {
      const { project, rootDir } = loaded;
      const graph = buildCallGraph(loaded);
      const mutableFiles: LocateSourceFile[] = project
        .getSourceFiles()
        .flatMap((sourceFile) => {
          const relative = relativeSourcePath(rootDir, sourceFile.getFilePath());
          return relative !== null && isMutablePath(relative)
            ? [{ path: relative, sourceFile }]
            : [];
        })
        .sort((a, b) => a.path.localeCompare(b.path));

      // 1단계: 위치 탐색과 텍스트 변형. 타입 검사(2단계)는 소스 파일을 교체하므로 노드를 쓰는 작업을 먼저 끝낸다
      const results: MutationApplyResult[] = [];
      let applied = 0;
      for (const id of ids) {
        const definition = catalog.find((entry) => entry.id === id);
        if (!definition) {
          results.push(
            notApplicable(
              emptyResult({ id, group: "", targetCriterionIds: [] }),
              "UNKNOWN_MUTATION",
              null,
            ),
          );
          continue;
        }
        let result = emptyResult(definition);
        if (applied >= MAX_MUTATIONS_PER_EVALUATION) {
          results.push(notApplicable(result, "OVER_LIMIT", null));
          continue;
        }
        applied += 1;

        let located: Located | undefined = locateHeuristic(definition, graph, rootDir)[0];
        if (located) {
          result.locatedBy = "heuristic";
        } else if (input.llm) {
          const llmResult = await locateWithLlm({
            definition,
            llm: input.llm,
            files: mutableFiles,
            logger,
          });
          result.discardedCandidates = llmResult.discarded;
          result.llm =
            llmResult.outcome.status === "OK"
              ? { status: "OK", accepted: llmResult.target?.candidate }
              : { status: llmResult.outcome.status, reason: llmResult.outcome.reason };
          if (llmResult.target) {
            const relative = relativeSourcePath(
              rootDir,
              llmResult.target.node.getSourceFile().getFilePath(),
            );
            if (relative !== null) {
              located = { node: llmResult.target.node, path: relative };
              result.locatedBy = "llm";
            }
          }
        }

        if (!located) {
          if (result.llm && result.llm.status !== "OK") {
            const label = result.llm.status === "NOT_RUN" ? "LLM 미실행" : "LLM 결과 미확정";
            results.push(
              notApplicable(
                result,
                "LOCATE_FAILED",
                `AST 휴리스틱 후보 없음, ${label}: ${result.llm.reason ?? ""}`.trim(),
              ),
            );
          } else {
            const llmNote = result.llm
              ? llmDiscardNote(result.discardedCandidates)
              : "LLM 탐색 미사용";
            results.push(notApplicable(result, "NO_TARGET", `AST 휴리스틱 후보 없음, ${llmNote}`));
          }
          continue;
        }

        // 테스트 파일은 어떤 경로로 골랐든 바꾸지 않는다
        if (!isMutablePath(located.path)) {
          results.push(notApplicable(result, "NO_TARGET", `변형할 수 없는 파일: ${located.path}`));
          continue;
        }
        const sourceFile = located.node.getSourceFile();
        const original = sourceFile.getFullText();
        const mutated = applyTextEdits(original, definition.transform(located.node));
        result.target = {
          path: located.path,
          startLine: located.node.getStartLineNumber(),
          endLine: located.node.getEndLineNumber(),
        };
        const diff = unifiedDiff(located.path, original, mutated);
        if (diff.text === "") {
          results.push(notApplicable(result, "EMPTY_DIFF", null));
          continue;
        }
        result = {
          ...result,
          status: "APPLIED",
          diff: diff.text,
          patchDigest: patchDigestOf(diff.text),
          changedLines: diff.changedLines,
          mutatedFiles: { [located.path]: mutated },
        };
        results.push(result);
      }

      // 2단계: 사전 타입 검사. 변형 전에 없던 오류가 생기면 BUILD_FAIL
      const pending = results.filter((r) => r.status === "APPLIED");
      if (pending.length > 0) {
        const baseline = diagnosticKeys(project, rootDir);
        for (const result of pending) {
          const [relative, text] = Object.entries(result.mutatedFiles)[0]!;
          const sourceFile = project.getSourceFileOrThrow(
            path.join(rootDir, ...relative.split("/")),
          );
          const original = sourceFile.getFullText();
          sourceFile.replaceWithText(text);
          const added = newDiagnostics(baseline, diagnosticKeys(project, rootDir));
          sourceFile.replaceWithText(original);
          if (added.length > 0) {
            result.status = "BUILD_FAIL";
            result.reasonCode = "BUILD_FAIL";
            result.reason = MUTATION_REASON_TEXT.BUILD_FAIL;
            result.detail = `새 타입 오류 ${added.length}개`;
            result.buildErrors = added.slice(0, MAX_BUILD_ERRORS);
          }
        }
      }

      for (const result of results) {
        logger?.info(
          {
            mutationId: result.mutationId,
            status: result.status,
            reasonCode: result.reasonCode,
            locatedBy: result.locatedBy,
            target: result.target,
            patchDigest: result.patchDigest,
          },
          "mutation 적용 결과",
        );
      }
      return results;
    },
  );
}

/** 변형 하나만 적용한다 */
export async function applyMutation(
  input: Omit<ApplyMutationsInput, "mutationIds"> & { mutationId: string },
): Promise<MutationApplyResult> {
  const [result] = await applyMutations({ ...input, mutationIds: [input.mutationId] });
  return result!;
}

/** 원본 파일 공급자 위에 변형 파일을 겹친 공급자 */
export function mutantFiles(base: AnalysisFiles, result: MutationApplyResult): AnalysisFiles {
  return {
    listFiles: () => base.listFiles(),
    readText: (relativePath) =>
      Object.hasOwn(result.mutatedFiles, relativePath)
        ? Promise.resolve(result.mutatedFiles[relativePath]!)
        : base.readText(relativePath),
  };
}

/**
 * 변형 디렉터리를 만든다: `sourceDir`(풀어 둔 스냅샷)를 `targetDir`로 복사하고(`node_modules`·`.git`·심볼릭 링크 제외)
 * 바뀐 파일만 덮어쓴다. 바이너리 파일도 그대로 복사된다.
 */
export async function writeMutantDirectory(input: {
  sourceDir: string;
  targetDir: string;
  result: MutationApplyResult;
}): Promise<void> {
  const { sourceDir, targetDir, result } = input;
  if (result.status === "NOT_APPLICABLE") {
    throw new Error(
      `적용되지 않은 mutation(${result.mutationId})으로 변형 디렉터리를 만들 수 없습니다`,
    );
  }
  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: async (source) => {
      const name = path.basename(source);
      if (name === "node_modules" || name === ".git") return false;
      return !(await lstat(source)).isSymbolicLink();
    },
  });
  for (const [relative, text] of Object.entries(result.mutatedFiles)) {
    assertSafeRelativePath(relative);
    const target = path.join(targetDir, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }
}
