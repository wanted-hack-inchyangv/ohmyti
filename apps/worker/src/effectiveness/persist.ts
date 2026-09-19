/**
 * 테스트 실효성 판정 저장 (TICKET.md T-404). T-205가 REQUIREMENT_VERIFY 뒤에 남긴 MUTATION 기준의 자리 표시 판정
 * (INCONCLUSIVE)을 `decideEffectiveness` 결과로 바꾸고, 평가 점수를 `aggregateScore`로 다시 저장한다. 한 트랜잭션이다.
 *
 * 근거: 그룹의 실험마다 유효성 검증 기록(MUTATION_VALIDATION)·제출 테스트 기록(MUTATION_TESTS)·diff를 각각 Evidence로 둔다
 * (rubric `mutationIds` 순서로 검증 → 테스트 → diff). 기존 근거(원본 제출 테스트 기록)는 뒤에 남긴다. 첫 근거가 검증 기록이라
 * 워크벤치에서 그룹을 누르면 재생 뷰가 첫 변형의 검증 기록을 연다.
 * - 기록 근거: `runId` = 기록 ID, `artifactRefs` = 기록 본문 + diff. `testId`는 두지 않는다(하네스 케이스 재실행 대상이 아니다).
 * - diff 근거: `runId` 없음, `artifactRefs` = [diff], `source` = 변형을 적용한 위치.
 *
 * 멱등성: 같은 기록·diff를 가리키는 근거가 이미 있으면 새로 만들지 않고 재사용한다. 판정 행은 같은 값으로 다시 쓴다.
 * 사람이 확정한 판정(`reviewState = CONFIRMED`, T-306)은 바꾸지 않는다.
 */
import { aggregateScore, type EvaluationStageRecord, type Rubric } from "@ohmyti/core";
import {
  insertEvidences,
  listEvidences,
  listExecutionRecords,
  listMutationExperiments,
  lockCriterionResults,
  replaceCriterionResult,
  setEvaluationScore,
  toCriterionResult,
  type Database,
  type EvidenceRow,
  type ExecutionRecordRow,
  type NewEvidence,
} from "@ohmyti/db";
import { artifactKeys } from "@ohmyti/storage";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logger";
import { scoreFieldsOf } from "../results";
import {
  decideEffectiveness,
  type EffectivenessBasis,
  type EffectivenessExperiment,
  type GroupDecision,
} from "./decide";

export interface PersistEffectivenessInput {
  evaluation: { id: string; submissionSha: string };
  rubric: Rubric;
  /** 닫힌(DONE·SKIPPED) TEST_EFFECTIVENESS 단계 기록 */
  stage: Pick<EvaluationStageRecord, "state" | "reason" | "detail">;
}

export interface PersistEffectivenessDeps {
  db: Database;
  logger?: Logger | undefined;
  newId?: (() => string) | undefined;
}

/** `stage_log[TEST_EFFECTIVENESS].detail.scoring`에 남기는 요약 */
export interface EffectivenessScoringSummary {
  groups: Array<{
    criterionId: string;
    groupId: string | null;
    verdict: GroupDecision["verdict"];
    earnedPoints: number | null;
    basis: EffectivenessBasis;
    unverifiedCriterionIds: string[];
    /** 사람이 이미 확정해 바꾸지 않았거나 판정 행이 없어 건너뛰었으면 그 사유 */
    skipped: string | null;
  }>;
  evidencesAdded: number;
  score: { earned: number; min: number; max: number; pendingPoints: number; display: string };
  [key: string]: unknown;
}

export type PersistEffectivenessResult =
  { status: "saved"; summary: EffectivenessScoringSummary } | { status: "no_results" };

function recordRefs(record: ExecutionRecordRow): string[] {
  const refs = [record.inputRef, record.expectedRef, record.actualRef];
  if (record.kind === "MUTATION_VALIDATION") {
    refs.push(artifactKeys.runRecord(record.evaluationId, record.id, "timeline"));
  }
  return refs;
}

