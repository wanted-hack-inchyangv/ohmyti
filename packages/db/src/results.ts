import {
  CriterionResultSchema,
  EvidenceSchema,
  ExecutionRecordSchema,
  type AreaScore,
  type CriterionResult,
  type Evidence,
  type EvidenceDetail,
  type EvidenceKind,
  type ExecutionRecord,
  type ExecutionRecordKind,
  type FailureKind,
  type Method,
  type ReviewState,
  type SourceLocation,
  type Verdict,
} from "@ohmyti/core";
import { and, asc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { Database } from "./client";
import type * as schema from "./schema";
import { criterionResults, evaluations, evidences, executionRecords } from "./schema";
import { fromIsoTimestamp, toIsoTimestampOrUndefined } from "./timestamps";

/**
 * 판정 저장 (TICKET.md T-205): ExecutionRecord·Evidence·CriterionResult 행과 평가 점수 필드.
 *
 * - `execution_records`는 불변이다 (G-03, 트리거). 여기에는 INSERT만 있고 UPDATE 함수는 두지 않는다.
 * - `criterion_results`의 G-02·G-04는 DB CHECK와 core 스키마(`CriterionResultSchema`)가 이중으로 검사한다.
 * - `persistEvaluationResults`는 한 트랜잭션에서 기록 → 근거 → 판정 → 점수 순으로 쓴다. 이미 판정이 있는 평가에는
 *   다시 쓰지 않고 `EvaluationResultsExistError`를 던진다 (재시도는 `hasCriterionResults`로 먼저 확인한다).
 * - 행 ↔ core 타입 변환(`toCriterionResult` 등)은 `aggregateScore`와 리포트(T-207)가 같은 값을 보게 한다.
 */

/** `Database`와 `db.transaction()`의 `tx`가 모두 만족하는 실행자 타입 */
export type DbExecutor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

export type ExecutionRecordRow = typeof executionRecords.$inferSelect;
export type EvidenceRow = typeof evidences.$inferSelect;
export type CriterionResultRow = typeof criterionResults.$inferSelect;

export class EvaluationResultsExistError extends Error {
  constructor(readonly evaluationId: string) {
    super(`평가 ${evaluationId}에는 이미 기준별 판정이 저장되어 있습니다`);
    this.name = "EvaluationResultsExistError";
  }
}

export interface NewExecutionRecord {
  /** 호출자가 정한 UUID. 근거가 `runId`로 참조하므로 미리 정한다 */
  id: string;
  evaluationId: string;
  kind: ExecutionRecordKind;
  submissionSha: string;
  rubricVersion: string;
  harnessVersion: string;
  environmentDigest: string;
  patchDigest?: string | undefined;
  seed?: string | undefined;
  inputRef: string;
  expectedRef: string;
  actualRef: string;
  exitCode: number | null;
  failureKind: FailureKind;
  /** ISO 8601 */
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  durationMs?: number | undefined;
}

export interface NewEvidence {
  id: string;
  evaluationId: string;
  submissionSha: string;
  source?: SourceLocation | undefined;
  runId?: string | undefined;
  testId?: string | undefined;
  artifactRefs: string[];
  snippet?: string | undefined;
  kind?: EvidenceKind | undefined;
  detail?: EvidenceDetail | undefined;
}

export interface NewCriterionResult {
  id?: string | undefined;
  evaluationId: string;
  criterionId: string;
  rubricVersion: string;
  maxPoints: number;
  earnedPoints: number | null;
  verdict: Verdict;
  method: Method;
  evidenceIds: string[];
  issueId?: string | undefined;
  observation: string;
  interpretation?: string | undefined;
  reviewState: ReviewState;
  satisfiedSubCriterionIds?: string[] | undefined;
}

export interface EvaluationScore {
  earned: number;
  min: number;
  max: number;
  pendingPoints: number;
  /** 영역별 소계 (`aggregateScore().byArea`). 생략하면 `score_by_area`를 null로 둔다 */
  byArea?: AreaScore[] | undefined;
}

export interface EvaluationResultsInput {
  evaluationId: string;
  executionRecords: NewExecutionRecord[];
  evidences: NewEvidence[];
  criterionResults: NewCriterionResult[];
  score: EvaluationScore;
}

export interface EvaluationResults {
  executionRecords: ExecutionRecordRow[];
  evidences: EvidenceRow[];
  criterionResults: CriterionResultRow[];
}

export async function insertExecutionRecords(
  db: DbExecutor,
  records: readonly NewExecutionRecord[],
): Promise<ExecutionRecordRow[]> {
  if (records.length === 0) return [];
  return db
    .insert(executionRecords)
    .values(
      records.map((record) => ({
        id: record.id,
        evaluationId: record.evaluationId,
        kind: record.kind,
        submissionSha: record.submissionSha,
        rubricVersion: record.rubricVersion,
        harnessVersion: record.harnessVersion,
        environmentDigest: record.environmentDigest,
        patchDigest: record.patchDigest ?? null,
        seed: record.seed ?? null,
        inputRef: record.inputRef,
        expectedRef: record.expectedRef,
        actualRef: record.actualRef,
        exitCode: record.exitCode,
        failureKind: record.failureKind,
        startedAt: record.startedAt ? fromIsoTimestamp(record.startedAt) : null,
        finishedAt: record.finishedAt ? fromIsoTimestamp(record.finishedAt) : null,
        durationMs: record.durationMs ?? null,
      })),
    )
    .returning();
}

export async function insertEvidences(
  db: DbExecutor,
  items: readonly NewEvidence[],
): Promise<EvidenceRow[]> {
  if (items.length === 0) return [];
  return db
    .insert(evidences)
    .values(
      items.map((item) => ({
        id: item.id,
        evaluationId: item.evaluationId,
        submissionSha: item.submissionSha,
        source: item.source ?? null,
        runId: item.runId ?? null,
        testId: item.testId ?? null,
        artifactRefs: item.artifactRefs,
        snippet: item.snippet ?? null,
        kind: item.kind ?? null,
        detail: item.detail ?? null,
      })),
    )
    .returning();
}

/** core 스키마(G-02·G-04)를 먼저 통과시킨 뒤 INSERT한다 */
export async function insertCriterionResults(
  db: DbExecutor,
  items: readonly NewCriterionResult[],
): Promise<CriterionResultRow[]> {
  if (items.length === 0) return [];
  for (const item of items) {
    CriterionResultSchema.parse({
      criterionId: item.criterionId,
      rubricVersion: item.rubricVersion,
      maxPoints: item.maxPoints,
      earnedPoints: item.earnedPoints,
      verdict: item.verdict,
      method: item.method,
      evidenceIds: item.evidenceIds,
      ...(item.issueId !== undefined ? { issueId: item.issueId } : {}),
      observation: item.observation,
      ...(item.interpretation !== undefined ? { interpretation: item.interpretation } : {}),
      reviewState: item.reviewState,
      evaluationId: item.evaluationId,
      ...(item.satisfiedSubCriterionIds !== undefined
        ? { satisfiedSubCriterionIds: item.satisfiedSubCriterionIds }
        : {}),
    });
  }
  return db
    .insert(criterionResults)
    .values(
      items.map((item) => ({
        ...(item.id !== undefined ? { id: item.id } : {}),
        evaluationId: item.evaluationId,
        criterionId: item.criterionId,
        rubricVersion: item.rubricVersion,
        maxPoints: item.maxPoints,
        earnedPoints: item.earnedPoints,
        verdict: item.verdict,
        method: item.method,
        evidenceIds: item.evidenceIds,
        issueId: item.issueId ?? null,
        observation: item.observation,
        interpretation: item.interpretation ?? null,
        reviewState: item.reviewState,
        satisfiedSubCriterionIds: item.satisfiedSubCriterionIds ?? null,
      })),
    )
    .returning();
}

/** `aggregateScore` 결과를 평가 점수 필드에 쓴다 (부록 C). 재환산하지 않고 값을 그대로 둔다 */
export async function setEvaluationScore(
  db: DbExecutor,
  evaluationId: string,
  score: EvaluationScore,
): Promise<void> {
  const [row] = await db
    .update(evaluations)
    .set({
      scoreEarned: score.earned,
      scoreMin: score.min,
      scoreMax: score.max,
      pendingPoints: score.pendingPoints,
      scoreByArea: score.byArea ?? null,
    })
    .where(eq(evaluations.id, evaluationId))
    .returning({ id: evaluations.id });
  if (!row) throw new Error(`평가를 찾을 수 없습니다: ${evaluationId}`);
}

export async function hasCriterionResults(db: DbExecutor, evaluationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: criterionResults.id })
    .from(criterionResults)
    .where(eq(criterionResults.evaluationId, evaluationId))
    .limit(1);
  return row !== undefined;
}

