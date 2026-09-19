/**
 * LocalProcessRunner (TICKET.md 1.4, T-108): 워커 컨테이너 안에서 비관리자 사용자로 자식 프로세스를 띄우는 MVP 격리 실행기.
 *
 * - 일회성 임시 디렉터리(`<workRoot>/ohmyti-sandbox-*`)에 스냅샷을 풀고, 템플릿 `node_modules`를 심볼릭 링크로 연결한다.
 * - 자식에게는 화이트리스트 환경변수만 준다: `PATH`, `HOME`, `NODE_ENV=production`, `PORT`(서비스·요청 시), `NODE_OPTIONS`(메모리 상한).
 * - 벽시계 제한이 지나면 프로세스 그룹 전체를 종료한다. stdout·stderr는 마스킹·상한 적용 후 ArtifactStore에 저장한다.
 * - 알려진 한계: 컨테이너 권한 없이는 아웃바운드 네트워크를 OS 수준에서 차단할 수 없다 (README).
 */
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { maskSensitive, type ExecutionContract } from "@ohmyti/core";
import { parseArtifactPrefix, type ArtifactStore } from "@ohmyti/storage";
import { LOCAL_RUNNER_DEFAULTS, type LocalRunnerConfig } from "../config";
import {
  BlockedCommandError,
  EnvironmentDestroyedError,
  RunnerEnvironmentError,
  ServiceStartError,
  SnapshotRejectedError,
  type CollectedFile,
  type CommandOptions,
  type CommandResult,
  type PrepareOptions,
  type PreparedEnv,
  type ProcessExit,
  type RunningService,
  type SandboxRunner,
  type ServiceLogsRef,
  type ServiceStartupObservation,
  type StartServiceOptions,
} from "../runner";
import {
  TemplateManifestSchema,
  computeEnvironmentDigest,
  type TemplateManifest,
} from "../template";
import { assertCommandAllowed, assertScriptsAllowed, programName } from "./commands";
import { findFreePort, waitForHealth } from "./net";
import { ProcessGroup, type ProcessGroupExit } from "./process";
import { unpackSnapshot } from "./unpack";

export interface LocalProcessRunnerOptions {
  config: LocalRunnerConfig;
  artifactStore: ArtifactStore;
  /** 로그에서 반드시 가릴 값 (워커의 `collectSecrets()`) */
  secrets?: readonly string[];
}

/** 자식에게 전달하는 환경변수 이름. 이 밖의 워커 환경변수는 어떤 것도 넘기지 않는다. */
export const CHILD_ENV_WHITELIST = ["PATH", "HOME", "NODE_ENV", "PORT", "NODE_OPTIONS"] as const;

interface EnvState {
  destroyed: boolean;
  serviceSeq: number;
  commandSeq: number;
  services: Set<LocalRunningService>;
  commands: Set<ProcessGroup>;
}

interface StoredLogs {
  stdout: string;
  stderr: string;
}

export class LocalProcessRunner implements SandboxRunner {
  readonly kind = "local" as const;
  readonly config: LocalRunnerConfig;
  private readonly store: ArtifactStore;
  private readonly secrets: readonly string[];
  private readonly envs = new Map<string, EnvState>();

  constructor(options: LocalProcessRunnerOptions) {
    this.config = { ...LOCAL_RUNNER_DEFAULTS, ...options.config };
    this.store = options.artifactStore;
    this.secrets = options.secrets ?? [];
  }

