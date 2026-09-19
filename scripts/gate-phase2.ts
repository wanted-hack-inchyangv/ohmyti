/**
 * 2단계 게이트 (T-208): Railway 워커 + Vercel 웹 배포에 샘플 A/B/C/D를 실제 입력 경로(공개 GitHub 저장소 URL)로
 * 제출하고, 조회 API(T-207)의 리포트를 `expected-matrix.json`과 대조한다. 같은 샘플을 여러 번 제출해 판정 digest가
 * 같은지(결정성)도 확인한다. 미지원 저장소(Python)를 제출해 UNSUPPORTED 사유가 API와 화면(HTML)에 보이는지 검사한다.
 *
 * 흐름: `POST /api/login` → `GET /api/assignment-versions`(승인 버전) → `POST /api/submissions`(샘플별) →
 * `GET /api/submissions/[id]` 폴링(종료 상태까지) → `GET /api/evaluations/[id]` + `runs/[runId]` → 대조·digest.
 * 판정은 배포된 워커가 한다. 이 스크립트는 아무것도 실행하지 않고 결과만 읽는다 (G-01, G-07).
 *
 * 사용: `pnpm gate:phase2 --base-url https://ohmyti.vercel.app [--phase 5] [--repeat 3] [--repeat-samples A,C] [--samples A,B,C,D]
 *        [--skip-unsupported] [--out docs/gates/phase2.md] [--json docs/gates/phase2.json] [--timeout-ms 900000] [--poll-ms 5000]`
 * `--phase`는 배포된 단계에 맞는 기대값을 고른다(2 = T-208 시점, 4 = mutation·리뷰 단계 포함, 5 = 맥락 연결까지, 기본 5, T-507).
 * 환경변수: `APP_ACCESS_PASSWORD`(배포의 접근 비밀번호, `.env.local` 자동 로드) 또는 `--password`. 공개 배포는 생략한다(T-606).
 * 종료 코드: 0 = 모든 제출이 COMPLETED이고 기대와 일치하며 반복 결과가 동일하고 미지원 검사가 통과. 1 = 그 밖.
 *
 * 워커 로그의 비밀값 마스킹 확인은 이 스크립트 밖에서 한다(`docs/deploy.md` 2단계 게이트 절). 기록 파일을 다시 만들면
 * 덮어쓰므로 수동 확인 결과는 기록 끝에 다시 붙인다.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { format as prettierFormat, resolveConfig as prettierResolveConfig } from "prettier";
import { z } from "zod";
import {
  ApprovedVersionListResponseSchema,
  CreatedSubmissionResponseSchema,
  EvaluationReportResponseSchema,
  RubricSchema,
  RunRecordReportResponseSchema,
  SubmissionSummaryResponseSchema,
  type EvaluationReport,
  type Rubric,
  type RunRecordReport,
  type SubmissionSummary,
  type Verdict,
} from "@ohmyti/core";
import "./load-env";
import {
  ExpectedMatrixSchema,
  SAMPLE_DIR,
  SAMPLE_IDS,
  type ExpectedMatrix,
  type ExpectedSample,
} from "./samples-check";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT = path.join(repoRoot, "docs", "gates", "phase2.md");
export const DEFAULT_JSON_OUT = path.join(repoRoot, "docs", "gates", "phase2.json");
export const DEFAULT_REPOS = path.join(SAMPLE_DIR, "sample-repos.json");
export const DEFAULT_REPEAT = 3;
export const DEFAULT_REPEAT_SAMPLES: SampleId[] = ["A", "C"];
/** 제출 하나가 종료 상태가 될 때까지 기다리는 상한 */
export const DEFAULT_SUBMISSION_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_POLL_MS = 5000;

export type SampleId = (typeof SAMPLE_IDS)[number];

const RepoEntrySchema = z.strictObject({ url: z.url(), sha: z.string().regex(/^[0-9a-f]{40}$/) });
export const SampleReposSchema = z.strictObject({
  note: z.string().optional(),
  sourceCommit: z.string().optional(),
  samples: z.record(z.enum(SAMPLE_IDS), RepoEntrySchema),
  unsupported: RepoEntrySchema.extend({ expectedReasonCode: z.string().min(1) }),
});
export type SampleRepos = z.infer<typeof SampleReposSchema>;

// ── HTTP 클라이언트 ─────────────────────────────────────────────────────────────

export class GateHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${url} → HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "GateHttpError";
  }
}

/** 접근 보호(T-008)의 세션 쿠키를 들고 조회·제출 API를 부른다 */
export class GateClient {
  private cookie: string | null = null;

  constructor(readonly baseUrl: string) {}

  async login(password: string): Promise<void> {
    const res = await fetch(new URL("/api/login", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ password, next: "/" }),
      redirect: "manual",
    });
    const setCookie = res.headers.get("set-cookie");
    if (res.status !== 200 || !setCookie) {
      throw new GateHttpError(res.status, "/api/login", await res.text());
    }
    this.cookie = setCookie.split(";")[0]!;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/json",
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...extra,
    };
  }

  async getJson<T>(pathname: string, schema: z.ZodType<T>): Promise<T> {
    const res = await fetch(new URL(pathname, this.baseUrl), {
      headers: this.headers(),
      redirect: "manual",
    });
    const text = await res.text();
    if (res.status === 401) throw new GateHttpError(401, pathname, text);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new GateHttpError(res.status, pathname, text);
    }
    return schema.parse(json);
  }

  async postJson<T>(pathname: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const res = await fetch(new URL(pathname, this.baseUrl), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      redirect: "manual",
    });
    const text = await res.text();
    if (res.status === 401) throw new GateHttpError(401, pathname, text);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new GateHttpError(res.status, pathname, text);
    }
    return schema.parse(json);
  }

  /** 브라우저 탐색과 같은 조건(Accept: text/html + 쿠키)으로 화면 HTML을 받는다 */
  async getHtml(pathname: string): Promise<{ status: number; html: string }> {
    const res = await fetch(new URL(pathname, this.baseUrl), {
      headers: { accept: "text/html", ...(this.cookie ? { cookie: this.cookie } : {}) },
      redirect: "manual",
    });
    return { status: res.status, html: await res.text() };
  }
}

