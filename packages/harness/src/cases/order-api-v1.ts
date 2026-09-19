/**
 * 샘플 과제 order-api · rubric v1의 EXECUTION 기준(R-01~R-10) 케이스.
 * 판정 조건의 원문은 `samples/order-api/rubric.v1.json`, HTTP 계약은 `samples/order-api/SPEC.md`다.
 * 케이스마다 실행기가 `POST /admin/reset`을 먼저 호출하므로 모든 케이스는 시드 상태(p1 2, p2 5, p3 0)에서 시작한다.
 *
 * R-10의 `npm start`·`PORT`·기동 후 10초 안 `/health`는 서비스 기동(T-108)의 관측이다. 여기서는 기동된 서비스에
 * 대한 `/health`·`/admin/reset` 동작만 검사하며, T-205가 두 관측을 합쳐 R-10을 판정한다.
 */
import { defineCase, type CaseDefinition, type RequestSpec } from "../dsl";

export const ORDER_API_V1_CASE_SET = "order-api-v1" as const;

const SEED = { p1: 2, p2: 5, p3: 0 } as const;

/** `POST /orders` 요청. 헤더를 명시하지 않으면 `Idempotency-Key`를 보내지 않는다. */
function order(
  key: string | null,
  body: RequestSpec["body"] | undefined,
  extra: Partial<Pick<RequestSpec, "rawBody" | "headers">> = {},
): RequestSpec {
  const spec: RequestSpec = { method: "POST", path: "/orders" };
  const headers: Record<string, string> = { ...(extra.headers ?? {}) };
  if (key !== null) headers["Idempotency-Key"] = key;
  if (Object.keys(headers).length > 0) spec.headers = headers;
  if (extra.rawBody !== undefined) spec.rawBody = extra.rawBody;
  else if (body !== undefined) spec.body = body;
  return spec;
}

function repeat<T>(count: number, make: (i: number) => T): T[] {
  return Array.from({ length: count }, (_, i) => make(i));
}

const NOT_FOUND = { "error.code": "NOT_FOUND" };

export const R01_NORMAL_ORDER = defineCase({
  id: "R-01-normal-order",
  title: "정상 주문 201, 응답 스키마, 재고 차감",
  criterionIds: ["R-01"],
  steps: [
    {
      kind: "request",
      capture: "order",
      request: order("r01-k1", { productId: "p1", quantity: 1 }),
    },
    {
      kind: "assertResponse",
      of: "order",
      expect: {
        status: 201,
        body: { productId: "p1", quantity: 1, status: "CREATED" },
        nonEmptyStrings: ["id"],
      },
    },
    {
      kind: "observeState",
      capture: "p1After",
      path: "/products/p1",
      expect: { stock: SEED.p1 - 1 },
    },
  ],
  expect: [],
});

export const R02_LOOKUPS = defineCase({
  id: "R-02-lookups",
  title: "상품·주문 조회 200, 미존재 404",
  criterionIds: ["R-02"],
  steps: [
    {
      kind: "observeState",
      capture: "p1",
      path: "/products/p1",
      expect: { id: "p1", stock: SEED.p1 },
    },
    {
      kind: "observeState",
      capture: "p2",
      path: "/products/p2",
      expect: { id: "p2", stock: SEED.p2 },
    },
    {
      kind: "observeState",
      capture: "p3",
      path: "/products/p3",
      expect: { id: "p3", stock: SEED.p3 },
    },
    {
      kind: "request",
      capture: "order",
      request: order("r02-k1", { productId: "p1", quantity: 1 }),
    },
    { kind: "assertResponse", of: "order", expect: { status: 201, nonEmptyStrings: ["id"] } },
    {
      kind: "request",
      capture: "orderGet",
      request: { method: "GET", path: "/orders/{{order.body.id}}" },
    },
    {
      kind: "assertResponse",
      of: "orderGet",
      expect: { status: 200, body: { productId: "p1", quantity: 1, status: "CREATED" } },
    },
    {
      kind: "request",
      capture: "missingProduct",
      request: { method: "GET", path: "/products/p9" },
    },
    { kind: "assertResponse", of: "missingProduct", expect: { status: 404, body: NOT_FOUND } },
    {
      kind: "request",
      capture: "missingOrder",
      request: { method: "GET", path: "/orders/no-such-order-r02" },
    },
    { kind: "assertResponse", of: "missingOrder", expect: { status: 404, body: NOT_FOUND } },
  ],
  expect: [
    { name: "p1.status", actual: { $ref: "p1.status" }, equals: 200 },
    { name: "p1.name", actual: { $ref: "p1.body.name" }, nonEmptyString: true },
    { name: "p2.status", actual: { $ref: "p2.status" }, equals: 200 },
    { name: "p3.status", actual: { $ref: "p3.status" }, equals: 200 },
    {
      name: "orderGet.body.id == order.body.id",
      actual: { $sameValue: { refs: ["orderGet.body.id", "order.body.id"] } },
      equals: true,
    },
  ],
});

