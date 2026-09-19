/**
 * REVIEW_WRITE 입력 수집과 프롬프트 입력 구성 (T-407).
 *
 * 입력(이력서 제외, G-10): rubric, 기준별 판정(관측), 실패 케이스의 실행 기록 timeline, 정적 함수 그래프,
 * 관련 함수 코드(최대 12개), 설계 평가용 코드 신호(T-605, AST로 센 사실), README. 제출물에서 나온 텍스트(코드·README·응답 본문·관측 문장)는 모두 `untrusted()` 블록에 넣는다 (G-06).
 * 채점 기준 문장은 기업이 승인한 rubric이므로 블록 밖에 둔다.
 */
import { artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import {
  DesignSignalsSchema,
  designSignalItems,
  FunctionGraphAnalysisSchema,
  HarnessCaseActualSchema,
  ReplayTimelineSchema,
  type CaseFunctionGraph,
  type Criterion,
  type DesignSignals,
  type FunctionGraphAnalysis,
  type ReplayTimelineEntry,
  type Rubric,
  type SourceLocation,
} from "@ohmyti/core";
import type { CriterionResultRow, EvidenceRow } from "@ohmyti/db";
import { untrusted } from "@ohmyti/llm";
import type { SubmissionFiles } from "@ohmyti/runner";
import { sourceLines, type ReviewTargets } from "./postprocess";

/** 프롬프트에 넣는 관련 함수 코드 개수 상한 (티켓: 최대 12개) */
export const MAX_RELATED_FUNCTIONS = 12;
/** 함수 하나의 코드 줄 수 상한. 넘으면 앞부분만 넣고 생략을 알린다 */
export const MAX_FUNCTION_LINES = 80;
/** 케이스 하나에서 프롬프트에 넣는 재생 스텝 수 상한 */
export const MAX_STEPS_PER_CASE = 24;
export const MAX_README_CHARS = 6_000;
export const MAX_FILE_LIST = 200;
/** JSON 값 하나(요청·응답 본문, 검사 값)의 글자 수 상한 */
const MAX_VALUE_CHARS = 400;

export interface ReplayStepView {
  stepId: string;
  kind: string;
  request: { method: string; path: string; idempotencyKey: string | null; body: string };
  response: { status: number; body: string } | null;
  error: string | null;
}

export interface FailureCaseView {
  caseId: string;
  runId: string;
  steps: ReplayStepView[];
  omittedSteps: number;
  failedChecks: Array<{ name: string; expected: string; actual: string }>;
  graph: CaseFunctionGraph | null;
}

export interface FailureTarget {
  criterion: Criterion;
  observation: string;
  cases: FailureCaseView[];
}

export interface RelatedFunction {
  name: string;
  location: SourceLocation;
  code: string;
}

export interface ReviewWriteContext {
  rubric: Rubric;
  results: CriterionResultRow[];
  failures: FailureTarget[];
  /** 설계 평가 초안을 쓸 사람 검토 기준 (판정 점수 미확정) */
  design: Criterion[];
  functions: RelatedFunction[];
  files: Array<{ path: string; lines: number }>;
  readme: { path: string; text: string; truncated: boolean } | null;
  graphStatus: "ok" | "unavailable" | "missing";
  /** 설계 평가용 코드 신호 (T-605). 아티팩트가 없으면(추출 이전 평가) null */
  designSignals: DesignSignals | null;
}

export function clip(text: string, max = MAX_VALUE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(${text.length - max}자 생략)`;
}

function jsonText(value: unknown): string {
  if (value === undefined) return "";
  return clip(typeof value === "string" ? value : JSON.stringify(value));
}

function stepViewOf(caseId: string, entry: ReplayTimelineEntry): ReplayStepView {
  const headers = entry.request.headers;
  const keyHeader = Object.keys(headers).find((h) => h.toLowerCase() === "idempotency-key");
  return {
    stepId: `${caseId}#${entry.seq}`,
    kind: entry.kind,
    request: {
      method: entry.request.method,
      path: entry.request.path,
      idempotencyKey: keyHeader ? (headers[keyHeader] ?? null) : null,
      body: jsonText(entry.request.body),
    },
    response: entry.response
      ? { status: entry.response.status, body: jsonText(entry.response.body) }
      : null,
    error: entry.error ? `${entry.error.kind}: ${clip(entry.error.message, 200)}` : null,
  };
}

