import express, { type Express } from "express";
import { OrderService } from "./domain/order-service.js";
import { seedProducts } from "./domain/seed.js";
import { errorHandler } from "./http/error-handler.js";
import { createRoutes } from "./http/routes.js";
import {
  InMemoryIdempotencyStore,
  InMemoryOrderRepository,
  InMemoryProductRepository,
} from "./repository/in-memory.js";

/** 앱 조립. 저장소를 바꾸려면 여기서 다른 구현을 주입한다. */
export function createApp(): Express {
  const service = new OrderService({
    products: new InMemoryProductRepository(seedProducts()),
    orders: new InMemoryOrderRepository(),
    idempotency: new InMemoryIdempotencyStore(),
  });

  const app = express();
  app.disable("x-powered-by");
  // 본문이 JSON 객체·배열이 아니면(strict) 파서가 오류를 내고 errorHandler가 400으로 바꾼다.
  app.use(express.json({ strict: true, limit: "64kb" }));
  app.use(createRoutes(service));
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "route not found" } });
  });
  app.use(errorHandler);
  return app;
}
