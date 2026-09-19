// 주문/재고 API. 모든 로직을 핸들러 안에 둔 단일 파일 구현 (T-602 fixture)
import express from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";

const app = express();

function seed(): any[] {
  return [
    { id: "p1", name: "Keyboard", stock: 2 },
    { id: "p2", name: "Mouse", stock: 5 },
    { id: "p3", name: "Monitor", stock: 0 },
  ];
}

let items: any[] = seed();
let orders: any[] = [];
let idemRecords: any[] = [];

let busy = false;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function acquire() {
  while (busy) await wait(1);
  busy = true;
}

function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.post("/admin/reset", async (_req: Request, res: Response) => {
  await acquire();
  try {
    items = seed();
    orders = [];
    idemRecords = [];
    res.status(200).json({ ok: true });
  } finally {
    busy = false;
  }
});

app.get("/products/:id", (req: Request, res: Response) => {
  let hit: any = null;
  for (const it of items) {
    if (it.id === req.params.id) hit = it;
  }
  if (!hit) return fail(res, 404, "NOT_FOUND", "product not found");
  res.status(200).json({ id: hit.id, name: hit.name, stock: hit.stock });
});

app.post("/orders", express.json({ strict: true }), async (req: Request, res: Response) => {
  const headerValue = req.header("Idempotency-Key");
  const k = headerValue;
  if (typeof k !== "string" || k.length === 0 || k.length > 128) {
    return fail(res, 400, "VALIDATION_ERROR", "Idempotency-Key header invalid");
  }
  const body: any = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(res, 400, "VALIDATION_ERROR", "body must be json object");
  }
  const pid = body.productId;
  const qty = body.quantity;
  if (typeof pid !== "string" || pid.length === 0) {
    return fail(res, 400, "VALIDATION_ERROR", "productId invalid");
  }
  if (typeof qty !== "number" || !Number.isInteger(qty)) {
    return fail(res, 400, "VALIDATION_ERROR", "quantity must be integer");
  }
  if (qty < 1) return fail(res, 400, "VALIDATION_ERROR", "quantity must be >= 1");

  await acquire();
  try {
    const fingerprint = JSON.stringify({ productId: pid, quantity: qty });
    let prior: any = null;
    for (const rec of idemRecords) {
      if (rec.key === k) {
        prior = rec;
        break;
      }
    }
    if (prior) {
      if (prior.fingerprint === fingerprint) return res.status(201).json(prior.response);
      return fail(res, 422, "IDEMPOTENCY_CONFLICT", "key reused with different body");
    }

    let item: any = null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === pid) item = items[i];
    }
    if (!item) return fail(res, 404, "NOT_FOUND", "product not found");
    if (qty > item.stock) return fail(res, 409, "INSUFFICIENT_STOCK", "not enough stock");

    item.stock = item.stock - qty;
    const order = { id: randomUUID(), productId: pid, quantity: qty, status: "CREATED" };
    orders.push(order);
    idemRecords.push({ key: k, fingerprint, response: { ...order } });
    res.status(201).json(order);
  } finally {
    busy = false;
  }
});

app.get("/orders/:id", (req: Request, res: Response) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return fail(res, 404, "NOT_FOUND", "order not found");
  res.status(200).json(order);
});

app.post("/orders/:id/cancel", async (req: Request, res: Response) => {
  await acquire();
  try {
    let order: any = null;
    for (const o of orders) {
      if (o.id === req.params.id) order = o;
    }
    if (!order) return fail(res, 404, "NOT_FOUND", "order not found");
    if (order.status === "CANCELLED") {
      return fail(res, 409, "ALREADY_CANCELLED", "order already cancelled");
    }
    let target: any = null;
    for (const it of items) {
      if (it.id === order.productId) target = it;
    }
    if (target) {
      target.stock = target.stock + order.quantity;
    }
    order.status = "CANCELLED";
    res.status(200).json(order);
  } finally {
    busy = false;
  }
});

app.use((_req: Request, res: Response) => fail(res, 404, "NOT_FOUND", "route not found"));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((_err: any, _req: Request, res: Response, _next: any) => {
  fail(res, 400, "VALIDATION_ERROR", "invalid json body");
});

if (process.env.NODE_ENV !== "test") {
  app.listen(Number(process.env.PORT) || 3000);
}

export default app;
