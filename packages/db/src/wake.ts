import { setJobEnqueuedHook } from "./queue";

/**
 * 유휴 대기(`WORKER_IDLE_STOP_MS`) 중이거나 Railway가 재운 워커를 깨운다.
 *
 * 워커는 큐가 비면 폴링과 DB 연결을 멈추고, Railway는 나가는 트래픽이 없는 서비스를 재운다(Serverless).
 * 재운 서비스는 들어오는 요청으로만 깨어나므로 job을 적재한 쪽이 `WORKER_WAKE_URL`(워커의 `/wake`)을 호출한다.
 * 값이 없으면 아무것도 하지 않는다 (로컬, 워커가 항상 폴링하는 구성).
 */

type Env = Record<string, string | undefined>;

export interface WakeWorkerOptions {
  /** 시도 하나의 제한 시간. 재운 컨테이너가 뜨는 시간을 포함한다 */
  timeoutMs?: number | undefined;
  /** 재운 서비스의 첫 요청은 502가 될 수 있어 다시 시도한다 */
  attempts?: number | undefined;
  retryDelayMs?: number | undefined;
  fetch?: typeof fetch | undefined;
}

export function resolveWorkerWakeUrl(env: Env = process.env): string | null {
  const raw = env.WORKER_WAKE_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`WORKER_WAKE_URL은 http(s) 주소여야 합니다: ${url.protocol}`);
  }
  return url.toString();
}

/** 워커가 응답하면 true. 실패해도 던지지 않는다 (깨우기는 최선 노력이다) */
export async function wakeWorker(url: string, options: WakeWorkerOptions = {}): Promise<boolean> {
  const attempts = options.attempts ?? 3;
  const doFetch = options.fetch ?? fetch;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await doFetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      if (response.ok) return true;
    } catch {
      // 연결 실패·시간 초과. 요청이 닿은 것만으로 깨어나는 중일 수 있으므로 다시 시도한다.
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 2_000));
    }
  }
  return false;
}

/**
 * `enqueue`가 새 job을 만들 때마다 워커를 깨우도록 훅을 건다. `WORKER_WAKE_URL`이 없으면 걸지 않는다.
 * `schedule`은 응답 뒤에도 요청이 끝까지 가도록 실행 환경이 정한다 (web은 Next.js `after`).
 */
export function installWorkerWakeHook(
  env: Env = process.env,
  schedule: (task: () => Promise<void>) => void = (task) => void task(),
): boolean {
  const url = resolveWorkerWakeUrl(env);
  if (!url) return false;
  setJobEnqueuedHook(() => {
    schedule(async () => {
      await wakeWorker(url);
    });
  });
  return true;
}
