import { resolveWorkerWakeUrl, wakeWorker } from "@ohmyti/db";
import { after } from "next/server";

/** 같은 함수 인스턴스에서 상태 폴링이 워커를 다시 깨우는 최소 간격 */
const REWAKE_INTERVAL_MS = 30_000;

let lastWakeAt = 0;

/** 응답을 보낸 뒤에 요청이 끝까지 가도록 `after`에 맡긴다. 요청 범위 밖이면 바로 보낸다. */
export function scheduleWorkerWake(task: () => Promise<void>): void {
  lastWakeAt = Date.now();
  try {
    after(task);
  } catch {
    void task();
  }
}

/**
 * 끝나지 않은 job을 보고 있는 상태 폴링이 부른다. 적재 때 보낸 깨우기 요청이 닿지 못했어도
 * 화면이 열려 있는 동안 워커가 다시 깨어난다. `WORKER_WAKE_URL`이 없으면 아무것도 하지 않는다.
 */
export function rewakeWorkerIfDue(): void {
  if (Date.now() - lastWakeAt < REWAKE_INTERVAL_MS) return;
  const url = resolveWorkerWakeUrl(process.env);
  if (!url) return;
  scheduleWorkerWake(async () => {
    await wakeWorker(url, { attempts: 1 });
  });
}