export function unwrap<T>(
  result: { ok: true; data: T } | { ok: false; code: string; message: string },
  label: string,
): T {
  if (result.ok) return result.data;
  throw new Error(`${label}: ${result.code} ${result.message}`);
}

// ── 대조 ───────────────────────────────────────────────────────────────────────

export interface CriterionRow {
  criterionId: string;
  method: string;
  expected: { verdict: Verdict; earnedPoints: number | null } | null;
  actual: { verdict: Verdict; earnedPoints: number | null; issueId: string | null } | null;
  ok: boolean;
}

export interface SubmittedTestsActual {
  status: string;
  total: number;
  files: number;
}

export interface ReportComparison {
  sampleId: SampleId;
  rows: CriterionRow[];
  scoreDisplay: { expected: string; actual: string | null; ok: boolean };
  tests: {
    expected: ExpectedSample["submittedTests"];
    actual: SubmittedTestsActual | null;
    ok: boolean;
  };
  mismatches: string[];
}

/**
 * 기대값을 고르는 배포 단계. 2 = T-208 시점(mutation·리뷰·맥락 단계 미구현), 4 = T-408 이후(TEST_EFFECTIVENESS·REVIEW_WRITE
 * DONE, CONTEXT_LINK SKIPPED), 5 = T-503 이후 최종(모든 단계 DONE). 기본값은 현재 배포 기준인 5다.
 */
export const GATE_PHASES = [2, 4, 5] as const;
export type GatePhase = (typeof GATE_PHASES)[number];
export const DEFAULT_PHASE: GatePhase = 5;

/** 2단계 시점의 기대 판정: EXECUTION·STATIC은 기대 결과표, MUTATION(T-403 전)·HUMAN_REVIEW는 INCONCLUSIVE(null) */
export function expectedAtPhase2(
  method: string,
  cell: { verdict: Verdict; earnedPoints: number | null } | undefined,
): { verdict: Verdict; earnedPoints: number | null } | null {
  if (method === "MUTATION" || method === "HUMAN_REVIEW") {
    return { verdict: "INCONCLUSIVE", earnedPoints: null };
  }
  return cell ? { verdict: cell.verdict, earnedPoints: cell.earnedPoints } : null;
}

/** 단계별 기대 판정. 4단계부터는 MUTATION 기준도 기대 결과표를 따르고, HUMAN_REVIEW는 표대로 INCONCLUSIVE(null)다 */
export function expectedAtPhase(
  phase: GatePhase,
  method: string,
  cell: { verdict: Verdict; earnedPoints: number | null } | undefined,
): { verdict: Verdict; earnedPoints: number | null } | null {
  if (phase === 2) return expectedAtPhase2(method, cell);
  return cell ? { verdict: cell.verdict, earnedPoints: cell.earnedPoints } : null;
}

/** 단계별 기대 점수 표시: 2단계는 `withoutMutationStage`, 4단계부터는 `beforeHumanReview` */
export function expectedScoreDisplay(phase: GatePhase, expected: ExpectedSample): string {
  return phase === 2
    ? expected.scoreDisplay.withoutMutationStage
    : expected.scoreDisplay.beforeHumanReview;
}

type StageName =
  | "REPO_CHECK"
  | "ENV_PREP"
  | "REQUIREMENT_VERIFY"
  | "TEST_EFFECTIVENESS"
  | "REVIEW_WRITE"
  | "CONTEXT_LINK";

/** 단계별 기대 파이프라인 단계 상태 */
export function expectedStageStates(phase: GatePhase): Record<StageName, "DONE" | "SKIPPED"> {
  return {
    REPO_CHECK: "DONE",
    ENV_PREP: "DONE",
    REQUIREMENT_VERIFY: "DONE",
    TEST_EFFECTIVENESS: phase >= 4 ? "DONE" : "SKIPPED",
    REVIEW_WRITE: phase >= 4 ? "DONE" : "SKIPPED",
    CONTEXT_LINK: phase >= 5 ? "DONE" : "SKIPPED",
  };
}

const SubmittedTestsActualSchema = z.looseObject({
  status: z.string(),
  total: z.int(),
  testFiles: z.array(z.looseObject({ path: z.string() })),
});

/** 제출 테스트 기록(kind SUBMITTED_TESTS)의 actual 본문에서 상태·개수·파일 수를 읽는다 */
export function submittedTestsOf(runs: readonly RunRecordReport[]): SubmittedTestsActual | null {
  const run = runs.find((r) => r.record.kind === "SUBMITTED_TESTS");
  if (!run) return null;
  const parsed = SubmittedTestsActualSchema.safeParse(run.actual);
  if (!parsed.success) return null;
  return {
    status: parsed.data.status,
    total: parsed.data.total,
    files: parsed.data.testFiles.length,
  };
}

