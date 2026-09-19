/**
 * 6단계 게이트 (T-606): 가상 지원자 페르소나 4종(`samples/personas/`)을 배포 환경에 실제로 제출하고
 * 조회 API의 결과를 `samples/personas/expected-matrix.json`과 대조한다.
 *
 * 흐름: Playwright로 웹 폼(`/submissions/new`)에 저장소 URL·SHA·이력서 PDF·GitHub 프로필 URL을 넣어 제출한다
 * (`POST /api/submissions`는 이력서를 받지 않는다) → `GET /api/submissions/[id]` 폴링 → `GET /api/evaluations/[id]`
 * (판정·변이·단계) + `GET /api/evaluations/[id]/context`(GitHub 근거·맥락 연결) → 대조. 판정은 배포된 워커가 한다.
 * 이 스크립트는 아무것도 실행하지 않고 결과만 읽는다 (G-01, G-07).
 *
 * 실패 조건은 결정적인 항목(기준별 판정·점수, 변이 결과, 점수 표시, 단계 상태, GitHub 근거 선정·커밋 수집,
 * REVIEW_WRITE의 LLM 결과와 R-12 초안 존재)과 "후속 질문 존재"뿐이다. 주장 상태 라벨은 LLM 판단이라 경고로만 남긴다.
 * 끝나면 첫 화면 → 제출 → 워크벤치를 데스크톱·모바일로 캡처해 `docs/gates/personas/`에 둔다.
 *
 * 사용: `pnpm gate:personas --base-url https://ohmyti.vercel.app [--personas seojin,dohyun] [--password <pw>]
 *        [--out docs/gates/personas.md] [--json docs/gates/personas.json] [--screenshots docs/gates/personas]
 *        [--skip-screenshots] [--timeout-ms 1800000] [--poll-ms 10000] [--submissions seojin=<id>,...]`
 * 종료 코드: 0 = 모든 페르소나가 COMPLETED이고 실패 조건이 모두 기대와 같으며 화면 점검 통과. 1 = 그 밖.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, devices, type Browser, type Page } from "@playwright/test";
import { format as prettierFormat, resolveConfig as prettierResolveConfig } from "prettier";
import { z } from "zod";
import {
  ContextStatusSchema,
  EvaluationContextReportResponseSchema,
  EvaluationReportResponseSchema,
  MutationOutcomeSchema,
  VerdictSchema,
  type EvaluationContextReport,
  type EvaluationReport,
} from "@ohmyti/core";
import "./load-env";
import { GateClient, unwrap, waitForTerminal } from "./gate-phase2";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MATRIX = path.join(repoRoot, "samples", "personas", "expected-matrix.json");
export const DEFAULT_OUT = path.join(repoRoot, "docs", "gates", "personas.md");
export const DEFAULT_JSON_OUT = path.join(repoRoot, "docs", "gates", "personas.json");
export const DEFAULT_SCREENSHOTS = path.join(repoRoot, "docs", "gates", "personas");
/** 워커가 페르소나를 순서대로 처리하므로 마지막 제출은 앞 제출이 끝날 때까지 기다린다 */
export const DEFAULT_TIMEOUT_MS = 40 * 60 * 1000;
export const DEFAULT_POLL_MS = 10_000;
export const STAGES = [
  "REPO_CHECK",
  "ENV_PREP",
  "REQUIREMENT_VERIFY",
  "TEST_EFFECTIVENESS",
  "REVIEW_WRITE",
  "CONTEXT_LINK",
] as const;

// ── 기대값 ──────────────────────────────────────────────────────────────────────

const KeywordsSchema = z.array(z.string().min(1)).min(1);

