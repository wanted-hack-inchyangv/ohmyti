import { expect } from "vitest";
import { buildApi } from "../src/api.js";

export type Api = ReturnType<typeof buildApi>;
export type OrderBody = { id: string; productId: string; quantity: number; status: string };
export type Reply = { status: number; body: unknown; contentType: string | null };

/** 테스트마다 새 API(새 상태)를 만든다. 요청은 Hono의 `app.request()`로 프로세스 안에서 보낸다. */
export const newApi = (): Api => buildApi();

const read = async (res: Response): Promise<Reply> => {
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body, contentType: res.headers.get("content-type") };
};

export const get = async (api: Api, path: string): Promise<Reply> => read(await api.request(path));

export const post = async (api: Api, path: string): Promise<Reply> =>
  read(await api.request(path, { method: "POST" }));

/** 본문은 JSON으로 직렬화한다. `rawBody`를 주면 그대로 보낸다(JSON 아님 시나리오용). */
export const postOrder = async (
  api: Api,
  key: string | undefined,
  body: unknown,
  rawBody?: string,
): Promise<Reply> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== undefined) headers["idempotency-key"] = key;
  return read(
    await api.request("/orders", {
      method: "POST",
      headers,
      body: rawBody ?? JSON.stringify(body),
    }),
  );
};

export const placeOrder = async (
  api: Api,
  key: string,
  productId: string,
  quantity: number,
): Promise<OrderBody> => {
  const res = await postOrder(api, key, { productId, quantity });
  expect(res.status).toBe(201);
  return res.body as OrderBody;
};

export const stockOf = async (api: Api, productId: string): Promise<number> => {
  const res = await get(api, `/products/${productId}`);
  expect(res.status).toBe(200);
  return (res.body as { stock: number }).stock;
};

export const expectFailure = (res: Reply, status: number, code: string): void => {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ error: { code } });
  expect(typeof (res.body as { error: { message: unknown } }).error.message).toBe("string");
};
