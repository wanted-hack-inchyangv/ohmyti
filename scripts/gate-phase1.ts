/**
 * 1단계 게이트 (T-110): DB·LLM 없이 러너(T-108) + 하네스(T-107) + 제출 테스트 실행기(T-109)만으로
 * 샘플 A/B/C/D를 `expected-matrix.json`대로 구분하는지 확인하고, 같은 절차를 여러 번 반복해 결정성을 검증한다.
 *
 * 샘플마다: 스냅샷 생성 → `prepare` → `startService`(기동 관측) → 하네스 → `stop` → 제출 테스트 → `destroy`.
 * 기준별 verdict는 하네스 케이스 결과에서 결정적으로 유도한다 (G-01). 제출 테스트 결과는 리포터 파일에서만 온다 (G-07).
 *
 * 사용: `pnpm gate:phase1 [--rounds 3] [--out docs/gates/phase1.md] [--json docs/gates/phase1.json] [--matrix <path>] [--samples A,B]`
 * `--json`의 결과 요약은 `pnpm db:seed:sample`(T-201)이 과제 버전의 `validation_result`로 저장한다.
 * 종료 코드: 0 = 모든 샘플이 기대와 일치하고 반복 결과가 동일. 1 = 불일치·비결정성·환경 오류.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import "./load-env";
import { format as prettierFormat, resolveConfig as prettierResolveConfig } from "prettier";
import {
  ExecutionContractSchema,
  RubricSchema,
  validateRubric,
  type ExecutionContract,
  type Rubric,
  type Verdict,
} from "@ohmyti/core";
import {
  checkCoverage,
  deriveCriteria,
  getCaseSet,
  DEFAULT_CASE_SET,
  requestTimeoutFromEnv,
  runHarness,
  type DerivedCriterion,
  type HarnessReport,
} from "@ohmyti/harness";
import {
  createRunnerFromEnv,
  packDirectoryToTarGz,
  runSubmittedTests,
  ServiceStartError,
  type PreparedEnv,
  type SandboxRunner,
  type ServiceStartupObservation,
  type SubmittedTestResult,
} from "@ohmyti/runner";
import { FsArtifactStore } from "@ohmyti/storage";
import {
  ExpectedMatrixSchema,
  SAMPLE_DIR,
  SAMPLE_IDS,
  type ExpectedMatrix,
  type ExpectedSample,
} from "./samples-check";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATE_ROOT = path.join(repoRoot, "templates");
export const DEFAULT_ROUNDS = 3;
export const DEFAULT_OUT = path.join(repoRoot, "docs", "gates", "phase1.md");
export const DEFAULT_JSON_OUT = path.join(repoRoot, "docs", "gates", "phase1.json");
/** 인수 기준: 총 실행 시간 10분 이내 */
export const MAX_TOTAL_MS = 10 * 60 * 1000;

export type SampleId = (typeof SAMPLE_IDS)[number];
/** 기준 판정 규칙은 `@ohmyti/harness`의 `derive.ts`로 옮겼다 (T-204 오케스트레이터와 공유). 게이트 테스트 호환용 재수출 */
export {
  CONTRACT_AREA,
  deriveCriteria,
  foldVerdicts,
  type DerivedCriterion,
} from "@ohmyti/harness";

/** 샘플 하나를 한 번 실행한 관측 결과 */
export interface SampleObservation {
  sampleId: SampleId;
  round: number;
  environmentDigest: string;
  harnessVersion: string | null;
  startup: ServiceStartupObservation | null;
  /** 기동 실패 등으로 하네스를 돌리지 못했으면 null */
  harness: HarnessReport | null;
  tests: SubmittedTestResult | null;
  /** 환경 오류 (스냅샷·기동·러너 예외). 판정 불일치와 구분한다 (G-11) */
  environmentError?: string;
  durationMs: number;
}

export interface CriterionRow {
  criterionId: string;
  method: string;
  expected: { verdict: Verdict; earnedPoints: number | null } | null;
  actual: DerivedCriterion | null;
  /** 이 게이트가 판정하는 기준인지 (EXECUTION만) */
  inScope: boolean;
  ok: boolean | null;
}

export interface SampleComparison {
  sampleId: SampleId;
  rows: CriterionRow[];
  tests: {
    expected: ExpectedSample["submittedTests"];
    actual: { status: string; total: number; files: number } | null;
    ok: boolean;
  };
  mismatches: string[];
}