/** 리포트(배포 API)의 판정·점수·제출 테스트를 기대 결과표와 대조한다 */
export function compareReport(
  rubric: Rubric,
  expected: ExpectedSample,
  report: EvaluationReport,
  runs: readonly RunRecordReport[],
  expectedSha: string,
  phase: GatePhase = DEFAULT_PHASE,
): ReportComparison {
  const mismatches: string[] = [];
  const byId = new Map(report.criterionResults.map((r) => [r.criterionId, r]));
  const rows: CriterionRow[] = rubric.criteria.map((criterion) => {
    const expectedCell = expectedAtPhase(phase, criterion.method, expected.criteria[criterion.id]);
    const result = byId.get(criterion.id);
    const actual = result
      ? {
          verdict: result.verdict,
          earnedPoints: result.earnedPoints,
          issueId: result.issueId ?? null,
        }
      : null;
    let ok = false;
    if (!expectedCell) {
      mismatches.push(`${criterion.id}: expected-matrix에 기대 판정이 없음`);
    } else if (!actual) {
      mismatches.push(`${criterion.id}: 리포트에 판정이 없음`);
    } else if (
      actual.verdict !== expectedCell.verdict ||
      actual.earnedPoints !== expectedCell.earnedPoints
    ) {
      mismatches.push(
        `${criterion.id}: 기대 ${expectedCell.verdict}(${expectedCell.earnedPoints ?? "null"}) ≠ 실제 ${actual.verdict}(${actual.earnedPoints ?? "null"})${result?.observation ? ` — ${result.observation.slice(0, 160)}` : ""}`,
      );
    } else {
      ok = true;
    }
    return {
      criterionId: criterion.id,
      method: criterion.method,
      expected: expectedCell,
      actual,
      ok,
    };
  });
  if (report.criterionResults.length !== rubric.criteria.length) {
    mismatches.push(
      `기준 결과 개수 ${report.criterionResults.length} ≠ rubric 기준 ${rubric.criteria.length}`,
    );
  }

  const scoreExpected = expectedScoreDisplay(phase, expected);
  const scoreActual = report.score?.display ?? null;
  const scoreOk = scoreActual === scoreExpected;
  if (!scoreOk) {
    mismatches.push(`점수 표시: 기대 "${scoreExpected}" ≠ 실제 "${scoreActual ?? "없음"}"`);
  }

  const testsActual = submittedTestsOf(runs);
  const testsOk =
    testsActual !== null &&
    testsActual.status === expected.submittedTests.status &&
    testsActual.total === expected.submittedTests.total &&
    testsActual.files === expected.submittedTests.files;
  if (!testsOk) {
    mismatches.push(
      `제출 테스트: 기대 ${expected.submittedTests.status} ${expected.submittedTests.total}건/${expected.submittedTests.files}파일 ≠ 실제 ${
        testsActual
          ? `${testsActual.status} ${testsActual.total}건/${testsActual.files}파일`
          : "없음"
      }`,
    );
  }

  if (report.submission.status !== "COMPLETED") {
    mismatches.push(`제출 상태: 기대 COMPLETED ≠ 실제 ${report.submission.status}`);
  }
  if (report.evaluation.submissionSha !== expectedSha) {
    mismatches.push(`고정 SHA: 기대 ${expectedSha} ≠ 실제 ${report.evaluation.submissionSha}`);
  }
  if (report.evaluation.rubricVersion !== `${rubric.version}`) {
    // rubric.version은 DB의 rubric_version으로 덮어써 저장되므로 리포트 안에서 서로 같아야 한다
    mismatches.push(
      `rubric 버전: 리포트 rubric ${rubric.version} ≠ 평가 ${report.evaluation.rubricVersion}`,
    );
  }
  const stageState = new Map(report.stages.map((s) => [s.stage, s.state]));
  for (const [stage, state] of Object.entries(expectedStageStates(phase))) {
    if (stageState.get(stage as StageName) !== state) {
      mismatches.push(
        `단계 ${stage}: 기대 ${state}${state === "SKIPPED" ? "(미구현)" : ""} ≠ 실제 ${stageState.get(stage as StageName) ?? "없음"}`,
      );
    }
  }

  return {
    sampleId: expected.id,
    rows,
    scoreDisplay: {
      expected: scoreExpected,
      actual: scoreActual,
      ok: scoreOk,
    },
    tests: { expected: expected.submittedTests, actual: testsActual, ok: testsOk },
    mismatches,
  };
}

// ── 결정성 ─────────────────────────────────────────────────────────────────────

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return v;
  });
}

const HarnessActualSchema = z.looseObject({
  caseId: z.string(),
  verdict: z.string(),
  failureKind: z.string(),
  actual: z.unknown(),
  checks: z.unknown(),
});
const InputKindSchema = z.looseObject({ kind: z.string() });
const StartupActualSchema = z.looseObject({
  startup: z.looseObject({ outcome: z.string(), lastHealthStatus: z.unknown() }).nullable(),
});
const TestsDigestSchema = z.looseObject({
  status: z.string(),
  failureKind: z.string(),
  framework: z.unknown(),
  total: z.int(),
  passed: z.int(),
  failed: z.int(),
  skipped: z.int(),
  testFiles: z.array(
    z.looseObject({
      path: z.string(),
      status: z.string(),
      tests: z.array(z.looseObject({ fullName: z.string(), status: z.string() })),
    }),
  ),
});

/**
 * 판정 digest. 1단계 게이트(T-110)와 같은 항목(환경 digest, 기동 결과, 케이스별 verdict·failureKind·expected·actual·checks,
 * 제출 테스트 상태·개수·파일별 테스트 이름과 상태)에 저장된 기준별 판정·점수를 더한다. 시각·소요 시간·포트·주문 id·ID는 제외한다.
 * 근거 수는 LLM 추정 근거(`LLM_INTERPRETATION`, T-407 리뷰 작성)를 빼고 센다. LLM 문장은 실행마다 달라질 수 있고 판정에 쓰이지
 * 않으므로(G-01) 결정성 대상이 아니다 (T-507).
 */
