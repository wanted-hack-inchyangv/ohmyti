import os from "node:os";

/** 워커 실행 설정 (TICKET.md 1.6의 `WORKER_*` 계약). */
export interface WorkerConfig {
  workerId: string;
  /** 큐가 비었을 때 다음 폴링까지 대기 시간 */
  pollIntervalMs: number;
  /** 동시에 실행할 job 수 */
  concurrency: number;
  /** heartbeat가 이 시간을 넘기면 다른 워커가 회수한다 */
  staleMs: number;
  /** heartbeat 주기. 기본 staleMs / 3 */
  heartbeatIntervalMs: number;
  /** 오래된 lock 회수 검사 주기. 기본 staleMs / 2 */
  reclaimIntervalMs: number;
  /** SIGTERM 후 진행 중 job이 끝나기를 기다리는 최대 시간. 지나면 QUEUED로 반납한다 */
  shutdownGraceMs: number;
  /** `/healthz` 포트. 0이면 헬스 서버를 띄우지 않는다 */
  healthPort: number;
  logLevel: string;
}

export const WORKER_CONFIG_DEFAULTS = {
  pollIntervalMs: 1_000,
  concurrency: 1,
  staleMs: 60_000,
  shutdownGraceMs: 25_000,
  healthPort: 8080,
  logLevel: "info",
} as const;

type Env = Record<string, string | undefined>;

/** 환경변수에서 설정을 읽는다. 잘못된 값은 즉시 오류로 드러내 잘못된 배포를 빨리 알린다. */
export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const staleMs = intFrom(env, "WORKER_STALE_MS", WORKER_CONFIG_DEFAULTS.staleMs, 1);
  const heartbeatIntervalMs = intFrom(
    env,
    "WORKER_HEARTBEAT_INTERVAL_MS",
    Math.max(Math.floor(staleMs / 3), 1),
    1,
  );
  if (heartbeatIntervalMs >= staleMs) {
    throw new Error(
      `WORKER_HEARTBEAT_INTERVAL_MS(${heartbeatIntervalMs})는 WORKER_STALE_MS(${staleMs})보다 작아야 합니다`,
    );
  }
  return {
    workerId: env.WORKER_ID?.trim() || `${os.hostname()}-${process.pid}`,
    pollIntervalMs: intFrom(
      env,
      "WORKER_POLL_INTERVAL_MS",
      WORKER_CONFIG_DEFAULTS.pollIntervalMs,
      1,
    ),
    concurrency: intFrom(env, "WORKER_CONCURRENCY", WORKER_CONFIG_DEFAULTS.concurrency, 1),
    staleMs,
    heartbeatIntervalMs,
    reclaimIntervalMs: intFrom(
      env,
      "WORKER_RECLAIM_INTERVAL_MS",
      Math.max(Math.floor(staleMs / 2), 1),
      1,
    ),
    shutdownGraceMs: intFrom(
      env,
      "WORKER_SHUTDOWN_GRACE_MS",
      WORKER_CONFIG_DEFAULTS.shutdownGraceMs,
      0,
    ),
    // Railway는 서비스 포트를 PORT로 준다.
    healthPort: intFrom(env, "PORT", WORKER_CONFIG_DEFAULTS.healthPort, 0),
    logLevel: env.LOG_LEVEL?.trim() || WORKER_CONFIG_DEFAULTS.logLevel,
  };
}

function intFrom(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} 값 ${JSON.stringify(raw)}은 ${min} 이상의 정수여야 합니다`);
  }
  return value;
}

/** 로그에서 가려야 하는 환경변수. 값이 있으면 `maskSensitive`의 지정 비밀값으로 넘긴다. */
export const SECRET_ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_TEST",
  "BLOB_READ_WRITE_TOKEN",
  "APP_ACCESS_PASSWORD",
  "SESSION_SECRET",
  "GITHUB_TOKEN",
  "DEEP_SEEK_API_KEY",
  "VERCEL_TOKEN",
] as const;

/** 환경변수에서 비밀값 목록을 모은다. 연결 문자열은 비밀번호 부분도 따로 넣는다. */
export function collectSecrets(env: Env = process.env): string[] {
  const secrets = new Set<string>();
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    secrets.add(value);
    const password = passwordFromUrl(value);
    if (password) secrets.add(password);
  }
  return [...secrets];
}

function passwordFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.password ? decodeURIComponent(url.password) : null;
  } catch {
    return null;
  }
}
