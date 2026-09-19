import { describe, expect, it } from "vitest";
import { createOrder, getStock, newClient } from "./helpers.js";

describe("POST /orders/:id/cancel", () => {
  it("200 CANCELLED를 반환하고 재고를 복구한다", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-cancel", "p1", 1);
    expect(await getStock(client, "p1")).toBe(1);

    const res = await client.post(`/orders/${order.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: order.id, productId: "p1", quantity: 1, status: "CANCELLED" });
    expect(await getStock(client, "p1")).toBe(2);
  });

  it("취소된 주문은 CANCELLED로 조회된다", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-cancel-2", "p2", 2);
    await client.post(`/orders/${order.id}/cancel`);
    const res = await client.get(`/orders/${order.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: order.id, status: "CANCELLED" });
    expect(await getStock(client, "p2")).toBe(5);
  });

  it("취소로 복구된 재고로 새 주문을 만들 수 있다", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-refill-1", "p1", 2);
    await client.post(`/orders/${order.id}/cancel`);
    const next = await createOrder(client, "k-refill-2", "p1", 2);
    expect(next.id).not.toBe(order.id);
    expect(await getStock(client, "p1")).toBe(0);
  });
});