  async prepare(
    snapshotRef: string,
    contract: ExecutionContract,
    options: PrepareOptions = {},
  ): Promise<PreparedEnv> {
    const template = await this.loadTemplate(contract.templateName);
    const envId = `env-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const logKeyPrefix = options.logKeyPrefix ?? `sandbox/${envId}/`;
    parseArtifactPrefix(logKeyPrefix);

    const snapshot = await this.store.get(snapshotRef);
    if (snapshot === null) {
      throw new SnapshotRejectedError("NOT_FOUND", null, `스냅샷 ${snapshotRef}이(가) 없습니다`);
    }

    await mkdir(this.config.workRoot, { recursive: true });
    const rootDir = await mkdtemp(path.join(this.config.workRoot, "ohmyti-sandbox-"));
    const workDir = path.join(rootDir, "work");
    const homeDir = path.join(rootDir, "home");
    try {
      await mkdir(workDir);
      await mkdir(homeDir);
      const archiveFile = path.join(rootDir, "snapshot.tar.gz");
      await writeFile(archiveFile, snapshot.body);
      const unpacked = await unpackSnapshot(archiveFile, workDir, {
        maxFiles: this.config.maxSourceFiles,
        maxBytes: this.config.maxSourceBytes,
        ...(options.stripComponents === undefined
          ? {}
          : { stripComponents: options.stripComponents }),
      });
      await rm(archiveFile, { force: true });

      // 제출물의 node_modules는 어떤 형태로든 쓰지 않는다. 템플릿의 것을 연결한다.
      const nodeModules = path.join(workDir, "node_modules");
      await rm(nodeModules, { recursive: true, force: true });
      await symlink(template.nodeModulesDir, nodeModules, "dir");

      const env: PreparedEnv = {
        id: envId,
        kind: this.kind,
        contract,
        workDir,
        homeDir,
        rootDir,
        templateName: template.manifest.name,
        templateDir: template.dir,
        environmentDigest: template.environmentDigest,
        logKeyPrefix,
        fileCount: unpacked.fileCount,
        totalBytes: unpacked.totalBytes,
        droppedNodeModules: unpacked.droppedNodeModules,
        createdAt: new Date().toISOString(),
      };
      this.envs.set(envId, {
        destroyed: false,
        serviceSeq: 0,
        commandSeq: 0,
        services: new Set(),
        commands: new Set(),
      });
      return env;
    } catch (error) {
      await rm(rootDir, { recursive: true, force: true });
      throw error;
    }
  }

  async startService(env: PreparedEnv, options: StartServiceOptions = {}): Promise<RunningService> {
    const state = this.stateOf(env);
    const argv = splitCommand(env.contract.startCommand);
    await this.assertAllowed(env, argv);
    const port = await findFreePort();
    const healthTimeoutMs = Math.min(
      options.healthTimeoutMs ?? env.contract.healthTimeoutMs,
      this.config.healthTimeoutMs,
    );
    const maxLifetimeMs = options.maxLifetimeMs ?? this.config.runTimeoutMs;
    state.serviceSeq += 1;
    const label = options.label ?? `service-${state.serviceSeq}`;
    const logsRef = this.logsRef(env, label);
    const baseUrl = `http://127.0.0.1:${port}`;

    const group = ProcessGroup.start({
      argv: await this.resolveArgv(env, argv),
      cwd: env.workDir,
      env: this.childEnv(env, port),
      maxOutputBytes: this.config.maxOutputBytes,
    });
    const service = new LocalRunningService({
      runner: this,
      env,
      group,
      baseUrl,
      port,
      logsRef,
      maxLifetimeMs,
      onStopped: () => state.services.delete(service),
    });
    state.services.add(service);

    const startedMs = Date.now();
    const health = await waitForHealth({
      url: `${baseUrl}${env.contract.healthPath}`,
      timeoutMs: healthTimeoutMs,
      shouldAbort: () => group.leaderHasExited,
    });
    const base = {
      startCommand: env.contract.startCommand,
      port,
      healthPath: env.contract.healthPath,
      healthTimeoutMs,
      elapsedMs: Date.now() - startedMs,
      lastHealthStatus: health.lastStatus,
      healthAttempts: health.attempts,
    };
    if (health.healthy) {
      service.startup = { ...base, outcome: "HEALTHY" };
      return service;
    }
    const exitedEarly = group.leaderHasExited;
    const stopped = await service.stop();
    const startup: ServiceStartupObservation = group.error
      ? {
          ...base,
          outcome: "START_FAILED",
          reason: `시작 명령을 실행할 수 없습니다: ${group.error.message}`,
        }
      : exitedEarly
        ? {
            ...base,
            outcome: "EXITED_BEFORE_HEALTHY",
            reason: `서비스가 ${env.contract.healthPath} 200 전에 종료됐습니다 (exit ${stopped.exitCode ?? stopped.signal ?? "?"})`,
          }
        : {
            ...base,
            outcome: "HEALTH_TIMEOUT",
            reason: `${healthTimeoutMs}ms 안에 ${env.contract.healthPath}가 200을 주지 않았습니다 (마지막 상태 ${health.lastStatus ?? "응답 없음"})`,
          };
    throw new ServiceStartError(startup, logsRef, stopped);
  }

