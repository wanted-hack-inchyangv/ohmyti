import type { JobType } from "@ohmyti/core";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client";
import type { DbExecutor } from "./results";
import { jobs } from "./schema";

/**
 * PostgreSQL 기반 작업 큐 (TICKET.md T-006, 부록 B의 Job 상태 머신).
 *
 * - `enqueue`: web·worker 공용. `dedupeKey`가 QUEUED·RUNNING인 job과 겹치면 기존 id를 돌려준다.
 * - `claimJob`: `FOR UPDATE SKIP LOCKED`로 한 건을 가져와 RUNNING으로 바꾼다. 워커 여러 개가 같은 job을 잡지 못한다.
 * - `heartbeatJob` / `completeJob` / `failJob` / `releaseJob`: 잡은 워커만(`lockedBy` 일치) 상태를 바꿀 수 있다.
 * - `reclaimStaleJobs`: heartbeat가 끊긴 RUNNING job을 QUEUED로 되돌린다 (시도 횟수를 다 썼으면 FAILED).
 *
 * `attempts`는 claim 시점에 1 증가한다. 따라서 `attempts`는 "시작된 시도 횟수"이며 `maxAttempts`에 닿으면
 * 다음 실패에서 FAILED가 된다. `releaseJob`(정상 종료로 인한 반납)은 시도 횟수를 되돌린다.
 */

export type JobRow = typeof jobs.$inferSelect;

export interface EnqueueInput {
  type: JobType;
  /** JSON 직렬화가 가능한 값 */
  payload: unknown;
  /** 같은 대상의 중복 적재 방지 키. 활성(QUEUED·RUNNING) job과 겹치면 새로 만들지 않는다 */
  dedupeKey?: string | undefined;
  /** 이 시각 이후에만 실행한다. 기본 즉시 */
  runAfter?: Date | undefined;
  /** 최대 시도 횟수. 기본 3 */
  maxAttempts?: number | undefined;
}

export interface EnqueueResult {
  id: string;
  /** false이면 같은 dedupeKey의 활성 job이 이미 있어 그 id를 돌려준 것이다 */
  created: boolean;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/** 트랜잭션 안에서도 부를 수 있다 (`DbExecutor`) */
export async function enqueue(db: DbExecutor, input: EnqueueInput): Promise<EnqueueResult> {
  if (
    input.maxAttempts !== undefined &&
    (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)
  ) {
    throw new RangeError(`maxAttempts는 1 이상의 정수여야 합니다: ${input.maxAttempts}`);
  }
  // runAfter를 주지 않으면 DB 기본값 now()를 쓴다. 애플리케이션 시계가 DB보다 앞서 있으면
  // 방금 넣은 job이 잠시 claim되지 않는 문제를 피하기 위해서다.
  const values = {
    type: input.type,
    payload: input.payload,
    dedupeKey: input.dedupeKey ?? null,
    ...(input.runAfter ? { runAfter: input.runAfter } : {}),
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  };

  if (values.dedupeKey === null) {
    const [row] = await db.insert(jobs).values(values).returning({ id: jobs.id });
    if (!row) throw new Error("job insert가 행을 돌려주지 않았습니다");
    return { id: row.id, created: true };
  }

  // 부분 유니크 인덱스(jobs_dedupe_key_active_idx)와 같은 조건으로 충돌을 감지한다.
  // 충돌 직후 기존 job이 끝나 버리면 조회가 비므로 몇 번 다시 시도한다.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await db
      .insert(jobs)
      .values(values)
      .onConflictDoNothing({
        target: jobs.dedupeKey,
        where: sql`${jobs.status} IN ('QUEUED', 'RUNNING')`,
      })
      .returning({ id: jobs.id });
    const created = inserted[0];
    if (created) return { id: created.id, created: true };

    const existing = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.dedupeKey, values.dedupeKey), sql`${jobs.status} IN ('QUEUED', 'RUNNING')`),
      )
      .limit(1);
    const found = existing[0];
    if (found) return { id: found.id, created: false };
  }
  throw new Error(`dedupeKey ${JSON.stringify(values.dedupeKey)} job을 만들지도 찾지도 못했습니다`);
}

export interface ClaimOptions {
  workerId: string;
  /** 지정하면 이 타입만 가져온다 */
  types?: readonly JobType[] | undefined;
  /** 기준 시각. 테스트용. 기본 DB의 now() */
  now?: Date | undefined;
}