/**
 * 한 평가의 실행 기록·근거·판정·점수를 한 트랜잭션에 쓴다. 이미 판정이 있으면 아무것도 쓰지 않고
 * `EvaluationResultsExistError`다. 근거의 `runId`와 판정의 `evidenceIds`는 같은 입력 안의 ID를 가리켜야 한다
 * (외래 키는 `runId`만 검사하므로 `evidenceIds`는 여기서 대조한다).
 */
export async function persistEvaluationResults(
  db: Database,
  input: EvaluationResultsInput,
): Promise<EvaluationResults> {
  const evidenceIds = new Set(input.evidences.map((e) => e.id));
  for (const result of input.criterionResults) {
    for (const id of result.evidenceIds) {
      if (!evidenceIds.has(id)) {
        throw new Error(
          `기준 ${result.criterionId}의 evidenceIds가 입력에 없는 근거 ${id}를 가리킵니다`,
        );
      }
    }
  }
  return db.transaction(async (tx) => {
    if (await hasCriterionResults(tx, input.evaluationId)) {
      throw new EvaluationResultsExistError(input.evaluationId);
    }
    const records = await insertExecutionRecords(tx, input.executionRecords);
    const evidenceRows = await insertEvidences(tx, input.evidences);
    const resultRows = await insertCriterionResults(tx, input.criterionResults);
    await setEvaluationScore(tx, input.evaluationId, input.score);
    return { executionRecords: records, evidences: evidenceRows, criterionResults: resultRows };
  });
}

