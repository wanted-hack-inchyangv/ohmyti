/**
 * 실행 기록 본문의 재생용 형태 (TICKET.md T-303). `RunRecordReport`의 `timeline`·`expected`·`actual`은 `z.json()`이며,
 * 하네스 케이스 기록이면 `@ohmyti/harness`의 `TimelineEntry`·`CaseResult` 그대로다. web은 harness에 의존할 수 없으므로
 * (G-05, `deps:boundary-check`) 재생 뷰가 읽는 필드만 느슨한 스키마(`looseObject`: 모르는 필드는 통과)로 여기에 둔다.
 * 하네스 테스트가 실제 `CaseResult`로 이 스키마를 통과하는지 대조한다.
 *
 * 이 모듈은 값을 해석하지 않는다. 기록에 있는 값을 형태만 확인해 돌려주며 기대·실제 비교는 기록의 `checks[].ok`를 쓴다.
 */
import { z } from "zod";

/** JSON 값. 기록의 본문·기대값·관측값은 모두 이 형태다 (하네스 `JsonValue`와 같다) */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const ReplayHttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const ReplayRequestSchema = z.looseObject({
  method: ReplayHttpMethodSchema,
  path: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  body: JsonValueSchema,
});
export type ReplayRequest = z.infer<typeof ReplayRequestSchema>;

export const ReplayResponseSchema = z.looseObject({
  status: z.int(),
  headers: z.record(z.string(), z.string()),
  body: JsonValueSchema,
  bodyIsJson: z.boolean(),
});
export type ReplayResponse = z.infer<typeof ReplayResponseSchema>;

export const ReplayTransportErrorSchema = z.looseObject({
  kind: z.enum(["TIMEOUT", "CONNECTION"]),
  message: z.string(),
});

export const REPLAY_ENTRY_KINDS = ["reset", "request", "observeState", "parallel"] as const;
export const ReplayEntryKindSchema = z.enum(REPLAY_ENTRY_KINDS);
export type ReplayEntryKind = z.infer<typeof ReplayEntryKindSchema>;

/** 하네스 `TimelineEntry` 중 재생 뷰가 읽는 필드 */
export const ReplayTimelineEntrySchema = z.looseObject({
  seq: z.int().min(0),
  stepIndex: z.int().min(-1),
  kind: ReplayEntryKindSchema,
  capture: z.string().optional(),
  request: ReplayRequestSchema,
  response: ReplayResponseSchema.nullable(),
  error: ReplayTransportErrorSchema.optional(),
  elapsedMs: z.int().min(0),
  stateAfter: JsonValueSchema.optional(),
});
export type ReplayTimelineEntry = z.infer<typeof ReplayTimelineEntrySchema>;

export const ReplayTimelineSchema = z.array(ReplayTimelineEntrySchema);

/** 하네스 `CheckResult`. `ok`가 기록된 판정이며 화면은 이 값을 다시 계산하지 않는다 */
export const ReplayCheckSchema = z.looseObject({
  name: z.string().min(1),
  ok: z.boolean(),
  expected: JsonValueSchema,
  actual: JsonValueSchema,
});
export type ReplayCheck = z.infer<typeof ReplayCheckSchema>;

/** 워커(`buildRequirementResults`)가 하네스 케이스 기록의 `expected.json`에 쓰는 형태 */
export const HarnessCaseExpectedSchema = z.looseObject({
  caseId: z.string().min(1),
  /** 실패한 검사의 기대값 (검사 이름 → 값) */
  expected: z.record(z.string(), JsonValueSchema),
  checks: z.array(z.looseObject({ name: z.string().min(1), expected: JsonValueSchema })),
});
export type HarnessCaseExpected = z.infer<typeof HarnessCaseExpectedSchema>;

/** 워커가 하네스 케이스 기록의 `actual.json`에 쓰는 형태 */
export const HarnessCaseActualSchema = z.looseObject({
  caseId: z.string().min(1),
  verdict: z.string().min(1),
  failureKind: z.string().min(1),
  reason: z.string().nullable(),
  /** 실패한 검사의 관측값 (검사 이름 → 값) */
  actual: z.record(z.string(), JsonValueSchema),
  checks: z.array(ReplayCheckSchema),
});
export type HarnessCaseActual = z.infer<typeof HarnessCaseActualSchema>;