export const R05_IDEMPOTENT_RESEND = defineCase({
  id: "R-05-idempotent-resend",
  title: "같은 키·같은 본문 재전송 → 같은 id, 201, 재고 1회 차감",
  criterionIds: ["R-05"],
  // 재고를 시드 → 첫 주문 뒤 → 재전송 뒤 세 번 관측해 타임라인의 `stateAfter`에 `2 → 1 → 1`(정답) 또는
  // `2 → 1 → 0`(멱등성 결함)이 그대로 남는다 (PRD 7장 데모, T-303 실패 재생 뷰).
  steps: [
    { kind: "observeState", capture: "p1Seed", path: "/products/p1", expect: { stock: SEED.p1 } },
    {
      kind: "request",
      capture: "first",
      request: order("r05-k1", { productId: "p1", quantity: 1 }),
    },
    {
      kind: "observeState",
      capture: "p1AfterFirst",
      path: "/products/p1",
      expect: { stock: SEED.p1 - 1 },
    },
    {
      kind: "request",
      capture: "second",
      request: order("r05-k1", { productId: "p1", quantity: 1 }),
    },
    { kind: "assertResponse", of: "first", expect: { status: 201, nonEmptyStrings: ["id"] } },
    { kind: "assertResponse", of: "second", expect: { status: 201 } },
    {
      kind: "observeState",
      capture: "p1After",
      path: "/products/p1",
      expect: { stock: SEED.p1 - 1 },
    },
    {
      kind: "request",
      capture: "firstGet",
      request: { method: "GET", path: "/orders/{{first.body.id}}" },
    },
    { kind: "assertResponse", of: "firstGet", expect: { status: 200 } },
  ],
  expect: [
    {
      name: "second.body.id == first.body.id",
      actual: { $sameValue: { refs: ["second.body.id", "first.body.id"] } },
      equals: true,
    },
  ],
});

export const R06_IDEMPOTENCY_CONFLICT = defineCase({
  id: "R-06-idempotency-conflict",
  title: "같은 키·다른 본문 → 422, 새 주문 없음",
  criterionIds: ["R-06"],
  steps: [
    {
      kind: "request",
      capture: "first",
      request: order("r06-k1", { productId: "p1", quantity: 1 }),
    },
    { kind: "assertResponse", of: "first", expect: { status: 201, nonEmptyStrings: ["id"] } },
    {
      kind: "request",
      capture: "otherProduct",
      request: order("r06-k1", { productId: "p2", quantity: 1 }),
    },
    {
      kind: "assertResponse",
      of: "otherProduct",
      expect: { status: 422, body: { "error.code": "IDEMPOTENCY_CONFLICT" } },
    },
    {
      kind: "request",
      capture: "otherQuantity",
      request: order("r06-k1", { productId: "p1", quantity: 2 }),
    },
    {
      kind: "assertResponse",
      of: "otherQuantity",
      expect: { status: 422, body: { "error.code": "IDEMPOTENCY_CONFLICT" } },
    },
    {
      kind: "observeState",
      capture: "p1After",
      path: "/products/p1",
      expect: { stock: SEED.p1 - 1 },
    },
    { kind: "observeState", capture: "p2After", path: "/products/p2", expect: { stock: SEED.p2 } },
    {
      kind: "request",
      capture: "firstGet",
      request: { method: "GET", path: "/orders/{{first.body.id}}" },
    },
    {
      kind: "assertResponse",
      of: "firstGet",
      expect: { status: 200, body: { status: "CREATED" } },
    },
  ],
  expect: [],
});

