import { describe, expect, it } from "vitest";
import { createOrder, getStock, newClient } from "./helpers.js";

describe("GET /health", () => {
  it("200 { status: 'ok' }", async () => {
    const res = await newClient().get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /admin/reset", () => {
  it("재고를 시드로 되돌리고 주문을 지운다", async () => {
    const client = newClient();
    const order = await createOrder(client, "k-reset", "p1", 2);
    expect(await getStock(client, "p1")).toBe(0);

    const reset = await client.post("/admin/reset");
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ ok: true });

    expect(await getStock(client, "p1")).toBe(2);
    expect((await client.get(`/orders/${order.id}`)).status).toBe(404);
  });
});
