import { describe, expect, it } from "vitest";
import { expectError, getStock, newClient, postOrder } from "./helpers.js";

// R-04 입력 검증 (G1 · M-02)
describe("POST /orders 입력 검증", () => {
  const invalidBodies: Array<[string, unknown]> = [
    ["quantity 누락", { productId: "p1" }],
    ["quantity 0", { productId: "p1", quantity: 0 }],
    ["quantity -1", { productId: "p1", quantity: -1 }],
    ["quantity 1.5", { productId: "p1", quantity: 1.5 }],
    ['quantity 문자열 "1"', { productId: "p1", quantity: "1" }],
    ["quantity null", { productId: "p1", quantity: null }],
    ["productId 누락", { quantity: 1 }],
    ["productId 빈 문자열", { productId: "", quantity: 1 }],
    ["productId 숫자", { productId: 1, quantity: 1 }],
    ["본문이 배열", [{ productId: "p1", quantity: 1 }]],
  ];

  it.each(invalidBodies)("%s → 400 VALIDATION_ERROR, 재고 불변 (B-4, B-5)", async (_, body) => {
    const client = newClient();
    expectError(await postOrder(client, "k-v", body), 400, "VALIDATION_ERROR");
    expect(await getStock(client, "p1")).toBe(2);
  });

  it("quantity 0은 주문을 만들지 않는다 (재고 하한 경계)", async () => {
    const client = newClient();
    const res = await postOrder(client, "k-zero", { productId: "p1", quantity: 0 });
    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty("id");
    // 같은 키로 유효한 본문을 보내면 400은 기록되지 않았으므로 새 주문이 만들어진다
    const ok = await postOrder(client, "k-zero", { productId: "p1", quantity: 1 });
    expect(ok.status).toBe(201);
    expect(await getStock(client, "p1")).toBe(1);
  });

  it("Idempotency-Key 누락 → 400 (B-6)", async () => {
    const client = newClient();
    expectError(
      await postOrder(client, undefined, { productId: "p1", quantity: 1 }),
      400,
      "VALIDATION_ERROR",
    );
    expect(await getStock(client, "p1")).toBe(2);
  });

  it("Idempotency-Key 빈 문자열 → 400 (B-6)", async () => {
    const client = newClient();
    expectError(
      await postOrder(client, "", { productId: "p1", quantity: 1 }),
      400,
      "VALIDATION_ERROR",
    );
    expect(await getStock(client, "p1")).toBe(2);
  });

  it("Idempotency-Key 129자 → 400, 128자는 허용", async () => {
    const client = newClient();
    expectError(
      await postOrder(client, "x".repeat(129), { productId: "p1", quantity: 1 }),
      400,
      "VALIDATION_ERROR",
    );
    expect(
      (await postOrder(client, "y".repeat(128), { productId: "p1", quantity: 1 })).status,
    ).toBe(201);
  });

  it("JSON이 아닌 본문 → 400 (B-7)", async () => {
    const client = newClient();
    const res = await client
      .post("/orders")
      .set("Idempotency-Key", "k-json")
      .set("Content-Type", "application/json")
      .send("{not json");
    expectError(res, 400, "VALIDATION_ERROR");
    expect(await getStock(client, "p1")).toBe(2);
  });

  it("본문 없음 → 400", async () => {
    const client = newClient();
    const res = await client.post("/orders").set("Idempotency-Key", "k-empty");
    expectError(res, 400, "VALIDATION_ERROR");
  });

  it("400으로 끝난 키는 이후 유효한 본문으로 201을 만든다", async () => {
    const client = newClient();
    expectError(await postOrder(client, "k-reuse", { productId: "p1" }), 400, "VALIDATION_ERROR");
    expect((await postOrder(client, "k-reuse", { productId: "p1", quantity: 1 })).status).toBe(201);
  });
});
