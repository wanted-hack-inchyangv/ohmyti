/** 빈 포트 할당과 `/health` 대기 (T-108). */
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** 127.0.0.1에서 지금 비어 있는 포트를 돌려준다. OS가 고른 포트를 바로 닫으므로 짧은 경쟁 구간이 있다. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("포트를 할당하지 못했습니다"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export interface HealthWaitResult {
  healthy: boolean;
  lastStatus: number | null;
  attempts: number;
  elapsedMs: number;
}

export interface HealthWaitOptions {
  url: string;
  timeoutMs: number;
  /** 폴링 간격 */
  intervalMs?: number;
  /** 요청 하나의 제한 시간 */
  requestTimeoutMs?: number;
  /** true를 돌려주면 즉시 포기한다 (프로세스가 먼저 죽은 경우) */
  shouldAbort?: () => boolean;
}

/** `url`이 200을 줄 때까지 폴링한다. 연결 거부·다른 상태 코드는 계속 시도한다. */
export async function waitForHealth(options: HealthWaitOptions): Promise<HealthWaitResult> {
  const interval = options.intervalMs ?? 100;
  const requestTimeout = options.requestTimeoutMs ?? 2_000;
  const start = Date.now();
  let lastStatus: number | null = null;
  let attempts = 0;
  for (;;) {
    if (options.shouldAbort?.()) break;
    attempts += 1;
    try {
      const response = await fetch(options.url, {
        signal: AbortSignal.timeout(requestTimeout),
        redirect: "manual",
      });
      lastStatus = response.status;
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 200) {
        return { healthy: true, lastStatus, attempts, elapsedMs: Date.now() - start };
      }
    } catch {
      // 연결 거부·시간 초과: 아직 기동 중
    }
    if (Date.now() - start >= options.timeoutMs) break;
    await sleep(interval);
  }
  return { healthy: false, lastStatus, attempts, elapsedMs: Date.now() - start };
}
