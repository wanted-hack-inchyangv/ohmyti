/**
 * 테스트 실효성 점수 산정 (TICKET.md T-404, PRD 5장 테스트 실효성). mutation 실험 결과 → 요구사항 그룹(G1~G3)별 판정. 순수 함수다.
 *
 * 그룹 판정은 변형 생존율이 아니라 "검증되지 않은 요구사항"으로 묶는다. 비율을 계산하지 않는다.
 * - 유효 실험(KILLED·SURVIVED) 중 SURVIVED가 하나라도 있으면 FAIL(0점). observation에 살아남은 변형의 대상 요구사항 ID를 나열한다.
 * - SURVIVED가 없고 KILLED가 하나 이상이면 PASS(만점).
 * - 유효 실험이 없으면(NOT_APPLICABLE·EQUIVALENT·BUILD_FAIL·ENV_ERROR·TIMEOUT뿐, 또는 실험 없음) INCONCLUSIVE(null, 검토 대기).
 * 전제 조건(T-403 `precondition`)이 READY가 아니면 실험 없이 정한다.
 * - 테스트 미제출(NO_TESTS): 모든 그룹 FAIL(0점) + "제출 테스트 없음". 제출물의 선택이므로 미확정이 아니다.
 * - 환경 미지원(ENV_UNSUPPORTED)·기준 실행 실패(BASELINE_FAILED): 모든 그룹 INCONCLUSIVE(검토 대기).
 * TEST_EFFECTIVENESS가 SKIPPED면 모든 그룹 INCONCLUSIVE이며 사유를 observation에 남긴다.
 *
 * 판정은 러너가 수집한 실험 결과(`mutation_experiments.outcome`)만 쓰며 LLM은 관여하지 않는다 (G-01).
 * 감점 issueId는 그룹마다 `untested:<groupId>`다. 그룹은 서로 다른 요구사항을 검증하므로 같은 결함의 중복 감점이 아니다 (G-12).
 */
import type {
  EvaluationStageRecord,
  MutationOutcome,
  ReviewState,
  Rubric,
  SourceLocation,
  Verdict,
} from "@ohmyti/core";
import type { PreconditionStatus } from "../mutation";

/** 테스트 미제출 그룹의 observation (티켓 문구 그대로) */
export const NO_SUBMITTED_TESTS_OBSERVATION = "제출 테스트 없음";

/** 유효 실험: 하네스가 변형에서 실패를 관측했고(유효한 결함) 제출 테스트를 돌린 실험 */
export const EFFECTIVE_OUTCOMES: ReadonlySet<MutationOutcome> = new Set(["KILLED", "SURVIVED"]);

export interface EffectivenessExperiment {
  mutationId: string;
  groupId: string;
  targetCriterionId: string;
  outcome: MutationOutcome;
  reason: string | null;
  target: SourceLocation | null;
  patchRef: string | null;
  validationRecordId: string | null;
  testRecordId: string | null;
}

export type EffectivenessBasis =
  "EXPERIMENTS" | "NO_TESTS" | "ENV_UNSUPPORTED" | "BASELINE_FAILED" | "STAGE_SKIPPED" | "NO_GROUP";

export interface GroupDecision {
  criterionId: string;
  groupId: string | null;
  verdict: Verdict;
  earnedPoints: number | null;
  reviewState: ReviewState;
  issueId: string | null;
  observation: string;
  basis: EffectivenessBasis;
  /** SURVIVED 실험의 대상 요구사항 ID (rubric 순서, 중복 제거). FAIL이 아니면 비어 있다 */
  unverifiedCriterionIds: string[];
  /** 그룹의 실험 (rubric 그룹 `mutationIds` 순서). 근거를 만든다. 실험하지 않았으면 비어 있다 */
  experiments: EffectivenessExperiment[];
}

export interface DecideEffectivenessInput {
  rubric: Rubric;
  /** TEST_EFFECTIVENESS 단계 기록. DONE이면 `detail.precondition`을, SKIPPED면 `reason`을 쓴다 */
  stage: Pick<EvaluationStageRecord, "state" | "reason" | "detail">;
  experiments: readonly EffectivenessExperiment[];
}

const PRECONDITIONS: ReadonlySet<string> = new Set([
  "READY",
  "NO_TESTS",
  "ENV_UNSUPPORTED",
  "BASELINE_FAILED",
]);

/** 단계 detail의 전제 조건. DONE인데 기록이 없으면(형태가 다르면) 실험 결과만으로 판단한다 */
function preconditionOfStage(stage: DecideEffectivenessInput["stage"]): {
  status: PreconditionStatus;
  testsStatus: string | null;
} {
  const precondition = (stage.detail as { precondition?: unknown } | undefined)?.precondition as
    { status?: unknown; testsStatus?: unknown } | undefined;
  const status =
    typeof precondition?.status === "string" && PRECONDITIONS.has(precondition.status)
      ? (precondition.status as PreconditionStatus)
      : "READY";
  const testsStatus =
    typeof precondition?.testsStatus === "string" ? precondition.testsStatus : null;
  return { status, testsStatus };
}