/** 실행 가능한 job 하나를 잠그고 RUNNING으로 바꾼다. 없으면 null. */
export async function claimJob(db: Database, options: ClaimOptions): Promise<JobRow | null> {
  const now = options.now ? sql`${options.now.toISOString()}::timestamptz` : sql`now()`;
  const typeFilter =
    options.types && options.types.length > 0
      ? sql`AND ${jobs.type} IN (${sql.join(
          options.types.map((t) => sql`${t}::job_type`),
          sql`, `,
        )})`
      : sql``;

  const rows = await db.execute<JobRow>(sql`
    WITH next AS (
      SELECT ${jobs.id} AS id FROM ${jobs}
      WHERE ${jobs.status} = 'QUEUED' AND ${jobs.runAfter} <= ${now} ${typeFilter}
      ORDER BY ${jobs.runAfter}, ${jobs.createdAt}
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${jobs} SET
      status = 'RUNNING',
      locked_by = ${options.workerId},
      locked_at = ${now},
      heartbeat_at = ${now},
      attempts = ${jobs.attempts} + 1,
      updated_at = ${now}
    FROM next WHERE ${jobs.id} = next.id
    RETURNING ${jobs.id} AS id, ${jobs.type} AS type, ${jobs.payload} AS payload,
      ${jobs.status} AS status, ${jobs.attempts} AS attempts, ${jobs.maxAttempts} AS "maxAttempts",
      ${jobs.runAfter} AS "runAfter", ${jobs.lockedBy} AS "lockedBy", ${jobs.lockedAt} AS "lockedAt",
      ${jobs.heartbeatAt} AS "heartbeatAt", ${jobs.lastError} AS "lastError",
      ${jobs.dedupeKey} AS "dedupeKey", ${jobs.createdAt} AS "createdAt", ${jobs.updatedAt} AS "updatedAt"
  `);
  const row = rows[0];
  return row ? normalizeRow(row) : null;
}

/** 잡은 워커가 진행 중임을 알린다. false이면 회수·취소되어 더 이상 이 워커의 job이 아니다. */
export async function heartbeatJob(
  db: Database,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const updated = await db
    .update(jobs)
    .set({ heartbeatAt: new Date() })
    .where(ownedRunning(jobId, workerId))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

/** SUCCEEDED로 마친다. false이면 소유권을 잃은 뒤라 상태를 바꾸지 않았다. */
export async function completeJob(db: Database, jobId: string, workerId: string): Promise<boolean> {
  const updated = await db
    .update(jobs)
    .set({
      status: "SUCCEEDED",
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      lastError: null,
    })
    .where(ownedRunning(jobId, workerId))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

export interface FailOptions {
  error: string;
  /** true이면 남은 시도와 무관하게 FAILED로 끝낸다 */
  nonRetryable?: boolean | undefined;
  /** 재시도 대기 시간(ms) 계산. 기본 지수 백오프 */
  backoff?: ((attempts: number) => number) | undefined;
  now?: Date | undefined;
}

export type FailOutcome = "RETRY" | "FAILED" | "LOST";

/**
 * 시도가 실패했다. 남은 시도가 있으면 백오프 후 QUEUED로 돌리고, 없으면 FAILED로 끝낸다.
 * 두 경우 모두 `last_error`를 남긴다. 소유권을 잃었으면 `LOST`.
 */
export async function failJob(
  db: Database,
  jobId: string,
  workerId: string,
  options: FailOptions,
): Promise<FailOutcome> {
  const now = options.now ?? new Date();
  const backoff = options.backoff ?? defaultBackoffMs;
  const lastError = options.error.slice(0, 4000);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ attempts: jobs.attempts, maxAttempts: jobs.maxAttempts })
      .from(jobs)
      .where(ownedRunning(jobId, workerId))
      .for("update");
    if (!current) return "LOST";

    const exhausted = options.nonRetryable === true || current.attempts >= current.maxAttempts;
    if (exhausted) {
      await tx
        .update(jobs)
        .set({ status: "FAILED", lockedBy: null, lockedAt: null, heartbeatAt: null, lastError })
        .where(eq(jobs.id, jobId));
      return "FAILED";
    }
    const runAfter = new Date(now.getTime() + backoff(current.attempts));
    await tx
      .update(jobs)
      .set({
        status: "QUEUED",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        lastError,
        runAfter,
      })
      .where(eq(jobs.id, jobId));
    return "RETRY";
  });
}

/**
 * 워커가 정상 종료하면서 진행 중이던 job을 QUEUED로 반납한다. 실패가 아니므로 시도 횟수를 되돌린다.
 * false이면 소유권을 잃은 뒤다.
 */
