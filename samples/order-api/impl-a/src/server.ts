import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`invalid PORT: ${process.env.PORT ?? ""}`);
  process.exit(1);
}

const server = createApp().listen(port, () => {
  console.log(`order-api listening on port ${port}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
