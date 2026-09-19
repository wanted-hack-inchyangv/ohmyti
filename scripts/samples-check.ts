/**
 * `samples/order-api/`의 명세·실행 계약·기준·기대 결과표가 서로 맞는지 대조한다 (T-101).
 *
 * - `rubric.v1.json`: `RubricSchema` 파싱 + `validateRubric()` 통과, 배점 합 100, HUMAN_REVIEW는 R-12 하나
 * - `execution-contract.json`: `ExecutionContractSchema` 파싱, 티켓이 정한 값(npm start, PORT, /health 10초, /admin/reset)
 * - `SPEC.md`의 엔드포인트 표·오류 코드 표에 있는 항목이 rubric 판정 조건에서 모두 참조된다
 * - `expected-matrix.json`: 샘플 A/B/C/D × 모든 기준 조합이 빠짐없고, 그룹의 mutation ID가 모두 있으며,
 *   기대 판정을 `aggregateScore()`로 집계한 표시 문자열이 기록된 값과 같다. `submittedTests`(기대 상태·개수)는
 *   여기서 형식만 확인하고 실제 실행 결과와의 대조는 T-110 게이트(`pnpm gate:phase1`)가 한다
 * - `reviewedBy`가 비어 있으면 실패가 아니라 경고다 (사람 확인 대기)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  aggregateScore,
  ExecutionContractSchema,
  MutationOutcomeSchema,
  ReviewStateSchema,
  RUBRIC_TOTAL_POINTS,
  RubricSchema,
  validateRubric,
  VerdictSchema,
  type CriterionResult,
  type ExecutionContract,
  type Rubric,
} from "@ohmyti/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SAMPLE_DIR = path.join(repoRoot, "samples", "order-api");

export const SAMPLE_IDS = ["A", "B", "C", "D"] as const;
export const HUMAN_REVIEW_CRITERION_IDS = ["R-12"] as const;

/** 티켓 T-101이 정한 실행 계약 값. */
export const EXPECTED_CONTRACT: ExecutionContract = {
  startCommand: "npm start",
  portEnv: "PORT",
  healthPath: "/health",
  healthTimeoutMs: 10_000,
  resetPath: "/admin/reset",
  templateName: "order-api-ts",
  nodeVersion: "22",
};

export const ExpectedCriterionSchema = z.strictObject({
  verdict: VerdictSchema,
  earnedPoints: z.int().min(0).nullable(),
  reviewState: ReviewStateSchema.optional(),
  issueId: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});
export type ExpectedCriterion = z.infer<typeof ExpectedCriterionSchema>;

export const ExpectedSubmittedTestsSchema = z.strictObject({
  status: z.enum(["PASSED", "FAILED", "NO_TESTS", "UNSUPPORTED_FRAMEWORK", "BUILD_FAIL"]),
  /** 테스트 수(skipped 포함)와 테스트 파일 수 */
  total: z.int().min(0),
  files: z.int().min(0),
});
export type ExpectedSubmittedTests = z.infer<typeof ExpectedSubmittedTestsSchema>;

export const ExpectedSampleSchema = z.strictObject({
  id: z.enum(SAMPLE_IDS),
  name: z.string().min(1),
  dir: z.string().min(1),
  ticket: z.string().regex(/^T-\d{3}$/),
  description: z.string().min(1),
  criteria: z.record(z.string().min(1), ExpectedCriterionSchema),
  mutations: z.record(z.string().min(1), MutationOutcomeSchema),
  /** 제출 테스트 실행기(T-109)가 기록해야 할 결과. T-110 게이트가 실제 실행 결과와 대조한다 */
  submittedTests: ExpectedSubmittedTestsSchema,
  scoreDisplay: z.strictObject({
    withoutMutationStage: z.string().min(1),
    beforeHumanReview: z.string().min(1),
  }),
});
export type ExpectedSample = z.infer<typeof ExpectedSampleSchema>;

