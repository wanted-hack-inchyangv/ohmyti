import { PACKAGE_NAME } from "@ohmyti/core";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./env";

export function describeWorker(): string {
  return `ohmyti worker (core: ${PACKAGE_NAME})`;
}

export { createWorker, type Worker, type WorkerDeps, type WorkerStatus } from "./worker";
export {
  HandlerRegistry,
  JobLostError,
  NonRetryableJobError,
  createDefaultRegistry,
  type JobContext,
  type JobHandler,
} from "./registry";
export { createLogger, type Logger } from "./logger";
export { loadWorkerConfig, type WorkerConfig } from "./config";
export { runWorkerProcess } from "./main";
export * from "./repo";
export * from "./support";
export * from "./pipeline";
export * from "./delete";

// 번들(dist/index.js)이나 `tsx src/index.ts`로 직접 실행했을 때만 프로세스를 띄운다.
const invokedDirectly =
  typeof process.argv[1] === "string" && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  loadEnv();
  const { runWorkerProcess } = await import("./main");
  runWorkerProcess().then(
    // 유예 시간을 넘긴 핸들러가 자원을 붙들고 있어도 프로세스는 끝나야 한다.
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
