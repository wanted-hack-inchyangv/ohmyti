import {
  MutationExperimentSchema,
  type MutationExperiment,
  type MutationOutcome,
  type SourceLocation,
  type Verdict,
} from "@ohmyti/core";
import { asc, eq } from "drizzle-orm";
import { insertExecutionRecords, type DbExecutor, type NewExecutionRecord } from "./results";
import { mutationExperiments } from "./schema";
import { toIsoTimestamp } from "./timestamps";

/**
 * mutation 실험 저장 (TICKET.md T-403). 실험 행과 그 실행 기록(MUTATION_VALIDATION·MUTATION_TESTS)을 한 트랜잭션에서 쓴다.
 *
 * - 실험 행은 (evaluation, mutation)마다 하나다(유니크 인덱스). 재시도는 이미 있는 실험을 건너뛴다.
 * - KILLED·SURVIVED는 검증 판정 FAIL + 두 기록, EQUIVALENT는 검증 판정 PASS + 검증 기록만 있어야 한다.
 *   DB CHECK(`0008`)가 강제하므로 유효하지 않은 변형이 SURVIVED로 저장될 수 없다.
 */

export type MutationExperimentRow = typeof mutationExperiments.$inferSelect;

export interface NewMutationExperiment {
  id: string;
  evaluationId: string;
  mutationId: string;
  groupId: string;
  targetCriterionId: string;
  target?: SourceLocation | undefined;
  patchDigest?: string | undefined;
  patchRef?: string | undefined;
  outcome: MutationOutcome;
  validationVerdict?: Verdict | undefined;
  validationRecordId?: string | undefined;
  testRecordId?: string | undefined;
  reason?: string | undefined;
}

/** 실험 하나와 그 실행 기록을 저장한다. 기록은 실험 행보다 먼저 들어가야 외래 키가 맞는다 */
export async function persistMutationExperiment(
  db: DbExecutor,
  experiment: NewMutationExperiment,
  records: readonly NewExecutionRecord[] = [],
): Promise<MutationExperimentRow> {
  return db.transaction(async (tx) => {
    await insertExecutionRecords(tx, records);
    const [row] = await tx
      .insert(mutationExperiments)
      .values({
        id: experiment.id,
        evaluationId: experiment.evaluationId,
        mutationId: experiment.mutationId,
        groupId: experiment.groupId,
        targetCriterionId: experiment.targetCriterionId,
        target: experiment.target ?? null,
        patchDigest: experiment.patchDigest ?? null,
        patchRef: experiment.patchRef ?? null,
        outcome: experiment.outcome,
        validationVerdict: experiment.validationVerdict ?? null,
        validationRecordId: experiment.validationRecordId ?? null,
        testRecordId: experiment.testRecordId ?? null,
        reason: experiment.reason ?? null,
      })
      .returning();
    return row!;
  });
}

export async function listMutationExperiments(
  db: DbExecutor,
  evaluationId: string,
): Promise<MutationExperimentRow[]> {
  return db
    .select()
    .from(mutationExperiments)
    .where(eq(mutationExperiments.evaluationId, evaluationId))
    .orderBy(asc(mutationExperiments.mutationId));
}

/** 행 → PRD 9장 `MutationExperiment` */
export function toMutationExperiment(row: MutationExperimentRow): MutationExperiment {
  return MutationExperimentSchema.parse({
    id: row.id,
    evaluationId: row.evaluationId,
    mutationId: row.mutationId,
    groupId: row.groupId,
    targetCriterionId: row.targetCriterionId,
    ...(row.target !== null ? { target: row.target } : {}),
    ...(row.patchDigest !== null ? { patchDigest: row.patchDigest } : {}),
    ...(row.patchRef !== null ? { patchRef: row.patchRef } : {}),
    outcome: row.outcome,
    ...(row.validationRecordId !== null ? { validationRecordId: row.validationRecordId } : {}),
    ...(row.testRecordId !== null ? { testRecordId: row.testRecordId } : {}),
    ...(row.validationVerdict !== null ? { validationVerdict: row.validationVerdict } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    createdAt: toIsoTimestamp(row.createdAt),
  });
}