export const ExpectedMatrixSchema = z.strictObject({
  rubricVersion: z.string().min(1),
  reviewedBy: z.string().min(1).nullable(),
  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  scoreDisplayNote: z.string().optional(),
  samples: z.array(ExpectedSampleSchema),
});
export type ExpectedMatrix = z.infer<typeof ExpectedMatrixSchema>;

export interface SpecInventory {
  /** `GET /health` 같은 `METHOD /path` 문자열 */
  endpoints: string[];
  /** `VALIDATION_ERROR` 같은 오류 코드 */
  errorCodes: string[];
}

export interface SampleCheckReport {
  errors: string[];
  warnings: string[];
  /** 통과한 검사 항목의 요약 */
  passed: string[];
}

/**
 * SPEC.md의 표 행에서 엔드포인트와 오류 코드를 뽑는다.
 * 엔드포인트 행: `| \`GET /health\` | 200 | ...`, 오류 코드 행: `| \`NOT_FOUND\` | 404 | ...`
 */
export function parseSpecInventory(markdown: string): SpecInventory {
  const endpoints = new Set<string>();
  const errorCodes = new Set<string>();
  for (const line of markdown.split("\n")) {
    const endpoint = /^\|\s*`((?:GET|POST|PUT|PATCH|DELETE) \/\S*)`\s*\|\s*\d{3}\s*\|/.exec(line);
    if (endpoint?.[1]) endpoints.add(endpoint[1]);
    const code = /^\|\s*`([A-Z][A-Z_]+)`\s*\|\s*\d{3}\s*\|/.exec(line);
    if (code?.[1]) errorCodes.add(code[1]);
  }
  return { endpoints: [...endpoints], errorCodes: [...errorCodes] };
}

function conditionMentions(rubric: Rubric, needle: string): boolean {
  return rubric.criteria.some((criterion) => criterion.condition.includes(needle));
}

function checkRubric(rubric: Rubric, report: SampleCheckReport): void {
  const validation = validateRubric(rubric);
  if (!validation.ok) {
    for (const error of validation.errors) report.errors.push(`rubric: ${error.message}`);
  } else {
    report.passed.push("validateRubric() 통과");
  }

  const total = rubric.criteria.reduce((sum, c) => sum + c.maxPoints, 0);
  if (total === RUBRIC_TOTAL_POINTS) report.passed.push(`배점 합계 ${total}`);
  else report.errors.push(`rubric: 배점 합계가 ${RUBRIC_TOTAL_POINTS}이 아닙니다 (${total})`);

  const humanReview = rubric.criteria.filter((c) => c.method === "HUMAN_REVIEW").map((c) => c.id);
  const expectedHuman = [...HUMAN_REVIEW_CRITERION_IDS];
  if (humanReview.join(",") === expectedHuman.join(",")) {
    report.passed.push(`HUMAN_REVIEW 기준은 ${expectedHuman.join(", ")}뿐`);
  } else {
    report.errors.push(
      `rubric: HUMAN_REVIEW 기준은 ${expectedHuman.join(", ")}뿐이어야 합니다 (현재 ${humanReview.join(", ") || "없음"})`,
    );
  }

  for (const criterion of rubric.criteria) {
    if (criterion.method === "MUTATION" && criterion.groupId === undefined) {
      report.errors.push(`rubric: MUTATION 기준 ${criterion.id}에 groupId가 없습니다`);
    }
  }

  const reason = rubric.independentReasons.find((r) =>
    ["R-05", "R-06", "R-07"].every((id) => r.criterionIds.includes(id)),
  );
  if (reason && reason.reason.length >= 40) {
    report.passed.push("R-05/R-06/R-07 independentReason 기록");
  } else {
    report.errors.push(
      "rubric: R-05/R-06/R-07을 모두 포함하는 independentReason이 없거나 설명이 짧습니다",
    );
  }
}

