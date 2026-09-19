/**
 * 재실행 (TICKET.md T-307) 계약: 워커가 RERUN 기록의 `actual.json`에 남기는 원본 비교와,
 * web의 `GET /api/evaluations/[id]/reruns`가 돌려주는 재실행 상태.
 *
 * - 비교(`RerunComparison`)는 워커가 재실행 직후 원본 기록의 `actual.json`과 대조해 기록한 관측값이다. 화면은 이 값을
 *   그대로 보여 주며 다시 비교하지 않는다 (T-303 규칙: 화면은 재계산하지 않는다). 판정·점수에는 쓰지 않는다.
 * - 상태(`RerunStatusReport`)는 `jobs` 테이블의 RERUN_EXECUTION job을 옮긴 것이다. 성공 여부는 job 상태이며 성공한 job의
 *   결과 기록은 리포트의 `executionRecords`(kind RERUN)에 나타난다. 실패(FAILED)는 `lastError`가 사유다 (G-14).
 */
import { z } from "zod";
import { IdSchema, NonNegativeIntSchema, TimestampSchema } from "./common";
import { JobStatusSchema } from "./enums";

/** 워커가 RERUN 기록 `actual.json`의 `rerun` 필드에 쓰는 원본 비교 */
export const RerunComparisonSchema = z.strictObject({
  originalRunId: IdSchema,
  /** 재실행을 만든 job */
  jobId: IdSchema,
  /** 원본과 verdict가 같은가 */
  sameVerdict: z.boolean(),
  /** 원본과 실패한 검사의 관측값 맵(`actual`)이 같은가 (`canonicalJson` 대조) */
  sameActual: z.boolean(),
  /** 원본과 검사별 `ok`가 모두 같은가 */
  sameChecks: z.boolean(),
  /** `ok` 또는 관측값이 원본과 다른 검사 이름 (기록 순) */
  differingChecks: z.array(z.string().min(1)),
  /** 셋 다 같으면 `same`, 아니면 `different` */
  outcome: z.enum(["same", "different"]),
});
export type RerunComparison = z.infer<typeof RerunComparisonSchema>;

/** RERUN 기록의 `actual.json` 중 재생 뷰가 읽는 부분 (`HarnessCaseActualSchema`에 `rerun`이 더해진 형태) */
export const RerunActualSchema = z.looseObject({
  rerun: RerunComparisonSchema,
});

export const RerunJobSummarySchema = z.strictObject({
  id: IdSchema,
  caseId: z.string().min(1),
  status: JobStatusSchema,
  attempts: NonNegativeIntSchema,
  maxAttempts: z.int().min(1),
  /** 마지막 실패 사유 (마스킹됨). 재시도 대기 중이거나 FAILED일 때 있다 */
  lastError: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type RerunJobSummary = z.infer<typeof RerunJobSummarySchema>;

/** `GET /api/evaluations/[id]/reruns` */
export const RerunStatusReportSchema = z.strictObject({
  evaluationId: IdSchema,
  /** evaluation당 재실행 상한 */
  limit: z.int().min(1),
  /** 지금까지 만든 재실행 job 수 (CANCELLED 제외). 상한과 비교하는 값 */
  used: NonNegativeIntSchema,
  remaining: NonNegativeIntSchema,
  /** 새 재실행을 받을 수 있는가. false면 `blockedReason`에 사유 */
  canRequest: z.boolean(),
  blockedReason: z.string().nullable(),
  /** 재실행 job (생성 순) */
  jobs: z.array(RerunJobSummarySchema),
});
export type RerunStatusReport = z.infer<typeof RerunStatusReportSchema>;

/** `POST` 서버 액션 결과: 만들었거나(created) 같은 케이스의 활성 job이 이미 있어 그 id를 돌려줬다 */
export const RerunRequestedSchema = z.strictObject({
  jobId: IdSchema,
  created: z.boolean(),
  status: RerunStatusReportSchema,
});
export type RerunRequested = z.infer<typeof RerunRequestedSchema>;
