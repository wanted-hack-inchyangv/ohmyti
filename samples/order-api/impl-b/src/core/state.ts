import { type Ledger, emptyLedger } from "./ledger.js";

export type OrderStatus = "CREATED" | "CANCELLED";
export type Order = {
  readonly id: string;
  readonly productId: string;
  readonly quantity: number;
  readonly status: OrderStatus;
};

/** 멱등 키 한 건의 기록. 요청 지문(fingerprint)과 그때 돌려준 201 본문을 그대로 보관한다. */
export type IdempotencyEntry = { readonly fingerprint: string; readonly reply: Order };

export type State = {
  ledger: Ledger;
  orders: Map<string, Order>;
  idempotency: Map<string, IdempotencyEntry>;
};

export const freshState = (): State => ({
  ledger: emptyLedger(),
  orders: new Map(),
  idempotency: new Map(),
});

/** SPEC 5.2 초기화. 원장을 비우면 재고는 저절로 시드로 돌아간다. */
export const resetState = (state: State): void => {
  state.ledger = emptyLedger();
  state.orders.clear();
  state.idempotency.clear();
};