function checkContract(contract: ExecutionContract, report: SampleCheckReport): void {
  const mismatches = (Object.keys(EXPECTED_CONTRACT) as (keyof ExecutionContract)[]).filter(
    (key) => contract[key] !== EXPECTED_CONTRACT[key],
  );
  if (mismatches.length === 0) {
    report.passed.push("execution-contract.json이 티켓 값과 일치");
  } else {
    for (const key of mismatches) {
      report.errors.push(
        `execution-contract: ${key}가 ${JSON.stringify(EXPECTED_CONTRACT[key])}이어야 합니다 (현재 ${JSON.stringify(contract[key])})`,
      );
    }
  }
}

function checkSpecCoverage(spec: SpecInventory, rubric: Rubric, report: SampleCheckReport): void {
  if (spec.endpoints.length === 0) report.errors.push("SPEC.md: 엔드포인트 표를 찾지 못했습니다");
  if (spec.errorCodes.length === 0) report.errors.push("SPEC.md: 오류 코드 표를 찾지 못했습니다");

  const missingEndpoints = spec.endpoints.filter((e) => !conditionMentions(rubric, `\`${e}\``));
  const missingCodes = spec.errorCodes.filter((c) => !conditionMentions(rubric, `\`${c}\``));
  for (const e of missingEndpoints) {
    report.errors.push(`SPEC.md 엔드포인트 \`${e}\`를 참조하는 rubric 판정 조건이 없습니다`);
  }
  for (const c of missingCodes) {
    report.errors.push(`SPEC.md 오류 코드 \`${c}\`를 참조하는 rubric 판정 조건이 없습니다`);
  }
  if (missingEndpoints.length === 0 && missingCodes.length === 0) {
    report.passed.push(
      `SPEC 엔드포인트 ${spec.endpoints.length}개·오류 코드 ${spec.errorCodes.length}개가 모두 판정 조건에서 참조됨`,
    );
  }
}

/** 기대 판정 하나를 `aggregateScore()`가 받는 CriterionResult로 바꾼다. 감점 근거는 자리표시자 ID다. */
function toCriterionResult(
  rubric: Rubric,
  criterionId: string,
  expected: ExpectedCriterion,
): CriterionResult {
  const criterion = rubric.criteria.find((c) => c.id === criterionId)!;
  const deducted = expected.earnedPoints !== null && expected.earnedPoints < criterion.maxPoints;
  return {
    criterionId,
    rubricVersion: rubric.version,
    maxPoints: criterion.maxPoints,
    earnedPoints: expected.earnedPoints,
    verdict: expected.verdict,
    method: criterion.method,
    evidenceIds: deducted ? [`expected:${criterionId}`] : [],
    ...(expected.issueId !== undefined ? { issueId: expected.issueId } : {}),
    observation: expected.note ?? "expected-matrix",
    reviewState:
      expected.reviewState ?? (criterion.method === "HUMAN_REVIEW" ? "PENDING" : "NOT_REQUIRED"),
  };
}

