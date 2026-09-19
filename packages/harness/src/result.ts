/**
 * 케이스 실행 결과 (TICKET.md T-107).
 * 요청·응답은 헤더·본문 전체를 마스킹해 기록하며, `expected`·`actual`은 검사 이름별 구체 값이다.
 */
import { FailureKindSchema, VerdictSchema } from "@ohmyti/core";
import { z } from "zod";
import { HttpMethodSchema, JsonValueSchema } from "./dsl";

export const RecordedRequestSchema = z.strictObject({
  method: HttpMethodSchema,
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  /** JSON 본문은 파싱된 값, 그 밖의 본문은 문자열. 본문이 없으면 null */
  body: JsonValueSchema,
});
export type RecordedRequest = z.infer<typeof RecordedRequestSchema>;

export const RecordedResponseSchema = z.strictObject({
  status: z.int(),
  headers: z.record(z.string(), z.string()),
  /** JSON으로 파싱되면 그 값, 아니면 원문 문자열. 빈 본문은 null */
  body: JsonValueSchema,
  /** 본문이 JSON으로 파싱됐는지. 기대값 비교는 파싱된 본문에만 의미가 있다 */
  bodyIsJson: z.boolean(),
});
export type RecordedResponse = z.infer<typeof RecordedResponseSchema>;

/** 전송 단계 오류. 응답을 받지 못한 경우다. */
export const TransportErrorSchema = z.strictObject({
  kind: z.enum(["TIMEOUT", "CONNECTION"]),
  /** 마스킹된 메시지 */
  message: z.string(),
});
export type TransportError = z.infer<typeof TransportErrorSchema>;

export const TimelineEntrySchema = z.strictObject({
  seq: z.int().min(0),
  /** 케이스 `steps` 배열의 인덱스. 케이스 시작 전 초기화 요청은 -1 */
  stepIndex: z.int().min(-1),
  kind: z.enum(["reset", "request", "observeState", "parallel"]),
  /** 캡처 이름. parallel은 `이름[인덱스]` */
  capture: z.string().optional(),
  request: RecordedRequestSchema,
  response: RecordedResponseSchema.nullable(),
  error: TransportErrorSchema.optional(),
  elapsedMs: z.int().min(0),
  /** observeState 스텝이 읽은 상태 본문 */
  stateAfter: JsonValueSchema.optional(),
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const CheckResultSchema = z.strictObject({
  name: z.string().min(1),
  ok: z.boolean(),
  /** 기대값. `gte`는 `">= n"`, `nonEmptyString`은 `"non-empty string"` */
  expected: JsonValueSchema,
  /** 관측값. 참조를 풀 수 없으면 null */
  actual: JsonValueSchema,
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const CaseResultSchema = z.strictObject({
  caseId: z.string().min(1),
  criterionIds: z.array(z.string().min(1)).min(1),
  verdict: VerdictSchema,
  failureKind: FailureKindSchema,
  /** INCONCLUSIVE·SUBMISSION의 사유(마스킹됨) */
  reason: z.string().optional(),
  timeline: z.array(TimelineEntrySchema),
  /** 모든 검사 결과 (통과 포함) */
  checks: z.array(CheckResultSchema),
  /** 실패한 검사의 기대값. 키는 검사 이름 */
  expected: z.record(z.string(), JsonValueSchema),
  /** 실패한 검사의 관측값. 키는 검사 이름 */
  actual: z.record(z.string(), JsonValueSchema),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const HarnessReportSchema = z.strictObject({
  harnessVersion: z.string().min(1),
  caseSet: z.string().min(1),
  rubricVersion: z.string().min(1),
  baseUrl: z.url(),
  requestTimeoutMs: z.int().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  results: z.array(CaseResultSchema),
  summary: z.strictObject({
    total: z.int().min(0),
    pass: z.int().min(0),
    fail: z.int().min(0),
    inconclusive: z.int().min(0),
  }),
});
export type HarnessReport = z.infer<typeof HarnessReportSchema>;
