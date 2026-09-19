/**
 * `.env.example`이 환경변수 계약(TICKET.md 1.6)의 변수를 빠짐없이 담고 있는지 대조한다.
 * 계약 목록은 이 파일에 고정해 두며, 1.6이 바뀌면 여기와 .env.example을 함께 갱신한다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./load-env";

export const ENV_CONTRACT = [
  "DATABASE_URL",
  "DATABASE_URL_TEST",
  "ARTIFACT_STORE",
  "ARTIFACT_FS_ROOT",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_ACCESS",
  "ARTIFACT_MAX_BYTES",
  "APP_ACCESS_PASSWORD",
  "SESSION_SECRET",
  "SANDBOX_RUNNER",
  "TEMPLATE_ROOT",
  "RUN_TIMEOUT_MS",
  "RUN_MEMORY_MB",
  "HEALTH_TIMEOUT_MS",
  "SANDBOX_WORK_ROOT",
  "RUN_MAX_OUTPUT_BYTES",
  "RUN_KILL_GRACE_MS",
  "MAX_SOURCE_FILES",
  "MAX_SOURCE_BYTES",
  "MAX_PROFILE_REPOS",
  "GITHUB_TOKEN",
  "DEEP_SEEK_API_KEY",
  "LLM_PROVIDER",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_MAX_CALLS_PER_EVALUATION",
  "LLM_MAX_COST_USD_PER_EVALUATION",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_SANDBOX_IMAGE",
  "VERCEL_SANDBOX_VCPUS",
  "VERCEL_SANDBOX_TIMEOUT_MS",
  "VERCEL_SANDBOX_INSTALL_TIMEOUT_MS",
  "VERCEL_SANDBOX_REGION",
  "WORKER_POLL_INTERVAL_MS",
  "WORKER_CONCURRENCY",
  "WORKER_STALE_MS",
  "WORKER_ID",
  "WORKER_HEARTBEAT_INTERVAL_MS",
  "WORKER_RECLAIM_INTERVAL_MS",
  "WORKER_SHUTDOWN_GRACE_MS",
  "WORKER_IDLE_STOP_MS",
  "WORKER_WAKE_URL",
  "PORT",
  "LOG_LEVEL",
  "MIGRATIONS_FOLDER",
  "DEMO_MODE",
] as const;

export function parseEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

function main(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const examplePath = path.join(repoRoot, ".env.example");
  const keys = parseEnvKeys(readFileSync(examplePath, "utf8"));

  const missing = ENV_CONTRACT.filter((name) => !keys.has(name));
  const extra = [...keys].filter((name) => !(ENV_CONTRACT as readonly string[]).includes(name));

  if (missing.length > 0) {
    console.error(`.env.example에 없는 변수: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    console.error(`계약에 없는 변수 (.env.example에만 있음): ${extra.join(", ")}`);
  }
  if (missing.length > 0 || extra.length > 0) {
    process.exit(1);
  }
  console.log(`env:check OK — ${ENV_CONTRACT.length}개 변수가 .env.example과 일치합니다.`);
}

main();
