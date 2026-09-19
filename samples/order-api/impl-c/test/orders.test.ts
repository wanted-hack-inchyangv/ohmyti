import { describe, expect, it } from "vitest";
import { createOrder, getStock, newClient } from "./helpers.js";

describe("GET /products/:id", () => {
  it("시드 상품을 재고와 함께 반환한다", async () => {
    const client = newClient();
    const res = await client.get("/products/p1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "p1", name: "Keyboard", stock: 2 });
  });

  it("없는 상품은 404", async () => {
    const res = await newClient().get("/products/p9");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("POST /orders", () => {
  it("201과 주문을 반환하고 재고를 차감한다", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-1", "p1", 1);
    expect(typeof order.id).toBe("string");
    expect(order).toMatchObject({ productId: "p1", quantity: 1, status: "CREATED" });
    expect(await getStock(client, "p1")).toBe(1);
  });

  it("다른 키의 주문은 서로 다른 id를 받는다", async () => {
    const client = newClient();
    const a = await createOrder(client, "k-a", "p2", 1);
    const b = await createOrder(client, "k-b", "p2", 2);
    expect(a.id).not.toBe(b.id);
    expect(await getStock(client, "p2")).toBe(2);
  });
});

describe("GET /orders/:id", () => {
  it("만든 주문을 200으로 조회한다", async () => {
    const client = newClient();
    const created = await createOrder(client, "k-3", "p2", 2);
    const res = await client.get(`/orders/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: created.id, productId: "p2", quantity: 2, status: "CREATED" });
  });

  it("없는 주문은 404", async () => {
    const res = await newClient().get("/orders/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
