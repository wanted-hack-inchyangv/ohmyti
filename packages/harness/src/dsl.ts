/**
 * 케이스 정의 DSL (TICKET.md T-107).
 *
 * 케이스는 함수 없이 JSON으로 직렬화할 수 있는 선언형 데이터다. 그래야 `harnessVersion`의 케이스 해시를
 * 정규 직렬화로 계산할 수 있고(워커 번들 안에서도 같은 값), 케이스 정의 자체를 실행 기록에 남길 수 있다.
 *
 * 앞 스텝의 응답은 `capture` 이름으로 저장되고, 뒤 스텝은 `{{name.body.id}}` 템플릿(문자열 안)이나
 * `{ $ref: "name.body.id" }`(값 자리)로 참조한다. 검사(Check)는 관측값을 기대값과 비교하며,
 * 판정에 LLM은 쓰지 않는다 (G-01).
 */
import { z } from "zod";

export const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

/** JSON 값. 본문·기대값·관측값은 모두 이 형태다. */
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

/** 캡처된 값 참조. 경로는 `이름.필드.필드`이며 배열은 `이름.0.body.id`처럼 인덱스로 접근한다. */
export const RefSchema = z.strictObject({ $ref: z.string().min(1) });
export type Ref = z.infer<typeof RefSchema>;

/** 본문 안에 참조를 섞어 쓸 수 있는 값. */
export type BodyValue = JsonValue | Ref | BodyValue[] | { [key: string]: BodyValue };
export const BodyValueSchema: z.ZodType<BodyValue> = z.lazy(() =>
  z.union([
    RefSchema,
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(BodyValueSchema),
    z.record(z.string(), BodyValueSchema),
  ]),
);

/** HTTP 요청 한 건. `body`는 JSON으로 보내고 `rawBody`는 문자열 그대로 보낸다(JSON이 아닌 본문 검증용). */
export const RequestSpecSchema = z
  .strictObject({
    method: HttpMethodSchema,
    /** `{{name.body.id}}` 템플릿을 쓸 수 있다. */
    path: z.string().startsWith("/"),
    /** 헤더 값에도 템플릿을 쓸 수 있다. 명시한 헤더만 보낸다. */
    headers: z.record(z.string(), z.string()).optional(),
    body: BodyValueSchema.optional(),
    rawBody: z.string().optional(),
  })
  .refine((r) => !(r.body !== undefined && r.rawBody !== undefined), {
    message: "body와 rawBody는 함께 쓸 수 없습니다",
  });
export type RequestSpec = z.infer<typeof RequestSpecSchema>;

/** 배열 항목 필터. `path`의 값이 `equals`와 같은 항목만 고른다. */
export const WhereSchema = z.strictObject({
  path: z.string().min(1),
  equals: JsonValueSchema,
});
export type Where = z.infer<typeof WhereSchema>;

/**
 * 관측값 식. 참조 하나이거나, 캡처된 배열(parallel 결과)에 대한 집계다.
 * 집계 결과는 결정적인 스칼라(개수·불리언·최솟값)여서 무작위 id가 `actual`에 섞이지 않는다.
 */
export const ValueExprSchema = z.union([
  RefSchema,
  /** `where`에 맞는 항목 수 */
  z.strictObject({ $countWhere: z.strictObject({ of: z.string().min(1), where: WhereSchema }) }),
  /** (`where` 필터 후) `path` 값의 서로 다른 개수 */
  z.strictObject({
    $distinctCount: z.strictObject({
      of: z.string().min(1),
      path: z.string().min(1),
      where: WhereSchema.optional(),
    }),
  }),
  /** (`where` 필터 후) `path` 값이 모두 같은지. 항목이 없으면 false */
  z.strictObject({
    $allEqual: z.strictObject({
      of: z.string().min(1),
      path: z.string().min(1),
      where: WhereSchema.optional(),
    }),
  }),
  /** (`where` 필터 후) 숫자 `path` 값의 최솟값. 숫자가 아닌 값이 섞이면 null */
  z.strictObject({
    $min: z.strictObject({
      of: z.string().min(1),
      path: z.string().min(1),
      where: WhereSchema.optional(),
    }),
  }),
  /** 여러 참조의 값이 모두 같은지 (id 비교용. 값 자체는 `actual`에 남기지 않는다) */
  z.strictObject({ $sameValue: z.strictObject({ refs: z.array(z.string().min(1)).min(2) }) }),
]);
export type ValueExpr = z.infer<typeof ValueExprSchema>;

/** 검사 하나. 비교 방식은 하나만 지정한다. */
export const CheckSchema = z
  .strictObject({
    /** 사람이 읽는 이름. `expected`·`actual`의 키가 된다. 케이스 안에서 유일해야 한다. */
    name: z.string().min(1),
    actual: ValueExprSchema,
    equals: JsonValueSchema.optional(),
    gte: z.number().optional(),
    nonEmptyString: z.literal(true).optional(),
  })
  .refine(
    (c) =>
      [c.equals !== undefined, c.gte !== undefined, c.nonEmptyString === true].filter(Boolean)
        .length === 1,
    { message: "equals, gte, nonEmptyString 중 정확히 하나를 지정해야 합니다" },
  );
