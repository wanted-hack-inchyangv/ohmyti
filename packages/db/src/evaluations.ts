import {
  EVALUATION_STAGE_ORDER,
  EvaluationStageRecordSchema,
  InvalidTransitionError,
  canTransition,
  type EvaluationStage,
  type EvaluationStageRecord,
  type StageState,
} from "@ohmyti/core";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "./client";
import { evaluations } from "./schema";
import { toIsoTimestamp } from "./timestamps";

/**
 * 평가 행과 `stage_log` 갱신 (TICKET.md T-203, T-204).
 *
 * `stage_log`는 `EvaluationStageRecord[]`이며 기록이 없는 단계는 PENDING이다. 단계 전이는 부록 B
 * (`PENDING → RUNNING → DONE | SKIPPED | FAILED | UNSUPPORTED`, `PENDING → SKIPPED`)를 따르고
 * 허용되지 않는 전이는 `InvalidTransitionError`다. 같은 상태를 유지한 채 `detail`·`reason`만
 * 덧붙이는 갱신은 허용한다. 한 평가는 워커 하나가 순서대로 처리하므로 배열 전체를 읽고 다시 쓴다.
 */

export type EvaluationRow = typeof evaluations.$inferSelect;

export interface CreateEvaluationInput {
  submissionId: string;
  assignmentVersionId: string;
  rubricVersion: string;
  harnessVersion: string;
  environmentDigest: string;
  submissionSha: string;
  isSample?: boolean | undefined;
}

export async function createEvaluation(
  db: Database,
  input: CreateEvaluationInput,
): Promise<EvaluationRow> {
  const [row] = await db
    .insert(evaluations)
    .values({
      submissionId: input.submissionId,
      assignmentVersionId: input.assignmentVersionId,
      rubricVersion: input.rubricVersion,
      harnessVersion: input.harnessVersion,
      environmentDigest: input.environmentDigest,
      submissionSha: input.submissionSha,
      isSample: input.isSample ?? false,
      stageLog: [],
    })
    .returning();
  if (!row) throw new Error("evaluations insert 실패");
  return row;
}

export async function getEvaluation(db: Database, id: string): Promise<EvaluationRow | null> {
  const [row] = await db.select().from(evaluations).where(eq(evaluations.id, id));
  return row ?? null;
}

/**
 * 제출의 아직 끝나지 않은(`finished_at IS NULL`) 평가 중 가장 최근 것. job 재시도(T-204)가 같은 평가를 이어서 쓰기 위해 찾는다.
 * `submissionSha`를 주면 그 SHA로 만든 평가만, `assignmentVersionId`를 주면 그 버전의 평가만 찾는다(재평가, T-405).
 */
export async function findOpenEvaluation(
  db: Database,
  submissionId: string,
  submissionSha?: string,
  assignmentVersionId?: string,
): Promise<EvaluationRow | null> {
  const [row] = await db
    .select()
    .from(evaluations)
    .where(
      and(
        eq(evaluations.submissionId, submissionId),
        isNull(evaluations.finishedAt),
        ...(submissionSha ? [eq(evaluations.submissionSha, submissionSha)] : []),
        ...(assignmentVersionId ? [eq(evaluations.assignmentVersionId, assignmentVersionId)] : []),
      ),
    )
    .orderBy(desc(evaluations.createdAt))
    .limit(1);
  return row ?? null;
}

/** 제출의 특정 버전 평가 중 끝난 가장 최근 것 (재평가 멱등성, T-405) */
export async function findFinishedEvaluationForVersion(
  db: Database,
  submissionId: string,
  assignmentVersionId: string,
): Promise<EvaluationRow | null> {
  const [row] = await db
    .select()
    .from(evaluations)
    .where(
      and(
        eq(evaluations.submissionId, submissionId),
        eq(evaluations.assignmentVersionId, assignmentVersionId),
        isNotNull(evaluations.finishedAt),
      ),
    )
    .orderBy(desc(evaluations.createdAt))
    .limit(1);
  return row ?? null;
}

/** 제출의 모든 평가 (오래된 순). 재평가 뒤에도 이전 평가가 남는지 확인한다 */
export async function listSubmissionEvaluations(
  db: Database,
  submissionId: string,
): Promise<EvaluationRow[]> {
  return db
    .select()
    .from(evaluations)
    .where(eq(evaluations.submissionId, submissionId))
    .orderBy(asc(evaluations.createdAt), asc(evaluations.id));
}

/** 제출의 가장 최근 평가 (끝났는지와 무관). 상태 화면(T-206)이 `stage_log`를 읽기 위해 찾는다 */
export async function findLatestEvaluation(
  db: Database,
  submissionId: string,
): Promise<EvaluationRow | null> {
  const [row] = await db
    .select()
    .from(evaluations)
    .where(eq(evaluations.submissionId, submissionId))
    .orderBy(desc(evaluations.createdAt))
    .limit(1);
  return row ?? null;
}