export async function listExecutionRecords(
  db: DbExecutor,
  evaluationId: string,
): Promise<ExecutionRecordRow[]> {
  return db
    .select()
    .from(executionRecords)
    .where(eq(executionRecords.evaluationId, evaluationId))
    .orderBy(asc(executionRecords.createdAt), asc(executionRecords.id));
}

export async function listEvidences(db: DbExecutor, evaluationId: string): Promise<EvidenceRow[]> {
  return db
    .select()
    .from(evidences)
    .where(eq(evidences.evaluationId, evaluationId))
    .orderBy(asc(evidences.createdAt), asc(evidences.id));
}

export async function listCriterionResults(
  db: DbExecutor,
  evaluationId: string,
): Promise<CriterionResultRow[]> {
  return db
    .select()
    .from(criterionResults)
    .where(eq(criterionResults.evaluationId, evaluationId))
    .orderBy(asc(criterionResults.criterionId));
}

export async function getEvaluationResults(
  db: DbExecutor,
  evaluationId: string,
): Promise<EvaluationResults> {
  const [records, evidenceRows, resultRows] = await Promise.all([
    listExecutionRecords(db, evaluationId),
    listEvidences(db, evaluationId),
    listCriterionResults(db, evaluationId),
  ]);
  return { executionRecords: records, evidences: evidenceRows, criterionResults: resultRows };
}

/** 행 → PRD 9장 `CriterionResult` (`aggregateScore` 입력) */
export function toCriterionResult(row: CriterionResultRow): CriterionResult {
  return CriterionResultSchema.parse({
    id: row.id,
    evaluationId: row.evaluationId,
    criterionId: row.criterionId,
    rubricVersion: row.rubricVersion,
    maxPoints: row.maxPoints,
    earnedPoints: row.earnedPoints,
    verdict: row.verdict,
    method: row.method,
    evidenceIds: row.evidenceIds,
    ...(row.issueId !== null ? { issueId: row.issueId } : {}),
    observation: row.observation,
    ...(row.interpretation !== null ? { interpretation: row.interpretation } : {}),
    reviewState: row.reviewState,
    ...(row.satisfiedSubCriterionIds !== null
      ? { satisfiedSubCriterionIds: row.satisfiedSubCriterionIds }
      : {}),
  });
}

export function toEvidence(row: EvidenceRow): Evidence {
  return EvidenceSchema.parse({
    id: row.id,
    evaluationId: row.evaluationId,
    submissionSha: row.submissionSha,
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.runId !== null ? { runId: row.runId } : {}),
    ...(row.testId !== null ? { testId: row.testId } : {}),
    artifactRefs: row.artifactRefs,
    createdAt: toIsoTimestampOrUndefined(row.createdAt),
    ...(row.kind !== null ? { kind: row.kind } : {}),
    ...(row.snippet !== null ? { snippet: row.snippet } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
  });
}

export function toExecutionRecord(row: ExecutionRecordRow): ExecutionRecord {
  return ExecutionRecordSchema.parse({
    id: row.id,
    evaluationId: row.evaluationId,
    kind: row.kind,
    submissionSha: row.submissionSha,
    rubricVersion: row.rubricVersion,
    harnessVersion: row.harnessVersion,
    environmentDigest: row.environmentDigest,
    ...(row.patchDigest !== null ? { patchDigest: row.patchDigest } : {}),
    ...(row.seed !== null ? { seed: row.seed } : {}),
    inputRef: row.inputRef,
    expectedRef: row.expectedRef,
    actualRef: row.actualRef,
    exitCode: row.exitCode,
    failureKind: row.failureKind,
    ...(row.startedAt !== null ? { startedAt: toIsoTimestampOrUndefined(row.startedAt) } : {}),
    ...(row.finishedAt !== null ? { finishedAt: toIsoTimestampOrUndefined(row.finishedAt) } : {}),
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
  });
}