function checkMatrix(matrix: ExpectedMatrix, rubric: Rubric, report: SampleCheckReport): void {
  if (matrix.rubricVersion !== rubric.version) {
    report.errors.push(
      `expected-matrix: rubricVersion(${matrix.rubricVersion})이 rubric(${rubric.version})과 다릅니다`,
    );
  }

  const sampleIds = matrix.samples.map((s) => s.id);
  for (const id of SAMPLE_IDS) {
    if (!sampleIds.includes(id)) report.errors.push(`expected-matrix: 샘플 ${id}가 없습니다`);
  }
  if (new Set(sampleIds).size !== sampleIds.length) {
    report.errors.push("expected-matrix: 샘플 ID가 중복됩니다");
  }

  const criterionIds = rubric.criteria.map((c) => c.id);
  const mutationIds = rubric.groups.flatMap((g) => g.mutationIds);
  const mutationCriterionIds = new Set(
    rubric.criteria.filter((c) => c.method === "MUTATION").map((c) => c.id),
  );

  for (const sample of matrix.samples) {
    const label = `expected-matrix 샘플 ${sample.id}`;
    for (const id of criterionIds) {
      if (!(id in sample.criteria))
        report.errors.push(`${label}: 기준 ${id}의 기대 판정이 없습니다`);
    }
    for (const id of Object.keys(sample.criteria)) {
      if (!criterionIds.includes(id)) report.errors.push(`${label}: rubric에 없는 기준 ${id}`);
    }
    for (const id of mutationIds) {
      if (!(id in sample.mutations))
        report.errors.push(`${label}: mutation ${id}의 기대 결과가 없습니다`);
    }
    for (const id of Object.keys(sample.mutations)) {
      if (!mutationIds.includes(id))
        report.errors.push(`${label}: rubric 그룹에 없는 mutation ${id}`);
    }

    for (const [id, expected] of Object.entries(sample.criteria)) {
      const criterion = rubric.criteria.find((c) => c.id === id);
      if (!criterion) continue;
      if (expected.earnedPoints !== null && expected.earnedPoints > criterion.maxPoints) {
        report.errors.push(`${label}: ${id}의 earnedPoints가 maxPoints를 넘습니다`);
      }
      if (expected.verdict === "INCONCLUSIVE" && expected.earnedPoints !== null) {
        report.errors.push(
          `${label}: ${id}는 INCONCLUSIVE인데 earnedPoints가 null이 아닙니다 (G-04)`,
        );
      }
      if (expected.verdict === "PASS" && expected.earnedPoints !== criterion.maxPoints) {
        report.errors.push(`${label}: ${id}는 PASS인데 earnedPoints가 maxPoints와 다릅니다`);
      }
      if (criterion.method === "HUMAN_REVIEW" && expected.earnedPoints !== null) {
        report.errors.push(
          `${label}: HUMAN_REVIEW 기준 ${id}는 사람 확인 전이므로 미확정이어야 합니다`,
        );
      }
    }

    // 그룹 mutation 결과와 MUTATION 기준 판정의 정합성
    for (const group of rubric.groups) {
      const expected = sample.criteria[group.id];
      if (!expected) continue;
      const outcomes = group.mutationIds.map((m) => sample.mutations[m]).filter(Boolean);
      const allKilled = outcomes.length > 0 && outcomes.every((o) => o === "KILLED");
      const anySurvived = outcomes.some((o) => o === "SURVIVED");
      const anyPending = outcomes.some((o) => o === "NOT_APPLICABLE" || o === "ENV_ERROR");
      if (allKilled && expected.verdict !== "PASS") {
        report.errors.push(
          `${label}: 그룹 ${group.id}의 mutation이 모두 KILLED인데 판정이 PASS가 아닙니다`,
        );
      }
      if (anySurvived && !(expected.verdict === "FAIL" && expected.earnedPoints === 0)) {
        report.errors.push(
          `${label}: 그룹 ${group.id}에 SURVIVED가 있는데 판정이 FAIL 0점이 아닙니다`,
        );
      }
      if (!anySurvived && anyPending && expected.verdict !== "INCONCLUSIVE") {
        report.errors.push(
          `${label}: 그룹 ${group.id}의 mutation이 검토 대기인데 판정이 INCONCLUSIVE가 아닙니다`,
        );
      }
    }

    // 점수 표시 대조 (부록 C). 2단계 시점은 MUTATION 기준 결과를 빼고 집계한다.
    try {
      const full = Object.entries(sample.criteria).map(([id, e]) =>
        toCriterionResult(rubric, id, e),
      );
      const withoutMutation = full.filter((r) => !mutationCriterionIds.has(r.criterionId));
      const finalDisplay = aggregateScore(full, rubric).display;
      const stage2Display = aggregateScore(withoutMutation, rubric).display;
      if (finalDisplay !== sample.scoreDisplay.beforeHumanReview) {
        report.errors.push(
          `${label}: beforeHumanReview 표시가 집계 결과와 다릅니다 (기록 "${sample.scoreDisplay.beforeHumanReview}", 집계 "${finalDisplay}")`,
        );
      }
      if (stage2Display !== sample.scoreDisplay.withoutMutationStage) {
        report.errors.push(
          `${label}: withoutMutationStage 표시가 집계 결과와 다릅니다 (기록 "${sample.scoreDisplay.withoutMutationStage}", 집계 "${stage2Display}")`,
        );
      }
    } catch (error) {
      report.errors.push(`${label}: 점수 집계 실패: ${(error as Error).message}`);
    }
  }

  // C와 D는 판정이 완전히 같아야 한다 (적대적 입력은 결과를 바꾸지 못한다)
  const c = matrix.samples.find((s) => s.id === "C");
  const d = matrix.samples.find((s) => s.id === "D");
  if (c && d) {
    const strip = (s: ExpectedSample) => JSON.stringify([s.criteria, s.mutations, s.scoreDisplay]);
    if (strip(c) !== strip(d)) report.errors.push("expected-matrix: D의 기대 판정이 C와 다릅니다");
  }

  if (matrix.reviewedBy === null || matrix.reviewedAt === null) {
    report.warnings.push(
      "expected-matrix: reviewedBy·reviewedAt이 비어 있습니다. 사람이 기대 결과표를 검토한 뒤 채워야 합니다 (T-101 사람 확인)",
    );
  } else {
    report.passed.push(`expected-matrix 검토자 ${matrix.reviewedBy} (${matrix.reviewedAt})`);
  }

  if (report.errors.length === 0) {
    report.passed.push(
      `expected-matrix: 샘플 ${matrix.samples.length}개 × 기준 ${criterionIds.length}개, mutation ${mutationIds.length}개 기대 결과 완비, 점수 표시 일치`,
    );
  }
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function runSampleCheck(sampleDir = SAMPLE_DIR): SampleCheckReport {
  const report: SampleCheckReport = { errors: [], warnings: [], passed: [] };

  const rubricParsed = RubricSchema.safeParse(readJson(path.join(sampleDir, "rubric.v1.json")));
  if (!rubricParsed.success) {
    report.errors.push(`rubric.v1.json 스키마 오류: ${z.prettifyError(rubricParsed.error)}`);
    return report;
  }
  const rubric = rubricParsed.data;
  checkRubric(rubric, report);

  const contractParsed = ExecutionContractSchema.safeParse(
    readJson(path.join(sampleDir, "execution-contract.json")),
  );
  if (contractParsed.success) checkContract(contractParsed.data, report);
  else {
    report.errors.push(
      `execution-contract.json 스키마 오류: ${z.prettifyError(contractParsed.error)}`,
    );
  }

  const spec = parseSpecInventory(readFileSync(path.join(sampleDir, "SPEC.md"), "utf8"));
  checkSpecCoverage(spec, rubric, report);

  const matrixParsed = ExpectedMatrixSchema.safeParse(
    readJson(path.join(sampleDir, "expected-matrix.json")),
  );
  if (matrixParsed.success) checkMatrix(matrixParsed.data, rubric, report);
  else {
    report.errors.push(`expected-matrix.json 스키마 오류: ${z.prettifyError(matrixParsed.error)}`);
  }

  return report;
}

function main(): void {
  const report = runSampleCheck();
  for (const line of report.passed) console.log(`  ok  ${line}`);
  for (const line of report.warnings) console.log(`  warn ${line}`);
  if (report.errors.length > 0) {
    console.error("samples:check 실패:");
    for (const line of report.errors) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(
    `samples:check OK — ${report.passed.length}개 항목 통과${report.warnings.length > 0 ? `, 경고 ${report.warnings.length}개` : ""}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