export const R09_CANCEL = defineCase({
  id: "R-09-cancel",
  title: "취소 시 재고 복구, 이중 취소 409, 없는 주문 404",
  criterionIds: ["R-09"],
  steps: [
    {
      kind: "request",
      capture: "order",
      request: order("r09-k1", { productId: "p1", quantity: 1 }),
    },
    { kind: "assertResponse", of: "order", expect: { status: 201, nonEmptyStrings: ["id"] } },
    {
      kind: "observeState",
      capture: "p1Ordered",
      path: "/products/p1",
      expect: { stock: SEED.p1 - 1 },
    },
    {
      kind: "request",
      capture: "cancel",
      request: { method: "POST", path: "/orders/{{order.body.id}}/cancel" },
    },
    {
      kind: "assertResponse",
      of: "cancel",
      expect: { status: 200, body: { status: "CANCELLED" } },
    },
    {
      kind: "observeState",
      capture: "p1Cancelled",
      path: "/products/p1",
      expect: { stock: SEED.p1 },
    },
    {
      kind: "request",
      capture: "cancelAgain",
      request: { method: "POST", path: "/orders/{{order.body.id}}/cancel" },
    },
    {
      kind: "assertResponse",
      of: "cancelAgain",
      expect: { status: 409, body: { "error.code": "ALREADY_CANCELLED" } },
    },
    {
      kind: "observeState",
      capture: "p1CancelledAgain",
      path: "/products/p1",
      expect: { stock: SEED.p1 },
    },
    {
      kind: "request",
      capture: "cancelMissing",
      request: { method: "POST", path: "/orders/no-such-order-r09/cancel" },
    },
    { kind: "assertResponse", of: "cancelMissing", expect: { status: 404, body: NOT_FOUND } },
    {
      kind: "request",
      capture: "orderGet",
      request: { method: "GET", path: "/orders/{{order.body.id}}" },
    },
    {
      kind: "assertResponse",
      of: "orderGet",
      expect: { status: 200, body: { status: "CANCELLED" } },
    },
  ],
  expect: [
    {
      name: "cancel.body.id == order.body.id",
      actual: { $sameValue: { refs: ["cancel.body.id", "order.body.id"] } },
      equals: true,
    },
  ],
});

export const R03_INSUFFICIENT_STOCK = defineCase({
  id: "R-03-insufficient-stock",
  title: "재고 부족 409, 재고 불변, 재고와 같은 수량은 201",
  criterionIds: ["R-03"],
  steps: [
    {
      kind: "request",
      capture: "tooMany",
      request: order("r03-k1", { productId: "p1", quantity: 3 }),
    },
    {
      kind: "assertResponse",
      of: "tooMany",
      expect: { status: 409, body: { "error.code": "INSUFFICIENT_STOCK" } },
    },
    {
      kind: "observeState",
      capture: "p1AfterTooMany",
      path: "/products/p1",
      expect: { stock: SEED.p1 },
    },
    {
      kind: "request",
      capture: "outOfStock",
      request: order("r03-k2", { productId: "p3", quantity: 1 }),
    },
    {
      kind: "assertResponse",
      of: "outOfStock",
      expect: { status: 409, body: { "error.code": "INSUFFICIENT_STOCK" } },
    },
    { kind: "observeState", capture: "p3After", path: "/products/p3", expect: { stock: SEED.p3 } },
    {
      kind: "request",
      capture: "exact",
      request: order("r03-k3", { productId: "p1", quantity: 2 }),
    },
    { kind: "assertResponse", of: "exact", expect: { status: 201, nonEmptyStrings: ["id"] } },
    { kind: "observeState", capture: "p1AfterExact", path: "/products/p1", expect: { stock: 0 } },
  ],
  expect: [],
});