  async runCommand(
    env: PreparedEnv,
    argv: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const state = this.stateOf(env);
    await this.assertAllowed(env, argv);
    state.commandSeq += 1;
    const label = options.label ?? `command-${state.commandSeq}`;
    const logsRef = this.logsRef(env, label);
    const timeoutMs = options.timeoutMs ?? this.config.runTimeoutMs;
    const collectTargets = (options.collectFiles ?? []).map((p) => ({
      path: p,
      absolute: this.resolveInsideEnv(env, p),
    }));

    const startedAt = new Date();
    const group = ProcessGroup.start({
      argv: await this.resolveArgv(env, argv),
      cwd: env.workDir,
      env: this.childEnv(env, options.port),
      maxOutputBytes: this.config.maxOutputBytes,
    });
    state.commands.add(group);
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    try {
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const outcome = await Promise.race([group.waitForLeaderExit(), timeout]);
      if (outcome === "timeout") {
        timedOut = true;
      }
      // 리더가 끝났어도 손자가 남아 파이프를 쥐고 있을 수 있다. 그룹 전체를 정리하고 close를 기다린다.
      const exit = await group.kill(timedOut ? this.config.killGraceMs : 0);
      const finishedAt = new Date();
      const files = await collectFiles(collectTargets);
      const stdout = this.mask(group.stdout.snapshot().text);
      const stderr = this.mask(group.stderr.snapshot().text);
      await this.storeLogs(logsRef, { stdout, stderr });
      return {
        argv: [...argv],
        exitCode: timedOut ? null : exit.exitCode,
        signal: exit.signal,
        stdout,
        stderr,
        stdoutTruncated: group.stdout.snapshot().truncated,
        stderrTruncated: group.stderr.snapshot().truncated,
        timedOut,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        files,
        logsRef,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      };
    } finally {
      if (timer) clearTimeout(timer);
      state.commands.delete(group);
    }
  }

  async destroy(env: PreparedEnv): Promise<void> {
    const state = this.envs.get(env.id);
    if (state) {
      state.destroyed = true;
      await Promise.all([...state.services].map((s) => s.stop()));
      await Promise.all([...state.commands].map((g) => g.kill(0)));
      state.services.clear();
      state.commands.clear();
    }
    await rm(env.rootDir, { recursive: true, force: true });
  }

  /** 러너 내부용: 서비스 종료 시 로그 저장 */
  async storeServiceLogs(logsRef: ServiceLogsRef, logs: StoredLogs): Promise<void> {
    await this.storeLogs(logsRef, logs);
  }

  mask(text: string): string {
    return maskSensitive(text, this.secrets);
  }

  get killGraceMs(): number {
    return this.config.killGraceMs;
  }

  private stateOf(env: PreparedEnv): EnvState {
    const state = this.envs.get(env.id);
    if (!state || state.destroyed) throw new EnvironmentDestroyedError(env.id);
    return state;
  }

  private logsRef(env: PreparedEnv, label: string): ServiceLogsRef {
    if (!/^[A-Za-z0-9._-]+$/.test(label)) {
      throw new RunnerEnvironmentError(
        `로그 이름 ${JSON.stringify(label)}은 키 세그먼트로 쓸 수 없습니다`,
      );
    }
    return {
      stdout: `${env.logKeyPrefix}${label}/stdout.txt`,
      stderr: `${env.logKeyPrefix}${label}/stderr.txt`,
    };
  }

  private async storeLogs(logsRef: ServiceLogsRef, logs: StoredLogs): Promise<void> {
    const contentType = "text/plain; charset=utf-8";
    await this.store.put(logsRef.stdout, logs.stdout, { contentType });
    await this.store.put(logsRef.stderr, logs.stderr, { contentType });
  }

  /** 차단 목록과 package.json 스크립트 본문을 검사한다 */
  private async assertAllowed(env: PreparedEnv, argv: readonly string[]): Promise<void> {
    assertCommandAllowed(argv);
    const scripts = await readScripts(path.join(env.workDir, "package.json"));
    assertScriptsAllowed(argv, scripts);
  }