export function evaluationDigest(
  report: EvaluationReport,
  runs: readonly RunRecordReport[],
): string {
  const kindOf = (run: RunRecordReport): string | null => {
    const parsed = InputKindSchema.safeParse(run.input);
    return parsed.success ? parsed.data.kind : null;
  };
  const startupRun = runs.find((r) => kindOf(r) === "SERVICE_STARTUP");
  const startup = startupRun ? StartupActualSchema.safeParse(startupRun.actual) : null;
  const cases = runs
    .filter((r) => kindOf(r) === "HARNESS_CASE")
    .map((r) => {
      const actual = HarnessActualSchema.safeParse(r.actual);
      const caseId = actual.success ? actual.data.caseId : (r.evidences[0]?.testId ?? "");
      return {
        caseId,
        expected: r.expected,
        verdict: actual.success ? actual.data.verdict : null,
        failureKind: actual.success ? actual.data.failureKind : null,
        actual: actual.success ? actual.data.actual : r.actual,
        checks: actual.success ? actual.data.checks : null,
      };
    })
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  const testsRun = runs.find((r) => r.record.kind === "SUBMITTED_TESTS");
  const testsParsed = testsRun ? TestsDigestSchema.safeParse(testsRun.actual) : null;
  const tests = testsParsed?.success
    ? {
        status: testsParsed.data.status,
        failureKind: testsParsed.data.failureKind,
        framework: testsParsed.data.framework,
        total: testsParsed.data.total,
        passed: testsParsed.data.passed,
        failed: testsParsed.data.failed,
        skipped: testsParsed.data.skipped,
        files: testsParsed.data.testFiles.map((f) => ({
          path: f.path,
          status: f.status,
          tests: f.tests.map((t) => ({ fullName: t.fullName, status: t.status })),
        })),
      }
    : null;
  const llmEvidenceIds = new Set(
    report.evidences.filter((e) => e.kind === "LLM_INTERPRETATION").map((e) => e.id),
  );
  const payload = {
    environmentDigest: report.evaluation.environmentDigest,
    harnessVersion: report.evaluation.harnessVersion,
    rubricVersion: report.evaluation.rubricVersion,
    submissionSha: report.evaluation.submissionSha,
    score: report.score
      ? {
          earned: report.score.earned,
          min: report.score.min,
          max: report.score.max,
          pendingPoints: report.score.pendingPoints,
        }
      : null,
    criteria: report.criterionResults.map((r) => ({
      criterionId: r.criterionId,
      verdict: r.verdict,
      earnedPoints: r.earnedPoints,
      issueId: r.issueId ?? null,
      reviewState: r.reviewState,
      satisfiedSubCriterionIds: r.satisfiedSubCriterionIds ?? null,
      evidenceCount: r.evidenceIds.filter((id) => !llmEvidenceIds.has(id)).length,
    })),
    stages: report.stages.map((s) => ({ stage: s.stage, state: s.state })),
    startup: startup?.success
      ? {
          outcome: startup.data.startup?.outcome ?? null,
          lastHealthStatus: startup.data.startup?.lastHealthStatus ?? null,
        }
      : null,
    cases,
    tests,
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export interface RunDigest {
  sampleId: SampleId;
  round: number;
  submissionId: string;
  evaluationId: string;
  digest: string;
}

/** 같은 샘플의 회차별 digest가 모두 같아야 한다 */
export function checkDeterminism(digests: readonly RunDigest[]): string[] {
  const problems: string[] = [];
  const bySample = new Map<SampleId, RunDigest[]>();
  for (const d of digests) {
    const list = bySample.get(d.sampleId) ?? [];
    list.push(d);
    bySample.set(d.sampleId, list);
  }
  for (const [sampleId, list] of bySample) {
    const distinct = new Set(list.map((d) => d.digest));
    if (distinct.size > 1) {
      problems.push(
        `${sampleId}: 회차별 digest가 다름 (${list.map((d) => `${d.round}회차 ${d.digest.slice(0, 16)}`).join(", ")})`,
      );
    }
  }
  return problems;
}

// ── 실행 ───────────────────────────────────────────────────────────────────────

export interface SubmissionRun {
  sampleId: SampleId;
  round: number;
  submissionId: string;
  evaluationId: string | null;
  status: string;
  submittedAt: string;
  finishedAt: string | null;
  /** 제출 → 종료 상태까지 벽시계 (큐 대기 포함) */
  waitMs: number;
  comparison: ReportComparison | null;
  digest: string | null;
  error?: string;
}

export interface UnsupportedCheck {
  repoUrl: string;
  submissionId: string;
  status: string;
  unsupportedReason: string | null;
  expectedReasonCode: string;
  apiOk: boolean;
  /** `/submissions/<id>` HTML에 미지원 배지와 사유 코드가 있는지 */
  htmlOk: boolean;
  problems: string[];
}

export interface GateRunSummary {
  baseUrl: string;
  phase: GatePhase;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  assignmentVersion: { id: string; label: string; rubricVersion: string };
  reposPath: string;
  /** 제출한 저장소 URL·SHA (기록용) */
  repos: SampleRepos;
  matrixPath: string;
  runs: SubmissionRun[];
  determinismProblems: string[];
  unsupported: UnsupportedCheck | null;
  ok: boolean;
}

export interface GateOptions {
  baseUrl: string;
  /** 접근 보호가 켜진 배포의 비밀번호. 공개 배포(`APP_ACCESS_MODE=public`)면 null이고 로그인하지 않는다 */
  password: string | null;
  phase: GatePhase;
  sampleIds: SampleId[];
  repeat: number;
  repeatSamples: SampleId[];
  skipUnsupported: boolean;
  reposPath: string;
  matrixPath: string;
  timeoutMs: number;
  pollMs: number;
  log: (line: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForTerminal(
  client: GateClient,
  submissionId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<SubmissionSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const summary = unwrap(
      await client.getJson(`/api/submissions/${submissionId}`, SubmissionSummaryResponseSchema),
      `GET /api/submissions/${submissionId}`,
    );
    if (summary.terminal) return summary;
    if (Date.now() > deadline) {
      throw new Error(
        `제출 ${submissionId}가 ${timeoutMs}ms 안에 끝나지 않음 (상태 ${summary.status})`,
      );
    }
    await sleep(pollMs);
  }
}

async function fetchRuns(client: GateClient, report: EvaluationReport): Promise<RunRecordReport[]> {
  const runs: RunRecordReport[] = [];
  for (const record of report.executionRecords) {
    runs.push(
      unwrap(
        await client.getJson(
          `/api/evaluations/${report.evaluation.id}/runs/${record.id}`,
          RunRecordReportResponseSchema,
        ),
        `GET run ${record.id}`,
      ),
    );
  }
  return runs;
}

/** 제출 계획: 샘플마다 1회, 반복 대상 샘플은 `repeat`회. 큐가 순서대로 처리하도록 제출 순서도 이 순서다 */
export function planSubmissions(
  sampleIds: readonly SampleId[],
  repeat: number,
  repeatSamples: readonly SampleId[],
): { sampleId: SampleId; round: number }[] {
  const plan: { sampleId: SampleId; round: number }[] = [];
  for (const sampleId of sampleIds) plan.push({ sampleId, round: 1 });
  for (let round = 2; round <= repeat; round += 1) {
    for (const sampleId of repeatSamples) {
      if (sampleIds.includes(sampleId)) plan.push({ sampleId, round });
    }
  }
  return plan;
}

export async function runGate(
  options: GateOptions,
): Promise<{ summary: GateRunSummary; rubric: Rubric }> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const { log } = options;

  const matrix: ExpectedMatrix = ExpectedMatrixSchema.parse(
    JSON.parse(await readFile(options.matrixPath, "utf8")),
  );
  const repos: SampleRepos = SampleReposSchema.parse(
    JSON.parse(await readFile(options.reposPath, "utf8")),
  );
  const client = new GateClient(options.baseUrl);
  if (options.password) await client.login(options.password);
  log(`로그인 성공: ${options.baseUrl}`);

  const versions = unwrap(
    await client.getJson("/api/assignment-versions", ApprovedVersionListResponseSchema),
    "GET /api/assignment-versions",
  );
  if (versions.length !== 1) {
    throw new Error(
      `승인된 과제 버전이 정확히 하나여야 합니다 (현재 ${versions.length}개: ${versions.map((v) => v.label).join(", ")})`,
    );
  }
  const version = versions[0]!;
  log(`과제 버전: ${version.label} (${version.id}, rubric ${version.rubricVersion})`);

  const plan = planSubmissions(options.sampleIds, options.repeat, options.repeatSamples);
  const runs: SubmissionRun[] = [];

  // 미지원 저장소는 빠르게 끝나므로 먼저 제출한다
  let unsupportedSubmissionId: string | null = null;
  if (!options.skipUnsupported) {
    const created = unwrap(
      await client.postJson(
        "/api/submissions",
        {
          assignmentVersionId: version.id,
          repoUrl: repos.unsupported.url,
          commitSha: repos.unsupported.sha,
        },
        CreatedSubmissionResponseSchema,
      ),
      "POST /api/submissions (unsupported)",
    );
    unsupportedSubmissionId = created.submissionId;
    log(`미지원 저장소 제출: ${repos.unsupported.url} → ${created.submissionId}`);
  }

  for (const item of plan) {
    const repo = repos.samples[item.sampleId];
    const submittedAt = new Date().toISOString();
    const created = unwrap(
      await client.postJson(
        "/api/submissions",
        { assignmentVersionId: version.id, repoUrl: repo.url, commitSha: repo.sha },
        CreatedSubmissionResponseSchema,
      ),
      `POST /api/submissions (${item.sampleId} ${item.round}회차)`,
    );
    runs.push({
      sampleId: item.sampleId,
      round: item.round,
      submissionId: created.submissionId,
      evaluationId: null,
      status: "QUEUED",
      submittedAt,
      finishedAt: null,
      waitMs: 0,
      comparison: null,
      digest: null,
    });
    log(
      `제출 ${item.sampleId} ${item.round}회차: ${repo.url}@${repo.sha.slice(0, 7)} → ${created.submissionId}`,
    );
  }

  // 순서대로 종료를 기다린다 (워커는 큐 순서대로 처리한다)
  let rubric: Rubric | null = null;
  for (const run of runs) {
    try {
      const summary = await waitForTerminal(
        client,
        run.submissionId,
        options.timeoutMs,
        options.pollMs,
      );
      run.status = summary.status;
      run.finishedAt = new Date().toISOString();
      run.waitMs = Date.parse(run.finishedAt) - Date.parse(run.submittedAt);
      run.evaluationId = summary.latestEvaluation?.id ?? null;
      if (summary.status !== "COMPLETED" || !run.evaluationId) {
        run.error = `종료 상태 ${summary.status}${summary.unsupportedReason ? ` (${summary.unsupportedReason})` : ""}${run.evaluationId ? "" : ", 평가 없음"}`;
        log(`${run.sampleId} ${run.round}회차: ${run.error}`);
        continue;
      }
      const report = unwrap(
        await client.getJson(
          `/api/evaluations/${run.evaluationId}`,
          EvaluationReportResponseSchema,
        ),
        `GET /api/evaluations/${run.evaluationId}`,
      );
      rubric ??= RubricSchema.parse(report.rubric);
      const runRecords = await fetchRuns(client, report);
      const expected = matrix.samples.find((s) => s.id === run.sampleId);
      if (!expected) throw new Error(`expected-matrix에 샘플 ${run.sampleId}이 없음`);
      run.comparison = compareReport(
        RubricSchema.parse(report.rubric),
        expected,
        report,
        runRecords,
        repos.samples[run.sampleId].sha,
        options.phase,
      );
      run.digest = evaluationDigest(report, runRecords);
      log(
        `${run.sampleId} ${run.round}회차: ${summary.status} ${(run.waitMs / 1000).toFixed(0)}s · 점수 ${report.score?.display ?? "-"} · 불일치 ${run.comparison.mismatches.length} · digest ${run.digest.slice(0, 16)}`,
      );
    } catch (error) {
      run.error = (error as Error).message;
      run.finishedAt ??= new Date().toISOString();
      log(`${run.sampleId} ${run.round}회차 오류: ${run.error}`);
    }
  }

  let unsupported: UnsupportedCheck | null = null;
  if (unsupportedSubmissionId) {
    const problems: string[] = [];
    const summary = await waitForTerminal(
      client,
      unsupportedSubmissionId,
      options.timeoutMs,
      options.pollMs,
    );
    const code = repos.unsupported.expectedReasonCode;
    const apiOk =
      summary.status === "UNSUPPORTED" && (summary.unsupportedReason ?? "").includes(code);
    if (summary.status !== "UNSUPPORTED")
      problems.push(`상태 ${summary.status} (기대 UNSUPPORTED)`);
    if (!(summary.unsupportedReason ?? "").includes(code)) {
      problems.push(`사유에 ${code}가 없음: ${summary.unsupportedReason ?? "없음"}`);
    }
    const page = await client.getHtml(`/submissions/${unsupportedSubmissionId}`);
    const htmlOk =
      page.status === 200 &&
      page.html.includes('data-testid="submission-status-badge"') &&
      page.html.includes("미지원") &&
      page.html.includes(code);
    if (!htmlOk) {
      problems.push(
        `화면 HTML(${page.status})에 미지원 배지·사유 코드가 없음 (badge ${page.html.includes('data-testid="submission-status-badge"')}, 미지원 ${page.html.includes("미지원")}, ${code} ${page.html.includes(code)})`,
      );
    }
    unsupported = {
      repoUrl: repos.unsupported.url,
      submissionId: unsupportedSubmissionId,
      status: summary.status,
      unsupportedReason: summary.unsupportedReason,
      expectedReasonCode: code,
      apiOk,
      htmlOk,
      problems,
    };
    log(
      `미지원 검사: ${summary.status} · 사유 ${summary.unsupportedReason ?? "없음"} · API ${apiOk ? "OK" : "실패"} · 화면 ${htmlOk ? "OK" : "실패"}`,
    );
  }

  const digests: RunDigest[] = runs.flatMap((r) =>
    r.digest && r.evaluationId
      ? [
          {
            sampleId: r.sampleId,
            round: r.round,
            submissionId: r.submissionId,
            evaluationId: r.evaluationId,
            digest: r.digest,
          },
        ]
      : [],
  );
  const determinismProblems = checkDeterminism(digests);
  const finishedAtMs = Date.now();
  const ok =
    runs.length === plan.length &&
    runs.every(
      (r) => r.status === "COMPLETED" && r.comparison?.mismatches.length === 0 && !r.error,
    ) &&
    determinismProblems.length === 0 &&
    (options.skipUnsupported || (unsupported !== null && unsupported.problems.length === 0));

  if (!rubric) {
    // 완료된 평가가 하나도 없으면 저장소의 rubric으로 표를 그린다
    rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLE_DIR, "rubric.v1.json"), "utf8")),
    );
  }
  const summary: GateRunSummary = {
    baseUrl: options.baseUrl,
    phase: options.phase,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    totalMs: finishedAtMs - startedAtMs,
    assignmentVersion: {
      id: version.id,
      label: version.label,
      rubricVersion: version.rubricVersion,
    },
    reposPath: path.relative(repoRoot, options.reposPath),
    repos,
    matrixPath: path.relative(repoRoot, options.matrixPath),
    runs,
    determinismProblems,
    unsupported,
    ok,
  };
  return { summary, rubric };
}