const VALIDATION_ERROR = { "error.code": "VALIDATION_ERROR" };
const INVALID_REQUESTS: Array<{ capture: string; request: RequestSpec }> = [
  { capture: "quantityMissing", request: order("r04-k1", { productId: "p1" }) },
  { capture: "quantityZero", request: order("r04-k2", { productId: "p1", quantity: 0 }) },
  { capture: "quantityNegative", request: order("r04-k3", { productId: "p1", quantity: -1 }) },
  { capture: "quantityFraction", request: order("r04-k4", { productId: "p1", quantity: 1.5 }) },
  { capture: "quantityString", request: order("r04-k5", { productId: "p1", quantity: "1" }) },
  { capture: "productIdMissing", request: order("r04-k6", { quantity: 1 }) },
  { capture: "productIdEmpty", request: order("r04-k7", { productId: "", quantity: 1 }) },
  { capture: "keyMissing", request: order(null, { productId: "p1", quantity: 1 }) },
  { capture: "keyEmpty", request: order("", { productId: "p1", quantity: 1 }) },
  { capture: "notJson", request: order("r04-k8", undefined, { rawBody: "{not json" }) },
];

export const R04_VALIDATION = defineCase({
  id: "R-04-validation",
  title: "입력 검증 400, 재고 불변, 400으로 끝난 키는 재사용 가능",
  criterionIds: ["R-04"],
  steps: [
    ...INVALID_REQUESTS.flatMap<CaseDefinition["steps"][number]>(({ capture, request }) => [
      { kind: "request", capture, request },
      { kind: "assertResponse", of: capture, expect: { status: 400, body: VALIDATION_ERROR } },
    ]),
    { kind: "observeState", capture: "p1After", path: "/products/p1", expect: { stock: SEED.p1 } },
    {
      kind: "request",
      capture: "reuseKey",
      request: order("r04-k2", { productId: "p1", quantity: 1 }),
    },
    { kind: "assertResponse", of: "reuseKey", expect: { status: 201, nonEmptyStrings: ["id"] } },
  ],
  expect: [],
});

export const R07_SAME_KEY_CONCURRENT = defineCase({
  id: "R-07-same-key-concurrent",
  title: "같은 키 10건 동시 → 모두 201 같은 id, 재고 1회 차감",
  criterionIds: ["R-07"],
  steps: [
    {
      kind: "parallel",
      capture: "burst",
      requests: repeat(10, () => order("r07-k1", { productId: "p2", quantity: 1 })),
    },
    {
      kind: "observeState",
      capture: "p2After",
      path: "/products/p2",
      expect: { stock: SEED.p2 - 1 },
    },
  ],
  expect: [
    {
      name: "burst.count(status == 201)",
      actual: { $countWhere: { of: "burst", where: { path: "status", equals: 201 } } },
      equals: 10,
    },
    {
      name: "burst.allEqual(body.id)",
      actual: { $allEqual: { of: "burst", path: "body.id" } },
      equals: true,
    },
  ],
});