async function readJson(store: ArtifactStore, key: string): Promise<unknown> {
  const object = await store.get(key);
  if (!object) return undefined;
  try {
    return JSON.parse(Buffer.from(object.body).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function loadGraph(
  store: ArtifactStore,
  evaluationId: string,
): Promise<FunctionGraphAnalysis | null> {
  const parsed = FunctionGraphAnalysisSchema.safeParse(
    await readJson(store, artifactKeys.functionGraph(evaluationId)),
  );
  return parsed.success ? parsed.data : null;
}

async function loadDesignSignals(
  store: ArtifactStore,
  evaluationId: string,
): Promise<DesignSignals | null> {
  const parsed = DesignSignalsSchema.safeParse(
    await readJson(store, artifactKeys.designSignals(evaluationId)),
  );
  return parsed.success ? parsed.data : null;
}

async function loadCase(
  store: ArtifactStore,
  evaluationId: string,
  runId: string,
  caseId: string,
  graph: FunctionGraphAnalysis | null,
): Promise<FailureCaseView> {
  const timeline = ReplayTimelineSchema.safeParse(
    await readJson(store, artifactKeys.runRecord(evaluationId, runId, "timeline")),
  );
  const actual = HarnessCaseActualSchema.safeParse(
    await readJson(store, artifactKeys.runRecord(evaluationId, runId, "actual")),
  );
  const entries = timeline.success ? timeline.data : [];
  return {
    caseId,
    runId,
    steps: entries.slice(0, MAX_STEPS_PER_CASE).map((e) => stepViewOf(caseId, e)),
    omittedSteps: Math.max(0, entries.length - MAX_STEPS_PER_CASE),
    failedChecks: actual.success
      ? actual.data.checks
          .filter((c) => !c.ok)
          .map((c) => ({
            name: c.name,
            expected: jsonText(c.expected),
            actual: jsonText(c.actual),
          }))
      : [],
    graph: graph?.status === "ok" ? (graph.cases.find((c) => c.caseId === caseId) ?? null) : null,
  };
}

function isReadme(path: string): boolean {
  return /^readme(\.[a-z]+)?$/i.test(path);
}

/** 스냅샷·아티팩트에서 입력을 모은다. 실패 케이스 기록이 없으면 그 케이스는 빼고 계속한다 */
export async function collectReviewWriteContext(input: {
  evaluationId: string;
  rubric: Rubric;
  results: CriterionResultRow[];
  evidences: EvidenceRow[];
  files: SubmissionFiles;
  store: ArtifactStore;
}): Promise<ReviewWriteContext> {
  const { rubric, results, store } = input;
  const graph = await loadGraph(store, input.evaluationId);
  const designSignals = await loadDesignSignals(store, input.evaluationId);
  const resultById = new Map(results.map((r) => [r.criterionId, r]));
  const evidenceById = new Map(input.evidences.map((e) => [e.id, e]));

  const failures: FailureTarget[] = [];
  for (const criterion of rubric.criteria) {
    const result = resultById.get(criterion.id);
    if (!result || result.verdict !== "FAIL") continue;
    const cases: FailureCaseView[] = [];
    const seen = new Set<string>();
    for (const evidenceId of result.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      // 하네스 케이스 기록 근거만 (정적 관계·LLM·사람 검토 근거는 kind가 있다)
      if (!evidence || evidence.kind !== null || !evidence.runId || !evidence.testId) continue;
      if (seen.has(evidence.runId)) continue;
      seen.add(evidence.runId);
      cases.push(await loadCase(store, input.evaluationId, evidence.runId, evidence.testId, graph));
    }
    failures.push({ criterion, observation: result.observation, cases });
  }

  const design = rubric.criteria.filter((c) => {
    const result = resultById.get(c.id);
    return c.method === "HUMAN_REVIEW" && result !== undefined && result.earnedPoints === null;
  });

  const paths = (await input.files.listFiles()).filter(
    (p) => !p.split("/").includes("node_modules"),
  );
  const texts = new Map<string, string>();
  const readText = async (path: string): Promise<string | null> => {
    if (texts.has(path)) return texts.get(path)!;
    const text = await input.files.readText(path);
    if (text !== null) texts.set(path, text);
    return text;
  };

  // 관련 함수: 실패 케이스 서브그래프의 노드(루트부터 깊이 순) → 설계 평가가 있으면 라우트 핸들러 순으로 채운다
  const functions: RelatedFunction[] = [];
  const addFunction = async (name: string, location: SourceLocation) => {
    if (functions.length >= MAX_RELATED_FUNCTIONS) return;
    if (
      functions.some(
        (f) =>
          f.location.path === location.path &&
          f.location.startLine === location.startLine &&
          f.location.endLine === location.endLine,
      )
    ) {
      return;
    }
    const text = await readText(location.path);
    if (text === null) return;
    const lines = sourceLines(text);
    const end = Math.min(
      location.endLine,
      lines.length,
      location.startLine + MAX_FUNCTION_LINES - 1,
    );
    if (location.startLine > end) return;
    const body = lines
      .slice(location.startLine - 1, end)
      .map((line, i) => `${String(location.startLine + i).padStart(4, " ")}| ${line}`)
      .join("\n");
    const omitted = Math.min(location.endLine, lines.length) - end;
    functions.push({
      name,
      location,
      code: omitted > 0 ? `${body}\n    | …(${omitted}줄 생략)` : body,
    });
  };
  const nodes = failures
    .flatMap((f) => f.cases)
    .flatMap((c) => c.graph?.nodes ?? [])
    .sort((a, b) => a.depth - b.depth);
  for (const node of nodes) await addFunction(node.name, node.location);
  if (design.length > 0 && graph?.status === "ok") {
    for (const route of graph.routes) await addFunction(route.handler.name, route.handler.location);
  }

  const files: Array<{ path: string; lines: number }> = [];
  for (const path of paths.slice(0, MAX_FILE_LIST)) {
    const text = await readText(path);
    if (text !== null) files.push({ path, lines: sourceLines(text).length });
  }

  const readmePath = paths.find(isReadme);
  const readmeText = readmePath ? await readText(readmePath) : null;

  return {
    rubric,
    results,
    failures,
    design,
    functions,
    files,
    readme:
      readmePath && readmeText !== null
        ? {
            path: readmePath,
            text: readmeText.slice(0, MAX_README_CHARS),
            truncated: readmeText.length > MAX_README_CHARS,
          }
        : null,
    graphStatus: graph === null ? "missing" : graph.status,
    designSignals,
  };
}

/** 후처리가 쓰는 요청 대상 (FAIL 기준 → 참조 가능 스텝, 사람 검토 기준 → 만점) */
export function reviewTargetsOf(context: ReviewWriteContext): ReviewTargets {
  return {
    failures: new Map(
      context.failures.map((f) => [
        f.criterion.id,
        new Set(f.cases.flatMap((c) => c.steps.map((s) => s.stepId))),
      ]),
    ),
    design: new Map(context.design.map((c) => [c.id, c.maxPoints])),
  };
}

/** 신호 하나에 프롬프트로 넣는 위치 수 상한 */
export const MAX_SIGNAL_LOCATIONS_IN_PROMPT = 8;

function locationText(location: SourceLocation): string {
  return location.startLine === location.endLine
    ? `${location.path}:${location.startLine}`
    : `${location.path}:${location.startLine}-${location.endLine}`;
}

/** 코드 신호 목록 (값과 위치). 경로·함수 이름이 제출물에서 나오므로 호출하는 쪽이 `untrusted()`로 감싼다 */
export function designSignalsText(signals: Extract<DesignSignals, { status: "ok" }>): string {
  return designSignalItems(signals)
    .map((item) => {
      const head = `- ${item.label}: ${item.value}`;
      if (item.groups && item.groups.length > 0) {
        return [
          head,
          ...item.groups.map(
            (g) => `  - ${g.statements}문장: ${g.locations.map(locationText).join(" ↔ ")}`,
          ),
        ].join("\n");
      }
      if (item.locations.length === 0 || item.id === "max-file") return head;
      const shown = item.locations.slice(0, MAX_SIGNAL_LOCATIONS_IN_PROMPT).map(locationText);
      const total = item.count ?? item.locations.length;
      const more = total > shown.length ? ` 외 ${total - shown.length}곳` : "";
      return `${head}\n  위치: ${shown.join(", ")}${more}`;
    })
    .join("\n");
}

function graphText(graph: CaseFunctionGraph): string {
  const nodes = graph.nodes.map(
    (n) =>
      `- ${n.name} (${n.kind}, ${n.location.path}:${n.location.startLine}-${n.location.endLine}, 깊이 ${n.depth}${n.route ? `, 라우트 ${n.route.method} ${n.route.path}` : ""}${n.observed ? ", 요청 관측됨" : ""})`,
  );
  const byId = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const edges = graph.edges.map(
    (e) => `- ${byId.get(e.from) ?? e.from} → ${byId.get(e.to) ?? e.to}`,
  );
  return [
    "노드:",
    ...nodes,
    "호출 간선(정적 분석):",
    ...(edges.length > 0 ? edges : ["(없음)"]),
    graph.truncated ? `(노드 ${graph.omittedCount}개 생략)` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 사용자 메시지 본문 */
export function buildReviewWriteInput(context: ReviewWriteContext): string {
  const resultById = new Map(context.results.map((r) => [r.criterionId, r]));
  const sections: string[] = [];

  sections.push(
    "## 채점 기준 (기업이 승인한 rubric)",
    context.rubric.criteria
      .map((c) => {
        const r = resultById.get(c.id);
        return `- ${c.id} [${c.method}] ${c.title}: ${c.condition} · 판정 ${r?.verdict ?? "없음"}`;
      })
      .join("\n"),
  );

  sections.push("## 추정 원인을 쓸 FAIL 기준");
  if (context.failures.length === 0) {
    sections.push("(없음: failures는 빈 배열로 둔다)");
  }
  for (const failure of context.failures) {
    const lines = [`### ${failure.criterion.id} · ${failure.criterion.title}`];
    lines.push(`판정 조건: ${failure.criterion.condition}`);
    lines.push("관측(실행 기록에서 확인한 사실):");
    lines.push(untrusted(`observation:${failure.criterion.id}`, failure.observation));
    if (failure.cases.length === 0) {
      lines.push(
        "실패 재생 스텝 없음 (mutation 기준, 서비스 기동 실패 등). 이 기준은 minimalReproSummary를 생략한다.",
      );
    }
    for (const view of failure.cases) {
      lines.push(`#### 케이스 ${view.caseId} (실행 기록 ${view.runId})`);
      lines.push("실패 재생 스텝 (stepId는 이 목록의 값만 쓸 수 있다):");
      lines.push(
        untrusted(
          `timeline:${view.caseId}`,
          view.steps
            .map((s) =>
              [
                `${s.stepId} ${s.kind} ${s.request.method} ${s.request.path}`,
                s.request.idempotencyKey !== null
                  ? ` Idempotency-Key=${s.request.idempotencyKey}`
                  : "",
                s.request.body ? ` 요청 본문=${s.request.body}` : "",
                s.response
                  ? ` → ${s.response.status} 응답 본문=${s.response.body}`
                  : " → 응답 없음",
                s.error ? ` 오류=${s.error}` : "",
              ].join(""),
            )
            .join("\n") + (view.omittedSteps > 0 ? `\n(스텝 ${view.omittedSteps}개 생략)` : ""),
        ),
      );
      if (view.failedChecks.length > 0) {
        lines.push("실패한 검사 (기대 / 실제):");
        lines.push(
          untrusted(
            `checks:${view.caseId}`,
            view.failedChecks.map((c) => `${c.name}: ${c.expected} / ${c.actual}`).join("\n"),
          ),
        );
      }
      lines.push("관련 함수 그래프 (요청이 매치된 핸들러에서 시작한 정적 호출 관계):");
      lines.push(
        view.graph
          ? untrusted(`graph:${view.caseId}`, graphText(view.graph))
          : "(그래프 없음: 분석 불가이거나 매치된 핸들러가 없다)",
      );
    }
    sections.push(lines.join("\n"));
  }

  sections.push("## 설계 평가 초안을 쓸 사람 검토 기준");
  if (context.design.length === 0) {
    sections.push("(없음: designReviews는 빈 배열로 둔다)");
  } else {
    sections.push(
      "designReviews에는 아래 기준 ID마다 항목 하나를 쓴다. 하위 기준은 rationale 안에서 다룬다.",
      context.design
        .map((c) => {
          const rule = context.rubric.partialRules.find((r) => r.criterionId === c.id);
          const subs = rule
            ? rule.subCriteria.map((s) => `\n  - ${s.id} (${s.points}): ${s.description}`).join("")
            : "";
          return `- ${c.id} · ${c.title} (만점 ${c.maxPoints}): ${c.condition}${subs}`;
        })
        .join("\n"),
    );
  }

  sections.push("## 관측된 코드 신호 (AST로 센 사실, 판정·점수와 무관)");
  if (context.designSignals === null) {
    sections.push("(코드 신호 없음: 신호를 추출하기 전의 평가)");
  } else if (context.designSignals.status === "unavailable") {
    sections.push(`(코드 신호 없음: 추출 실패 · ${context.designSignals.reason})`);
  } else {
    sections.push(untrusted("design_signals", designSignalsText(context.designSignals)));
  }

  sections.push(
    "## 저장소 파일 목록 (경로 · 줄 수)",
    untrusted("file_list", context.files.map((f) => `${f.path} · ${f.lines}`).join("\n")),
  );

  sections.push("## 관련 함수 코드 (왼쪽 숫자가 파일 안 라인 번호)");
  if (context.functions.length === 0) sections.push("(없음)");
  for (const fn of context.functions) {
    const { path, startLine, endLine } = fn.location;
    sections.push(
      `### ${fn.name} · ${path}:${startLine}-${endLine}`,
      untrusted(`source:${path}:${startLine}-${endLine}`, fn.code),
    );
  }

  sections.push("## README");
  sections.push(
    context.readme
      ? untrusted(
          `readme:${context.readme.path}`,
          context.readme.text + (context.readme.truncated ? "\n…(생략)" : ""),
        )
      : "(README 없음)",
  );

  sections.push("위 자료로 근거 탐색·리뷰 json을 작성한다.");
  return sections.join("\n\n");
}
