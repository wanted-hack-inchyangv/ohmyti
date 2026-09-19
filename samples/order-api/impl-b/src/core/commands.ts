import { randomUUID } from "node:crypto";
import { type CatalogEntry, findCatalogEntry } from "./catalog.js";
import { availableStock, release, reserve } from "./ledger.js";
import { type Outcome, fail, ok } from "./outcome.js";
import { type OrderRequest, fingerprintOf, parseKey, parseOrderRequest } from "./rules.js";
import { createSerial } from "./serial.js";
import { type Order, type State, freshState, resetState } from "./state.js";

export type ProductView = { id: string; name: string; stock: number };

export type Commands = {
  product(productId: string): Outcome<ProductView>;
  order(orderId: string): Outcome<Order>;
  place(keyHeader: string | undefined, body: unknown): Promise<Outcome<Order>>;
  cancel(orderId: string): Promise<Outcome<Order>>;
  reset(): Promise<void>;
};

const viewOf = (state: State, entry: CatalogEntry): ProductView => ({
  id: entry.id,
  name: entry.name,
  stock: availableStock(state.ledger, entry),
});

/**
 * 도메인 명령. 상태는 클로저 안에만 있고 밖으로는 함수만 노출한다.
 * 쓰기 명령(place·cancel·reset)은 직렬 큐를 거치므로 동시 요청도 한 건씩 판정된다.
 */
export const createCommands = (newId: () => string = randomUUID): Commands => {
  const state = freshState();
  const serial = createSerial();

  const product: Commands["product"] = (productId) => {
    const entry = findCatalogEntry(productId);
    return entry ? ok(viewOf(state, entry)) : fail("NOT_FOUND", `product ${productId} not found`);
  };

  const order: Commands["order"] = (orderId) => {
    const found = state.orders.get(orderId);
    return found ? ok(found) : fail("NOT_FOUND", `order ${orderId} not found`);
  };

  /** SPEC 5.4 판정 순서: 검증(400) → 멱등성(201 재전송 / 422) → 상품(404) → 재고(409) → 생성(201). */
  const placeSerialized = (key: string, request: OrderRequest): Outcome<Order> => {
    const fingerprint = fingerprintOf(request);

    // M-03은 이 조회를 건너뛰고, M-04는 지문 비교를 건너뛴다.
    const seen = state.idempotency.get(key);
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        return fail(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request body",
        );
      }
      return ok(seen.reply);
    }

    const entry = findCatalogEntry(request.productId);
    if (!entry) return fail("NOT_FOUND", `product ${request.productId} not found`);

    const stock = availableStock(state.ledger, entry);
    // M-01은 이 재고 검사를 제거하거나 조건을 반전한다.
    if (request.quantity > stock) {
      return fail("INSUFFICIENT_STOCK", `requested ${request.quantity} but only ${stock} in stock`);
    }

    const created: Order = {
      id: newId(),
      productId: entry.id,
      quantity: request.quantity,
      status: "CREATED",
    };
    reserve(state.ledger, entry.id, created.id, created.quantity);
    state.orders.set(created.id, created);
    // 멱등성 기록은 201로 끝난 요청만 남긴다. 재전송 응답은 이때의 본문 그대로다.
    state.idempotency.set(key, { fingerprint, reply: created });
    return ok(created);
  };

  const place: Commands["place"] = async (keyHeader, body) => {
    const key = parseKey(keyHeader);
    if (!key.ok) return key;
    const request = parseOrderRequest(body);
    if (!request.ok) return request;
    return serial(() => placeSerialized(key.value, request.value));
  };

  const cancel: Commands["cancel"] = (orderId) =>
    serial(() => {
      const found = state.orders.get(orderId);
      if (!found) return fail("NOT_FOUND", `order ${orderId} not found`);
      if (found.status === "CANCELLED") {
        return fail("ALREADY_CANCELLED", `order ${orderId} is already cancelled`);
      }
      const cancelled: Order = { ...found, status: "CANCELLED" };
      state.orders.set(orderId, cancelled);
      // M-05는 이 재고 복구(RELEASE 이벤트)를 제거한다.
      release(state.ledger, found.productId, found.id, found.quantity);
      return ok(cancelled);
    });

  const reset: Commands["reset"] = () =>
    serial(() => {
      resetState(state);
    });

  return { product, order, place, cancel, reset };
};
