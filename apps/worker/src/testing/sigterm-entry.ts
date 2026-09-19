/**
 * SIGTERM 통합 테스트용 엔트리. EVALUATE_SUBMISSION 핸들러가 `TEST_HANDLER_MS`만큼 기다린 뒤 끝나며,
 * 값이 `hang`이면 끝나지 않는다. 그 외 동작은 실제 워커 프로세스(`runWorkerProcess`)와 같다.
 */
import { runWorkerProcess } from "../main";
import { createDefaultRegistry } from "../registry";

const mode = process.env.TEST_HANDLER_MS ?? "500";
const registry = createDefaultRegistry().register("EVALUATE_SUBMISSION", async (_job, ctx) => {
  if (mode === "hang") {
    await new Promise<void>(() => {});
    return;
  }
  const ms = Number(mode);
  const step = 50;
  for (let waited = 0; waited < ms; waited += step) {
    await new Promise((resolve) => setTimeout(resolve, step));
    await ctx.heartbeat();
  }
});

await runWorkerProcess({ registry });
process.exit(0);