export const PersonaExpectationSchema = z.strictObject({
  level: z.string().min(1),
  repoUrl: z.url(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  /** 저장소 이름을 바꾸기 전의 이름. 근거에 선택되면 안 되는 제출 저장소로 함께 본다 */
  formerRepoNames: z.array(z.string().min(1)),
  resume: z.string().min(1),
  /** 근거로 선택되어야 하는 본인의 포트폴리오 저장소 이름 */
  portfolio: z.array(z.string().min(1)).min(1),
  criteria: z.record(z.string(), VerdictSchema),
  mutations: z.record(z.string(), MutationOutcomeSchema),
  mutationNotes: z.record(z.string(), z.string()),
  scoreDisplay: z.string().min(1),
  /** 후속 질문이 있어야 하는 주장. 주장 문장에 키워드 하나가 들어 있으면 그 주장으로 본다 */
  followUpClaims: z.array(z.strictObject({ label: z.string().min(1), anyOf: KeywordsSchema })),
  /** 주장별 기대 상태. LLM 판단이라 불일치는 경고다 */
  claims: z.array(z.strictObject({ anyOf: KeywordsSchema, status: ContextStatusSchema })),
});
export type PersonaExpectation = z.infer<typeof PersonaExpectationSchema>;

export const PersonaMatrixSchema = z.strictObject({
  note: z.string().optional(),
  organization: z.string().min(1),
  githubProfileUrl: z.url(),
  rubricVersion: z.string().min(1),
  personas: z.record(z.string(), PersonaExpectationSchema),
});
export type PersonaMatrix = z.infer<typeof PersonaMatrixSchema>;

export function repoNameOf(url: string): string {
  const name = new URL(url).pathname.split("/").filter(Boolean)[1];
  if (!name) throw new Error(`저장소 URL이 아닙니다: ${url}`);
  return name;
}

/** 페르소나의 근거에 선택되면 안 되는 저장소: 본인 제출 저장소(옛 이름 포함)와 다른 페르소나의 모든 저장소 */
export function forbiddenRepos(matrix: PersonaMatrix, handle: string): string[] {
  const names = new Set<string>();
  for (const [other, p] of Object.entries(matrix.personas)) {
    names.add(repoNameOf(p.repoUrl));
    for (const n of p.formerRepoNames) names.add(n);
    if (other !== handle) for (const n of p.portfolio) names.add(n);
  }
  return [...names].sort().map((n) => `${matrix.organization}/${n}`);
}

// ── 대조 ───────────────────────────────────────────────────────────────────────

export interface PersonaFacts {
  criteria: Record<string, { verdict: string; earnedPoints: number | null }>;
  mutations: Record<string, { outcome: string; reason: string | null }>;
  scoreDisplay: string | null;
  stages: Record<string, string>;
  reviewWrite: { llm: string | null; reason: string | null; r12Draft: R12Draft | null };
  github: {
    status: string | null;
    selection: string | null;
    repos: {
      fullName: string;
      commits: number;
      mergedPulls: number;
      authorFilter: string | null;
    }[];
    excludedRepos: string[];
  };
  links: {
    claim: string;
    status: string;
    followUpQuestion: string | null;
    criterionId: string | null;
  }[];
}

export interface R12Draft {
  suggestedPoints: number | null;
  maxPoints: number | null;
  rationale: string;
}

export interface PersonaComparison {
  mismatches: string[];
  warnings: string[];
  facts: PersonaFacts;
}

function includesAny(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

const ReviewWriteDetailSchema = z.looseObject({
  llm: z.string().optional(),
  designSuggestions: z
    .array(
      z.looseObject({
        criterionId: z.string(),
        suggestedPoints: z.number().nullable().optional(),
        maxPoints: z.number().nullable().optional(),
        rationale: z.string().optional(),
      }),
    )
    .optional(),
});

export function factsOf(report: EvaluationReport, context: EvaluationContextReport): PersonaFacts {
  const reviewStage = report.stages.find((s) => s.stage === "REVIEW_WRITE");
  const detail = ReviewWriteDetailSchema.safeParse(reviewStage?.detail ?? {});
  const draft = detail.success
    ? detail.data.designSuggestions?.find((d) => d.criterionId === "R-12")
    : undefined;
  const sources = context.github.sources;
  return {
    criteria: Object.fromEntries(
      report.criterionResults.map((c) => [
        c.criterionId,
        { verdict: c.verdict, earnedPoints: c.earnedPoints },
      ]),
    ),
    mutations: Object.fromEntries(
      report.mutationExperiments.map((m) => [
        m.mutationId,
        { outcome: m.outcome, reason: m.reason ?? null },
      ]),
    ),
    scoreDisplay: report.score?.display ?? null,
    stages: Object.fromEntries(report.stages.map((s) => [s.stage, s.state])),
    reviewWrite: {
      llm: detail.success ? (detail.data.llm ?? null) : null,
      reason: reviewStage?.reason ?? null,
      r12Draft: draft
        ? {
            suggestedPoints: draft.suggestedPoints ?? null,
            maxPoints: draft.maxPoints ?? null,
            rationale: draft.rationale ?? "",
          }
        : null,
    },
    github: {
      status: sources?.status ?? null,
      selection: sources?.selection ?? null,
      repos: (sources?.repos ?? []).map((r) => ({
        fullName: r.fullName,
        commits: r.commits.length,
        mergedPulls: r.mergedPulls.length,
        authorFilter: r.authorFilter ?? null,
      })),
      excludedRepos: sources?.excludedRepos ?? [],
    },
    links: context.links.map((l) => ({
      claim: l.claim,
      status: l.status,
      followUpQuestion: l.followUpQuestion ?? null,
      criterionId: l.assignmentObservation?.criterionId ?? null,
    })),
  };
}

export function comparePersona(
  matrix: PersonaMatrix,
  handle: string,
  maxPointsOf: ReadonlyMap<string, number>,
  facts: PersonaFacts,
): PersonaComparison {
  const expected = matrix.personas[handle];
  if (!expected) throw new Error(`기대값에 없는 페르소나: ${handle}`);
  const mismatches: string[] = [];
  const warnings: string[] = [];

  for (const [criterionId, verdict] of Object.entries(expected.criteria)) {
    const actual = facts.criteria[criterionId];
    const max = maxPointsOf.get(criterionId);
    const points = verdict === "PASS" ? (max ?? null) : verdict === "FAIL" ? 0 : null;
    if (!actual) {
      mismatches.push(`${criterionId}: 판정 없음 (기대 ${verdict})`);
    } else if (actual.verdict !== verdict || actual.earnedPoints !== points) {
      mismatches.push(
        `${criterionId}: 기대 ${verdict} ${points ?? "null"}점, 실제 ${actual.verdict} ${actual.earnedPoints ?? "null"}점`,
      );
    }
  }
  for (const criterionId of Object.keys(facts.criteria)) {
    if (!(criterionId in expected.criteria)) mismatches.push(`${criterionId}: 기대값에 없는 기준`);
  }

  for (const [mutationId, outcome] of Object.entries(expected.mutations)) {
    const actual = facts.mutations[mutationId];
    if (!actual) mismatches.push(`${mutationId}: 실험 없음 (기대 ${outcome})`);
    else if (actual.outcome !== outcome) {
      mismatches.push(
        `${mutationId}: 기대 ${outcome}, 실제 ${actual.outcome}${actual.reason ? ` (${actual.reason})` : ""}`,
      );
    }
  }

  if (facts.scoreDisplay !== expected.scoreDisplay) {
    mismatches.push(
      `점수 표시: 기대 ${expected.scoreDisplay}, 실제 ${facts.scoreDisplay ?? "없음"}`,
    );
  }

  for (const stage of STAGES) {
    if (facts.stages[stage] !== "DONE") {
      mismatches.push(`${stage}: 기대 DONE, 실제 ${facts.stages[stage] ?? "없음"}`);
    }
  }
  if (facts.reviewWrite.llm !== "OK") {
    mismatches.push(
      `REVIEW_WRITE LLM 결과: 기대 OK, 실제 ${facts.reviewWrite.llm ?? "없음"}${facts.reviewWrite.reason ? ` (${facts.reviewWrite.reason})` : ""}`,
    );
  }
  if (!facts.reviewWrite.r12Draft) mismatches.push("R-12 설계 초안 없음");

  if (facts.github.status !== "COLLECTED") {
    mismatches.push(
      `GitHub 근거 상태: 기대 COLLECTED, 실제 ${facts.github.status ?? "조회 안 함"}`,
    );
  }
  const selected = facts.github.repos.map((r) => r.fullName.toLowerCase());
  for (const name of expected.portfolio) {
    const full = `${matrix.organization}/${name}`.toLowerCase();
    if (!selected.includes(full)) mismatches.push(`GitHub 근거에 ${name}이 없음`);
  }
  const forbidden = new Set(forbiddenRepos(matrix, handle).map((n) => n.toLowerCase()));
  for (const repo of facts.github.repos) {
    if (forbidden.has(repo.fullName.toLowerCase())) {
      mismatches.push(`GitHub 근거에 선택되면 안 되는 저장소: ${repo.fullName}`);
    }
  }
  const commits = facts.github.repos.reduce((sum, r) => sum + r.commits, 0);
  if (commits < 1) mismatches.push("GitHub 근거에 수집된 커밋 없음");

  for (const want of expected.followUpClaims) {
    const matched = facts.links.filter((l) => includesAny(l.claim, want.anyOf));
    if (matched.length === 0) {
      mismatches.push(`후속 질문 대상 주장 "${want.label}"이 맥락 연결에 없음`);
    } else if (!matched.some((l) => l.followUpQuestion)) {
      mismatches.push(`주장 "${want.label}"에 후속 질문 없음`);
    }
  }

  for (const want of expected.claims) {
    const matched = facts.links.filter((l) => includesAny(l.claim, want.anyOf));
    if (matched.length === 0) {
      warnings.push(`주장(${want.anyOf.join("·")}): 맥락 연결에서 찾지 못함 (기대 ${want.status})`);
    } else if (!matched.some((l) => l.status === want.status)) {
      warnings.push(
        `주장(${want.anyOf.join("·")}): 기대 ${want.status}, 실제 ${[...new Set(matched.map((l) => l.status))].join("·")}`,
      );
    }
  }

  return { mismatches, warnings, facts };
}

// ── 제출 (웹 폼) ────────────────────────────────────────────────────────────────

async function submitViaForm(
  browser: Browser,
  baseUrl: string,
  matrix: PersonaMatrix,
  expected: PersonaExpectation,
  screenshotPath: string | null,
): Promise<string> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(new URL("/submissions/new", baseUrl).toString(), { waitUntil: "networkidle" });
    const select = page.locator('select[name="assignmentVersionId"]');
    const optionTexts = await select.locator("option").allTextContents();
    if (optionTexts.length !== 1) {
      throw new Error(
        `승인된 과제 버전이 정확히 하나가 아님: ${optionTexts.join(" / ") || "없음"}`,
      );
    }
    await page.locator('input[name="repoUrl"]').fill(expected.repoUrl);
    await page.locator('input[name="commitSha"]').fill(expected.sha);
    await page.locator('input[name="githubProfileUrl"]').fill(matrix.githubProfileUrl);
    await page.locator('input[name="resume"]').setInputFiles(path.join(repoRoot, expected.resume));
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
    await Promise.all([
      page.waitForURL(/\/submissions\/[0-9a-f-]{36}(?:[/?#]|$)/, { timeout: 60_000 }),
      page.getByRole("button", { name: "분석 및 채점" }).click(),
    ]);
    const id = /\/submissions\/([0-9a-f-]{36})/.exec(page.url())?.[1];
    if (!id) throw new Error(`제출 ID를 URL에서 찾지 못함: ${page.url()}`);
    return id;
  } finally {
    await context.close();
  }
}

// ── 화면 캡처 ───────────────────────────────────────────────────────────────────

export interface ScreenCheck {
  name: string;
  viewport: "desktop" | "mobile";
  url: string;
  file: string;
  status: number | null;
  horizontalOverflowPx: number;
  consoleErrors: string[];
  problems: string[];
}

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: devices["iPhone 13"],
} as const;

async function capture(
  page: Page,
  name: string,
  viewport: "desktop" | "mobile",
  url: string,
  dir: string,
): Promise<ScreenCheck> {
  const consoleErrors: string[] = [];
  const onConsole = (msg: { type(): string; text(): string }) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  };
  page.on("console", onConsole);
  const response = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1000);
  // 스크립트 tsconfig에는 DOM 타입이 없어 식을 문자열로 넘긴다
  const overflow = Number(
    await page.evaluate(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    ),
  );
  const bodyText = await page.locator("body").innerText();
  const file = path.join(dir, `${name}-${viewport}.png`);
  await page.screenshot({ path: file, fullPage: true });
  page.off("console", onConsole);
  const status = response?.status() ?? null;
  const problems: string[] = [];
  if (status === null || status >= 400) problems.push(`HTTP ${status ?? "응답 없음"}`);
  if (overflow > 1) problems.push(`가로 넘침 ${overflow}px`);
  if (/Application error|Unhandled Runtime Error|Internal Server Error/.test(bodyText)) {
    problems.push("오류 화면 문구");
  }
  if (consoleErrors.length > 0) problems.push(`콘솔 오류 ${consoleErrors.length}건`);
  return {
    name,
    viewport,
    url,
    file: path.relative(repoRoot, file),
    status,
    horizontalOverflowPx: Math.max(0, overflow),
    consoleErrors,
    problems,
  };
}