function describeExperiment(e: EffectivenessExperiment): string {
  return `${e.mutationId} ${e.outcome}(${e.targetCriterionId})${e.reason ? `: ${e.reason}` : ""}`;
}

export function decideEffectiveness(input: DecideEffectivenessInput): GroupDecision[] {
  const { rubric, stage } = input;
  const groups = new Map(rubric.groups.map((g) => [g.id, g]));
  const criterionOrder = rubric.criteria.map((c) => c.id);
  const experimentsById = new Map(input.experiments.map((e) => [e.mutationId, e]));
  const precondition = preconditionOfStage(stage);
  const decisions: GroupDecision[] = [];

  for (const criterion of rubric.criteria) {
    if (criterion.method !== "MUTATION") continue;
    const group = criterion.groupId ? groups.get(criterion.groupId) : undefined;
    const pending = (observation: string, basis: EffectivenessBasis): GroupDecision => ({
      criterionId: criterion.id,
      groupId: group?.id ?? criterion.groupId ?? null,
      verdict: "INCONCLUSIVE",
      earnedPoints: null,
      reviewState: "PENDING",
      issueId: null,
      observation,
      basis,
      unverifiedCriterionIds: [],
      experiments: [],
    });

    if (!group) {
      decisions.push(
        pending(`기준에 연결된 요구사항 그룹(${criterion.groupId ?? "없음"})이 없음`, "NO_GROUP"),
      );
      continue;
    }
    if (stage.state === "SKIPPED") {
      decisions.push(
        pending(`테스트 실효성 미실행: ${stage.reason ?? "단계를 건너뜀"}`, "STAGE_SKIPPED"),
      );
      continue;
    }
    if (precondition.status === "NO_TESTS") {
      decisions.push({
        criterionId: criterion.id,
        groupId: group.id,
        verdict: "FAIL",
        earnedPoints: 0,
        reviewState: "NOT_REQUIRED",
        issueId: `untested:${group.id}`,
        observation: NO_SUBMITTED_TESTS_OBSERVATION,
        basis: "NO_TESTS",
        unverifiedCriterionIds: [...group.criterionIds],
        experiments: [],
      });
      continue;
    }
    if (precondition.status === "ENV_UNSUPPORTED") {
      decisions.push(
        pending(
          `환경 미지원: 제출 테스트 기준 실행 ${precondition.testsStatus ?? "결과 없음"} · 변형 실험을 하지 않음`,
          "ENV_UNSUPPORTED",
        ),
      );
      continue;
    }
    if (precondition.status === "BASELINE_FAILED") {
      decisions.push(
        pending(
          "제출 테스트 기준 실행 실패: 원본에서 이미 실패해 변형 탐지 여부를 가를 수 없음 · 변형 실험을 하지 않음",
          "BASELINE_FAILED",
        ),
      );
      continue;
    }

    const experiments = group.mutationIds
      .map((id) => experimentsById.get(id))
      .filter((e): e is EffectivenessExperiment => e !== undefined);
    const survived = experiments.filter((e) => e.outcome === "SURVIVED");
    const killed = experiments.filter((e) => e.outcome === "KILLED");
    const details = experiments.map(describeExperiment);
    const missing = group.mutationIds.filter((id) => !experimentsById.has(id));
    if (missing.length > 0) details.push(`실험 기록 없음: ${missing.join(", ")}`);

    if (survived.length > 0) {
      const targets = new Set(survived.map((e) => e.targetCriterionId));
      const unverified = [
        ...criterionOrder.filter((id) => targets.has(id)),
        ...[...targets].filter((id) => !criterionOrder.includes(id)),
      ];
      decisions.push({
        criterionId: criterion.id,
        groupId: group.id,
        verdict: "FAIL",
        earnedPoints: 0,
        reviewState: "NOT_REQUIRED",
        issueId: `untested:${group.id}`,
        observation: [`검증되지 않은 요구사항: ${unverified.join(", ")}`, ...details].join(" · "),
        basis: "EXPERIMENTS",
        unverifiedCriterionIds: unverified,
        experiments,
      });
      continue;
    }
    if (killed.length > 0) {
      decisions.push({
        criterionId: criterion.id,
        groupId: group.id,
        verdict: "PASS",
        earnedPoints: criterion.maxPoints,
        reviewState: "NOT_REQUIRED",
        issueId: null,
        observation: ["유효한 변형을 제출 테스트가 모두 탐지함", ...details].join(" · "),
        basis: "EXPERIMENTS",
        unverifiedCriterionIds: [],
        experiments,
      });
      continue;
    }
    decisions.push({
      ...pending(
        [
          "유효한 변형 없음: 결함을 주입해 확인할 수 없어 검토 대기",
          ...(details.length > 0 ? details : ["그룹에 변형이 없음"]),
        ].join(" · "),
        "EXPERIMENTS",
      ),
      experiments,
    });
  }
  return decisions;
}
