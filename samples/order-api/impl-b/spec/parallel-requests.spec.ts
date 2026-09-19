import { describe, expect, it } from "vitest";
import { get, newApi, postOrder, stockOf } from "./harness.js";

const N = 10;

// R-07 같은 키 동시 요청
describe("같은 키·같은 본문 10건 동시", () => {
  it("전부 201 같은 id, 재고 1회 차감 (B-11)", async () => {
    const api = newApi();
    const replies = await Promise.all(
      Array.from({ length: N }, () => postOrder(api, "k-conc", { productId: "p2", quantity: 1 })),
    );
    expect(replies.map((r) => r.status)).toEqual(Array(N).fill(201));
    const ids = new Set(replies.map((r) => (r.body as { id: string }).id));
    expect(ids.size).toBe(1);
    expect(await stockOf(api, "p2")).toBe(4);
  });

  it("같은 키 동시 요청 중 본문이 다른 것은 422이고 나머지는 같은 id", async () => {
    const api = newApi();
    const replies = await Promise.all([
      postOrder(api, "k-mixed", { productId: "p2", quantity: 1 }),
      postOrder(api, "k-mixed", { productId: "p2", quantity: 1 }),
      postOrder(api, "k-mixed", { productId: "p2", quantity: 2 }),
      postOrder(api, "k-mixed", { productId: "p2", quantity: 1 }),
    ]);
    const created = replies.filter((r) => r.status === 201);
    const conflicted = replies.filter((r) => r.status === 422);
    expect(created).toHaveLength(3);
    expect(conflicted).toHaveLength(1);
    expect(new Set(created.map((r) => (r.body as { id: string }).id)).size).toBe(1);
    expect(await stockOf(api, "p2")).toBe(4);
  });
});

// R-08 다른 키 동시 요청과 재고 하한
describe("다른 키 10건 동시, p2(재고 5) quantity 1", () => {
  it("201 정확히 5건, 409 INSUFFICIENT_STOCK 5건, 재고 0 (B-12)", async () => {
    const api = newApi();
    const replies = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        postOrder(api, `k-par-${i}`, { productId: "p2", quantity: 1 }),
      ),
    );
    const created = replies.filter((r) => r.status === 201);
    const rejected = replies.filter((r) => r.status === 409);
    expect(created).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    for (const r of rejected)
      expect(r.body).toMatchObject({ error: { code: "INSUFFICIENT_STOCK" } });

    const ids = created.map((r) => (r.body as { id: string }).id);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect((await get(api, `/orders/${id}`)).status).toBe(200);

    const stock = await stockOf(api, "p2");
    expect(stock).toBe(0);
    expect(stock).toBeGreaterThanOrEqual(0);
  });

  it("재고보다 큰 수량이 섞인 동시 요청에서도 성공 수량 합이 재고를 넘지 않는다", async () => {
    const api = newApi();
    const quantities = [3, 3, 2, 2, 1, 1];
    const replies = await Promise.all(
      quantities.map((q, i) => postOrder(api, `k-mix-${i}`, { productId: "p2", quantity: q })),
    );
    const sold = replies
      .filter((r) => r.status === 201)
      .reduce((sum, r) => sum + (r.body as { quantity: number }).quantity, 0);
    expect(sold).toBeLessThanOrEqual(5);
    expect(await stockOf(api, "p2")).toBe(5 - sold);
    for (const r of replies) expect([201, 409]).toContain(r.status);
  });
});