/** 심사위원 시점: 첫 화면 → 제출 화면 → 제출 상태 → 워크벤치 → 워크벤치 하단 맥락 탭 */
async function captureScreens(
  browser: Browser,
  baseUrl: string,
  dir: string,
  target: { submissionId: string; evaluationId: string },
): Promise<ScreenCheck[]> {
  await mkdir(dir, { recursive: true });
  const pages: [string, string][] = [
    ["01-home", "/"],
    ["02-submit", "/submissions/new"],
    ["03-submission-status", `/submissions/${target.submissionId}`],
    ["04-workbench", `/evaluations/${target.evaluationId}`],
    ["05-workbench-r12", `/evaluations/${target.evaluationId}?criterion=R-12`],
  ];
  const checks: ScreenCheck[] = [];
  for (const viewport of ["desktop", "mobile"] as const) {
    const context = await browser.newContext(VIEWPORTS[viewport]);
    const page = await context.newPage();
    for (const [name, pathname] of pages) {
      checks.push(await capture(page, name, viewport, new URL(pathname, baseUrl).toString(), dir));
    }
    await context.close();
  }
  return checks;
}

// ── 실행 ───────────────────────────────────────────────────────────────────────

export interface PersonaRun {
  handle: string;
  submissionId: string | null;
  evaluationId: string | null;
  status: string;
  waitMs: number;
  comparison: PersonaComparison | null;
  error: string | null;
}

