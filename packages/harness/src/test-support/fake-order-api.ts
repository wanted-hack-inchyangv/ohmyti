/**
 * 테스트용 인메모리 order-api (SPEC.md v1). 하네스 테스트가 샘플 구현이나 템플릿 `node_modules` 없이
 * 돌아가도록 Node 내장 `http`만 쓴다. 옵션으로 결함(멱등성 없음)·5xx·응답 지연을 흉내 낸다.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

export interface FakeOrderApiOptions {
  /** false면 `Idempotency-Key`를 저장·조회하지 않는다 (샘플 C와 같은 결함) */
  idempotency?: boolean;
  /** `POST /orders`가 항상 500을 돌려준다 */
  serverError?: boolean;
  /** 모든 요청을 이 시간(ms)만큼 지연한다 */
  delayMs?: number;
  /** `POST /admin/reset`이 500을 돌려준다 */
  resetFails?: boolean;
  /** 응답 헤더에 넣을 값 (마스킹 테스트용) */
  extraHeader?: [string, string];
}

interface Order {
  id: string;
  productId: string;
  quantity: number;
  status: "CREATED" | "CANCELLED";
}

const SEED = [
  { id: "p1", name: "Keyboard", stock: 2 },
  { id: "p2", name: "Mouse", stock: 5 },
  { id: "p3", name: "Monitor", stock: 0 },
];

export interface FakeOrderApi {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFakeOrderApi(options: FakeOrderApiOptions = {}): Promise<FakeOrderApi> {
  const idempotency = options.idempotency ?? true;
  let products = SEED.map((p) => ({ ...p }));
  let orders = new Map<string, Order>();
  let keys = new Map<string, { fingerprint: string; response: Order }>();

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    if (options.extraHeader) res.setHeader(options.extraHeader[0], options.extraHeader[1]);
    res.end(JSON.stringify(body));
  };
  const error = (res: ServerResponse, status: number, code: string): void =>
    json(res, status, { error: { code, message: code.toLowerCase() } });

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk: Buffer) => (data += chunk.toString()));
      req.on("end", () => resolve(data));
    });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/health") return json(res, 200, { status: "ok" });
    if (method === "POST" && path === "/admin/reset") {
      if (options.resetFails) return error(res, 500, "INTERNAL");
      products = SEED.map((p) => ({ ...p }));
      orders = new Map();
      keys = new Map();
      return json(res, 200, { ok: true });
    }
    const productMatch = /^\/products\/([^/]+)$/.exec(path);
    if (method === "GET" && productMatch) {
      const product = products.find((p) => p.id === productMatch[1]);
      return product ? json(res, 200, product) : error(res, 404, "NOT_FOUND");
    }
    const orderMatch = /^\/orders\/([^/]+)$/.exec(path);
    if (method === "GET" && orderMatch) {
      const order = orders.get(orderMatch[1]!);
      return order ? json(res, 200, order) : error(res, 404, "NOT_FOUND");
    }
    const cancelMatch = /^\/orders\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancelMatch) {
      const order = orders.get(cancelMatch[1]!);
      if (!order) return error(res, 404, "NOT_FOUND");
      if (order.status === "CANCELLED") return error(res, 409, "ALREADY_CANCELLED");
      order.status = "CANCELLED";
      products.find((p) => p.id === order.productId)!.stock += order.quantity;
      return json(res, 200, order);
    }
    if (method === "POST" && path === "/orders") {
      if (options.serverError) return error(res, 500, "INTERNAL");
      const key = req.headers["idempotency-key"];
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return error(res, 400, "VALIDATION_ERROR");
      }
      if (typeof key !== "string" || key.length === 0 || key.length > 128) {
        return error(res, 400, "VALIDATION_ERROR");
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return error(res, 400, "VALIDATION_ERROR");
      }
      const { productId, quantity } = body as { productId?: unknown; quantity?: unknown };
      if (typeof productId !== "string" || productId.length === 0) {
        return error(res, 400, "VALIDATION_ERROR");
      }
      if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
        return error(res, 400, "VALIDATION_ERROR");
      }
      const fingerprint = JSON.stringify([productId, quantity]);
      if (idempotency) {
        const existing = keys.get(key);
        if (existing) {
          if (existing.fingerprint !== fingerprint) return error(res, 422, "IDEMPOTENCY_CONFLICT");
          return json(res, 201, existing.response);
        }
      }
      const product = products.find((p) => p.id === productId);
      if (!product) return error(res, 404, "NOT_FOUND");
      if (quantity > product.stock) return error(res, 409, "INSUFFICIENT_STOCK");
      product.stock -= quantity;
      const order: Order = { id: randomUUID(), productId, quantity, status: "CREATED" };
      orders.set(order.id, order);
      if (idempotency) keys.set(key, { fingerprint, response: { ...order } });
      return json(res, 201, order);
    }
    return error(res, 404, "NOT_FOUND");
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
