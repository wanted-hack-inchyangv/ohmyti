import { describe, expect, it } from "vitest";
import { expectFailure, get, newApi, placeOrder, post, stockOf } from "./harness.js";

// R-09 주문 취소와 재고 복구 (G3 · M-05)
describe("POST /orders/:id/cancel", () => {
  it("200 CANCELLED를 반환하고 RELEASE 이벤트로 재고를 복구한다 (B-13)", async () => {
    const api = newApi();
    const order = await placeOrder(api, "k-cancel", "p1", 1);
    expect(await stockOf(api, "p1")).toBe(1);

    const res = await post(api, `/orders/${order.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: order.id, productId: "p1", quantity: 1, status: "CANCELLED" });
    expect(await stockOf(api, "p1")).toBe(2);
  });

  it("수량 2 주문을 취소하면 재고가 수량만큼 돌아온다", async () => {
    const api = newApi();
    const order = await placeOrder(api, "k-cancel-2", "p2", 2);
    expect(await stockOf(api, "p2")).toBe(3);
    expect((await post(api, `/orders/${order.id}/cancel`)).status).toBe(200);
    expect(await stockOf(api, "p2")).toBe(5);
  });

  it("취소된 주문은 GET /orders/:id에서 CANCELLED로 조회된다", async () => {
    const api = newApi();
    const order = await placeOrder(api, "k-cancel-3", "p1", 1);
    await post(api, `/orders/${order.id}/cancel`);
    const res = await get(api, `/orders/${order.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: order.id, status: "CANCELLED" });
  });

  it("이중 취소는 409 ALREADY_CANCELLED이며 재고는 한 번만 복구된다 (B-14)", async () => {
    const api = newApi();
    const order = await placeOrder(api, "k-double", "p1", 1);
    expect((await post(api, `/orders/${order.id}/cancel`)).status).toBe(200);
    expectFailure(await post(api, `/orders/${order.id}/cancel`), 409, "ALREADY_CANCELLED");
    expect(await stockOf(api, "p1")).toBe(2);
  });

  it("같은 주문을 동시에 취소해도 복구는 한 번뿐이다", async () => {
    const api = newApi();
    const order = await placeOrder(api, "k-race", "p2", 2);
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => post(api, `/orders/${order.id}/cancel`)),
    );
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await stockOf(api, "p2")).toBe(5);
  });

  it("취소로 복구된 재고로 새 주문을 만들 수 있다", async () => {
    const api = newApi();
    const order = await placeOrder(api, "k-refill-1", "p1", 2);
    await post(api, `/orders/${order.id}/cancel`);
    const next = await placeOrder(api, "k-refill-2", "p1", 2);
    expect(next.id).not.toBe(order.id);
    expect(await stockOf(api, "p1")).toBe(0);
  });

  it("없는 주문의 취소는 404 NOT_FOUND (B-15)", async () => {
    expectFailure(await post(newApi(), "/orders/nope/cancel"), 404, "NOT_FOUND");
  });
});