export interface RoundDigest {
  sampleId: SampleId;
  round: number;
  digest: string;
}

/** 유도된 판정·제출 테스트 결과를 기대 결과표와 대조한다 */
export function compareSample(
  rubric: Rubric,
  expected: ExpectedSample,
  derived: readonly DerivedCriterion[],
  tests: SubmittedTestResult | null,
): SampleComparison {
  const mismatches: string[] = [];
  const byId = new Map(derived.map((d) => [d.criterionId, d]));
  const rows: CriterionRow[] = rubric.criteria.map((criterion) => {
    const exp = expected.criteria[criterion.id];
    const expectedCell = exp ? { verdict: exp.verdict, earnedPoints: exp.earnedPoints } : null;
    const actual = byId.get(criterion.id) ?? null;
    const inScope = criterion.method === "EXECUTION";
    if (!inScope) {
      return {
        criterionId: criterion.id,
        method: criterion.method,
        expected: expectedCell,
        actual,
        inScope,
        ok: null,
      };
    }
    let ok = false;
    if (!expectedCell) {
      mismatches.push(`${criterion.id}: expected-matrix에 기대 판정이 없음`);
    } else if (!actual) {
      mismatches.push(`${criterion.id}: 유도된 판정이 없음`);
    } else if (
      actual.verdict !== expectedCell.verdict ||
      actual.earnedPoints !== expectedCell.earnedPoints
    ) {
      mismatches.push(
        `${criterion.id}: 기대 ${expectedCell.verdict}(${expectedCell.earnedPoints ?? "null"}) ≠ 실제 ${actual.verdict}(${actual.earnedPoints ?? "null"})${actual.reason ? ` — ${actual.reason}` : ""}`,
      );
    } else {
      ok = true;
    }
    return {
      criterionId: criterion.id,
      method: criterion.method,
      expected: expectedCell,
      actual,
      inScope,
      ok,
    };
  });

  const actualTests = tests
    ? { status: tests.status, total: tests.total, files: tests.testFiles.length }
    : null;
  const testsOk =
    actualTests !== null &&
    actualTests.status === expected.submittedTests.status &&
    actualTests.total === expected.submittedTests.total &&
    actualTests.files === expected.submittedTests.files;
  if (!testsOk) {
    mismatches.push(
      `제출 테스트: 기대 ${expected.submittedTests.status} ${expected.submittedTests.total}건/${expected.submittedTests.files}파일 ≠ 실제 ${
        actualTests
          ? `${actualTests.status} ${actualTests.total}건/${actualTests.files}파일${tests?.reason ? ` — ${tests.reason}` : ""}`
          : "없음"
      }`,
    );
  }

  return {
    sampleId: expected.id,
    rows,
    tests: { expected: expected.submittedTests, actual: actualTests, ok: testsOk },
    mismatches,
  };
}

/** 정렬된 키로 직렬화해 값이 같으면 문자열도 같게 한다 */
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

/**
 * 판정에 영향을 주는 부분만 모아 sha256으로 만든다. 시각·소요 시간·포트·무작위 주문 id가 든 timeline은 제외한다.
 * 반복 실행의 digest가 모두 같아야 결정적이다.
 */