  /**
   * 프로그램을 절대 경로로 바꾼다. `npm`·`node`는 워커와 같은 Node 런타임의 것, 그 밖의 이름은
   * 템플릿 `node_modules/.bin`에서 찾는다. 슬래시가 든 경로는 환경 루트 안이어야 한다.
   */
  private async resolveArgv(env: PreparedEnv, argv: readonly string[]): Promise<string[]> {
    const [first, ...rest] = argv;
    if (first === undefined) throw new BlockedCommandError(argv, "빈 명령");
    if (first.includes("/") || first.includes("\\")) {
      return [this.resolveInsideEnv(env, first), ...rest];
    }
    const name = programName(first);
    if (name === "node") return [process.execPath, ...rest];
    if (name === "npm") return [await this.npmPath(), ...rest];
    const templateBin = path.join(env.templateDir, "node_modules", ".bin", name);
    if (await exists(templateBin)) return [templateBin, ...rest];
    const nodeBin = path.join(path.dirname(process.execPath), name);
    if (await exists(nodeBin)) return [nodeBin, ...rest];
    throw new RunnerEnvironmentError(
      `프로그램 ${JSON.stringify(first)}을(를) 템플릿 node_modules/.bin과 Node 런타임에서 찾지 못했습니다`,
    );
  }

  private async npmPath(): Promise<string> {
    const candidate = path.join(path.dirname(process.execPath), "npm");
    if (await exists(candidate)) return candidate;
    throw new RunnerEnvironmentError(`npm을 찾지 못했습니다 (${candidate})`);
  }

  private childEnv(env: PreparedEnv, port: number | undefined): Record<string, string> {
    const pathEntries = [
      path.dirname(process.execPath),
      path.join(env.templateDir, "node_modules", ".bin"),
      "/usr/bin",
      "/bin",
    ];
    const child: Record<string, string> = {
      PATH: pathEntries.join(path.delimiter),
      HOME: env.homeDir,
      NODE_ENV: "production",
      NODE_OPTIONS: `--max-old-space-size=${this.config.runMemoryMb}`,
    };
    if (port !== undefined) child.PORT = String(port);
    return child;
  }

  /** 상대 경로를 workDir 기준으로 풀되 환경 루트 밖이면 거부한다 */
  private resolveInsideEnv(env: PreparedEnv, relative: string): string {
    const resolved = path.resolve(env.workDir, relative);
    if (resolved !== env.rootDir && !resolved.startsWith(env.rootDir + path.sep)) {
      throw new RunnerEnvironmentError(`경로 ${JSON.stringify(relative)}은(는) 환경 루트 밖입니다`);
    }
    return resolved;
  }

