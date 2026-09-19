import { describe, expect, it } from "vitest";
import { expectFailure, newApi, postOrder, stockOf } from "./harness.js";

// R-04 입력 검증 (G1 · M-02)
describe("POST /orders 입력 검증", () => {
  const invalidBodies: Array<[string, unknown]> = [
    ["quantity 누락", { productId: "p1" }],
    ["quantity 0", { productId: "p1", quantity: 0 }],
    ["quantity -1", { productId: "p1", quantity: -1 }],
    ["quantity 1.5", { productId: "p1", quantity: 1.5 }],
    ['quantity 문자열 "1"', { productId: "p1", quantity: "1" }],
    ["quantity null", { productId: "p1", quantity: null }],
    ["quantity 불리언", { productId: "p1", quantity: true }],
    ["productId 누락", { quantity: 1 }],
    ["productId 빈 문자열", { productId: "", quantity: 1 }],
    ["productId 숫자", { productId: 1, quantity: 1 }],
    ["productId null", { productId: null, quantity: 1 }],
    ["본문이 배열", [{ productId: "p1", quantity: 1 }]],
    ["본문이 문자열", "p1"],
    ["본문이 null", null],
  ];

  it.each(invalidBodies)("%s → 400 VALIDATION_ERROR, 재고 불변 (B-4, B-5)", async (_, body) => {
    const api = newApi();
    expectFailure(await postOrder(api, "k-v", body), 400, "VALIDATION_ERROR");
    expect(await stockOf(api, "p1")).toBe(2);
  });

  it("quantity 0은 주문을 만들지 않는다 (재고 하한 경계)", async () => {
    const api = newApi();
    const res = await postOrder(api, "k-zero", { productId: "p1", quantity: 0 });
    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty("id");
    // 400은 멱등성 기록에 남지 않으므로 같은 키의 유효한 본문은 새 주문이 된다
    const ok = await postOrder(api, "k-zero", { productId: "p1", quantity: 1 });
    expect(ok.status).toBe(201);
    expect(await stockOf(api, "p1")).toBe(1);
  });

  it("quantity 1은 하한을 통과한다", async () => {
    const api = newApi();
    expect((await postOrder(api, "k-one", { productId: "p1", quantity: 1 })).status).toBe(201);
  });

  it("Idempotency-Key 누락 → 400 (B-6)", async () => {
    const api = newApi();
    expectFailure(
      await postOrder(api, undefined, { productId: "p1", quantity: 1 }),
      400,
      "VALIDATION_ERROR",
    );
    expect(await stockOf(api, "p1")).toBe(2);
  });

  it("Idempotency-Key 빈 문자열 → 400 (B-6)", async () => {
    const api = newApi();
    expectFailure(
      await postOrder(api, "", { productId: "p1", quantity: 1 }),
      400,
      "VALIDATION_ERROR",
    );
    expect(await stockOf(api, "p1")).toBe(2);
  });

  it("Idempotency-Key 129자 → 400, 128자는 허용", async () => {
    const api = newApi();
    expectFailure(
      await postOrder(api, "x".repeat(129), { productId: "p1", quantity: 1 }),
      400,
      "VALIDATION_ERROR",
    );
    expect((await postOrder(api, "y".repeat(128), { productId: "p1", quantity: 1 })).status).toBe(
      201,
    );
  });

  it("JSON이 아닌 본문 → 400 (B-7)", async () => {
    const api = newApi();
    expectFailure(await postOrder(api, "k-json", undefined, "{not json"), 400, "VALIDATION_ERROR");
    expect(await stockOf(api, "p1")).toBe(2);
  });

  it("본문 없음 → 400", async () => {
    const api = newApi();
    const res = await api.request("/orders", {
      method: "POST",
      headers: { "idempotency-key": "k-empty" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("검증 실패는 멱등성 검사보다 먼저다: 사용된 키라도 잘못된 본문은 400", async () => {
    const api = newApi();
    expect((await postOrder(api, "k-first", { productId: "p1", quantity: 1 })).status).toBe(201);
    expectFailure(await postOrder(api, "k-first", { productId: "p1" }), 400, "VALIDATION_ERROR");
  });

  it("400으로 끝난 키는 이후 유효한 본문으로 201을 만든다", async () => {
    const api = newApi();
    expectFailure(await postOrder(api, "k-reuse", { productId: "p1" }), 400, "VALIDATION_ERROR");
    expect((await postOrder(api, "k-reuse", { productId: "p1", quantity: 1 })).status).toBe(201);
  });
});
