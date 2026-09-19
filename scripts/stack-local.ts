/**
 * `pnpm stack:local` (T-308): 로컬 전체 스택(web dev 서버 + 워커)을 한 번에 띄운다. PostgreSQL은 미리 떠 있어야 한다
 * (`DATABASE_URL`, `.env.local` 자동 로드). 웹과 워커가 같은 fs 아티팩트 스토어(`apps/web/.artifacts-e2e`)를 쓰도록
 * 환경변수를 맞추고, 워커의 `TEMPLATE_ROOT`는 절대 경로로 넘긴다(상대 경로는 `apps/worker` 기준으로 풀린다).
 *
 * 순서: `pnpm db:migrate`(생략 `--no-migrate`) → `pnpm db:seed:sample`(생략 `--no-seed`, 현재 하네스 버전의 샘플 과제를
 * 승인) → 워커(`tsx apps/worker/src/index.ts`, `/healthz`) → 웹(`next dev`) → 둘 다 응답할 때까지 대기 → Ctrl+C까지 유지.
 * 종료 신호가 오면 두 프로세스 그룹에 SIGTERM을 보내고 유예 뒤 SIGKILL한다.
 *
 * 포트: 웹 `E2E_PORT`(기본 4310, Playwright 설정과 같다), 워커 `E2E_WORKER_PORT`(기본 4320).
 * Playwright는 웹을 `reuseExistingServer`로 재사용하고, `e2e/workbench-stack.spec.ts`는 워커 `/healthz`가 응답하면
 * 그 워커를 재사용하며 아니면 같은 설정으로 직접 띄운다. 그래서 `pnpm stack:local & pnpm e2e -- workbench`와
 * `pnpm e2e` 단독 실행이 모두 동작한다.
 *
 * 사용: `pnpm stack:local [--no-migrate] [--no-seed] [--web-port 4310] [--worker-port 4320]`
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import "./load-env";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STACK_DEFAULTS = {
  webPort: 4310,
  workerPort: 4320,
  /** `apps/web` 기준 상대 경로. Playwright 설정의 `ARTIFACT_FS_ROOT`와 같다 */
  artifactRoot: ".artifacts-e2e",
  /** `/healthz`·`/` 응답 대기 상한 */
  readyTimeoutMs: 120_000,
  readyIntervalMs: 500,
  /** SIGTERM 뒤 SIGKILL까지 유예 */
  stopGraceMs: 10_000,
} as const;

type Env = Record<string, string | undefined>;

export interface StackPorts {
  webPort: number;
  workerPort: number;
}

/** `E2E_PORT`(웹)·`E2E_WORKER_PORT`(워커). 잘못된 값은 즉시 오류다 */
export function stackPorts(
  env: Env = process.env,
  overrides: Partial<StackPorts> = {},
): StackPorts {
  return {
    webPort: overrides.webPort ?? portFrom(env, "E2E_PORT", STACK_DEFAULTS.webPort),
    workerPort: overrides.workerPort ?? portFrom(env, "E2E_WORKER_PORT", STACK_DEFAULTS.workerPort),
  };
}

function portFrom(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} 값 ${JSON.stringify(raw)}은 1~65535 사이의 정수여야 합니다`);
  }
  return value;
}

/**
 * 웹·워커·시드가 공유하는 fs 아티팩트 스토어의 절대 경로.
 * 웹은 `apps/web`에서 `next dev`를 실행하므로 `E2E_ARTIFACT_FS_ROOT`(기본 `.artifacts-e2e`)를 `apps/web` 기준으로 푼다.
 */
export function stackArtifactRoot(env: Env = process.env, root: string = repoRoot): string {
  return path.resolve(root, "apps/web", env.E2E_ARTIFACT_FS_ROOT ?? STACK_DEFAULTS.artifactRoot);
}

/** 워커 템플릿 루트 (`templates/`, 절대 경로) */
export function stackTemplateRoot(root: string = repoRoot): string {
  return path.resolve(root, "templates");
}

/** 웹 dev 서버 환경. Playwright 설정(`webServer.env`)과 같은 값이어야 한다 */
export function webEnv(env: Env = process.env, root: string = repoRoot): Record<string, string> {
  return {
    ...definedOnly(env),
    ARTIFACT_STORE: "fs",
    ARTIFACT_FS_ROOT: stackArtifactRoot(env, root),
    // 로컬 스택은 샘플 체험(`/demo`, T-505)을 연다. `pnpm demo:seed`가 같은 fs 스토어에 저장된 실행을 만든다.
    // `.env.example`을 복사한 `.env.local`의 `DEMO_MODE=false`(배포 기본값)가 덮어쓰지 않도록 Playwright 설정처럼 고정한다 (T-507)
    DEMO_MODE: "true",
  };
}

/** 워커 환경. 로컬 러너·fs 스토어·절대 경로 템플릿·헬스 포트를 고정하고 나머지는 상속한다 */
export function workerEnv(
  env: Env = process.env,
  root: string = repoRoot,
  ports: StackPorts = stackPorts(env),
): Record<string, string> {
  return {
    ...definedOnly(env),
    SANDBOX_RUNNER: "local",
    ARTIFACT_STORE: "fs",
    ARTIFACT_FS_ROOT: stackArtifactRoot(env, root),
    TEMPLATE_ROOT: stackTemplateRoot(root),
    PORT: String(ports.workerPort),
    WORKER_ID: env.WORKER_ID?.trim() || `stack-local-${process.pid}`,
    LOG_LEVEL: env.LOG_LEVEL?.trim() || "info",
  };
}

function definedOnly(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
}

/** 워커 실행 명령. 루트 `tsx`로 소스를 직접 실행하며 cwd는 `apps/worker`(dev 스크립트와 같다) */
export function workerCommand(root: string = repoRoot): CommandSpec {
  return {
    command: path.join(root, "node_modules", ".bin", "tsx"),
    args: [path.join(root, "apps", "worker", "src", "index.ts")],
    cwd: path.join(root, "apps", "worker"),
  };
}

/** 웹 dev 서버 실행 명령 (Playwright `webServer.command`와 같다) */
export function webCommand(port: number, root: string = repoRoot): CommandSpec {
  return {
    command: "pnpm",
    args: ["--filter", "@ohmyti/web", "dev", "--port", String(port)],
    cwd: root,
  };
}

export function workerHealthUrl(ports: StackPorts): string {
  return `http://localhost:${ports.workerPort}/healthz`;
}

