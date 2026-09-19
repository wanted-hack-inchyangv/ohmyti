import type { CriterionResult } from "./contracts";
import { RubricAreaSchema, type RubricArea } from "./enums";
import type { Criterion, Rubric } from "./rubric";

/**
 * 점수 집계 엔진 (PRD 5장 불변 규칙, 부록 C).
 * 순수 함수다. LLM·DB·UI에 의존하지 않으며 CriterionResult 배열과 rubric만으로 계산한다 (G-01).
 */

export type ScoreAggregationCode =
  | "UNKNOWN_CRITERION"
  | "DUPLICATE_RESULT"
  | "RUBRIC_VERSION_MISMATCH"
  | "MAX_POINTS_MISMATCH"
  | "PARTIAL_NOT_ALLOWED"
  | "UNKNOWN_SUB_CRITERION"
  | "PARTIAL_POINTS_MISMATCH"
  | "DUPLICATE_DEDUCTION";

export class ScoreAggregationError extends Error {
  readonly code: ScoreAggregationCode;
  /** 문제가 된 기준 ID·issueId 등 (있으면). */
  readonly ref: string | undefined;

  constructor(code: ScoreAggregationCode, message: string, ref?: string) {
    super(message);
    this.name = "ScoreAggregationError";
    this.code = code;
    this.ref = ref;
  }
}

/** 같은 issueId를 두 기준 이상에서 감점했는데 rubric에 independentReason이 없다 (G-12). */
export class DuplicateDeductionError extends ScoreAggregationError {
  readonly issueId: string;
  readonly criterionIds: readonly string[];

  constructor(issueId: string, criterionIds: readonly string[]) {
    super(
      "DUPLICATE_DEDUCTION",
      `같은 결함(${issueId})을 여러 기준(${criterionIds.join(", ")})에서 감점하려면 rubric에 independentReason이 있어야 합니다`,
      issueId,
    );
    this.name = "DuplicateDeductionError";
    this.issueId = issueId;
    this.criterionIds = criterionIds;
  }
}

/** PARTIAL 결과가 rubric에 없는 하위 기준을 참조했다. */
export class UnknownSubCriterionError extends ScoreAggregationError {
  readonly criterionId: string;
  readonly subCriterionId: string;

  constructor(criterionId: string, subCriterionId: string) {
    super(
      "UNKNOWN_SUB_CRITERION",
      `기준 ${criterionId}의 PARTIAL 결과가 rubric에 없는 하위 기준을 참조합니다: ${subCriterionId}`,
      criterionId,
    );
    this.name = "UnknownSubCriterionError";
    this.criterionId = criterionId;
    this.subCriterionId = subCriterionId;
  }
}

/** 미확정으로 남은 이유. 0점과 구분한다 (G-04). */
export type PendingReason =
  /** 실행·판정 불가 (verdict INCONCLUSIVE) */
  | "INCONCLUSIVE"
  /** 사람 확인 전 (HUMAN_REVIEW, 또는 확인 대기 중인 판정) */
  | "REVIEW_PENDING"
  /** 결과 자체가 아직 없다 (해당 단계 미실행) */
  | "NOT_EVALUATED";

export interface PendingCriterion {
  criterionId: string;
  area: RubricArea;
  maxPoints: number;
  reason: PendingReason;
}

export interface AreaScore {
  area: RubricArea;
  /** 확정 점수 */
  earned: number;
  /** 확정 점수와 같다. 범위 표기의 하한 */
  min: number;
  /** 확정 + 미확정 배점. 범위 표기의 상한 */
  max: number;
  /** 미확정 배점 */
  pendingPoints: number;
  /** 영역 배점 합 */
  total: number;
}

export interface ScoreSummary {
  /** 확정 점수: earnedPoints가 null이 아닌 기준의 합 */
  earned: number;
  /** 범위 하한 (= earned) */
  min: number;
  /** 범위 상한 (= earned + pendingPoints). total과 다를 수 있다 */
  max: number;
  /** 미확정 배점: earnedPoints가 null이거나 결과가 없는 기준의 maxPoints 합 */
  pendingPoints: number;
  pendingCriteria: PendingCriterion[];
  /** rubric 배점 합 (보통 100) */
  total: number;
  /** rubric에 등장하는 영역의 소계 (RubricArea 열거 순서) */
  byArea: AreaScore[];
  /** `87/100` 또는 `54~69/100 · 15점 검토 대기` */
  display: string;
}

/** 부록 C의 표시 규칙. 미확정 배점을 제외하고 재환산하지 않는다. */
export function formatScoreDisplay(earned: number, pendingPoints: number, total: number): string {
  if (pendingPoints === 0) return `${earned}/${total}`;
  return `${earned}~${earned + pendingPoints}/${total} · ${pendingPoints}점 검토 대기`;
}

/**
 * PARTIAL 결과의 점수를 rubric 하위 기준으로 계산한다.
 * 하위 기준 규칙이 없거나 모르는 하위 기준을 참조하면 예외를 던진다.
 */
function partialPointsFromRubric(
  rubric: Rubric,
  criterion: Criterion,
  result: CriterionResult,
): number {
  const rule = rubric.partialRules.find((r) => r.criterionId === criterion.id);
  if (!criterion.allowPartial || !rule) {
    throw new ScoreAggregationError(
      "PARTIAL_NOT_ALLOWED",
      `기준 ${criterion.id}은(는) PARTIAL 판정을 허용하지 않습니다`,
      criterion.id,
    );
  }
  const pointsBySubId = new Map(rule.subCriteria.map((sub) => [sub.id, sub.points]));
  const satisfied = result.satisfiedSubCriterionIds ?? [];
  let sum = 0;
  const seen = new Set<string>();
  for (const subId of satisfied) {
    const points = pointsBySubId.get(subId);
    if (points === undefined) throw new UnknownSubCriterionError(criterion.id, subId);
    if (seen.has(subId)) continue;
    seen.add(subId);
    sum += points;
  }
  return Math.min(sum, criterion.maxPoints);
}

