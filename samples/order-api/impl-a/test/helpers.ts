import request, { type Response } from "supertest";
import { expect } from "vitest";
import { createApp } from "../src/app.js";

export type Client = ReturnType<typeof request>;

/** 테스트마다 새 앱(새 인메모리 상태)을 만든다. */
export function newClient(): Client {
  return request(createApp());
}

export function postOrder(
  client: Client,
  key: string | undefined,
  body: unknown,
): ReturnType<Client["post"]> {
  const req = client.post("/orders");
  if (key !== undefined) req.set("Idempotency-Key", key);
  return req.set("Content-Type", "application/json").send(body as object);
}

export async function createOrder(
  client: Client,
  key: string,
  productId: string,
  quantity: number,
): Promise<{ id: string; productId: string; quantity: number; status: string }> {
  const res = await postOrder(client, key, { productId, quantity });
  expect(res.status).toBe(201);
  return res.body as { id: string; productId: string; quantity: number; status: string };
}

export async function getStock(client: Client, productId: string): Promise<number> {
  const res = await client.get(`/products/${productId}`);
  expect(res.status).toBe(200);
  return (res.body as { stock: number }).stock;
}

export function expectError(res: Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ error: { code } });
  expect(typeof (res.body as { error: { message: unknown } }).error.message).toBe("string");
}