// ── 기록 ───────────────────────────────────────────────────────────────────────

function cell(row: CriterionRow | undefined): string {
  if (!row) return "-";
  const exp = row.expected
    ? `${row.expected.verdict}${row.expected.earnedPoints === null ? "" : ` ${row.expected.earnedPoints}`}`
    : "?";
  const act = row.actual
    ? `${row.actual.verdict}${row.actual.earnedPoints === null ? "" : ` ${row.actual.earnedPoints}`}`
    : "없음";
  return `${exp} → ${act} ${row.ok ? "✓" : "✗"}`;
}

export function renderTable(rubric: Rubric, runs: readonly SubmissionRun[]): string {
  const firstRounds = SAMPLE_IDS.map((id) =>
    runs.find((r) => r.sampleId === id && r.round === 1),
  ).filter((r): r is SubmissionRun => r !== undefined);
  const header = `| 기준 | method | 배점 | ${firstRounds.map((r) => `${r.sampleId} (기대 → 실제)`).join(" | ")} |`;
  const sep = `|---|---|---:|${firstRounds.map(() => "---").join("|")}|`;
  const lines = rubric.criteria.map((c) => {
    const cells = firstRounds.map((r) =>
      cell(r.comparison?.rows.find((row) => row.criterionId === c.id)),
    );
    return `| ${c.id} | ${c.method} | ${c.maxPoints} | ${cells.join(" | ")} |`;
  });
  const score = `| 점수 표시 | - | - | ${firstRounds
    .map((r) =>
      r.comparison
        ? `${r.comparison.scoreDisplay.expected} → ${r.comparison.scoreDisplay.actual ?? "없음"} ${r.comparison.scoreDisplay.ok ? "✓" : "✗"}`
        : "-",
    )
    .join(" | ")} |`;
  const tests = `| 제출 테스트 | T-109 | - | ${firstRounds
    .map((r) => {
      if (!r.comparison) return "-";
      const t = r.comparison.tests;
      return `${t.expected.status} ${t.expected.total}건/${t.expected.files}파일 → ${
        t.actual ? `${t.actual.status} ${t.actual.total}건/${t.actual.files}파일` : "없음"
      } ${t.ok ? "✓" : "✗"}`;
    })
    .join(" | ")} |`;
  return [header, sep, ...lines, score, tests].join("\n");
}

