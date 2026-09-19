import { describe, expect, it } from "vitest";
import { expectError, getStock, newClient, postOrder } from "./helpers.js";

// R-03 재고 부족 거절 (G1 · M-01)
describe("재고 부족", () => {
  it("p1(재고 2)에 quantity 3 → 409 INSUFFICIENT_STOCK, 재고·주문 불변 (B-1)", async () => {
    const client = newClient();
    const res = await postOrder(client, "k-stock-1", { productId: "p1", quantity: 3 });
    expectError(res, 409, "INSUFFICIENT_STOCK");
    expect(await getStock(client, "p1")).toBe(2);
  });

  it("p3(재고 0)에 quantity 1 → 409 INSUFFICIENT_STOCK (B-2)", async () => {
    const client = newClient();
    expectError(
      await postOrder(client, "k-stock-2", { productId: "p3", quantity: 1 }),
      409,
      "INSUFFICIENT_STOCK",
    );
    expect(await getStock(client, "p3")).toBe(0);
  });

  it("재고를 소진한 뒤의 추가 주문은 409이며 재고는 0을 유지한다", async () => {
    const client = newClient();
    expect((await postOrder(client, "k-stock-3", { productId: "p1", quantity: 2 })).status).toBe(
      201,
    );
    expectError(
      await postOrder(client, "k-stock-4", { productId: "p1", quantity: 1 }),
      409,
      "INSUFFICIENT_STOCK",
    );
    expect(await getStock(client, "p1")).toBe(0);
  });

  it("409로 끝난 요청의 키는 멱등성 기록에 남지 않는다", async () => {
    const client = newClient();
    expectError(
      await postOrder(client, "k-stock-5", { productId: "p1", quantity: 5 }),
      409,
      "INSUFFICIENT_STOCK",
    );
    const ok = await postOrder(client, "k-stock-5", { productId: "p1", quantity: 1 });
    expect(ok.status).toBe(201);
    expect(await getStock(client, "p1")).toBe(1);
  });
});