export async function persistEffectivenessResults(
  input: PersistEffectivenessInput,
  deps: PersistEffectivenessDeps,
): Promise<PersistEffectivenessResult> {
  const newId = deps.newId ?? randomUUID;
  const evaluationId = input.evaluation.id;
  const result = await deps.db.transaction(async (tx): Promise<PersistEffectivenessResult> => {
    const rows = await lockCriterionResults(tx, evaluationId);
    if (rows.length === 0) return { status: "no_results" };
    const [experimentRows, recordRows, evidenceRows] = await Promise.all([
      listMutationExperiments(tx, evaluationId),
      listExecutionRecords(tx, evaluationId),
      listEvidences(tx, evaluationId),
    ]);
    const experiments: EffectivenessExperiment[] = experimentRows.map((e) => ({
      mutationId: e.mutationId,
      groupId: e.groupId,
      targetCriterionId: e.targetCriterionId,
      outcome: e.outcome,
      reason: e.reason,
      target: e.target,
      patchRef: e.patchRef,
      validationRecordId: e.validationRecordId,
      testRecordId: e.testRecordId,
    }));
    const decisions = decideEffectiveness({
      rubric: input.rubric,
      stage: input.stage,
      experiments,
    });
    const records = new Map(recordRows.map((r) => [r.id, r]));
    const recordEvidence = new Map<string, EvidenceRow | NewEvidence>();
    const diffEvidence = new Map<string, EvidenceRow | NewEvidence>();
    for (const evidence of evidenceRows) {
      if (evidence.runId) {
        if (!recordEvidence.has(evidence.runId)) recordEvidence.set(evidence.runId, evidence);
      } else if (
        evidence.artifactRefs.length === 1 &&
        evidence.artifactRefs[0]!.endsWith(".patch")
      ) {
        diffEvidence.set(evidence.artifactRefs[0]!, evidence);
      }
    }
    const created: NewEvidence[] = [];
    const base = { evaluationId, submissionSha: input.evaluation.submissionSha };
    const evidenceForRecord = (recordId: string, patchRef: string | null): string | null => {
      const existing = recordEvidence.get(recordId);
      if (existing) return existing.id;
      const record = records.get(recordId);
      if (!record) return null;
      const evidence: NewEvidence = {
        ...base,
        id: newId(),
        runId: record.id,
        artifactRefs: [...recordRefs(record), ...(patchRef ? [patchRef] : [])],
      };
      created.push(evidence);
      recordEvidence.set(recordId, evidence);
      return evidence.id;
    };
    const evidenceForDiff = (experiment: EffectivenessExperiment): string | null => {
      if (!experiment.patchRef) return null;
      const existing = diffEvidence.get(experiment.patchRef);
      if (existing) return existing.id;
      const evidence: NewEvidence = {
        ...base,
        id: newId(),
        artifactRefs: [experiment.patchRef],
        ...(experiment.target ? { source: experiment.target } : {}),
      };
      created.push(evidence);
      diffEvidence.set(experiment.patchRef, evidence);
      return evidence.id;
    };

    const rowsById = new Map(rows.map((r) => [r.criterionId, r]));
    const groups: EffectivenessScoringSummary["groups"] = [];
    const replacements: Array<{
      row: (typeof rows)[number];
      decision: GroupDecision;
      evidenceIds: string[];
    }> = [];
    for (const decision of decisions) {
      const row = rowsById.get(decision.criterionId);
      const skipped = !row
        ? "판정 행 없음"
        : row.reviewState === "CONFIRMED"
          ? "사람이 확정한 판정이라 바꾸지 않음"
          : null;
      groups.push({
        criterionId: decision.criterionId,
        groupId: decision.groupId,
        verdict: decision.verdict,
        earnedPoints: decision.earnedPoints,
        basis: decision.basis,
        unverifiedCriterionIds: decision.unverifiedCriterionIds,
        skipped,
      });
      if (!row || skipped) continue;
      const ids: string[] = [];
      for (const experiment of decision.experiments) {
        for (const id of [
          experiment.validationRecordId
            ? evidenceForRecord(experiment.validationRecordId, experiment.patchRef)
            : null,
          experiment.testRecordId
            ? evidenceForRecord(experiment.testRecordId, experiment.patchRef)
            : null,
          evidenceForDiff(experiment),
        ]) {
          if (id && !ids.includes(id)) ids.push(id);
        }
      }
      for (const id of row.evidenceIds) if (!ids.includes(id)) ids.push(id);
      replacements.push({ row, decision, evidenceIds: ids });
    }

    await insertEvidences(tx, created);
    const updated = new Map(rows.map((r) => [r.id, r]));
    for (const { row, decision, evidenceIds } of replacements) {
      updated.set(
        row.id,
        await replaceCriterionResult(tx, row, {
          earnedPoints: decision.earnedPoints,
          verdict: decision.verdict,
          reviewState: decision.reviewState,
          evidenceIds,
          issueId: decision.issueId,
          observation: decision.observation,
        }),
      );
    }
    const score = aggregateScore([...updated.values()].map(toCriterionResult), input.rubric);
    await setEvaluationScore(tx, evaluationId, scoreFieldsOf(score));
    return {
      status: "saved",
      summary: {
        groups,
        evidencesAdded: created.length,
        score: {
          earned: score.earned,
          min: score.min,
          max: score.max,
          pendingPoints: score.pendingPoints,
          display: score.display,
        },
      },
    };
  });
  if (result.status === "saved") {
    deps.logger?.info(
      {
        evaluationId,
        groups: result.summary.groups.map(
          (g) => `${g.criterionId}=${g.verdict}${g.skipped ? "(skipped)" : ""}`,
        ),
        score: result.summary.score.display,
      },
      "테스트 실효성 판정을 저장했습니다",
    );
  }
  return result;
}