/** 파이프라인이 끝났음을 기록한다 (`finished_at`). 점수 필드는 T-205가 따로 채운다 */
export async function finishEvaluation(
  db: Database,
  evaluationId: string,
  finishedAt: Date = new Date(),
): Promise<EvaluationRow> {
  const [row] = await db
    .update(evaluations)
    .set({ finishedAt })
    .where(eq(evaluations.id, evaluationId))
    .returning();
  if (!row) throw new Error(`평가를 찾을 수 없습니다: ${evaluationId}`);
  return row;
}

/** `stage_log`에서 단계 기록을 찾는다. 없으면 PENDING 기록을 돌려준다 */
export function stageRecordOf(
  stageLog: readonly EvaluationStageRecord[],
  stage: EvaluationStage,
): EvaluationStageRecord {
  return stageLog.find((record) => record.stage === stage) ?? { stage, state: "PENDING" };
}

export interface StagePatch {
  state: StageState;
  /** FAILED·UNSUPPORTED 사유. 마스킹된 문자열 */
  reason?: string | undefined;
  /** 단계가 남긴 구조화 결과. JSON으로 직렬화 가능한 값만 */
  detail?: Record<string, unknown> | undefined;
  /** 기본값: RUNNING으로 바뀔 때 `now`, 그 밖에는 기존 값 유지 */
  startedAt?: string | undefined;
  /** 기본값: 종료 상태(DONE·SKIPPED·FAILED·UNSUPPORTED)로 바뀔 때 `now` */
  finishedAt?: string | undefined;
  now?: Date | undefined;
}

const TERMINAL_STAGE_STATES: ReadonlySet<StageState> = new Set([
  "DONE",
  "SKIPPED",
  "FAILED",
  "UNSUPPORTED",
]);

/** 단계 기록 하나를 갱신한 새 `stage_log`를 만든다 (순수 함수, 단계 순서대로 정렬) */
export function applyStagePatch(
  stageLog: readonly EvaluationStageRecord[],
  stage: EvaluationStage,
  patch: StagePatch,
): EvaluationStageRecord[] {
  const current = stageRecordOf(stageLog, stage);
  if (
    current.state !== patch.state &&
    !canTransition("evaluationStage", current.state, patch.state)
  ) {
    throw new InvalidTransitionError("evaluationStage", current.state, patch.state);
  }
  const now = toIsoTimestamp(patch.now ?? new Date());
  const startedAt =
    patch.startedAt ?? current.startedAt ?? (patch.state !== "PENDING" ? now : undefined);
  const finishedAt =
    patch.finishedAt ??
    (TERMINAL_STAGE_STATES.has(patch.state) ? (current.finishedAt ?? now) : undefined);
  const reason = patch.reason ?? current.reason;
  const detail = patch.detail ?? current.detail;
  const next: EvaluationStageRecord = EvaluationStageRecordSchema.parse({
    stage,
    state: patch.state,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(detail !== undefined ? { detail } : {}),
  });
  const others = stageLog.filter((record) => record.stage !== stage);
  return [...others, next].sort(
    (a, b) => EVALUATION_STAGE_ORDER.indexOf(a.stage) - EVALUATION_STAGE_ORDER.indexOf(b.stage),
  );
}

/** 단계 기록을 갱신하고 저장한다. 갱신된 평가 행을 돌려준다 */
export async function updateEvaluationStage(
  db: Database,
  evaluationId: string,
  stage: EvaluationStage,
  patch: StagePatch,
): Promise<EvaluationRow> {
  const evaluation = await getEvaluation(db, evaluationId);
  if (!evaluation) throw new Error(`평가를 찾을 수 없습니다: ${evaluationId}`);
  const stageLog = applyStagePatch(evaluation.stageLog, stage, patch);
  const [row] = await db
    .update(evaluations)
    .set({ stageLog })
    .where(eq(evaluations.id, evaluationId))
    .returning();
  if (!row) throw new Error(`평가를 찾을 수 없습니다: ${evaluationId}`);
  return row;
}

/**
 * `after` 뒤의 모든 단계 중 아직 PENDING인 것을 SKIPPED로 기록한다 (부록 B: 앞 단계가 UNSUPPORTED면 뒤 단계는 모두 SKIPPED).
 * 이미 시작했거나 끝난 단계는 건드리지 않는다.
 */
export async function skipStagesAfter(
  db: Database,
  evaluationId: string,
  after: EvaluationStage,
  reason: string,
  now: Date = new Date(),
): Promise<EvaluationRow> {
  const evaluation = await getEvaluation(db, evaluationId);
  if (!evaluation) throw new Error(`평가를 찾을 수 없습니다: ${evaluationId}`);
  let stageLog = evaluation.stageLog;
  const start = EVALUATION_STAGE_ORDER.indexOf(after) + 1;
  for (const stage of EVALUATION_STAGE_ORDER.slice(start)) {
    if (stageRecordOf(stageLog, stage).state !== "PENDING") continue;
    stageLog = applyStagePatch(stageLog, stage, { state: "SKIPPED", reason, now });
  }
  const [row] = await db
    .update(evaluations)
    .set({ stageLog })
    .where(eq(evaluations.id, evaluationId))
    .returning();
  if (!row) throw new Error(`평가를 찾을 수 없습니다: ${evaluationId}`);
  return row;
}
