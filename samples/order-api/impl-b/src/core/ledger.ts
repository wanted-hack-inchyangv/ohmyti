import { type CatalogEntry } from "./catalog.js";

/**
 * 재고 이벤트 원장. 재고 숫자를 덮어쓰지 않고 예약(RESERVE)·해제(RELEASE) 이벤트를 append-only로 쌓는다.
 * 현재 재고 = 시드 재고 + 이벤트 delta 합. 어떤 주문이 재고를 바꿨는지 orderId로 추적할 수 있다.
 */
export type StockEvent = {
  readonly seq: number;
  readonly productId: string;
  readonly orderId: string;
  readonly kind: "RESERVE" | "RELEASE";
  readonly delta: number;
};

export type Ledger = { events: StockEvent[] };

export const emptyLedger = (): Ledger => ({ events: [] });

export const availableStock = (ledger: Ledger, entry: CatalogEntry): number =>
  ledger.events
    .filter((event) => event.productId === entry.id)
    .reduce((stock, event) => stock + event.delta, entry.initialStock);

const append = (ledger: Ledger, event: Omit<StockEvent, "seq">): void => {
  ledger.events.push({ seq: ledger.events.length + 1, ...event });
};

export const reserve = (ledger: Ledger, productId: string, orderId: string, qty: number): void =>
  append(ledger, { productId, orderId, kind: "RESERVE", delta: -qty });

export const release = (ledger: Ledger, productId: string, orderId: string, qty: number): void =>
  append(ledger, { productId, orderId, kind: "RELEASE", delta: qty });
