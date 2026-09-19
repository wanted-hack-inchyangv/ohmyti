import { type Outcome, fail, ok } from "./outcome.js";

export const MAX_KEY_LENGTH = 128;

export type OrderRequest = { readonly productId: string; readonly quantity: number };

/** SPEC 5.4 헤더 규칙: 비어 있지 않은 문자열, 128자 이하. */
export const parseKey = (header: string | undefined): Outcome<string> => {
  if (header === undefined || header === "") {
    return fail("VALIDATION_ERROR", "Idempotency-Key header is required");
  }
  if (header.length > MAX_KEY_LENGTH) {
    return fail("VALIDATION_ERROR", `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`);
  }
  return ok(header);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** SPEC 5.4 본문 규칙. 스키마 라이브러리 없이 필드를 하나씩 확인한다. */
export const parseOrderRequest = (body: unknown): Outcome<OrderRequest> => {
  if (!isPlainObject(body)) {
    return fail("VALIDATION_ERROR", "request body must be a JSON object");
  }
  const { productId, quantity } = body;
  if (typeof productId !== "string" || productId === "") {
    return fail("VALIDATION_ERROR", "productId must be a non-empty string");
  }
  if (typeof quantity !== "number" || !Number.isInteger(quantity)) {
    return fail("VALIDATION_ERROR", "quantity must be an integer");
  }
  // 수량 하한. M-02(결함 주입 카탈로그)는 이 비교를 `< 0`으로 완화한다.
  if (quantity <= 0) {
    return fail("VALIDATION_ERROR", "quantity must be at least 1");
  }
  return ok({ productId, quantity });
};

/**
 * 멱등성 비교용 요청 지문. 필드를 고정 순서로 직렬화하므로 본문의 필드 순서가 달라도
 * 같은 요청이면 같은 지문이다. 해시는 쓰지 않는다.
 */
export const fingerprintOf = (request: OrderRequest): string =>
  JSON.stringify([request.productId, request.quantity]);
