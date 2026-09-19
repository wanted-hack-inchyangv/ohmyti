import { describe, expect, it } from "vitest";
import { expectFailure, newApi, postOrder, stockOf } from "./harness.js";

// R-03 재고 부족 거절 (G1 · M-01)
describe("재고 부족", () => {
  it("p1(재고 2)에 quantity 3 → 409 INSUFFICIENT_STOCK, 재고·주문 불변 (B-1)", async () => {
    const api = newApi();
    expectFailure(
      await postOrder(api, "k-stock-1", { productId: "p1", quantity: 3 }),
      409,
      "INSUFFICIENT_STOCK",
    );
    expect(await stockOf(api, "p1")).toBe(2);
  });

  it("p3(재고 0)에 quantity 1 → 409 INSUFFICIENT_STOCK (B-2)", async () => {
    const api = newApi();
    expectFailure(
      await postOrder(api, "k-stock-2", { productId: "p3", quantity: 1 }),
      409,
      "INSUFFICIENT_STOCK",
    );
    expect(await stockOf(api, "p3")).toBe(0);
  });

  it("재고를 소진한 뒤의 추가 주문은 409이며 원장 합은 0을 유지한다", async () => {
    const api = newApi();
    expect((await postOrder(api, "k-stock-3", { productId: "p1", quantity: 2 })).status).toBe(201);
    expectFailure(
      await postOrder(api, "k-stock-4", { productId: "p1", quantity: 1 }),
      409,
      "INSUFFICIENT_STOCK",
    );
    expect(await stockOf(api, "p1")).toBe(0);
  });

  it("재고는 어떤 시점에도 음수가 되지 않는다 (수량 초과 요청 반복)", async () => {
    const api = newApi();
    for (let i = 0; i < 5; i += 1) {
      await postOrder(api, `k-neg-${i}`, { productId: "p1", quantity: 2 });
      expect(await stockOf(api, "p1")).toBeGreaterThanOrEqual(0);
    }
    expect(await stockOf(api, "p1")).toBe(0);
  });

  it("409로 끝난 요청의 키는 멱등성 기록에 남지 않는다", async () => {
    const api = newApi();
    expectFailure(
      await postOrder(api, "k-stock-5", { productId: "p1", quantity: 5 }),
      409,
      "INSUFFICIENT_STOCK",
    );
    const ok = await postOrder(api, "k-stock-5", { productId: "p1", quantity: 1 });
    expect(ok.status).toBe(201);
    expect(await stockOf(api, "p1")).toBe(1);
  });
});
