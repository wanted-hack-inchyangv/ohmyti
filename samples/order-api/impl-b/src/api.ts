import { Hono } from "hono";
import { type Context } from "hono";
import { type ContentfulStatusCode } from "hono/utils/http-status";
import { type Commands, createCommands } from "./core/commands.js";
import { type Failure, type FailureCode, type Outcome } from "./core/outcome.js";

/** SPEC 4절 오류 코드 → HTTP 상태. 새 코드는 여기와 outcome.ts의 FailureCode에 한 줄씩 더한다. */
const STATUS_OF: Record<FailureCode, ContentfulStatusCode> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  INSUFFICIENT_STOCK: 409,
  ALREADY_CANCELLED: 409,
  IDEMPOTENCY_CONFLICT: 422,
};

const failureResponse = (c: Context, failure: Failure): Response =>
  c.json({ error: { code: failure.code, message: failure.reason } }, STATUS_OF[failure.code]);

/** Outcome을 HTTP 응답으로 바꾼다. 성공 상태 코드만 라우트가 정한다. */
const reply = <T>(c: Context, outcome: Outcome<T>, status: ContentfulStatusCode): Response =>
  outcome.ok ? c.json(outcome.value, status) : failureResponse(c, outcome);

/** 본문을 JSON으로 읽는다. 파싱에 실패하거나 본문이 없으면 `undefined`이며 검증 단계에서 400이 된다. */
const readJson = async (c: Context): Promise<unknown> => {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    return undefined;
  }
};

/** HTTP 라우팅. 헤더·본문 추출과 응답 변환만 하며 규칙은 commands에 있다. */
export const buildApi = (commands: Commands = createCommands()): Hono => {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }, 200));

  app.post("/admin/reset", async (c) => {
    await commands.reset();
    return c.json({ ok: true }, 200);
  });

  app.get("/products/:id", (c) => reply(c, commands.product(c.req.param("id")), 200));

  app.post("/orders", async (c) => {
    const outcome = await commands.place(c.req.header("Idempotency-Key"), await readJson(c));
    return reply(c, outcome, 201);
  });

  app.get("/orders/:id", (c) => reply(c, commands.order(c.req.param("id")), 200));

  app.post("/orders/:id/cancel", async (c) =>
    reply(c, await commands.cancel(c.req.param("id")), 200),
  );

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "route not found" } }, 404));

  app.onError((err, c) => c.json({ error: { code: "INTERNAL_ERROR", message: err.message } }, 500));

  return app;
};