/** 실행 기록 하나. 평가 ID도 대조해 다른 평가의 기록을 돌려주지 않는다 (T-207 run 엔드포인트) */
export async function getExecutionRecord(
  db: DbExecutor,
  evaluationId: string,
  runId: string,
): Promise<ExecutionRecordRow | null> {
  const [row] = await db
    .select()
    .from(executionRecords)
    .where(and(eq(executionRecords.evaluationId, evaluationId), eq(executionRecords.id, runId)))
    .limit(1);
  return row ?? null;
}

/** 실행 기록을 `run_id`로 참조하는 근거 */
export async function listEvidencesForRun(
  db: DbExecutor,
  evaluationId: string,
  runId: string,
): Promise<EvidenceRow[]> {
  return db
    .select()
    .from(evidences)
    .where(and(eq(evidences.evaluationId, evaluationId), eq(evidences.runId, runId)))
    .orderBy(asc(evidences.createdAt), asc(evidences.id));
}

/** 워커가 자리 표시 판정을 실제 판정으로 바꿀 때의 값 (T-404 테스트 실효성). 사람 검토(`applyCriterionReview`)와 구분한다 */
export interface CriterionResultReplacement {
  earnedPoints: number | null;
  verdict: Verdict;
  reviewState: ReviewState;
  evidenceIds: string[];
  issueId: string | null;
  observation: string;
}

/**
 * 판정 행의 판정·근거·관측을 바꾼다. core 스키마(G-02·G-04)를 먼저 통과시키고, DB 제약도 다시 검사한다.
 * `interpretation`·`satisfiedSubCriterionIds`는 건드리지 않는다
 */
export async function replaceCriterionResult(
  db: DbExecutor,
  row: CriterionResultRow,
  replacement: CriterionResultReplacement,
): Promise<CriterionResultRow> {
  CriterionResultSchema.parse({
    criterionId: row.criterionId,
    rubricVersion: row.rubricVersion,
    maxPoints: row.maxPoints,
    earnedPoints: replacement.earnedPoints,
    verdict: replacement.verdict,
    method: row.method,
    evidenceIds: replacement.evidenceIds,
    ...(replacement.issueId !== null ? { issueId: replacement.issueId } : {}),
    observation: replacement.observation,
    ...(row.interpretation !== null ? { interpretation: row.interpretation } : {}),
    reviewState: replacement.reviewState,
    evaluationId: row.evaluationId,
  });
  const [updated] = await db
    .update(criterionResults)
    .set({
      earnedPoints: replacement.earnedPoints,
      verdict: replacement.verdict,
      reviewState: replacement.reviewState,
      evidenceIds: replacement.evidenceIds,
      issueId: replacement.issueId,
      observation: replacement.observation,
      updatedAt: new Date(),
    })
    .where(eq(criterionResults.id, row.id))
    .returning();
  if (!updated) throw new Error(`판정 행을 찾을 수 없습니다: ${row.id}`);
  return updated;
}

/** 한 평가의 판정 행을 모두 잠그고 읽는다 (`FOR UPDATE`, 기준 ID 순). 트랜잭션 안에서 불러야 한다 */
export async function lockCriterionResults(
  db: DbExecutor,
  evaluationId: string,
): Promise<CriterionResultRow[]> {
  return db
    .select()
    .from(criterionResults)
    .where(eq(criterionResults.evaluationId, evaluationId))
    .orderBy(asc(criterionResults.criterionId))
    .for("update");
}

/**
 * LLM 근거 탐색(T-407)이 판정 행에 남기는 값: `interpretation`(추정)과 근거 목록만 바꾼다.
 * 점수·판정·관측(`earned_points`·`verdict`·`observation`)과 검토 상태는 SET 절에 없으므로 바뀔 수 없다 (G-01)
 */
export async function setCriterionInterpretation(
  db: DbExecutor,
  rowId: string,
  patch: { interpretation: string | null; evidenceIds: string[] },
): Promise<CriterionResultRow> {
  const [updated] = await db
    .update(criterionResults)
    .set({
      interpretation: patch.interpretation,
      evidenceIds: patch.evidenceIds,
      updatedAt: new Date(),
    })
    .where(eq(criterionResults.id, rowId))
    .returning();
  if (!updated) throw new Error(`판정 행을 찾을 수 없습니다: ${rowId}`);
  return updated;
}
