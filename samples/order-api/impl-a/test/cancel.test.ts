import { describe, expect, it } from "vitest";
import { createOrder, expectError, getStock, newClient } from "./helpers.js";

// R-09 주문 취소와 재고 복구 (G3 · M-05)
describe("POST /orders/:id/cancel", () => {
  it("200 CANCELLED를 반환하고 재고를 복구한다 (B-13)", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-cancel", "p1", 1);
    expect(await getStock(client, "p1")).toBe(1);

    const res = await client.post(`/orders/${order.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: order.id, productId: "p1", quantity: 1, status: "CANCELLED" });
    expect(await getStock(client, "p1")).toBe(2);
  });

  it("수량 2 주문을 취소하면 재고가 수량만큼 돌아온다", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-cancel-2", "p2", 2);
    expect(await getStock(client, "p2")).toBe(3);
    expect((await client.post(`/orders/${order.id}/cancel`)).status).toBe(200);
    expect(await getStock(client, "p2")).toBe(5);
  });

  it("취소된 주문은 GET /orders/:id에서 CANCELLED로 조회된다", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-cancel-3", "p1", 1);
    await client.post(`/orders/${order.id}/cancel`);
    const res = await client.get(`/orders/${order.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: order.id, status: "CANCELLED" });
  });

  it("이중 취소는 409 ALREADY_CANCELLED이며 재고는 한 번만 복구된다 (B-14)", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-double", "p1", 1);
    expect((await client.post(`/orders/${order.id}/cancel`)).status).toBe(200);
    expectError(await client.post(`/orders/${order.id}/cancel`), 409, "ALREADY_CANCELLED");
    expect(await getStock(client, "p1")).toBe(2);
  });

  it("취소로 복구된 재고로 새 주문을 만들 수 있다", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-refill-1", "p1", 2);
    await client.post(`/orders/${order.id}/cancel`);
    const next = await createOrder(client, "k-refill-2", "p1", 2);
    expect(next.id).not.toBe(order.id);
    expect(await getStock(client, "p1")).toBe(0);
  });

  it("없는 주문의 취소는 404 NOT_FOUND (B-15)", async () => {
    expectError(await newClient().post("/orders/nope/cancel"), 404, "NOT_FOUND");
  });
});
