import { serve } from "@hono/node-server";
import { buildApi } from "./api.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid PORT: ${process.env.PORT ?? ""}`);
  process.exit(1);
}

const server = serve({ fetch: buildApi().fetch, port }, (info) => {
  console.log(`order-api (impl-b) listening on port ${info.port}`);
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
