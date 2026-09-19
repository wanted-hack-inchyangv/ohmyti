import { describe, expect, it } from "vitest";
import { expectFailure, get, newApi, placeOrder, post, postOrder, stockOf } from "./harness.js";

// R-10 실행 계약: /health, /admin/reset
describe("GET /health", () => {
  it("항상 200 { status: 'ok' }", async () => {
    const res = await get(newApi(), "/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /admin/reset", () => {
  it("200 { ok: true }를 반환한다", async () => {
    const res = await post(newApi(), "/admin/reset");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("원장을 비워 재고를 시드로 되돌리고 주문·멱등성 기록을 지운다 (B-16)", async () => {
    const api = newApi();
    const order = await placeOrder(api, "k-reset", "p1", 2);
    expect(await stockOf(api, "p1")).toBe(0);

    expect((await post(api, "/admin/reset")).status).toBe(200);

    expect(await stockOf(api, "p1")).toBe(2);
    expect(await stockOf(api, "p2")).toBe(5);
    expect(await stockOf(api, "p3")).toBe(0);
    expectFailure(await get(api, `/orders/${order.id}`), 404, "NOT_FOUND");

    // 이전 키는 새 키처럼 동작한다
    const again = await postOrder(api, "k-reset", { productId: "p1", quantity: 1 });
    expect(again.status).toBe(201);
    expect((again.body as { id: string }).id).not.toBe(order.id);
    expect(await stockOf(api, "p1")).toBe(1);
  });
});

describe("알 수 없는 경로", () => {
  it("404 NOT_FOUND 오류 본문을 반환한다", async () => {
    expectFailure(await get(newApi(), "/nope"), 404, "NOT_FOUND");
  });
});