function phaseLabel(phase: GatePhase): string {
  const states = expectedStageStates(phase);
  return `${phase}단계 배포 (단계 상태 ${Object.entries(states)
    .map(([stage, state]) => `${stage} ${state}`)
    .join(" · ")})`;
}

export function renderReport(rubric: Rubric, summary: GateRunSummary): string {
  const lines: string[] = [];
  lines.push("# 2단계 게이트: 배포 환경 E2E (T-208)");
  lines.push("");
  lines.push(
    "`pnpm gate:phase2`가 만든 기록이다. Vercel 웹(`POST /api/submissions`)에 샘플 A/B/C/D의 공개 GitHub 저장소 URL과 커밋 SHA를 제출하고, Railway 워커가 채점한 결과를 조회 API(T-207)로 읽어 `samples/order-api/expected-matrix.json`과 대조한다. 같은 샘플을 여러 번 제출해 판정 digest가 같은지, 미지원 저장소가 사유와 함께 거절되는지도 확인한다.",
  );
  lines.push("");
  lines.push(`- 결과: **${summary.ok ? "통과" : "실패"}**`);
  lines.push(`- 배포: ${summary.baseUrl}`);
  lines.push(`- 기대값 기준: ${phaseLabel(summary.phase)} (\`--phase ${summary.phase}\`)`);
  lines.push(
    `- 실행 일시: ${summary.startedAt} ~ ${summary.finishedAt} (총 ${(summary.totalMs / 1000 / 60).toFixed(1)}분)`,
  );
  lines.push(
    `- 과제 버전: ${summary.assignmentVersion.label} (\`${summary.assignmentVersion.id}\`, rubric \`${summary.assignmentVersion.rubricVersion}\`)`,
  );
  lines.push(`- 샘플 저장소: \`${summary.reposPath}\` · 기대 결과표: \`${summary.matrixPath}\``);
  lines.push("");
  lines.push("## 샘플 저장소");
  lines.push("");
  lines.push("| 샘플 | 저장소 | 커밋 SHA |");
  lines.push("|---|---|---|");
  for (const id of SAMPLE_IDS) {
    const repo = summary.repos.samples[id];
    lines.push(`| ${id} | ${repo.url} | \`${repo.sha}\` |`);
  }
  lines.push(
    `| 미지원 | ${summary.repos.unsupported.url} | \`${summary.repos.unsupported.sha}\` |`,
  );
  lines.push("");
  lines.push("## 제출");
  lines.push("");
  lines.push("| 샘플 | 회차 | 제출 ID | 평가 ID | 상태 | 제출→종료 | 불일치 | digest |");
  lines.push("|---|---:|---|---|---|---:|---:|---|");
  for (const r of summary.runs) {
    lines.push(
      `| ${r.sampleId} | ${r.round} | \`${r.submissionId}\` | ${r.evaluationId ? `\`${r.evaluationId}\`` : "-"} | ${r.status} | ${(r.waitMs / 1000).toFixed(0)}s | ${r.comparison ? r.comparison.mismatches.length : "-"} | ${r.digest ? `\`${r.digest.slice(0, 16)}\`` : "-"}${r.error ? ` (${r.error})` : ""} |`,
    );
  }
  lines.push("");
  lines.push("## 샘플 × 기준 판정 (1회차)");
  lines.push("");
  lines.push(
    summary.phase === 2
      ? "셀은 `기대 → 실제 ✓/✗`다. EXECUTION·STATIC 기준은 기대 결과표, MUTATION(G1~G3)은 T-403 전이라 INCONCLUSIVE, HUMAN_REVIEW(R-12)는 사람 확인 전이라 INCONCLUSIVE를 기대한다. 점수 표시는 기대 결과표의 `withoutMutationStage`와 대조한다."
      : "셀은 `기대 → 실제 ✓/✗`다. EXECUTION·STATIC·MUTATION(G1~G3) 기준은 기대 결과표를 따르고, HUMAN_REVIEW(R-12)는 사람 확인 전이라 INCONCLUSIVE를 기대한다. 점수 표시는 기대 결과표의 `beforeHumanReview`와 대조한다.",
  );
  lines.push("");
  lines.push(renderTable(rubric, summary.runs));
  lines.push("");
  lines.push("## 불일치");
  lines.push("");
  const mismatches = summary.runs.flatMap((r) => [
    ...(r.comparison?.mismatches ?? []).map((m) => `- ${r.sampleId} ${r.round}회차: ${m}`),
    ...(r.error ? [`- ${r.sampleId} ${r.round}회차: ${r.error}`] : []),
  ]);
  lines.push(mismatches.length === 0 ? "없음" : mismatches.join("\n"));
  lines.push("");
  lines.push("## 결정성");
  lines.push("");
  lines.push(
    "판정 digest = sha256(환경 digest, harnessVersion, rubric 버전, 고정 SHA, 저장 점수, 기준별 verdict·earnedPoints·issueId·reviewState·근거 수(LLM 추정 근거 제외), 단계 상태, 기동 결과, 하네스 케이스별 verdict·failureKind·expected·actual·checks, 제출 테스트 상태·개수·파일별 테스트 이름과 상태). 시각·소요 시간·포트·주문 id·레코드 ID는 제외한다.",
  );
  lines.push("");
  const bySample = new Map<SampleId, SubmissionRun[]>();
  for (const r of summary.runs) bySample.set(r.sampleId, [...(bySample.get(r.sampleId) ?? []), r]);
  const maxRound = Math.max(1, ...summary.runs.map((r) => r.round));
  const roundHeaders = Array.from({ length: maxRound }, (_, i) => `${i + 1}회차`);
  lines.push(`| 샘플 | ${roundHeaders.join(" | ")} | 동일 |`);
  lines.push(`|---|${roundHeaders.map(() => "---").join("|")}|---|`);
  for (const [sampleId, list] of bySample) {
    const cells = roundHeaders.map((_, i) => {
      const r = list.find((x) => x.round === i + 1);
      return r?.digest ? `\`${r.digest.slice(0, 16)}\`` : "-";
    });
    const digests = new Set(list.map((r) => r.digest).filter(Boolean));
    lines.push(
      `| ${sampleId} | ${cells.join(" | ")} | ${list.length > 1 ? (digests.size === 1 ? "✓" : "✗") : "(1회)"} |`,
    );
  }
  if (summary.determinismProblems.length > 0) {
    lines.push("");
    lines.push(summary.determinismProblems.map((p) => `- ${p}`).join("\n"));
  }
  lines.push("");
  lines.push("## 미지원 저장소");
  lines.push("");
  if (summary.unsupported) {
    const u = summary.unsupported;
    lines.push(`- 저장소: ${u.repoUrl}`);
    lines.push(`- 제출 ID: \`${u.submissionId}\` · 상태: ${u.status}`);
    lines.push(`- 사유(API): ${u.unsupportedReason ? `\`${u.unsupportedReason}\`` : "없음"}`);
    lines.push(
      `- 기대 사유 코드 \`${u.expectedReasonCode}\`: API ${u.apiOk ? "✓" : "✗"} · 화면 HTML(\`/submissions/<id>\`) ${u.htmlOk ? "✓" : "✗"}`,
    );
    if (u.problems.length > 0) lines.push(u.problems.map((p) => `- 문제: ${p}`).join("\n"));
  } else {
    lines.push("건너뜀 (`--skip-unsupported`)");
  }
  return lines.join("\n");
}

