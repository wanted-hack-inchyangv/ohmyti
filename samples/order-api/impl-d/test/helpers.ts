import request from "supertest";
import { expect } from "vitest";
import { createApp } from "../src/app.js";

export type Client = ReturnType<typeof request>;

/** 테스트마다 새 앱(새 인메모리 상태)을 만든다. */
export function newClient(): Client {
  return request(createApp());
}

export type OrderBody = { id: string; productId: string; quantity: number; status: string };

export async function createOrder(
  client: Client,
  key: string,
  productId: string,
  quantity: number,
): Promise<OrderBody> {
  const res = await client
    .post("/orders")
    .set("Idempotency-Key", key)
    .set("Content-Type", "application/json")
    .send({ productId, quantity });
  expect(res.status).toBe(201);
  return res.body as OrderBody;
}

export async function getStock(client: Client, productId: string): Promise<number> {
  const res = await client.get(`/products/${productId}`);
  expect(res.status).toBe(200);
  return (res.body as { stock: number }).stock;
}