  private async loadTemplate(templateName: string): Promise<{
    dir: string;
    nodeModulesDir: string;
    manifest: TemplateManifest;
    environmentDigest: string;
  }> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(templateName)) {
      throw new RunnerEnvironmentError(
        `템플릿 이름 ${JSON.stringify(templateName)}이(가) 올바르지 않습니다`,
      );
    }
    const dir = path.resolve(this.config.templateRoot, templateName);
    let manifest: TemplateManifest;
    try {
      const raw = await readFile(path.join(dir, "template.json"), "utf8");
      manifest = TemplateManifestSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new RunnerEnvironmentError(
        `템플릿 ${templateName}의 template.json을 읽을 수 없습니다 (${dir}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const nodeModulesDir = path.join(dir, "node_modules");
    if (!(await exists(nodeModulesDir))) {
      throw new RunnerEnvironmentError(
        `템플릿 ${templateName}의 node_modules가 없습니다 (${nodeModulesDir}). pnpm template:build를 먼저 실행하세요`,
      );
    }
    let environmentDigest = manifest.environmentDigest;
    if (manifest.runnerKind !== this.kind) {
      // 템플릿 digest는 러너 종류를 포함한다. 매니페스트가 다른 러너로 계산됐으면 이 러너 기준으로 다시 계산한다.
      const lockfileContent = await readFile(path.join(dir, manifest.lockfile), "utf8");
      environmentDigest = computeEnvironmentDigest({
        nodeVersion: manifest.nodeVersion,
        lockfileContent,
        runnerKind: this.kind,
      });
    }
    return { dir, nodeModulesDir, manifest, environmentDigest };
  }
}

interface LocalRunningServiceInit {
  runner: LocalProcessRunner;
  env: PreparedEnv;
  group: ProcessGroup;
  baseUrl: string;
  port: number;
  logsRef: ServiceLogsRef;
  maxLifetimeMs: number;
  onStopped: () => void;
}

class LocalRunningService implements RunningService {
  readonly baseUrl: string;
  readonly port: number;
  readonly pid: number;
  readonly logsRef: ServiceLogsRef;
  startup: ServiceStartupObservation;
  private readonly runner: LocalProcessRunner;
  private readonly group: ProcessGroup;
  private readonly startedAt: Date;
  private readonly lifetimeTimer: NodeJS.Timeout;
  private timedOut = false;
  private stoppedByCaller = false;
  private stopping: Promise<ProcessExit> | null = null;
  private readonly onStopped: () => void;

  constructor(init: LocalRunningServiceInit) {
    this.runner = init.runner;
    this.group = init.group;
    this.baseUrl = init.baseUrl;
    this.port = init.port;
    this.pid = init.group.pid;
    this.logsRef = init.logsRef;
    this.onStopped = init.onStopped;
    this.startedAt = new Date(init.group.startedAtMs);
    this.startup = {
      outcome: "START_FAILED",
      startCommand: init.env.contract.startCommand,
      port: init.port,
      healthPath: init.env.contract.healthPath,
      healthTimeoutMs: 0,
      elapsedMs: 0,
      lastHealthStatus: null,
      healthAttempts: 0,
    };
    this.lifetimeTimer = setTimeout(() => {
      this.timedOut = true;
      void this.finish();
    }, init.maxLifetimeMs);
    this.lifetimeTimer.unref();
    // 서비스가 스스로 죽어도 로그를 남긴다
    void this.group.waitForExit().then(() => this.finish());
  }

  isRunning(): boolean {
    return !this.group.hasExited;
  }

  stop(): Promise<ProcessExit> {
    if (!this.group.hasExited) this.stoppedByCaller = true;
    return this.finish();
  }

  private finish(): Promise<ProcessExit> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      clearTimeout(this.lifetimeTimer);
      const exit: ProcessGroupExit = await this.group.kill(this.runner.killGraceMs);
      const finishedAt = new Date();
      const stdout = this.runner.mask(this.group.stdout.snapshot().text);
      const stderr = this.runner.mask(this.group.stderr.snapshot().text);
      await this.runner.storeServiceLogs(this.logsRef, { stdout, stderr });
      this.onStopped();
      return {
        exitCode: exit.exitCode,
        signal: exit.signal,
        timedOut: this.timedOut,
        stoppedByCaller: this.stoppedByCaller,
        stdout,
        stderr,
        stdoutTruncated: this.group.stdout.snapshot().truncated,
        stderrTruncated: this.group.stderr.snapshot().truncated,
        durationMs: finishedAt.getTime() - this.startedAt.getTime(),
        startedAt: this.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      };
    })();
    return this.stopping;
  }
}

/** `npm start` 같은 계약 명령을 공백으로 나눈다. 따옴표·셸 문법은 지원하지 않는다 (계약은 단순 명령만 허용). */
export function splitCommand(command: string): string[] {
  const argv = command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (argv.length === 0) throw new BlockedCommandError([command], "빈 시작 명령");
  if (/["'`$|&;<>()]/.test(command)) {
    throw new BlockedCommandError(argv, "시작 명령에 셸 문법은 허용하지 않습니다");
  }
  return argv;
}

async function readScripts(packageJsonPath: string): Promise<Record<string, string> | undefined> {
  let raw: string;
  try {
    raw = await readFile(packageJsonPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return undefined;
    const out: Record<string, string> = {};
    for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof body === "string") out[name] = body;
    }
    return out;
  } catch {
    return undefined;
  }
}

async function collectFiles(
  targets: readonly { path: string; absolute: string }[],
): Promise<CollectedFile[]> {
  const files: CollectedFile[] = [];
  for (const target of targets) {
    try {
      files.push({ path: target.path, bytes: new Uint8Array(await readFile(target.absolute)) });
    } catch {
      // 없는 파일은 결과에 넣지 않는다
    }
  }
  return files;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