export interface PersonaGateSummary {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  matrixPath: string;
  rubricVersion: string | null;
  runs: PersonaRun[];
  screens: ScreenCheck[];
  ok: boolean;
}

export interface PersonaGateOptions {
  baseUrl: string;
  password: string | null;
  handles: string[];
  matrixPath: string;
  screenshotsDir: string | null;
  timeoutMs: number;
  pollMs: number;
  /** 이미 제출한 페르소나의 제출 ID. 있으면 폼으로 다시 제출하지 않고 결과만 기다려 대조한다 */
  existingSubmissions?: Record<string, string>;
  log: (line: string) => void;
}

export async function runPersonaGate(options: PersonaGateOptions): Promise<PersonaGateSummary> {
  const startedAtMs = Date.now();
  const { log } = options;
  const matrix = PersonaMatrixSchema.parse(JSON.parse(await readFile(options.matrixPath, "utf8")));
  const client = new GateClient(options.baseUrl);
  if (options.password) await client.login(options.password);

  const browser = await chromium.launch();
  const runs: PersonaRun[] = [];
  let screens: ScreenCheck[] = [];
  let rubricVersion: string | null = null;
  try {
    const submitted: { handle: string; submissionId: string }[] = [];
    for (const handle of options.handles) {
      const expected = matrix.personas[handle];
      if (!expected) throw new Error(`기대값에 없는 페르소나: ${handle}`);
      const existing = options.existingSubmissions?.[handle];
      if (existing) {
        log(`기존 제출 ${handle}: ${existing} (다시 제출하지 않음)`);
        submitted.push({ handle, submissionId: existing });
        continue;
      }
      const shot = options.screenshotsDir
        ? path.join(options.screenshotsDir, `00-submit-form-${handle}.png`)
        : null;
      if (shot) await mkdir(path.dirname(shot), { recursive: true });
      const submissionId = await submitViaForm(browser, options.baseUrl, matrix, expected, shot);
      log(`제출 ${handle}: ${expected.repoUrl}@${expected.sha.slice(0, 7)} → ${submissionId}`);
      submitted.push({ handle, submissionId });
    }

    for (const { handle, submissionId } of submitted) {
      const run: PersonaRun = {
        handle,
        submissionId,
        evaluationId: null,
        status: "UNKNOWN",
        waitMs: 0,
        comparison: null,
        error: null,
      };
      runs.push(run);
      try {
        const summary = await waitForTerminal(
          client,
          submissionId,
          options.timeoutMs,
          options.pollMs,
        );
        run.status = summary.status;
        // 제출 시각 → 평가 종료 시각. 기존 제출을 대조할 때도 실제 채점 시간이 남는다
        const finishedAt = summary.latestEvaluation?.finishedAt ?? summary.updatedAt;
        run.waitMs = Date.parse(finishedAt) - Date.parse(summary.createdAt);
        run.evaluationId = summary.latestEvaluation?.id ?? null;
        log(`종료 ${handle}: ${summary.status} (${(run.waitMs / 1000).toFixed(0)}s)`);
        if (summary.status !== "COMPLETED" || !run.evaluationId) {
          run.error = `제출이 COMPLETED가 아님: ${summary.status}${summary.unsupportedReason ? ` (${summary.unsupportedReason})` : ""}`;
          continue;
        }
        const report = unwrap(
          await client.getJson(
            `/api/evaluations/${run.evaluationId}`,
            EvaluationReportResponseSchema,
          ),
          `GET /api/evaluations/${run.evaluationId}`,
        );
        const context = unwrap(
          await client.getJson(
            `/api/evaluations/${run.evaluationId}/context`,
            EvaluationContextReportResponseSchema,
          ),
          `GET /api/evaluations/${run.evaluationId}/context`,
        );
        rubricVersion = report.evaluation.rubricVersion;
        const comparison = comparePersona(
          matrix,
          handle,
          new Map(report.rubric.criteria.map((c) => [c.id, c.maxPoints])),
          factsOf(report, context),
        );
        if (report.evaluation.rubricVersion !== matrix.rubricVersion) {
          comparison.mismatches.push(
            `rubric 버전: 기대 ${matrix.rubricVersion}, 실제 ${report.evaluation.rubricVersion}`,
          );
        }
        if (report.evaluation.submissionSha !== matrix.personas[handle]!.sha) {
          comparison.mismatches.push(
            `평가 SHA가 제출 SHA와 다름: ${report.evaluation.submissionSha}`,
          );
        }
        run.comparison = comparison;
      } catch (error) {
        run.error = error instanceof Error ? error.message : String(error);
      }
    }

    const target =
      runs.find((r) => r.handle === "dohyun" && r.evaluationId) ?? runs.find((r) => r.evaluationId);
    if (options.screenshotsDir && target?.submissionId && target.evaluationId) {
      screens = await captureScreens(browser, options.baseUrl, options.screenshotsDir, {
        submissionId: target.submissionId,
        evaluationId: target.evaluationId,
      });
    }
  } finally {
    await browser.close();
  }

  const ok =
    runs.length === options.handles.length &&
    runs.every(
      (r) => r.status === "COMPLETED" && !r.error && r.comparison?.mismatches.length === 0,
    ) &&
    screens.every((s) => s.problems.length === 0);
  const finishedAtMs = Date.now();
  return {
    baseUrl: options.baseUrl,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    totalMs: finishedAtMs - startedAtMs,
    matrixPath: path.relative(repoRoot, options.matrixPath),
    rubricVersion,
    runs,
    screens,
    ok,
  };
}