function pendingReason(result: CriterionResult | undefined): PendingReason {
  if (result === undefined) return "NOT_EVALUATED";
  if (result.verdict === "INCONCLUSIVE") return "INCONCLUSIVE";
  return "REVIEW_PENDING";
}

/**
 * 같은 issueId로 두 기준 이상에서 감점했으면 rubric의 independentReason이 그 기준들을 모두 포함해야 한다 (G-12).
 */
function assertNoDuplicateDeduction(
  rubric: Rubric,
  deductions: ReadonlyMap<string, string[]>,
): void {
  for (const [issueId, criterionIds] of deductions) {
    if (criterionIds.length < 2) continue;
    const covered = rubric.independentReasons.some((reason) => {
      const ids = new Set(reason.criterionIds);
      return criterionIds.every((id) => ids.has(id));
    });
    if (!covered) throw new DuplicateDeductionError(issueId, criterionIds);
  }
}

/**
 * CriterionResult 배열과 rubric에서 확정 점수, 범위, 검토 대기 배점, 영역별 소계, 표시 문자열을 계산한다.
 *
 * - 확정 점수 = earnedPoints가 null이 아닌 기준의 합. PARTIAL은 rubric 하위 기준으로 다시 계산하며 결과값과 다르면 예외다.
 * - 미확정 배점 = earnedPoints가 null인 기준과 결과가 없는 기준의 maxPoints 합.
 * - rubric에 없는 기준, 같은 기준의 중복 결과, rubricVersion·maxPoints 불일치는 예외다.
 * - 같은 issueId의 중복 감점은 independentReason이 없으면 DuplicateDeductionError다.
 */
export function aggregateScore(results: readonly CriterionResult[], rubric: Rubric): ScoreSummary {
  const criterionById = new Map(rubric.criteria.map((criterion) => [criterion.id, criterion]));
  const resultByCriterion = new Map<string, CriterionResult>();

  for (const result of results) {
    const criterion = criterionById.get(result.criterionId);
    if (!criterion) {
      throw new ScoreAggregationError(
        "UNKNOWN_CRITERION",
        `rubric에 없는 기준의 결과입니다: ${result.criterionId}`,
        result.criterionId,
      );
    }
    if (resultByCriterion.has(result.criterionId)) {
      throw new ScoreAggregationError(
        "DUPLICATE_RESULT",
        `같은 기준의 결과가 두 개 이상입니다: ${result.criterionId}`,
        result.criterionId,
      );
    }
    if (result.rubricVersion !== rubric.version) {
      throw new ScoreAggregationError(
        "RUBRIC_VERSION_MISMATCH",
        `기준 ${result.criterionId}의 rubricVersion(${result.rubricVersion})이 rubric(${rubric.version})과 다릅니다`,
        result.criterionId,
      );
    }
    if (result.maxPoints !== criterion.maxPoints) {
      throw new ScoreAggregationError(
        "MAX_POINTS_MISMATCH",
        `기준 ${result.criterionId}의 maxPoints(${result.maxPoints})가 rubric(${criterion.maxPoints})과 다릅니다`,
        result.criterionId,
      );
    }
    resultByCriterion.set(result.criterionId, result);
  }

  const areaTotals = new Map<RubricArea, AreaScore>();
  const pendingCriteria: PendingCriterion[] = [];
  const deductionsByIssue = new Map<string, string[]>();
  let earned = 0;
  let pendingPoints = 0;
  let total = 0;

  for (const criterion of rubric.criteria) {
    total += criterion.maxPoints;
    let area = areaTotals.get(criterion.area);
    if (!area) {
      area = { area: criterion.area, earned: 0, min: 0, max: 0, pendingPoints: 0, total: 0 };
      areaTotals.set(criterion.area, area);
    }
    area.total += criterion.maxPoints;

    const result = resultByCriterion.get(criterion.id);
    if (result === undefined || result.earnedPoints === null) {
      pendingPoints += criterion.maxPoints;
      area.pendingPoints += criterion.maxPoints;
      pendingCriteria.push({
        criterionId: criterion.id,
        area: criterion.area,
        maxPoints: criterion.maxPoints,
        reason: pendingReason(result),
      });
      continue;
    }

    let points = result.earnedPoints;
    if (result.verdict === "PARTIAL") {
      const computed = partialPointsFromRubric(rubric, criterion, result);
      if (computed !== result.earnedPoints) {
        throw new ScoreAggregationError(
          "PARTIAL_POINTS_MISMATCH",
          `기준 ${criterion.id}의 PARTIAL 점수(${result.earnedPoints})가 하위 기준 합(${computed})과 다릅니다`,
          criterion.id,
        );
      }
      points = computed;
    }

    earned += points;
    area.earned += points;

    if (points < criterion.maxPoints && result.issueId !== undefined) {
      const list = deductionsByIssue.get(result.issueId) ?? [];
      list.push(criterion.id);
      deductionsByIssue.set(result.issueId, list);
    }
  }

  assertNoDuplicateDeduction(rubric, deductionsByIssue);

  const byArea = RubricAreaSchema.options
    .map((area) => areaTotals.get(area))
    .filter((area): area is AreaScore => area !== undefined)
    .map((area) => ({ ...area, min: area.earned, max: area.earned + area.pendingPoints }));

  return {
    earned,
    min: earned,
    max: earned + pendingPoints,
    pendingPoints,
    pendingCriteria,
    total,
    byArea,
    display: formatScoreDisplay(earned, pendingPoints, total),
  };
}