export function webUrl(ports: StackPorts): string {
  return `http://localhost:${ports.webPort}/`;
}

/** 2xx 응답이면 true. 연결 실패·비정상 응답은 false */
export async function isHttpUp(url: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface WaitOptions {
  timeoutMs?: number | undefined;
  intervalMs?: number | undefined;
  /** 대기 중 프로세스가 죽었는지 확인한다. true를 돌려주면 즉시 실패한다 */
  exited?: (() => boolean) | undefined;
  label?: string | undefined;
}

/** `url`이 2xx를 돌려줄 때까지 기다린다. 상한을 넘기거나 프로세스가 먼저 끝나면 오류 */
export async function waitForHttp(url: string, options: WaitOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? STACK_DEFAULTS.readyTimeoutMs;
  const intervalMs = options.intervalMs ?? STACK_DEFAULTS.readyIntervalMs;
  const label = options.label ?? url;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (options.exited?.()) throw new Error(`${label} 프로세스가 준비되기 전에 끝났습니다`);
    if (await isHttpUp(url)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}이(가) ${timeoutMs}ms 안에 응답하지 않았습니다 (${url})`);
}

export interface ManagedProcess {
  name: string;
  child: ChildProcess;
  exited: () => boolean;
  exitCode: () => number | null;
  /** 프로세스 그룹 전체에 SIGTERM → 유예 뒤 SIGKILL */
  stop: (graceMs?: number) => Promise<void>;
}

/**
 * 자식 프로세스를 자체 프로세스 그룹으로 띄우고 출력에 `[name]` 접두사를 붙여 넘긴다.
 * 그룹 단위로 죽여야 `pnpm → next dev`처럼 중첩된 프로세스가 남지 않는다.
 */
export function spawnManaged(
  name: string,
  spec: CommandSpec,
  env: Record<string, string>,
  output: NodeJS.WritableStream = process.stdout,
): ManagedProcess {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let done = false;
  let code: number | null = null;
  child.once("exit", (exitCode) => {
    done = true;
    code = exitCode;
  });
  child.once("error", (error) => {
    done = true;
    output.write(`[${name}] 실행 오류: ${error.message}\n`);
  });
  const forward = (stream: NodeJS.ReadableStream | null) => {
    if (!stream) return;
    let rest = "";
    stream.on("data", (chunk: Buffer | string) => {
      rest += chunk.toString();
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) output.write(`[${name}] ${line}\n`);
    });
    stream.on("end", () => {
      if (rest) output.write(`[${name}] ${rest}\n`);
    });
  };
  forward(child.stdout);
  forward(child.stderr);

  const signalGroup = (signal: NodeJS.Signals) => {
    if (done || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // 이미 끝났다
      }
    }
  };

  return {
    name,
    child,
    exited: () => done,
    exitCode: () => code,
    stop: async (graceMs = STACK_DEFAULTS.stopGraceMs) => {
      if (done) return;
      const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      signalGroup("SIGTERM");
      const timer = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), graceMs),
      );
      if ((await Promise.race([exit, timer])) === "timeout") {
        signalGroup("SIGKILL");
        await exit;
      }
    },
  };
}

/** 워커를 띄우고 `/healthz`가 응답할 때까지 기다린다 */
export async function startWorker(options: {
  env?: Env | undefined;
  root?: string | undefined;
  ports?: StackPorts | undefined;
  output?: NodeJS.WritableStream | undefined;
  readyTimeoutMs?: number | undefined;
}): Promise<ManagedProcess> {
  const env = options.env ?? process.env;
  const root = options.root ?? repoRoot;
  const ports = options.ports ?? stackPorts(env);
  const proc = spawnManaged(
    "worker",
    workerCommand(root),
    workerEnv(env, root, ports),
    options.output,
  );
  try {
    await waitForHttp(workerHealthUrl(ports), {
      timeoutMs: options.readyTimeoutMs,
      exited: proc.exited,
      label: "worker",
    });
  } catch (error) {
    await proc.stop();
    throw error;
  }
  return proc;
}

/** 웹 dev 서버를 띄우고 `/`가 응답할 때까지 기다린다 */
export async function startWeb(options: {
  env?: Env | undefined;
  root?: string | undefined;
  ports?: StackPorts | undefined;
  output?: NodeJS.WritableStream | undefined;
  readyTimeoutMs?: number | undefined;
}): Promise<ManagedProcess> {
  const env = options.env ?? process.env;
  const root = options.root ?? repoRoot;
  const ports = options.ports ?? stackPorts(env);
  const proc = spawnManaged(
    "web",
    webCommand(ports.webPort, root),
    webEnv(env, root),
    options.output,
  );
  try {
    await waitForHttp(webUrl(ports), {
      timeoutMs: options.readyTimeoutMs,
      exited: proc.exited,
      label: "web",
    });
  } catch (error) {
    await proc.stop();
    throw error;
  }
  return proc;
}

/** 준비 단계(`pnpm db:migrate`·`pnpm db:seed:sample`)를 순서대로 실행한다. 실패하면 종료 코드와 함께 오류 */
export function runStep(
  name: string,
  spec: CommandSpec,
  env: Record<string, string>,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawnManaged(name, spec, env, output);
    proc.child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} 단계가 종료 코드 ${code}로 실패했습니다`));
    });
    proc.child.once("error", reject);
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      migrate: { type: "boolean", default: true },
      seed: { type: "boolean", default: true },
      "web-port": { type: "string" },
      "worker-port": { type: "string" },
    },
    strict: true,
    allowNegative: true,
  });
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL이 필요합니다 (.env.local 또는 환경변수)");
  }
  const ports = stackPorts(process.env, {
    ...(values["web-port"] ? { webPort: Number(values["web-port"]) } : {}),
    ...(values["worker-port"] ? { workerPort: Number(values["worker-port"]) } : {}),
  });
  const log = (line: string) => process.stdout.write(`[stack] ${line}\n`);
  log(`아티팩트 스토어(fs): ${stackArtifactRoot()}`);
  log(`템플릿 루트: ${stackTemplateRoot()}`);

  const stepEnv = webEnv();
  if (values.migrate) {
    log("db:migrate");
    await runStep("migrate", { command: "pnpm", args: ["db:migrate"], cwd: repoRoot }, stepEnv);
  }
  if (values.seed) {
    log("db:seed:sample (현재 하네스 버전의 샘플 과제 승인)");
    await runStep("seed", { command: "pnpm", args: ["db:seed:sample"], cwd: repoRoot }, stepEnv);
  }

  const procs: ManagedProcess[] = [];
  let stopping = false;
  let interrupted = false;
  const stopAll = async () => {
    if (stopping) return;
    stopping = true;
    log("종료합니다");
    await Promise.all(procs.map((p) => p.stop()));
  };
  const onSignal = () => {
    interrupted = true;
    void stopAll();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    if (await isHttpUp(workerHealthUrl(ports))) {
      log(`워커가 이미 ${workerHealthUrl(ports)}에서 응답합니다. 재사용합니다`);
    } else {
      procs.push(await startWorker({ ports }));
      log(`워커 준비: ${workerHealthUrl(ports)}`);
    }
    if (await isHttpUp(webUrl(ports))) {
      log(`웹이 이미 ${webUrl(ports)}에서 응답합니다. 재사용합니다`);
    } else {
      procs.push(await startWeb({ ports }));
      log(`웹 준비: ${webUrl(ports)}`);
    }
    if (procs.length === 0) {
      log("띄울 프로세스가 없습니다. 이미 떠 있는 스택을 사용하세요");
      return;
    }
    log("스택이 준비됐습니다. Ctrl+C로 종료합니다");
    // 어느 하나가 먼저 끝나면 나머지도 정리하고 그 종료 코드로 끝낸다
    const first = await Promise.race(
      procs.map(
        (p) => new Promise<ManagedProcess>((resolve) => p.child.once("exit", () => resolve(p))),
      ),
    );
    if (!interrupted) log(`${first.name} 프로세스가 먼저 끝났습니다 (code ${first.exitCode()})`);
    await stopAll();
    process.exitCode = interrupted ? 0 : (first.exitCode() ?? 1);
  } catch (error) {
    await stopAll();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`stack:local 오류: ${(error as Error).message}`);
    process.exit(1);
  });
}