export type Check = z.infer<typeof CheckSchema>;

/** 응답 단언 스텝의 축약형. 상태와 본문 일부 일치를 검사로 풀어낸다. */
export const ResponseExpectationSchema = z.strictObject({
  status: z.int().min(100).max(599).optional(),
  /** 본문 일부 일치. 키마다 `body.<키>`가 값과 같은지 검사한다. 중첩 경로는 `error.code`처럼 점으로 쓴다. */
  body: z.record(z.string(), JsonValueSchema).optional(),
  /** 비어 있지 않은 문자열이어야 하는 본문 경로. */
  nonEmptyStrings: z.array(z.string().min(1)).optional(),
});
export type ResponseExpectation = z.infer<typeof ResponseExpectationSchema>;

export const StepSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("request"),
    capture: z.string().min(1),
    request: RequestSpecSchema,
  }),
  z.strictObject({
    kind: z.literal("assertResponse"),
    /** 검사할 캡처 이름 */
    of: z.string().min(1),
    /** 검사 이름 접두사. 기본은 캡처 이름 */
    label: z.string().min(1).optional(),
    expect: ResponseExpectationSchema,
  }),
  z.strictObject({
    kind: z.literal("observeState"),
    capture: z.string().min(1),
    /** `GET`으로 읽는 상태 경로 (예: `/products/p1`) */
    path: z.string().startsWith("/"),
    /** 기대 상태. 키는 본문 경로, 값은 기대값. 생략하면 관측만 한다 */
    expect: z.record(z.string(), JsonValueSchema).optional(),
    /** 검사 이름 접두사. 기본은 캡처 이름 */
    label: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("parallel"),
    capture: z.string().min(1),
    /** 동시에 보낼 요청 목록. 응답은 같은 순서의 배열로 캡처된다 */
    requests: z.array(RequestSpecSchema).min(1).optional(),
    /**
     * 캡처된 배열의 항목마다 요청을 만들어 동시에 보낸다. `request` 안에서 항목은 `{{item.body.id}}`로 참조한다.
     * `requests`와 함께 쓸 수 없다.
     */
    forEach: z
      .strictObject({
        of: z.string().min(1),
        where: WhereSchema.optional(),
        request: RequestSpecSchema,
      })
      .optional(),
  }),
]);
export type Step = z.infer<typeof StepSchema>;

export const CaseDefinitionSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  /** 이 케이스가 근거가 되는 rubric 기준 ID. 최소 1개 */
  criterionIds: z.array(z.string().min(1)).min(1),
  steps: z.array(StepSchema).min(1),
  /** 모든 스텝이 끝난 뒤 평가하는 검사 */
  expect: z.array(CheckSchema),
});
export type CaseDefinition = z.infer<typeof CaseDefinitionSchema>;

/** 케이스 정의를 검증해 돌려준다. 잘못된 정의는 케이스를 로드하는 시점에 바로 드러나야 한다. */
export function defineCase(definition: CaseDefinition): CaseDefinition {
  const parsed = CaseDefinitionSchema.parse(definition);
  for (const step of parsed.steps) {
    if (
      step.kind === "parallel" &&
      (step.requests === undefined) === (step.forEach === undefined)
    ) {
      throw new Error(
        `케이스 ${parsed.id}: parallel 스텝은 requests와 forEach 중 하나만 지정해야 합니다`,
      );
    }
  }
  const names = new Set<string>();
  for (const check of collectCheckNames(parsed)) {
    if (names.has(check)) throw new Error(`케이스 ${parsed.id}: 검사 이름이 중복됩니다: ${check}`);
    names.add(check);
  }
  return parsed;
}

/** 케이스가 만들어낼 검사 이름 전체(스텝 축약형 포함). 이름 중복 검사와 문서화에 쓴다. */
export function collectCheckNames(definition: CaseDefinition): string[] {
  const names: string[] = [];
  for (const step of definition.steps) {
    if (step.kind === "assertResponse") {
      const label = step.label ?? step.of;
      if (step.expect.status !== undefined) names.push(`${label}.status`);
      for (const key of Object.keys(step.expect.body ?? {})) names.push(`${label}.body.${key}`);
      for (const key of step.expect.nonEmptyStrings ?? []) names.push(`${label}.body.${key}`);
    } else if (step.kind === "observeState" && step.expect) {
      const label = step.label ?? step.capture;
      for (const key of Object.keys(step.expect)) names.push(`${label}.${key}`);
    }
  }
  for (const check of definition.expect) names.push(check.name);
  return names;
}