export const R08_DISTINCT_KEYS_CONCURRENT = defineCase({
  id: "R-08-distinct-keys-concurrent",
  title: "다른 키 10건 동시(재고 5) → 201 5건·409 5건, 재고 0, 음수 없음",
  criterionIds: ["R-08"],
  steps: [
    {
      kind: "parallel",
      capture: "burst",
      requests: repeat(10, (i) => order(`r08-k${i}`, { productId: "p2", quantity: 1 })),
    },
    { kind: "observeState", capture: "p2After", path: "/products/p2", expect: { stock: 0 } },
    {
      kind: "parallel",
      capture: "createdGets",
      forEach: {
        of: "burst",
        where: { path: "status", equals: 201 },
        request: { method: "GET", path: "/orders/{{item.body.id}}" },
      },
    },
  ],
  expect: [
    {
      name: "burst.count(status == 201)",
      actual: { $countWhere: { of: "burst", where: { path: "status", equals: 201 } } },
      equals: 5,
    },
    {
      name: "burst.count(status == 409)",
      actual: { $countWhere: { of: "burst", where: { path: "status", equals: 409 } } },
      equals: 5,
    },
    {
      name: "burst.count(error.code == INSUFFICIENT_STOCK)",
      actual: {
        $countWhere: {
          of: "burst",
          where: { path: "body.error.code", equals: "INSUFFICIENT_STOCK" },
        },
      },
      equals: 5,
    },
    {
      name: "burst.distinct(body.id | status == 201)",
      actual: {
        $distinctCount: { of: "burst", path: "body.id", where: { path: "status", equals: 201 } },
      },
      equals: 5,
    },
    {
      name: "createdGets.count(status == 200)",
      actual: { $countWhere: { of: "createdGets", where: { path: "status", equals: 200 } } },
      equals: 5,
    },
    { name: "p2After.stock >= 0", actual: { $ref: "p2After.body.stock" }, gte: 0 },
  ],
});

export const R10_HEALTH_AND_RESET = defineCase({
  id: "R-10-health-and-reset",
  title: "/health 200, /admin/reset 200 후 시드 복구·이전 주문 404·이전 키 재사용",
  criterionIds: ["R-10"],
  steps: [
    { kind: "request", capture: "health", request: { method: "GET", path: "/health" } },
    { kind: "assertResponse", of: "health", expect: { status: 200, body: { status: "ok" } } },
    {
      kind: "request",
      capture: "before",
      request: order("r10-k1", { productId: "p1", quantity: 1 }),
    },
    { kind: "assertResponse", of: "before", expect: { status: 201, nonEmptyStrings: ["id"] } },
    { kind: "request", capture: "reset", request: { method: "POST", path: "/admin/reset" } },
    { kind: "assertResponse", of: "reset", expect: { status: 200, body: { ok: true } } },
    { kind: "observeState", capture: "p1", path: "/products/p1", expect: { stock: SEED.p1 } },
    { kind: "observeState", capture: "p2", path: "/products/p2", expect: { stock: SEED.p2 } },
    { kind: "observeState", capture: "p3", path: "/products/p3", expect: { stock: SEED.p3 } },
    {
      kind: "request",
      capture: "beforeGet",
      request: { method: "GET", path: "/orders/{{before.body.id}}" },
    },
    { kind: "assertResponse", of: "beforeGet", expect: { status: 404, body: NOT_FOUND } },
    {
      kind: "request",
      capture: "after",
      request: order("r10-k1", { productId: "p1", quantity: 1 }),
    },
    { kind: "assertResponse", of: "after", expect: { status: 201, nonEmptyStrings: ["id"] } },
  ],
  expect: [],
});

/** rubric v1 EXECUTION 기준 순서(요구 기능 → 경계·실패 → 실행 재현성)대로 둔다. */
export const ORDER_API_V1_CASES: readonly CaseDefinition[] = [
  R01_NORMAL_ORDER,
  R02_LOOKUPS,
  R05_IDEMPOTENT_RESEND,
  R06_IDEMPOTENCY_CONFLICT,
  R09_CANCEL,
  R03_INSUFFICIENT_STOCK,
  R04_VALIDATION,
  R07_SAME_KEY_CONCURRENT,
  R08_DISTINCT_KEYS_CONCURRENT,
  R10_HEALTH_AND_RESET,
];
