import { describe, expect, it } from "vitest";
import { createOrder, expectError, getStock, newClient, postOrder } from "./helpers.js";

// R-02 상품·주문 조회
describe("GET /products/:id", () => {
  it("시드 상품 p1·p2·p3를 재고와 함께 반환한다", async () => {
    const client = newClient();
    const p1 = await client.get("/products/p1");
    expect(p1.status).toBe(200);
    expect(p1.body).toEqual({ id: "p1", name: "Keyboard", stock: 2 });
    expect((await client.get("/products/p2")).body).toEqual({ id: "p2", name: "Mouse", stock: 5 });
    expect((await client.get("/products/p3")).body).toEqual({
      id: "p3",
      name: "Monitor",
      stock: 0,
    });
  });

  it("없는 상품은 404 NOT_FOUND (B-8)", async () => {
    expectError(await newClient().get("/products/p9"), 404, "NOT_FOUND");
  });
});

// R-01 정상 주문 생성
describe("POST /orders 정상 경로", () => {
  it("201과 주문 스키마를 반환하고 재고를 차감한다", async () => {
    const client = newClient();
    const res = await postOrder(client, "k-1", { productId: "p1", quantity: 1 });
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    const body = res.body as {
      id: unknown;
      productId: unknown;
      quantity: unknown;
      status: unknown;
    };
    expect(typeof body.id).toBe("string");
    expect((body.id as string).length).toBeGreaterThan(0);
    expect(body).toMatchObject({ productId: "p1", quantity: 1, status: "CREATED" });
    expect(await getStock(client, "p1")).toBe(1);
  });

  it("수량이 재고와 같으면 성공하고 재고는 0이 된다 (B-3)", async () => {
    const client = newClient();
    await createOrder(client, "k-2", "p1", 2);
    expect(await getStock(client, "p1")).toBe(0);
  });

  it("다른 키의 주문은 서로 다른 id를 받는다", async () => {
    const client = newClient();
    const a = await createOrder(client, "k-a", "p2", 1);
    const b = await createOrder(client, "k-b", "p2", 1);
    expect(a.id).not.toBe(b.id);
    expect(await getStock(client, "p2")).toBe(3);
  });
});

describe("GET /orders/:id", () => {
  it("만든 주문을 200으로 조회한다", async () => {
    const client = newClient();
    const created = await createOrder(client, "k-3", "p2", 2);
    const res = await client.get(`/orders/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: created.id,
      productId: "p2",
      quantity: 2,
      status: "CREATED",
    });
  });

  it("없는 주문은 404 NOT_FOUND (B-15)", async () => {
    expectError(await newClient().get("/orders/does-not-exist"), 404, "NOT_FOUND");
  });
});
