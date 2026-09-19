/** LocalProcessRunner 설정. 환경변수 이름은 TICKET.md 1.6의 worker 계약이다. */
import os from "node:os";

export interface LocalRunnerLimits {
  /** 명령·서비스 수명의 벽시계 제한 (`RUN_TIMEOUT_MS`) */
  runTimeoutMs: number;
  /** 자식 node의 `--max-old-space-size` (`RUN_MEMORY_MB`) */
  runMemoryMb: number;
  /** `/health` 대기 시간의 상한. 계약의 `healthTimeoutMs`가 이보다 크면 이 값을 쓴다 (`HEALTH_TIMEOUT_MS`) */
  healthTimeoutMs: number;
  /** 스냅샷에서 풀 수 있는 파일 수·바이트 상한 (`MAX_SOURCE_FILES`, `MAX_SOURCE_BYTES`) */
  maxSourceFiles: number;
  maxSourceBytes: number;
  /** stdout·stderr 각각의 보관 상한(바이트). 넘는 부분은 버리고 truncated 표시 */
  maxOutputBytes: number;
  /** SIGTERM 뒤 SIGKILL까지 기다리는 시간 */
  killGraceMs: number;
}

export interface LocalRunnerConfig extends LocalRunnerLimits {
  /** 템플릿 루트 (`TEMPLATE_ROOT`). 컨테이너는 `/opt/templates` */
  templateRoot: string;
  /** 환경 디렉터리를 만들 곳. 기본 `os.tmpdir()` */
  workRoot: string;
}

export const LOCAL_RUNNER_DEFAULTS: LocalRunnerLimits = {
  runTimeoutMs: 120_000,
  runMemoryMb: 512,
  healthTimeoutMs: 30_000,
  maxSourceFiles: 500,
  maxSourceBytes: 20 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  killGraceMs: 2_000,
};

type Env = Record<string, string | undefined>;

/** 환경변수에서 설정을 읽는다. 잘못된 값은 즉시 오류로 드러낸다. */
export function loadLocalRunnerConfig(env: Env = process.env): LocalRunnerConfig {
  const templateRoot = env.TEMPLATE_ROOT?.trim();
  if (!templateRoot) {
    throw new Error("TEMPLATE_ROOT가 필요합니다 (예: /opt/templates, 로컬은 ./templates)");
  }
  return {
    templateRoot,
    workRoot: env.SANDBOX_WORK_ROOT?.trim() || os.tmpdir(),
    runTimeoutMs: intFrom(env, "RUN_TIMEOUT_MS", LOCAL_RUNNER_DEFAULTS.runTimeoutMs, 1),
    runMemoryMb: intFrom(env, "RUN_MEMORY_MB", LOCAL_RUNNER_DEFAULTS.runMemoryMb, 16),
    healthTimeoutMs: intFrom(env, "HEALTH_TIMEOUT_MS", LOCAL_RUNNER_DEFAULTS.healthTimeoutMs, 1),
    maxSourceFiles: intFrom(env, "MAX_SOURCE_FILES", LOCAL_RUNNER_DEFAULTS.maxSourceFiles, 1),
    maxSourceBytes: intFrom(env, "MAX_SOURCE_BYTES", LOCAL_RUNNER_DEFAULTS.maxSourceBytes, 1),
    maxOutputBytes: intFrom(
      env,
      "RUN_MAX_OUTPUT_BYTES",
      LOCAL_RUNNER_DEFAULTS.maxOutputBytes,
      1024,
    ),
    killGraceMs: intFrom(env, "RUN_KILL_GRACE_MS", LOCAL_RUNNER_DEFAULTS.killGraceMs, 0),
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

/** VercelSandboxRunner 설정 (T-209). 공통 제한은 `LocalRunnerConfig`와 같은 환경변수를 쓴다. */
export interface VercelRunnerConfig extends LocalRunnerConfig {
  /** SDK 자격증명. 셋 다 필요하다 (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`) */
  credentials: { token: string; teamId: string; projectId: string };
  /** VCR 이미지 (`VERCEL_SANDBOX_IMAGE`). 템플릿 `nodeVersion`과 같은 Node 메이저여야 한다 */
  image: string;
  /** vCPU 수 (`VERCEL_SANDBOX_VCPUS`). 비용 상한의 한 축이다 */
  vcpus: number;
  /** 세션 제한 시간 (`VERCEL_SANDBOX_TIMEOUT_MS`). 환경 하나의 벽시계·비용 상한이다 */
  sessionTimeoutMs: number;
  /** 템플릿 `npm ci` 제한 시간 (`VERCEL_SANDBOX_INSTALL_TIMEOUT_MS`) */
  installTimeoutMs: number;
  /** 리전 (`VERCEL_SANDBOX_REGION`). 생략하면 SDK 기본값 */
  region: string | undefined;
}

export const VERCEL_RUNNER_DEFAULTS = {
  image: "vercel/sandbox/node:22",
  vcpus: 2,
  sessionTimeoutMs: 15 * 60_000,
  installTimeoutMs: 5 * 60_000,
} as const;

export function loadVercelRunnerConfig(env: Env = process.env): VercelRunnerConfig {
  const base = loadLocalRunnerConfig(env);
  const token = env.VERCEL_TOKEN?.trim();
  const teamId = env.VERCEL_TEAM_ID?.trim();
  const projectId = env.VERCEL_PROJECT_ID?.trim();
  if (!token || !teamId || !projectId) {
    throw new Error(
      "SANDBOX_RUNNER=vercel에는 VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID가 모두 필요합니다",
    );
  }
  const image = env.VERCEL_SANDBOX_IMAGE?.trim() || VERCEL_RUNNER_DEFAULTS.image;
  const vcpus = intFrom(env, "VERCEL_SANDBOX_VCPUS", VERCEL_RUNNER_DEFAULTS.vcpus, 1);
  if (vcpus !== 1 && vcpus % 2 !== 0) {
    throw new Error(`VERCEL_SANDBOX_VCPUS 값 ${vcpus}은 1 또는 짝수여야 합니다`);
  }
  return {
    ...base,
    credentials: { token, teamId, projectId },
    image,
    vcpus,
    sessionTimeoutMs: intFrom(
      env,
      "VERCEL_SANDBOX_TIMEOUT_MS",
      VERCEL_RUNNER_DEFAULTS.sessionTimeoutMs,
      60_000,
    ),
    installTimeoutMs: intFrom(
      env,
      "VERCEL_SANDBOX_INSTALL_TIMEOUT_MS",
      VERCEL_RUNNER_DEFAULTS.installTimeoutMs,
      1_000,
    ),
    region: env.VERCEL_SANDBOX_REGION?.trim() || undefined,
  };
}
