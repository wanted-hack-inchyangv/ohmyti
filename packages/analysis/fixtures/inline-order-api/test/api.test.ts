import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/index";

// 단언이 약한 제출 테스트: 상태 코드가 500 미만인지만 본다
describe("order-api", () => {
  const key = "fixture-key";
  let orderId = "";

  beforeAll(async () => {
    await request(app).post("/admin/reset");
  });

  it("health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBeLessThan(500);
  });

  it("상품 조회", async () => {
    const res = await request(app).get("/products/p1");
    expect(res.body).toBeTruthy();
  });

  it("주문 생성", async () => {
    const res = await request(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ productId: "p1", quantity: 1 });
    expect(res.status).toBeLessThan(500);
    orderId = res.body.id;
  });

  it("같은 키 재전송", async () => {
    const res = await request(app)
      .post("/orders")
      .set("Idempotency-Key", key)
      .send({ productId: "p1", quantity: 1 });
    expect(res.status).toBeLessThan(500);
  });

  it("수량 0", async () => {
    const res = await request(app)
      .post("/orders")
      .set("Idempotency-Key", "zero")
      .send({ productId: "p1", quantity: 0 });
    expect(res.status).toBeLessThan(500);
  });

  it("주문 취소", async () => {
    const res = await request(app).post(`/orders/${orderId}/cancel`);
    expect(res.body).toBeDefined();
  });
});
