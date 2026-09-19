import { describe, expect, it } from "vitest";
import { createOrder, expectError, getStock, newClient, postOrder } from "./helpers.js";

// R-10 실행 계약: /health, /admin/reset
describe("GET /health", () => {
  it("항상 200 { status: 'ok' }", async () => {
    const client = newClient();
    const res = await client.get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /admin/reset", () => {
  it("200 { ok: true }를 반환한다", async () => {
    const res = await newClient().post("/admin/reset");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("재고를 시드로 되돌리고 주문과 멱등성 기록을 지운다 (B-16)", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-reset", "p1", 2);
    expect(await getStock(client, "p1")).toBe(0);

    const reset = await client.post("/admin/reset");
    expect(reset.status).toBe(200);

    expect(await getStock(client, "p1")).toBe(2);
    expect(await getStock(client, "p2")).toBe(5);
    expect(await getStock(client, "p3")).toBe(0);
    expectError(await client.get(`/orders/${order.id}`), 404, "NOT_FOUND");

    // 이전 키는 새 키처럼 동작한다
    const again = await postOrder(client, "k-reset", { productId: "p1", quantity: 1 });
    expect(again.status).toBe(201);
    expect((again.body as { id: string }).id).not.toBe(order.id);
    expect(await getStock(client, "p1")).toBe(1);
  });
});

describe("알 수 없는 경로", () => {
  it("404 NOT_FOUND 오류 본문을 반환한다", async () => {
    expectError(await newClient().get("/nope"), 404, "NOT_FOUND");
  });
});
