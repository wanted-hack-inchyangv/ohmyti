/**
 * 재실행 요청·상태 (TICKET.md T-307). 서버 액션(`actions.ts`)과 `GET /api/evaluations/[id]/reruns`가 이 함수들을 부른다.
 *
 * - `requestRerun`: `RERUN_EXECUTION { evaluationId, caseId }` job을 넣는다. dedupeKey로 같은 케이스의 활성 job이 있으면
 *   새로 만들지 않고 그 id를 돌려준다. 여기서는 평가 존재, 원본 기록 존재(케이스가 실제로 실행됐는지), 횟수 상한만 확인한다.
 *   환경 digest·스냅샷·기준 버전 대조는 워커가 템플릿을 읽어야 하므로 워커가 한다 (거부되면 job FAILED + `lastError`에 사유).
 * - `readRerunStatus`: 평가의 재실행 job 목록과 상한. 화면은 이 값으로 대기·실행·실패를 보여 주고 폴링한다.
 * - web은 제출 코드를 실행하지 않는다 (G-05). 이 모듈은 큐에 넣고 읽기만 한다.
 */
import { z } from "zod";
import {
  DEFAULT_RERUN_LIMIT_PER_EVALUATION,
  RERUN_MAX_ATTEMPTS,
  rerunExecutionDedupeKey,
  RerunStatusReportSchema,
  type ApiErrorCode,
  type RerunJobSummary,
  type RerunRequested,
  type RerunStatusReport,
} from "@ohmyti/core";
import {
  enqueue,
  getEvaluation,
  getEvaluationResults,
  listRerunJobs,
  toIsoTimestamp,
  type Database,
  type JobRow,
} from "@ohmyti/db";

export interface RerunDeps {
  db: Database;
  /** evaluation당 재실행 상한. 기본 `DEFAULT_RERUN_LIMIT_PER_EVALUATION` (`RERUN_LIMIT_PER_EVALUATION`) */
  limit?: number | undefined;
}

export type RerunErrorCode = ApiErrorCode | "RERUN_REJECTED";

export type RerunResult<T> =
  { ok: true; data: T } | { ok: false; code: RerunErrorCode; message: string };

const CaseIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "케이스 ID 형식이 아닙니다");

/** `RERUN_LIMIT_PER_EVALUATION`. 없으면 기본 20, 잘못된 값은 기본값 */
export function rerunLimitFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env["RERUN_LIMIT_PER_EVALUATION"];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_RERUN_LIMIT_PER_EVALUATION;
}

function isUuid(value: string): boolean {
  return z.uuid().safeParse(value).success;
}

export function toRerunJobSummary(row: JobRow): RerunJobSummary {
  const payload = row.payload as { caseId?: unknown };
  return {
    id: row.id,
    caseId: typeof payload.caseId === "string" ? payload.caseId : "?",
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

/** job 목록 → 상태 보고. 상한 판단은 여기서만 한다 (화면·워커·요청이 같은 규칙을 쓴다) */
export function buildRerunStatus(
  evaluationId: string,
  rows: readonly JobRow[],
  limit: number,
): RerunStatusReport {
  const jobs = rows.map(toRerunJobSummary);
  const used = jobs.length;
  const remaining = Math.max(0, limit - used);
  const blockedReason =
    remaining === 0 ? `이 평가의 재실행 상한 ${limit}회를 모두 썼습니다 (${used}회)` : null;
  return RerunStatusReportSchema.parse({
    evaluationId,
    limit,
    used,
    remaining,
    canRequest: blockedReason === null,
    blockedReason,
    jobs,
  });
}

export async function readRerunStatus(
  deps: RerunDeps,
  evaluationId: string,
): Promise<RerunResult<RerunStatusReport>> {
  if (!isUuid(evaluationId)) {
    return { ok: false, code: "INVALID_INPUT", message: "평가 ID 형식이 올바르지 않습니다" };
  }
  const evaluation = await getEvaluation(deps.db, evaluationId);
  if (!evaluation) {
    return {
      ok: false,
      code: "EVALUATION_NOT_FOUND",
      message: `평가를 찾을 수 없습니다: ${evaluationId}`,
    };
  }
  const rows = await listRerunJobs(deps.db, evaluationId);
  return {
    ok: true,
    data: buildRerunStatus(evaluationId, rows, deps.limit ?? rerunLimitFromEnv()),
  };
}

/**
 * 재실행을 요청한다. 거부 사유는 `ok: false`로 돌려주며 예외를 던지지 않는다 (G-09·G-14).
 * 성공하면 갱신된 상태 보고를 함께 돌려준다.
 */
export async function requestRerun(
  deps: RerunDeps,
  evaluationId: string,
  rawCaseId: unknown,
): Promise<RerunResult<RerunRequested>> {
  if (!isUuid(evaluationId)) {
    return { ok: false, code: "INVALID_INPUT", message: "평가 ID 형식이 올바르지 않습니다" };
  }
  const caseId = CaseIdSchema.safeParse(rawCaseId);
  if (!caseId.success) {
    return { ok: false, code: "INVALID_INPUT", message: caseId.error.issues[0]!.message };
  }
  const limit = deps.limit ?? rerunLimitFromEnv();
  const evaluation = await getEvaluation(deps.db, evaluationId);
  if (!evaluation) {
    return {
      ok: false,
      code: "EVALUATION_NOT_FOUND",
      message: `평가를 찾을 수 없습니다: ${evaluationId}`,
    };
  }
  const results = await getEvaluationResults(deps.db, evaluationId);
  const hasOriginal = results.evidences.some((e) => {
    if (e.testId !== caseId.data || !e.runId) return false;
    const record = results.executionRecords.find((r) => r.id === e.runId);
    return record !== undefined && record.kind !== "RERUN";
  });
  if (!hasOriginal) {
    return {
      ok: false,
      code: "RERUN_REJECTED",
      message: `케이스 ${caseId.data}의 원본 실행 기록이 이 평가에 없어 같은 조건으로 재실행할 수 없습니다`,
    };
  }
  const before = buildRerunStatus(evaluationId, await listRerunJobs(deps.db, evaluationId), limit);
  const active = before.jobs.find(
    (j) => j.caseId === caseId.data && (j.status === "QUEUED" || j.status === "RUNNING"),
  );
  if (!active && !before.canRequest) {
    return { ok: false, code: "RERUN_REJECTED", message: before.blockedReason! };
  }
  const { id, created } = await enqueue(deps.db, {
    type: "RERUN_EXECUTION",
    payload: { evaluationId, caseId: caseId.data },
    dedupeKey: rerunExecutionDedupeKey(evaluationId, caseId.data),
    maxAttempts: RERUN_MAX_ATTEMPTS,
  });
  const status = buildRerunStatus(evaluationId, await listRerunJobs(deps.db, evaluationId), limit);
  return { ok: true, data: { jobId: id, created, status } };
}

export function rerunHttpStatusOf(code: RerunErrorCode): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "RERUN_REJECTED":
      return 409;
    default:
      return 404;
  }
}
