/**
 * 하네스 케이스 결과 → 기준별 판정 (T-110 게이트와 T-204 오케스트레이터가 같은 규칙을 쓴다. T-205가 CriterionResult로 저장한다).
 *
 * - 케이스 판정 묶음은 접는다: FAIL 하나라도 있으면 FAIL, 아니면 INCONCLUSIVE, 모두 PASS면 PASS.
 * - 기동이 HEALTHY가 아니면 실행 계약 기준(R-10, `CONTRACT_AREA`)은 FAIL·SUBMISSION, 나머지는 INCONCLUSIVE·ENVIRONMENT.
 * - 기준을 참조하는 케이스가 없으면 INCONCLUSIVE·ENVIRONMENT (커버리지 누락).
 * LLM은 관여하지 않는다 (G-01).
 */
import type { FailureKind, Rubric, Verdict } from "@ohmyti/core";
import type { HarnessReport } from "./result";

/** 기동 관측이 판정 근거가 되는 rubric 영역 (R-10 실행 계약) */
export const CONTRACT_AREA = "REPRODUCIBILITY_AND_DOCS";

/** 러너의 `ServiceStartupObservation` 중 판정에 쓰는 부분 (구조적 타입. 하네스는 러너에 의존하지 않는다) */
export interface StartupOutcome {
  outcome: string;
  reason?: string | undefined;
}

/** 기준 하나의 유도된 판정. 하네스 케이스 결과와 기동 관측에서만 만든다 */
export interface DerivedCriterion {
  criterionId: string;
  verdict: Verdict;
  earnedPoints: number | null;
  failureKind: FailureKind;
  /** 판정에 쓰인 케이스 ID */
  caseIds: string[];
  reason?: string;
}

/** 케이스 판정 묶음을 기준 판정으로 접는다: FAIL 하나라도 있으면 FAIL, 아니면 INCONCLUSIVE, 모두 PASS면 PASS */
export function foldVerdicts(verdicts: readonly { verdict: Verdict; failureKind: FailureKind }[]): {
  verdict: Verdict;
  failureKind: FailureKind;
} {
  const fail = verdicts.find((v) => v.verdict === "FAIL");
  if (fail) return { verdict: "FAIL", failureKind: fail.failureKind };
  const inconclusive = verdicts.find((v) => v.verdict === "INCONCLUSIVE");
  if (inconclusive) return { verdict: "INCONCLUSIVE", failureKind: inconclusive.failureKind };
  return { verdict: "PASS", failureKind: "NONE" };
}

function pointsFor(verdict: Verdict, maxPoints: number): number | null {
  if (verdict === "PASS") return maxPoints;
  if (verdict === "FAIL") return 0;
  return null;
}

/**
 * rubric의 EXECUTION 기준마다 하네스 케이스 결과와 기동 관측을 결정적으로 접어 판정을 만든다.
 * `harness`가 null이면(기동 실패로 돌리지 못함) 모든 기준은 케이스 없음으로 취급한다.
 */
export function deriveCriteria(
  rubric: Rubric,
  harness: Pick<HarnessReport, "results"> | null,
  startup: StartupOutcome | null,
): DerivedCriterion[] {
  const healthy = startup?.outcome === "HEALTHY";
  const derived: DerivedCriterion[] = [];
  for (const criterion of rubric.criteria) {
    if (criterion.method !== "EXECUTION") continue;
    const results = harness?.results.filter((r) => r.criterionIds.includes(criterion.id)) ?? [];
    const caseIds = results.map((r) => r.caseId);
    // 실행 계약 기준(R-10): 기동 관측(`startCommand`·`PORT`·`/health`)이 하네스 케이스와 함께 근거가 된다
    const isContractCriterion = criterion.area === CONTRACT_AREA;

    if (!healthy) {
      const reason = `서비스 기동 실패: ${startup?.reason ?? startup?.outcome ?? "기동 관측 없음"}`;
      derived.push(
        isContractCriterion
          ? {
              criterionId: criterion.id,
              verdict: "FAIL",
              earnedPoints: 0,
              failureKind: "SUBMISSION",
              caseIds,
              reason,
            }
          : {
              criterionId: criterion.id,
              verdict: "INCONCLUSIVE",
              earnedPoints: null,
              failureKind: "ENVIRONMENT",
              caseIds,
              reason,
            },
      );
      continue;
    }

    if (results.length === 0) {
      derived.push({
        criterionId: criterion.id,
        verdict: "INCONCLUSIVE",
        earnedPoints: null,
        failureKind: "ENVIRONMENT",
        caseIds,
        reason: "기준을 참조하는 하네스 케이스가 없음",
      });
      continue;
    }

    const folded = foldVerdicts(results);
    const reasons = results
      .filter((r) => r.verdict !== "PASS")
      .map((r) => `${r.caseId}: ${r.reason ?? Object.keys(r.actual).join(", ")}`);
    derived.push({
      criterionId: criterion.id,
      verdict: folded.verdict,
      earnedPoints: pointsFor(folded.verdict, criterion.maxPoints),
      failureKind: folded.failureKind,
      caseIds,
      ...(reasons.length > 0 ? { reason: reasons.join(" · ") } : {}),
    });
  }
  return derived;
}
