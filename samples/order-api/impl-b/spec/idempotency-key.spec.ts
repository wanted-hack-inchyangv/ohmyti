import { describe, expect, it } from "vitest";
import { expectFailure, get, newApi, placeOrder, post, postOrder, stockOf } from "./harness.js";

// R-05 멱등 재전송 (G2 · M-03)
describe("같은 키 + 같은 본문 재전송", () => {
  it("두 번 모두 201, 같은 id, 재고는 1회만 차감 (B-9)", async () => {
    const api = newApi();
    const first = await postOrder(api, "k-idem", { productId: "p1", quantity: 1 });
    const second = await postOrder(api, "k-idem", { productId: "p1", quantity: 1 });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(await stockOf(api, "p1")).toBe(1);
    expect((await get(api, `/orders/${(first.body as { id: string }).id}`)).status).toBe(200);
  });

  it("세 번 보내도 주문은 한 건이고 재고도 1회만 차감된다", async () => {
    const api = newApi();
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const res = await postOrder(api, "k-thrice", { productId: "p2", quantity: 1 });
      expect(res.status).toBe(201);
      ids.add((res.body as { id: string }).id);
    }
    expect(ids.size).toBe(1);
    expect(await stockOf(api, "p2")).toBe(4);
  });

  it("필드 순서가 달라도 같은 본문으로 본다", async () => {
    const api = newApi();
    const first = await postOrder(api, "k-order", { productId: "p2", quantity: 2 });
    const second = await postOrder(api, "k-order", { quantity: 2, productId: "p2" });
    expect(second.status).toBe(201);
    expect((second.body as { id: string }).id).toBe((first.body as { id: string }).id);
    expect(await stockOf(api, "p2")).toBe(3);
  });

  it("재전송은 재고가 소진된 뒤에도 원래 응답을 돌려준다 (409가 아니다)", async () => {
    const api = newApi();
    const first = await placeOrder(api, "k-drain", "p1", 2);
    expect(await stockOf(api, "p1")).toBe(0);
    const again = await postOrder(api, "k-drain", { productId: "p1", quantity: 2 });
    expect(again.status).toBe(201);
    expect((again.body as { id: string }).id).toBe(first.id);
    expect(await stockOf(api, "p1")).toBe(0);
  });

  it("원래 주문이 취소돼도 재전송 응답은 원래 응답(CREATED)과 같다", async () => {
    const api = newApi();
    const first = await placeOrder(api, "k-cancelled", "p1", 1);
    expect((await post(api, `/orders/${first.id}/cancel`)).status).toBe(200);
    const again = await postOrder(api, "k-cancelled", { productId: "p1", quantity: 1 });
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ id: first.id, productId: "p1", quantity: 1, status: "CREATED" });
    // 재고는 취소로 복구된 2 그대로이며 새 주문은 만들어지지 않는다
    expect(await stockOf(api, "p1")).toBe(2);
    expect((await get(api, `/orders/${first.id}`)).body).toMatchObject({ status: "CANCELLED" });
  });
});

// R-06 멱등 키 충돌 (G2 · M-04)
describe("같은 키 + 다른 본문", () => {
  it("quantity가 다르면 422 IDEMPOTENCY_CONFLICT, 재고·주문 불변 (B-10)", async () => {
    const api = newApi();
    const first = await placeOrder(api, "k-conflict", "p1", 1);
    expectFailure(
      await postOrder(api, "k-conflict", { productId: "p1", quantity: 2 }),
      422,
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await stockOf(api, "p1")).toBe(1);
    const stored = await get(api, `/orders/${first.id}`);
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({ quantity: 1, status: "CREATED" });
  });

  it("productId가 다르면 422이며 다른 상품의 재고도 변하지 않는다", async () => {
    const api = newApi();
    await placeOrder(api, "k-conflict-2", "p1", 1);
    expectFailure(
      await postOrder(api, "k-conflict-2", { productId: "p2", quantity: 1 }),
      422,
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await stockOf(api, "p1")).toBe(1);
    expect(await stockOf(api, "p2")).toBe(5);
  });

  it("키는 서버 전체 범위다: 상품이 달라도 같은 키는 충돌한다", async () => {
    const api = newApi();
    await placeOrder(api, "k-global", "p2", 1);
    expectFailure(
      await postOrder(api, "k-global", { productId: "p1", quantity: 1 }),
      422,
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("충돌은 상품 존재·재고보다 먼저 판정된다: 없는 상품이라도 422", async () => {
    const api = newApi();
    await placeOrder(api, "k-prec", "p1", 1);
    expectFailure(
      await postOrder(api, "k-prec", { productId: "p9", quantity: 1 }),
      422,
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("404로 끝난 요청의 키는 기록되지 않는다", async () => {
    const api = newApi();
    expectFailure(
      await postOrder(api, "k-404", { productId: "p9", quantity: 1 }),
      404,
      "NOT_FOUND",
    );
    expect((await postOrder(api, "k-404", { productId: "p1", quantity: 1 })).status).toBe(201);
  });
});