export function judgementDigest(observation: SampleObservation): string {
  const harness = observation.harness
    ? {
        harnessVersion: observation.harness.harnessVersion,
        results: observation.harness.results.map((r) => ({
          caseId: r.caseId,
          criterionIds: r.criterionIds,
          verdict: r.verdict,
          failureKind: r.failureKind,
          expected: r.expected,
          actual: r.actual,
          checks: r.checks,
        })),
      }
    : null;
  const tests = observation.tests
    ? {
        status: observation.tests.status,
        failureKind: observation.tests.failureKind,
        framework: observation.tests.framework,
        total: observation.tests.total,
        passed: observation.tests.passed,
        failed: observation.tests.failed,
        skipped: observation.tests.skipped,
        files: observation.tests.testFiles.map((f) => ({
          path: f.path,
          status: f.status,
          total: f.total,
          passed: f.passed,
          failed: f.failed,
          skipped: f.skipped,
          tests: f.tests.map((t) => ({ fullName: t.fullName, status: t.status })),
        })),
      }
    : null;
  const payload = {
    environmentDigest: observation.environmentDigest,
    startup: observation.startup
      ? {
          outcome: observation.startup.outcome,
          lastHealthStatus: observation.startup.lastHealthStatus,
        }
      : null,
    harness,
    tests,
    environmentError: observation.environmentError ?? null,
  };
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** 샘플별로 모든 회차의 digest가 같은지 확인한다. 다른 샘플은 사유 문자열로 돌려준다 */
export function checkDeterminism(digests: readonly RoundDigest[]): string[] {
  const problems: string[] = [];
  const bySample = new Map<SampleId, RoundDigest[]>();
  for (const d of digests) {
    const list = bySample.get(d.sampleId) ?? [];
    list.push(d);
    bySample.set(d.sampleId, list);
  }
  for (const [sampleId, list] of bySample) {
    const distinct = new Set(list.map((d) => d.digest));
    if (distinct.size > 1) {
      problems.push(
        `${sampleId}: 회차별 판정 digest가 다름 (${list.map((d) => `${d.round}회차 ${d.digest.slice(0, 16)}`).join(", ")})`,
      );
    }
  }
  return problems;
}

function verdictCell(verdict: Verdict, points: number | null): string {
  return `${verdict}${points === null ? "" : ` ${points}`}`;
}

/** 샘플 × 기준 verdict 표 (마크다운). 열: 기준, 샘플별 `기대 → 실제 ✓/✗` */
export function renderTable(rubric: Rubric, comparisons: readonly SampleComparison[]): string {
  const ids = comparisons.map((c) => c.sampleId);
  const header = `| 기준 | method | 배점 | ${ids.map((id) => `${id} (기대 → 실제)`).join(" | ")} |`;
  const sep = `|---|---|---:|${ids.map(() => "---").join("|")}|`;
  const lines = [header, sep];
  for (const [index, criterion] of rubric.criteria.entries()) {
    const cells = comparisons.map((c) => {
      const row = c.rows[index]!;
      if (!row.inScope) {
        const exp = row.expected
          ? verdictCell(row.expected.verdict, row.expected.earnedPoints)
          : "-";
        return `${exp} → (범위 밖)`;
      }
      const exp = row.expected ? verdictCell(row.expected.verdict, row.expected.earnedPoints) : "-";
      const act = row.actual ? verdictCell(row.actual.verdict, row.actual.earnedPoints) : "-";
      return `${exp} → ${act} ${row.ok ? "✓" : "✗"}`;
    });
    lines.push(
      `| ${criterion.id} | ${criterion.method} | ${criterion.maxPoints} | ${cells.join(" | ")} |`,
    );
  }
  const testCells = comparisons.map((c) => {
    const e = c.tests.expected;
    const a = c.tests.actual;
    const exp = `${e.status} ${e.total}건/${e.files}파일`;
    const act = a ? `${a.status} ${a.total}건/${a.files}파일` : "-";
    return `${exp} → ${act} ${c.tests.ok ? "✓" : "✗"}`;
  });
  lines.push(`| 제출 테스트 | T-109 | - | ${testCells.join(" | ")} |`);
  return lines.join("\n");
}

export interface GateRunSummary {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  rounds: number;
  nodeVersion: string;
  runnerKind: string;
  environmentDigest: string | null;
  harnessVersion: string | null;
  rubricVersion: string;
  matrixPath: string;
  observations: SampleObservation[];
  /** 마지막 회차 기준 대조 (모든 회차가 같은 digest이므로 어느 회차든 같다) */
  comparisons: SampleComparison[];
  digests: RoundDigest[];
  determinismProblems: string[];
  environmentErrors: string[];
  ok: boolean;
}

/**
 * 승인 근거로 DB(`assignment_versions.validation_result`)에 저장하는 요약. 관측 원문(하네스 요청·응답 본문)은
 * 빼고, 샘플별 기대·실제 대조와 결정성 결과만 담는다. 경로는 저장소 기준 상대 경로로 바꿔 머신 의존 값을 없앤다.
 */
export interface GateResultJson {
  gate: "phase1";
  ticket: "T-110";
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  rounds: number;
  nodeVersion: string;
  runnerKind: string;
  environmentDigest: string | null;
  harnessVersion: string | null;
  rubricVersion: string;
  matrixPath: string;
  comparisons: SampleComparison[];
  digests: RoundDigest[];
  determinismProblems: string[];
  environmentErrors: string[];
}

export function gateResultJson(summary: GateRunSummary, root: string = repoRoot): GateResultJson {
  const relativeMatrix = path.relative(root, summary.matrixPath);
  return {
    gate: "phase1",
    ticket: "T-110",
    ok: summary.ok,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    totalMs: summary.totalMs,
    rounds: summary.rounds,
    nodeVersion: summary.nodeVersion,
    runnerKind: summary.runnerKind,
    environmentDigest: summary.environmentDigest,
    harnessVersion: summary.harnessVersion,
    rubricVersion: summary.rubricVersion,
    matrixPath: relativeMatrix.startsWith("..") ? summary.matrixPath : relativeMatrix,
    comparisons: summary.comparisons,
    digests: summary.digests,
    determinismProblems: summary.determinismProblems,
    environmentErrors: summary.environmentErrors,
  };
}

export function renderReport(rubric: Rubric, summary: GateRunSummary): string {
  const lines: string[] = [];
  lines.push("# 1단계 게이트: 샘플 판별과 결정성 검증 (T-110)");
  lines.push("");
  lines.push(
    "`pnpm gate:phase1`이 만든 기록이다. DB·LLM 없이 러너(T-108) + 하네스(T-107) + 제출 테스트 실행기(T-109)만으로 샘플 A/B/C/D를 `samples/order-api/expected-matrix.json`과 대조하고, 같은 절차를 반복해 판정 digest가 같은지 확인한다.",
  );
  lines.push("");
  lines.push(`- 결과: **${summary.ok ? "통과" : "실패"}**`);
  lines.push(
    `- 실행 일시: ${summary.startedAt} ~ ${summary.finishedAt} (총 ${(summary.totalMs / 1000).toFixed(1)}초, 상한 ${MAX_TOTAL_MS / 60000}분)`,
  );
  lines.push(`- 반복 횟수: ${summary.rounds}`);
  lines.push(`- 러너: ${summary.runnerKind} (Node ${summary.nodeVersion})`);
  lines.push(`- environmentDigest: \`${summary.environmentDigest ?? "-"}\``);
  lines.push(`- harnessVersion: \`${summary.harnessVersion ?? "-"}\``);
  lines.push(
    `- rubric: ${summary.rubricVersion} · 기대 결과표: \`${path.relative(repoRoot, summary.matrixPath)}\``,
  );
  lines.push("");
  lines.push("## 샘플 × 기준 판정");
  lines.push("");
  lines.push(
    "셀은 `기대 → 실제 ✓/✗`다. 이 게이트는 EXECUTION 기준(R-01~R-10)과 제출 테스트 결과만 판정한다. MUTATION(G1~G3)은 T-403, STATIC(R-11)은 T-205, HUMAN_REVIEW(R-12)는 T-306의 범위다.",
  );
  lines.push("");
  lines.push(renderTable(rubric, summary.comparisons));
  lines.push("");
  const mismatches = summary.comparisons.flatMap((c) =>
    c.mismatches.map((m) => `- ${c.sampleId} ${m}`),
  );
  lines.push("## 불일치");
  lines.push("");
  lines.push(mismatches.length === 0 ? "없음" : mismatches.join("\n"));
  lines.push("");
  lines.push("## 결정성");
  lines.push("");
  lines.push(
    "판정 digest = sha256(환경 digest, 기동 결과, 하네스 케이스별 verdict·failureKind·expected·actual·checks, 제출 테스트 상태·개수·파일별 테스트 이름과 상태). 시각·소요 시간·포트·주문 id는 제외한다.",
  );
  lines.push("");
  lines.push(
    "| 샘플 | " +
      Array.from({ length: summary.rounds }, (_, i) => `${i + 1}회차`).join(" | ") +
      " | 동일 |",
  );
  lines.push("|---|" + Array.from({ length: summary.rounds }, () => "---").join("|") + "|---|");
  for (const sampleId of summary.comparisons.map((c) => c.sampleId)) {
    const list = summary.digests
      .filter((d) => d.sampleId === sampleId)
      .sort((a, b) => a.round - b.round);
    const same = new Set(list.map((d) => d.digest)).size === 1;
    lines.push(
      `| ${sampleId} | ${list.map((d) => `\`${d.digest.slice(0, 16)}\``).join(" | ")} | ${same ? "✓" : "✗"} |`,
    );
  }
  lines.push("");
  if (summary.determinismProblems.length > 0) {
    lines.push(summary.determinismProblems.map((p) => `- ${p}`).join("\n"));
    lines.push("");
  }
  lines.push("## 회차별 소요 시간");
  lines.push("");
  lines.push(
    "| 샘플 | " +
      Array.from({ length: summary.rounds }, (_, i) => `${i + 1}회차`).join(" | ") +
      " | 기동(ms) | 하네스 | 제출 테스트 |",
  );
  lines.push(
    "|---|" + Array.from({ length: summary.rounds }, () => "---:").join("|") + "|---:|---|---|",
  );
  for (const sampleId of summary.comparisons.map((c) => c.sampleId)) {
    const obs = summary.observations
      .filter((o) => o.sampleId === sampleId)
      .sort((a, b) => a.round - b.round);
    const last = obs[obs.length - 1];
    const harnessSummary = last?.harness
      ? `PASS ${last.harness.summary.pass} · FAIL ${last.harness.summary.fail} · INCONCLUSIVE ${last.harness.summary.inconclusive}`
      : "-";
    const testsSummary = last?.tests
      ? `${last.tests.status} ${last.tests.passed}/${last.tests.total} (${last.tests.testFiles.length}파일)`
      : "-";
    lines.push(
      `| ${sampleId} | ${obs.map((o) => `${(o.durationMs / 1000).toFixed(1)}s`).join(" | ")} | ${last?.startup?.elapsedMs ?? "-"} | ${harnessSummary} | ${testsSummary} |`,
    );
  }
  lines.push("");
  if (summary.environmentErrors.length > 0) {
    lines.push("## 환경 오류");
    lines.push("");
    lines.push(summary.environmentErrors.map((e) => `- ${e}`).join("\n"));
    lines.push("");
  }
  return lines.join("\n");
}

interface GateContext {
  rubric: Rubric;
  contract: ExecutionContract;
  matrix: ExpectedMatrix;
  runner: SandboxRunner;
  store: FsArtifactStore;
  sampleDir: string;
  requestTimeoutMs: number;
  log: (line: string) => void;
}

async function observeSample(
  ctx: GateContext,
  sample: ExpectedSample,
  round: number,
): Promise<SampleObservation> {
  const started = Date.now();
  const key = `gate/phase1/${sample.id}/round-${round}/snapshot.tar.gz`;
  const bytes = await packDirectoryToTarGz(path.join(ctx.sampleDir, sample.dir));
  await ctx.store.put(key, bytes, { contentType: "application/gzip" });

  let env: PreparedEnv | null = null;
  let startup: ServiceStartupObservation | null = null;
  let harness: HarnessReport | null = null;
  let tests: SubmittedTestResult | null = null;
  let environmentError: string | undefined;
  let environmentDigest = "";
  try {
    env = await ctx.runner.prepare(key, ctx.contract, {
      logKeyPrefix: `gate/phase1/${sample.id}/round-${round}/logs/`,
    });
    environmentDigest = env.environmentDigest;
    try {
      const service = await ctx.runner.startService(env);
      startup = service.startup;
      try {
        harness = await runHarness(getCaseSet(DEFAULT_CASE_SET), {
          baseUrl: service.baseUrl,
          timeoutMs: ctx.requestTimeoutMs,
          ...(ctx.contract.resetPath ? { resetPath: ctx.contract.resetPath } : {}),
          caseSet: DEFAULT_CASE_SET,
          rubric: ctx.rubric,
        });
      } finally {
        await service.stop();
      }
    } catch (error) {
      if (error instanceof ServiceStartError) startup = error.startup;
      else throw error;
    }
    tests = await runSubmittedTests(ctx.runner, env);
  } catch (error) {
    environmentError = `${sample.id} ${round}회차: ${(error as Error).message}`;
  } finally {
    if (env) await ctx.runner.destroy(env);
  }
  return {
    sampleId: sample.id,
    round,
    environmentDigest,
    harnessVersion: harness?.harnessVersion ?? null,
    startup,
    harness,
    tests,
    ...(environmentError ? { environmentError } : {}),
    durationMs: Date.now() - started,
  };
}

export interface RunGateOptions {
  rounds: number;
  matrixPath: string;
  sampleIds: readonly SampleId[];
  sampleDir?: string;
  log?: (line: string) => void;
}

export async function runGate(
  options: RunGateOptions,
): Promise<{ summary: GateRunSummary; rubric: Rubric }> {
  const log = options.log ?? (() => {});
  const sampleDir = options.sampleDir ?? SAMPLE_DIR;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const rubric = RubricSchema.parse(
    JSON.parse(await readFile(path.join(sampleDir, "rubric.v1.json"), "utf8")),
  );
  const validation = validateRubric(rubric);
  if (!validation.ok) {
    throw new Error(`rubric 검증 실패: ${validation.errors.map((e) => e.message).join("; ")}`);
  }
  const contract = ExecutionContractSchema.parse(
    JSON.parse(await readFile(path.join(sampleDir, "execution-contract.json"), "utf8")),
  );
  const matrix = ExpectedMatrixSchema.parse(JSON.parse(await readFile(options.matrixPath, "utf8")));
  const coverage = checkCoverage(getCaseSet(DEFAULT_CASE_SET), rubric);
  if (!coverage.ok) throw new Error("하네스 케이스 커버리지 검사 실패 (`pnpm harness:coverage`)");

  const samples = options.sampleIds.map((id) => {
    const sample = matrix.samples.find((s) => s.id === id);
    if (!sample) throw new Error(`expected-matrix에 샘플 ${id}가 없습니다`);
    return sample;
  });

  const workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-gate-phase1-"));
  const store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
  // 러너는 `SANDBOX_RUNNER`(기본 local)로 고른다. `vercel`이면 `.env.local`의 VERCEL_* 자격증명이 필요하다 (T-209)
  const runner = createRunnerFromEnv(
    {
      ...process.env,
      TEMPLATE_ROOT: TEMPLATE_ROOT,
      SANDBOX_WORK_ROOT: path.join(workRoot, "work"),
    },
    { artifactStore: store },
  );
  const ctx: GateContext = {
    rubric,
    contract,
    matrix,
    runner,
    store,
    sampleDir,
    requestTimeoutMs: requestTimeoutFromEnv(),
    log,
  };

  const observations: SampleObservation[] = [];
  const digests: RoundDigest[] = [];
  try {
    for (let round = 1; round <= options.rounds; round += 1) {
      for (const sample of samples) {
        const observation = await observeSample(ctx, sample, round);
        observations.push(observation);
        const digest = judgementDigest(observation);
        digests.push({ sampleId: sample.id, round, digest });
        const derived = deriveCriteria(rubric, observation.harness, observation.startup);
        const comparison = compareSample(rubric, sample, derived, observation.tests);
        log(
          `[${round}/${options.rounds}] ${sample.id} ${(observation.durationMs / 1000).toFixed(1)}s · 기동 ${observation.startup?.outcome ?? "-"} · 하네스 ${
            observation.harness
              ? `PASS ${observation.harness.summary.pass}/FAIL ${observation.harness.summary.fail}/INC ${observation.harness.summary.inconclusive}`
              : "-"
          } · 테스트 ${observation.tests ? `${observation.tests.status} ${observation.tests.total}` : "-"} · 불일치 ${comparison.mismatches.length} · digest ${digest.slice(0, 16)}${observation.environmentError ? ` · 환경 오류: ${observation.environmentError}` : ""}`,
        );
      }
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }

  const lastRound = observations.filter((o) => o.round === options.rounds);
  const comparisons = samples.map((sample) => {
    const observation = lastRound.find((o) => o.sampleId === sample.id)!;
    const derived = deriveCriteria(rubric, observation.harness, observation.startup);
    return compareSample(rubric, sample, derived, observation.tests);
  });
  // 어느 회차든 불일치가 있으면 실패다 (마지막 회차만 보면 앞 회차의 불일치를 놓친다)
  const allRoundMismatches = observations.flatMap((observation) => {
    const sample = samples.find((s) => s.id === observation.sampleId)!;
    const derived = deriveCriteria(rubric, observation.harness, observation.startup);
    return compareSample(rubric, sample, derived, observation.tests).mismatches;
  });
  const determinismProblems = checkDeterminism(digests);
  const environmentErrors = observations.flatMap((o) =>
    o.environmentError ? [o.environmentError] : [],
  );
  const finishedAtMs = Date.now();
  const totalMs = finishedAtMs - startedAtMs;
  const environmentDigests = new Set(observations.map((o) => o.environmentDigest).filter(Boolean));
  const harnessVersions = new Set(observations.map((o) => o.harnessVersion).filter(Boolean));
  const ok =
    allRoundMismatches.length === 0 &&
    determinismProblems.length === 0 &&
    environmentErrors.length === 0 &&
    environmentDigests.size === 1 &&
    harnessVersions.size === 1 &&
    totalMs <= MAX_TOTAL_MS;

  const summary: GateRunSummary = {
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    totalMs,
    rounds: options.rounds,
    nodeVersion: process.version,
    runnerKind: runner.kind,
    environmentDigest: environmentDigests.size === 1 ? [...environmentDigests][0]! : null,
    harnessVersion: harnessVersions.size === 1 ? ([...harnessVersions][0] as string) : null,
    rubricVersion: rubric.version,
    matrixPath: options.matrixPath,
    observations,
    comparisons,
    digests,
    determinismProblems,
    environmentErrors,
    ok,
  };
  return { summary, rubric };
}

function usage(): never {
  console.error(
    "사용법: gate:phase1 [--rounds <n>] [--out <file>] [--json <file>] [--matrix <path>] [--samples A,B,C,D]",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      rounds: { type: "string", default: String(DEFAULT_ROUNDS) },
      out: { type: "string", default: DEFAULT_OUT },
      json: { type: "string", default: DEFAULT_JSON_OUT },
      matrix: { type: "string", default: path.join(SAMPLE_DIR, "expected-matrix.json") },
      samples: { type: "string", default: SAMPLE_IDS.join(",") },
    },
    strict: true,
  });
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1) usage();
  const sampleIds = values.samples.split(",").map((s) => s.trim()) as SampleId[];
  if (sampleIds.some((id) => !(SAMPLE_IDS as readonly string[]).includes(id))) usage();

  console.log(
    `gate:phase1 시작 — 샘플 ${sampleIds.join(", ")} × ${rounds}회, 템플릿 ${TEMPLATE_ROOT}`,
  );
  const { summary, rubric } = await runGate({
    rounds,
    matrixPath: path.resolve(values.matrix),
    sampleIds,
    log: (line) => console.log(`  ${line}`),
  });

  console.log("");
  console.log(renderTable(rubric, summary.comparisons));
  console.log("");
  for (const c of summary.comparisons)
    for (const m of c.mismatches) console.error(`  불일치 ${c.sampleId} ${m}`);
  for (const p of summary.determinismProblems) console.error(`  비결정성 ${p}`);
  for (const e of summary.environmentErrors) console.error(`  환경 오류 ${e}`);
  if (summary.environmentDigest === null)
    console.error("  환경 digest가 회차·샘플 사이에 다릅니다");
  if (summary.harnessVersion === null)
    console.error("  harnessVersion이 회차·샘플 사이에 다르거나 없습니다");
  if (summary.totalMs > MAX_TOTAL_MS)
    console.error(`  총 실행 시간 ${summary.totalMs}ms가 상한 ${MAX_TOTAL_MS}ms를 넘었습니다`);

  // 기록 파일은 저장소의 prettier 설정으로 정렬해 `pnpm format:check`가 재생성 결과를 통과시키게 한다
  const outPath = path.resolve(values.out);
  const prettierOptions = (await prettierResolveConfig(outPath)) ?? {};
  const markdown = await prettierFormat(`${renderReport(rubric, summary)}\n`, {
    ...prettierOptions,
    parser: "markdown",
  });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, markdown, "utf8");

  // 시드(T-201)가 validation_result로 넣을 요약 JSON. 마크다운과 같은 실행에서 만든다
  const jsonPath = path.resolve(values.json);
  const json = await prettierFormat(JSON.stringify(gateResultJson(summary)), {
    ...((await prettierResolveConfig(jsonPath)) ?? {}),
    parser: "json",
  });
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, json, "utf8");
  console.log(
    `gate:phase1 ${summary.ok ? "OK" : "실패"} — ${(summary.totalMs / 1000).toFixed(1)}초, 기록 ${path.relative(process.cwd(), outPath)}, 요약 ${path.relative(process.cwd(), jsonPath)}`,
  );
  process.exit(summary.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`gate:phase1 오류: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
  });
}