// ── 기록 ───────────────────────────────────────────────────────────────────────

function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function renderPersonaReport(matrix: PersonaMatrix, summary: PersonaGateSummary): string {
  const lines: string[] = [];
  const ids = Object.keys(matrix.personas[summary.runs[0]?.handle ?? ""]?.criteria ?? {});
  lines.push("# 6단계 게이트: 페르소나 4종 배포 환경 회귀 (T-606)");
  lines.push("");
  lines.push(
    "`pnpm gate:personas`가 만든 기록이다. 배포된 웹의 제출 폼(`/submissions/new`)에 페르소나의 과제 저장소 URL·커밋 SHA·이력서 PDF·GitHub 프로필 URL을 넣어 제출하고, Railway 워커가 채점·맥락 연결한 결과를 조회 API(`/api/evaluations/[id]`, `/api/evaluations/[id]/context`)로 읽어 `samples/personas/expected-matrix.json`과 대조한다. 실패 조건은 기준별 판정·점수, 변이 결과, 점수 표시, 단계 상태, REVIEW_WRITE의 LLM 결과와 R-12 초안, GitHub 근거 선정·커밋 수집, 후속 질문 존재다. 주장 상태 라벨은 LLM 판단이라 경고로만 적는다.",
  );
  lines.push("");
  lines.push(`- 결과: **${summary.ok ? "통과" : "실패"}**`);
  lines.push(`- 배포: ${summary.baseUrl}`);
  lines.push(
    `- 실행 일시: ${summary.startedAt} ~ ${summary.finishedAt} (총 ${(summary.totalMs / 1000 / 60).toFixed(1)}분)`,
  );
  lines.push(`- rubric: \`${summary.rubricVersion ?? "-"}\` · 기대값: \`${summary.matrixPath}\``);
  lines.push("");
  lines.push("## 제출");
  lines.push("");
  lines.push("| 페르소나 | 저장소 @ SHA | 제출 ID | 평가 ID | 상태 | 제출→종료 | 불일치 | 경고 |");
  lines.push("|---|---|---|---|---|---:|---:|---:|");
  for (const r of summary.runs) {
    const p = matrix.personas[r.handle]!;
    lines.push(
      `| ${r.handle} | ${repoNameOf(p.repoUrl)} @ \`${p.sha.slice(0, 7)}\` | ${r.submissionId ? `\`${r.submissionId}\`` : "-"} | ${r.evaluationId ? `[\`${r.evaluationId}\`](${new URL(`/evaluations/${r.evaluationId}`, summary.baseUrl).toString()})` : "-"} | ${r.status} | ${(r.waitMs / 1000).toFixed(0)}s | ${r.comparison ? r.comparison.mismatches.length : "-"} | ${r.comparison ? r.comparison.warnings.length : "-"} |`,
    );
  }
  lines.push("");
  lines.push("## 기준별 판정 (기대 → 실제)");
  lines.push("");
  lines.push(`| 기준 | ${summary.runs.map((r) => r.handle).join(" | ")} |`);
  lines.push(`|---|${summary.runs.map(() => "---").join("|")}|`);
  for (const id of ids) {
    const cells = summary.runs.map((r) => {
      const exp = matrix.personas[r.handle]!.criteria[id] ?? "?";
      const act = r.comparison?.facts.criteria[id];
      if (!act) return `${exp} → 없음`;
      return `${exp} → ${act.verdict}${act.earnedPoints === null ? "" : ` ${act.earnedPoints}`} ${act.verdict === exp ? "✓" : "✗"}`;
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  lines.push(
    `| 점수 | ${summary.runs
      .map((r) => {
        const exp = matrix.personas[r.handle]!.scoreDisplay;
        const act = r.comparison?.facts.scoreDisplay ?? "없음";
        return `${exp} → ${act} ${exp === act ? "✓" : "✗"}`;
      })
      .join(" | ")} |`,
  );
  lines.push("");
  lines.push("## 변이 결과 (기대 → 실제)");
  lines.push("");
  lines.push(`| 변이 | ${summary.runs.map((r) => r.handle).join(" | ")} |`);
  lines.push(`|---|${summary.runs.map(() => "---").join("|")}|`);
  for (const id of ["M-01", "M-02", "M-03", "M-04", "M-05"]) {
    const cells = summary.runs.map((r) => {
      const exp = matrix.personas[r.handle]!.mutations[id] ?? "?";
      const act = r.comparison?.facts.mutations[id];
      return act ? `${exp} → ${act.outcome} ${act.outcome === exp ? "✓" : "✗"}` : `${exp} → 없음`;
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  const notes = summary.runs.flatMap((r) =>
    Object.entries(matrix.personas[r.handle]!.mutationNotes).map(
      ([id, note]) =>
        `- ${r.handle} ${id}: ${note}${r.comparison?.facts.mutations[id]?.reason ? ` · 워커 사유: ${oneLine(r.comparison.facts.mutations[id].reason, 200)}` : ""}`,
    ),
  );
  if (notes.length > 0) {
    lines.push(...notes);
    lines.push("");
  }
  lines.push("## GitHub 근거 선정");
  lines.push("");
  lines.push(
    "| 페르소나 | 상태 · 선정 방식 | 선택된 저장소 (커밋·병합 PR·작성자 조건) | 제외한 제출 저장소 |",
  );
  lines.push("|---|---|---|---|");
  for (const r of summary.runs) {
    const g = r.comparison?.facts.github;
    lines.push(
      `| ${r.handle} | ${g ? `${g.status ?? "-"} · ${g.selection ?? "-"}` : "-"} | ${g ? g.repos.map((x) => `\`${x.fullName}\` (${x.commits}·${x.mergedPulls}·${x.authorFilter ?? "-"})`).join(", ") : "-"} | ${g ? g.excludedRepos.map((x) => `\`${x}\``).join(", ") || "-" : "-"} |`,
    );
  }
  lines.push("");
  lines.push("## 단계 · REVIEW_WRITE · R-12 초안");
  lines.push("");
  lines.push("| 페르소나 | 단계 | REVIEW_WRITE LLM | R-12 초안 |");
  lines.push("|---|---|---|---|");
  for (const r of summary.runs) {
    const f = r.comparison?.facts;
    lines.push(
      `| ${r.handle} | ${f ? STAGES.map((s) => `${s} ${f.stages[s] ?? "-"}`).join(" · ") : "-"} | ${f?.reviewWrite.llm ?? "-"} | ${f?.reviewWrite.r12Draft ? `${f.reviewWrite.r12Draft.suggestedPoints ?? "?"}/${f.reviewWrite.r12Draft.maxPoints ?? "?"}` : "없음"} |`,
    );
  }
  lines.push("");
  for (const r of summary.runs) {
    const draft = r.comparison?.facts.reviewWrite.r12Draft;
    if (draft) lines.push(`- ${r.handle} R-12 초안 근거: ${oneLine(draft.rationale, 1200)}`);
  }
  lines.push("");
  lines.push("## 맥락 연결과 후속 질문");
  lines.push("");
  for (const r of summary.runs) {
    const links = r.comparison?.facts.links ?? [];
    lines.push(`### ${r.handle}`);
    lines.push("");
    if (links.length === 0) {
      lines.push("연결 없음");
    } else {
      lines.push("| 주장 | 상태 | 관측 기준 | 후속 질문 |");
      lines.push("|---|---|---|---|");
      for (const l of links) {
        lines.push(
          `| ${oneLine(l.claim, 160)} | ${l.status} | ${l.criterionId ?? "-"} | ${l.followUpQuestion ? oneLine(l.followUpQuestion, 300) : "-"} |`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## 불일치");
  lines.push("");
  const mismatches = summary.runs.flatMap((r) => [
    ...(r.comparison?.mismatches ?? []).map((m) => `- ${r.handle}: ${m}`),
    ...(r.error ? [`- ${r.handle}: ${r.error}`] : []),
  ]);
  lines.push(mismatches.length === 0 ? "없음" : mismatches.join("\n"));
  lines.push("");
  lines.push("## 경고 (주장 상태 라벨, 실패 조건 아님)");
  lines.push("");
  const warnings = summary.runs.flatMap((r) =>
    (r.comparison?.warnings ?? []).map((w) => `- ${r.handle}: ${w}`),
  );
  lines.push(warnings.length === 0 ? "없음" : warnings.join("\n"));
  lines.push("");
  lines.push("## 화면 캡처");
  lines.push("");
  if (summary.screens.length === 0) {
    lines.push("캡처하지 않음");
  } else {
    lines.push(
      "데스크톱 1440×900, 모바일 iPhone 13(390×844) 전체 페이지 캡처다. 자동 점검: HTTP 상태, 가로 넘침, 오류 화면 문구, 콘솔 오류.",
    );
    lines.push("");
    lines.push("| 화면 | 뷰포트 | HTTP | 가로 넘침 | 콘솔 오류 | 파일 | 문제 |");
    lines.push("|---|---|---:|---:|---:|---|---|");
    for (const s of summary.screens) {
      lines.push(
        `| ${s.name} | ${s.viewport} | ${s.status ?? "-"} | ${s.horizontalOverflowPx}px | ${s.consoleErrors.length} | \`${s.file}\` | ${s.problems.join(", ") || "없음"} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function personaGateJson(summary: PersonaGateSummary): unknown {
  return {
    ok: summary.ok,
    baseUrl: summary.baseUrl,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    rubricVersion: summary.rubricVersion,
    runs: summary.runs.map((r) => ({
      handle: r.handle,
      submissionId: r.submissionId,
      evaluationId: r.evaluationId,
      status: r.status,
      waitMs: r.waitMs,
      mismatches: r.comparison?.mismatches ?? [],
      warnings: r.comparison?.warnings ?? [],
      error: r.error,
      facts: r.comparison?.facts ?? null,
    })),
    screens: summary.screens,
  };
}

/** `seojin=<uuid>,dohyun=<uuid>` → { seojin, dohyun }. 형식이 틀리면 null */
export function parseExistingSubmissions(text: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const part of text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const match = /^([a-z]+)=([0-9a-f-]{36})$/.exec(part);
    if (!match) return null;
    result[match[1]!] = match[2]!;
  }
  return result;
}

function usage(): never {
  console.error(
    "사용법: gate:personas --base-url <url> [--password <pw>] [--personas seojin,taeyun,gaeun,dohyun] [--matrix <path>] [--out <file>] [--json <file>] [--screenshots <dir>] [--skip-screenshots] [--timeout-ms <ms>] [--poll-ms <ms>] [--submissions handle=<id>,...]",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "base-url": { type: "string" },
      password: { type: "string" },
      personas: { type: "string" },
      matrix: { type: "string", default: DEFAULT_MATRIX },
      out: { type: "string", default: DEFAULT_OUT },
      json: { type: "string", default: DEFAULT_JSON_OUT },
      screenshots: { type: "string", default: DEFAULT_SCREENSHOTS },
      "skip-screenshots": { type: "boolean", default: false },
      "timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
      "poll-ms": { type: "string", default: String(DEFAULT_POLL_MS) },
      submissions: { type: "string" },
    },
    strict: true,
  });
  const baseUrl = values["base-url"];
  if (!baseUrl) usage();
  const timeoutMs = Number(values["timeout-ms"]);
  const pollMs = Number(values["poll-ms"]);
  if (![timeoutMs, pollMs].every((n) => Number.isInteger(n) && n > 0)) usage();
  const matrixPath = path.resolve(values.matrix);
  const matrix = PersonaMatrixSchema.parse(JSON.parse(await readFile(matrixPath, "utf8")));
  const handles = values.personas
    ? values.personas
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : Object.keys(matrix.personas);
  if (handles.length === 0 || handles.some((h) => !(h in matrix.personas))) usage();
  const password = values.password ?? process.env.APP_ACCESS_PASSWORD ?? null;
  const existingSubmissions = parseExistingSubmissions(values.submissions ?? "");
  if (!existingSubmissions || Object.keys(existingSubmissions).some((h) => !handles.includes(h))) {
    usage();
  }

  console.log(`gate:personas 시작 — ${baseUrl}, 페르소나 ${handles.join(", ")}`);
  const summary = await runPersonaGate({
    baseUrl,
    password,
    handles,
    matrixPath,
    screenshotsDir: values["skip-screenshots"] ? null : path.resolve(values.screenshots),
    timeoutMs,
    pollMs,
    existingSubmissions,
    log: (line) => console.log(`  ${line}`),
  });

  for (const r of summary.runs) {
    for (const m of r.comparison?.mismatches ?? []) console.error(`  불일치 ${r.handle}: ${m}`);
    for (const w of r.comparison?.warnings ?? []) console.log(`  경고 ${r.handle}: ${w}`);
    if (r.error) console.error(`  오류 ${r.handle}: ${r.error}`);
  }
  for (const s of summary.screens) {
    if (s.problems.length > 0)
      console.error(`  화면 ${s.name} ${s.viewport}: ${s.problems.join(", ")}`);
  }

  const outPath = path.resolve(values.out);
  const markdown = await prettierFormat(`${renderPersonaReport(matrix, summary)}\n`, {
    ...((await prettierResolveConfig(outPath)) ?? {}),
    parser: "markdown",
  });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, markdown, "utf8");
  const jsonPath = path.resolve(values.json);
  const json = await prettierFormat(JSON.stringify(personaGateJson(summary)), {
    ...((await prettierResolveConfig(jsonPath)) ?? {}),
    parser: "json",
  });
  await writeFile(jsonPath, json, "utf8");
  console.log(
    `gate:personas ${summary.ok ? "OK" : "실패"} — ${(summary.totalMs / 1000 / 60).toFixed(1)}분, 기록 ${path.relative(process.cwd(), outPath)}, 요약 ${path.relative(process.cwd(), jsonPath)}`,
  );
  process.exit(summary.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`gate:personas 오류: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
  });
}