export function gateResultJson(summary: GateRunSummary): unknown {
  return {
    gate: "phase2",
    ok: summary.ok,
    phase: summary.phase,
    baseUrl: summary.baseUrl,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    totalMs: summary.totalMs,
    assignmentVersion: summary.assignmentVersion,
    runs: summary.runs.map((r) => ({
      sampleId: r.sampleId,
      round: r.round,
      submissionId: r.submissionId,
      evaluationId: r.evaluationId,
      status: r.status,
      waitMs: r.waitMs,
      scoreDisplay: r.comparison?.scoreDisplay ?? null,
      mismatches: r.comparison?.mismatches ?? [],
      digest: r.digest,
      error: r.error ?? null,
    })),
    determinismProblems: summary.determinismProblems,
    unsupported: summary.unsupported,
  };
}

function usage(): never {
  console.error(
    "사용법: gate:phase2 --base-url <url> [--password <pw>] [--phase 2|4|5] [--repeat <n>] [--repeat-samples A,C] [--samples A,B,C,D] [--skip-unsupported] [--out <file>] [--json <file>] [--repos <path>] [--matrix <path>] [--timeout-ms <ms>] [--poll-ms <ms>]",
  );
  process.exit(1);
}

function parseSampleIds(value: string): SampleId[] {
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as SampleId[];
  if (ids.length === 0 || ids.some((id) => !(SAMPLE_IDS as readonly string[]).includes(id)))
    usage();
  return ids;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "base-url": { type: "string" },
      password: { type: "string" },
      phase: { type: "string", default: String(DEFAULT_PHASE) },
      repeat: { type: "string", default: String(DEFAULT_REPEAT) },
      "repeat-samples": { type: "string", default: DEFAULT_REPEAT_SAMPLES.join(",") },
      samples: { type: "string", default: SAMPLE_IDS.join(",") },
      "skip-unsupported": { type: "boolean", default: false },
      out: { type: "string", default: DEFAULT_OUT },
      json: { type: "string", default: DEFAULT_JSON_OUT },
      repos: { type: "string", default: DEFAULT_REPOS },
      matrix: { type: "string", default: path.join(SAMPLE_DIR, "expected-matrix.json") },
      "timeout-ms": { type: "string", default: String(DEFAULT_SUBMISSION_TIMEOUT_MS) },
      "poll-ms": { type: "string", default: String(DEFAULT_POLL_MS) },
    },
    strict: true,
  });
  const baseUrl = values["base-url"];
  if (!baseUrl) usage();
  // 공개 배포는 비밀번호 없이 조회·제출한다. 보호가 켜진 배포에 비밀번호를 주지 않으면 첫 API 호출이 401로 끝난다
  const password = values.password ?? process.env.APP_ACCESS_PASSWORD ?? null;
  if (!password) console.log("접근 비밀번호가 없어 로그인하지 않습니다 (공개 배포로 간주)");
  const repeat = Number(values.repeat);
  const timeoutMs = Number(values["timeout-ms"]);
  const pollMs = Number(values["poll-ms"]);
  if (![repeat, timeoutMs, pollMs].every((n) => Number.isInteger(n) && n > 0)) usage();
  const phase = Number(values.phase) as GatePhase;
  if (!GATE_PHASES.includes(phase)) usage();

  const options: GateOptions = {
    baseUrl,
    password,
    phase,
    sampleIds: parseSampleIds(values.samples),
    repeat,
    repeatSamples: parseSampleIds(values["repeat-samples"]),
    skipUnsupported: values["skip-unsupported"],
    reposPath: path.resolve(values.repos),
    matrixPath: path.resolve(values.matrix),
    timeoutMs,
    pollMs,
    log: (line) => console.log(`  ${line}`),
  };
  console.log(
    `gate:phase2 시작 — ${baseUrl}, 기대값 ${phase}단계, 샘플 ${options.sampleIds.join(", ")}, 반복 ${options.repeatSamples.join(", ")} × ${repeat}회${options.skipUnsupported ? "" : ", 미지원 저장소 검사"}`,
  );
  const { summary, rubric } = await runGate(options);

  console.log("");
  console.log(renderTable(rubric, summary.runs));
  console.log("");
  for (const r of summary.runs) {
    for (const m of r.comparison?.mismatches ?? [])
      console.error(`  불일치 ${r.sampleId} ${r.round}회차: ${m}`);
    if (r.error) console.error(`  오류 ${r.sampleId} ${r.round}회차: ${r.error}`);
  }
  for (const p of summary.determinismProblems) console.error(`  비결정성 ${p}`);
  for (const p of summary.unsupported?.problems ?? []) console.error(`  미지원 검사 ${p}`);

  const outPath = path.resolve(values.out);
  const markdown = await prettierFormat(`${renderReport(rubric, summary)}\n`, {
    ...((await prettierResolveConfig(outPath)) ?? {}),
    parser: "markdown",
  });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, markdown, "utf8");
  const jsonPath = path.resolve(values.json);
  const json = await prettierFormat(JSON.stringify(gateResultJson(summary)), {
    ...((await prettierResolveConfig(jsonPath)) ?? {}),
    parser: "json",
  });
  await writeFile(jsonPath, json, "utf8");
  console.log(
    `gate:phase2 ${summary.ok ? "OK" : "실패"} — ${(summary.totalMs / 1000 / 60).toFixed(1)}분, 기록 ${path.relative(process.cwd(), outPath)}, 요약 ${path.relative(process.cwd(), jsonPath)}`,
  );
  process.exit(summary.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`gate:phase2 오류: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
  });
}