export async function releaseJob(db: Database, jobId: string, workerId: string): Promise<boolean> {
  const updated = await db
    .update(jobs)
    .set({
      status: "QUEUED",
      lockedBy: null,
      lockedAt: null,
      heartbeatAt: null,
      attempts: sql`GREATEST(${jobs.attempts} - 1, 0)`,
    })
    .where(ownedRunning(jobId, workerId))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

/**
 * QUEUED·RUNNING job을 CANCELLED로 바꾼다. 실행 중이던 워커는 다음 heartbeat에서 false를 받는다.
 * RUNNING이던 job은 `locked_by`를 남겨 둔다: 그 워커가 핸들러(러너 정리 포함)를 빠져나온 뒤
 * `acknowledgeCancelledJob`으로 지우므로, 제출 삭제(T-506)는 이 값이 비기를 기다려 실행이 멈췄음을 안다.
 */
export async function cancelJob(db: DbExecutor, jobId: string): Promise<boolean> {
  const updated = await db
    .update(jobs)
    .set(CANCEL_SET)
    .where(and(eq(jobs.id, jobId), sql`${jobs.status} IN ('QUEUED', 'RUNNING')`))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

/** `cancelJob`의 갱신 값. QUEUED였던 job은 원래 `locked_by`가 없으므로 그대로 비어 있다 */
export const CANCEL_SET = { status: "CANCELLED" as const, heartbeatAt: null };

/**
 * 취소된 job을 실행하던 워커가 핸들러를 빠져나왔음을 기록한다(`locked_by`를 비운다).
 * 이 워커가 잡은 CANCELLED job이 아니면 아무것도 하지 않고 false다.
 */
export async function acknowledgeCancelledJob(
  db: Database,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const updated = await db
    .update(jobs)
    .set({ lockedBy: null, lockedAt: null })
    .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId), eq(jobs.status, "CANCELLED")))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

export interface ReclaimOptions {
  /** heartbeat가 이 시간(ms)보다 오래되면 회수한다 */
  staleMs: number;
  now?: Date | undefined;
}

export interface ReclaimResult {
  requeued: string[];
  failed: string[];
}

/**
 * heartbeat가 `staleMs`를 넘긴 RUNNING job을 회수한다. 시도 횟수가 남았으면 QUEUED, 다 썼으면 FAILED.
 * 회수 사유는 `last_error`에 남긴다 (G-11: 환경 장애로 분류).
 */
export async function reclaimStaleJobs(
  db: Database,
  options: ReclaimOptions,
): Promise<ReclaimResult> {
  const now = options.now ?? new Date();
  const threshold = new Date(now.getTime() - options.staleMs);
  const rows = await db.execute<{ id: string; status: "QUEUED" | "FAILED" }>(sql`
    WITH stale AS (
      SELECT ${jobs.id} AS id FROM ${jobs}
      WHERE ${jobs.status} = 'RUNNING'
        AND COALESCE(${jobs.heartbeatAt}, ${jobs.lockedAt}, ${jobs.updatedAt}) < ${threshold.toISOString()}::timestamptz
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${jobs} SET
      status = CASE WHEN ${jobs.attempts} >= ${jobs.maxAttempts} THEN 'FAILED'::job_status ELSE 'QUEUED'::job_status END,
      locked_by = NULL,
      locked_at = NULL,
      heartbeat_at = NULL,
      last_error = 'ENVIRONMENT: heartbeat가 ' || ${options.staleMs}::text || 'ms 이상 끊겨 워커 ' || COALESCE(${jobs.lockedBy}, '?') || '에서 회수했습니다',
      updated_at = ${now.toISOString()}::timestamptz
    FROM stale WHERE ${jobs.id} = stale.id
    RETURNING ${jobs.id} AS id, ${jobs.status} AS status
  `);
  const result: ReclaimResult = { requeued: [], failed: [] };
  for (const row of rows) {
    (row.status === "FAILED" ? result.failed : result.requeued).push(row.id);
  }
  return result;
}

export async function getJob(db: Database, jobId: string): Promise<JobRow | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ?? null;
}

/** 지수 백오프: 1초 · 2초 · 4초 … 최대 5분. 같은 시각에 몰리지 않도록 최대 20% 지터를 더한다. */
export function defaultBackoffMs(attempts: number): number {
  const base = Math.min(1_000 * 2 ** Math.max(attempts - 1, 0), 5 * 60_000);
  return Math.round(base * (1 + Math.random() * 0.2));
}

function ownedRunning(jobId: string, workerId: string) {
  return and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId), eq(jobs.status, "RUNNING"));
}

/** `db.execute`는 timestamptz를 문자열로 돌려주므로 Drizzle select 결과와 같은 Date로 맞춘다. */
function normalizeRow(row: JobRow): JobRow {
  const toDate = (v: unknown): Date | null => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v;
    if (typeof v === "string" || typeof v === "number") return new Date(v);
    throw new TypeError(`timestamptz 값을 Date로 바꿀 수 없습니다: ${typeof v}`);
  };
  return {
    ...row,
    runAfter: toDate(row.runAfter) as Date,
    lockedAt: toDate(row.lockedAt),
    heartbeatAt: toDate(row.heartbeatAt),
    createdAt: toDate(row.createdAt) as Date,
    updatedAt: toDate(row.updatedAt) as Date,
  };
}
