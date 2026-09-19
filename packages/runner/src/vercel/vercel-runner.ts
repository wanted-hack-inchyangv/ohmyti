/**
 * VercelSandboxRunner (TICKET.md 1.4, T-209): Firecracker 기반 Vercel Sandbox VM 하나를 환경 하나로 쓰는 격리 실행기.
 * 인터페이스는 `LocalProcessRunner`(T-108)와 같다.
 *
 * - `prepare`: 스냅샷을 워커에서 검증·정리(`unpackSnapshot`, node_modules 제거)한 뒤 다시 tar.gz로 묶어 VM에 올린다.
 *   템플릿의 `package.json`과 lockfile만 VM에 올려 `installCommand`(`npm ci`)를 실행하고, 설치가 끝나면 아웃바운드
 *   네트워크를 `deny-all`로 닫는다. 제출물의 lockfile·`package.json`으로 설치하는 경로는 없다.
 * - `startService`: 생성 시 노출한 포트로 서비스를 띄우고 공개 URL(`sandbox.domain(port)`)의 `/health`를 기다린다.
 *   워커의 하네스는 이 URL로 HTTPS 요청을 보낸다.
 * - 제한: 세션 제한 시간(`VERCEL_SANDBOX_TIMEOUT_MS`)과 vCPU 수가 환경 하나의 비용 상한이다. 명령·서비스 벽시계는
 *   `RUN_TIMEOUT_MS`. VM은 `destroy()`와 `prepare` 실패 경로에서 항상 `stop()`한다.
 * - 알려진 한계: 프로세스 신호는 명령 단위로 보내므로 손자 프로세스가 남을 수 있다. VM은 환경과 함께 사라지므로
 *   환경 밖으로 새지는 않는다. `pid`는 VM 안의 값이라 워커에서 의미가 없어 0이다.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { maskSensitive, type ExecutionContract } from "@ohmyti/core";
import { parseArtifactPrefix, type ArtifactStore } from "@ohmyti/storage";
import { LOCAL_RUNNER_DEFAULTS, VERCEL_RUNNER_DEFAULTS, type VercelRunnerConfig } from "../config";
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
import { assertCommandAllowed, assertScriptsAllowed, programName } from "../local/commands";
import { splitCommand } from "../local/local-runner";
import { waitForHealth } from "../local/net";
import { packDirectoryToTarGz } from "../local/pack";
import { BoundedBuffer } from "../local/process";
import { unpackSnapshot } from "../local/unpack";
import { directoryFiles } from "../submitted-tests/detect";
import {
  TemplateManifestSchema,
  computeEnvironmentDigest,
  type TemplateManifest,
} from "../template";
import {
  vercelSandboxClient,
  type SandboxClient,
  type SandboxHandle,
  type SandboxProcess,
} from "./client";

export interface VercelSandboxRunnerOptions {
  config: VercelRunnerConfig;
  artifactStore: ArtifactStore;
  /** 로그에서 반드시 가릴 값 (워커의 `collectSecrets()`) */
  secrets?: readonly string[];
  /** 테스트 더블 주입용. 기본 `vercelSandboxClient()` */
  client?: SandboxClient;
}

/** VM 안의 환경 루트. 세션의 기본 작업 디렉터리(`sandbox.cwd`)를 쓰며 그 아래에 `template/`·`work/`·`home/`을 만든다 */
/** 서비스가 바인드할 포트. 생성 시 노출하며 환경당 서비스는 한 번에 하나다 */
export const SANDBOX_SERVICE_PORT = 3000;
/** VM 기본 PATH를 읽지 못했을 때의 대체값 */
const FALLBACK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** `wait()`가 종료 통지를 주지 않을 때 SIGKILL 뒤 더 기다리는 시간 */
const KILL_SETTLE_MS = 10_000;

interface EnvState {
  destroyed: boolean;
  destroying: Promise<void> | null;
  handle: SandboxHandle;
  /** 워커 쪽 미러 디렉터리 (검증된 스냅샷 사본, package.json 검사·파일 접근자용) */
  mirrorDir: string;
  /** VM의 기본 PATH */
  basePath: string;
  serviceSeq: number;
  commandSeq: number;
  service: VercelRunningService | null;
  commands: Set<BoundedProcess>;
}

interface StoredLogs {
  stdout: string;
  stderr: string;
}

export class VercelSandboxRunner implements SandboxRunner {
  readonly kind = "vercel" as const;
  readonly config: VercelRunnerConfig;
  private readonly store: ArtifactStore;
  private readonly secrets: readonly string[];
  private readonly client: SandboxClient;
  private readonly envs = new Map<string, EnvState>();

  constructor(options: VercelSandboxRunnerOptions) {
    this.config = { ...LOCAL_RUNNER_DEFAULTS, ...VERCEL_RUNNER_DEFAULTS, ...options.config };
    this.store = options.artifactStore;
    this.secrets = options.secrets ?? [];
    this.client = options.client ?? vercelSandboxClient();
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

    // 1) 워커 쪽에서 검증·정리한다. 거부되면 VM을 만들지 않는다.
    await mkdir(this.config.workRoot, { recursive: true });
    const mirrorDir = await mkdtemp(path.join(this.config.workRoot, "ohmyti-vercel-"));
    const mirrorWork = path.join(mirrorDir, "work");
    let handle: SandboxHandle | null = null;
    try {
      const archiveFile = path.join(mirrorDir, "snapshot.tar.gz");
      await writeFile(archiveFile, snapshot.body);
      const unpacked = await unpackSnapshot(archiveFile, mirrorWork, {
        maxFiles: this.config.maxSourceFiles,
        maxBytes: this.config.maxSourceBytes,
        ...(options.stripComponents === undefined
          ? {}
          : { stripComponents: options.stripComponents }),
      });
      await rm(archiveFile, { force: true });
      // 제출물의 node_modules는 이미 풀리지 않았다. 정리된 사본을 다시 묶어 VM에 올린다.
      const cleanArchive = await packDirectoryToTarGz(mirrorWork);

      // 2) VM 생성. 템플릿 설치 동안만 네트워크를 연다.
      handle = await this.client.create({
        image: this.config.image,
        timeoutMs: this.config.sessionTimeoutMs,
        vcpus: this.config.vcpus,
        ports: [SANDBOX_SERVICE_PORT],
        region: this.config.region,
        networkPolicy: "allow-all",
        env: {},
        tags: { app: "ohmyti", env: envId },
        credentials: this.config.credentials,
      });
      const paths = remotePaths(handle.cwd);
      const basePath = await this.detectPath(handle);
      await this.exec(handle, ["mkdir", "-p", paths.templateDir, paths.workDir, paths.homeDir]);

      // 3) 템플릿 package.json + lockfile만 올려 설치한다. 제출물의 manifest는 여기에 관여하지 않는다.
      await handle.writeFiles([
        { path: `${paths.templateDir}/package.json`, content: template.packageJson },
        { path: `${paths.templateDir}/${template.manifest.lockfile}`, content: template.lockfile },
      ]);
      const installArgv = splitCommand(template.manifest.installCommand);
      const install = await this.runBounded(
        handle,
        {
          argv: installArgv,
          cwd: paths.templateDir,
          env: { PATH: basePath, HOME: paths.homeDir, NODE_ENV: "production" },
        },
        this.config.installTimeoutMs,
      );
      if (install.timedOut || install.exitCode !== 0) {
        throw new RunnerEnvironmentError(
          `템플릿 ${template.manifest.name} 설치(${template.manifest.installCommand})가 실패했습니다 (${
            install.timedOut ? `${this.config.installTimeoutMs}ms 초과` : `exit ${install.exitCode}`
          }): ${tail(this.mask(install.process.stderr.snapshot().text), 800)}`,
        );
      }
      // 템플릿은 root 소유·읽기 전용으로 둔다 (제출 코드가 고칠 수 없다)
      await this.exec(handle, ["chown", "-R", "root:root", paths.templateDir], { sudo: true });
      await this.exec(handle, ["chmod", "-R", "go-w", paths.templateDir], { sudo: true });

      // 4) 정리된 스냅샷을 풀고 템플릿 node_modules를 연결한다.
      const remoteArchive = `${paths.rootDir}/snapshot.tar.gz`;
      await handle.writeFiles([{ path: remoteArchive, content: cleanArchive }]);
      await this.exec(handle, ["tar", "-xzf", remoteArchive, "-C", paths.workDir]);
      await this.exec(handle, ["rm", "-f", remoteArchive]);
      await this.exec(handle, ["rm", "-rf", `${paths.workDir}/node_modules`]);
      await this.exec(handle, [
        "ln",
        "-s",
        `${paths.templateDir}/node_modules`,
        `${paths.workDir}/node_modules`,
      ]);

      // 5) 이후 제출 코드는 바깥으로 나갈 수 없다.
      await handle.updateNetworkPolicy("deny-all");

      const env: PreparedEnv = {
        id: envId,
        kind: this.kind,
        contract,
        workDir: paths.workDir,
        homeDir: paths.homeDir,
        rootDir: paths.rootDir,
        templateName: template.manifest.name,
        templateDir: paths.templateDir,
        environmentDigest: template.environmentDigest,
        logKeyPrefix,
        fileCount: unpacked.fileCount,
        totalBytes: unpacked.totalBytes,
        droppedNodeModules: unpacked.droppedNodeModules,
        createdAt: new Date().toISOString(),
        files: directoryFiles(mirrorWork),
      };
      this.envs.set(envId, {
        destroyed: false,
        destroying: null,
        handle,
        mirrorDir,
        basePath,
        serviceSeq: 0,
        commandSeq: 0,
        service: null,
        commands: new Set(),
      });
      return env;
    } catch (error) {
      // 어떤 단계에서 실패해도 VM과 미러를 남기지 않는다
      if (handle) await handle.stop().catch(() => undefined);
      await rm(mirrorDir, { recursive: true, force: true });
      throw error;
    }
  }

  async startService(env: PreparedEnv, options: StartServiceOptions = {}): Promise<RunningService> {
    const state = this.stateOf(env);
    if (state.service) {
      throw new RunnerEnvironmentError(
        `환경 ${env.id}에 이미 실행 중인 서비스가 있습니다 (포트 ${SANDBOX_SERVICE_PORT} 하나만 노출)`,
      );
    }
    const argv = splitCommand(env.contract.startCommand);
    await this.assertAllowed(state, argv);
    const port = SANDBOX_SERVICE_PORT;
    const healthTimeoutMs = Math.min(
      options.healthTimeoutMs ?? env.contract.healthTimeoutMs,
      this.config.healthTimeoutMs,
    );
    const maxLifetimeMs = options.maxLifetimeMs ?? this.config.runTimeoutMs;
    state.serviceSeq += 1;
    const label = options.label ?? `service-${state.serviceSeq}`;
    const logsRef = this.logsRef(env, label);
    const baseUrl = state.handle.domain(port);

    const process = await BoundedProcess.start(state.handle, {
      argv: this.resolveArgv(env, argv),
      cwd: env.workDir,
      env: this.childEnv(state, env, port),
      maxOutputBytes: this.config.maxOutputBytes,
    });
    const service = new VercelRunningService({
      runner: this,
      env,
      process,
      baseUrl,
      port,
      logsRef,
      maxLifetimeMs,
      onStopped: () => {
        if (state.service === service) state.service = null;
      },
    });
    state.service = service;

    const startedMs = Date.now();
    const health = await waitForHealth({
      url: `${baseUrl}${env.contract.healthPath}`,
      timeoutMs: healthTimeoutMs,
      intervalMs: 250,
      requestTimeoutMs: 5_000,
      shouldAbort: () => process.hasExited,
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
    const exitedEarly = process.hasExited;
    const stopped = await service.stop();
    const startup: ServiceStartupObservation = exitedEarly
      ? {
          ...base,
          outcome: "EXITED_BEFORE_HEALTHY",
          reason: `서비스가 ${env.contract.healthPath} 200 전에 종료됐습니다 (exit ${stopped.exitCode ?? "?"})`,
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
    await this.assertAllowed(state, argv);
    state.commandSeq += 1;
    const label = options.label ?? `command-${state.commandSeq}`;
    const logsRef = this.logsRef(env, label);
    const timeoutMs = options.timeoutMs ?? this.config.runTimeoutMs;
    const collectTargets = (options.collectFiles ?? []).map((p) => ({
      path: p,
      absolute: resolveInsideEnv(env, p),
    }));

    const startedAt = new Date();
    const process = await BoundedProcess.start(state.handle, {
      argv: this.resolveArgv(env, argv),
      cwd: env.workDir,
      env: this.childEnv(state, env, options.port),
      maxOutputBytes: this.config.maxOutputBytes,
    });
    state.commands.add(process);
    try {
      const exit = await process.waitOrKill(timeoutMs, this.config.killGraceMs);
      const finishedAt = new Date();
      const files = await this.collectFiles(state.handle, collectTargets);
      const stdout = this.mask(process.stdout.snapshot().text);
      const stderr = this.mask(process.stderr.snapshot().text);
      await this.storeLogs(logsRef, { stdout, stderr });
      return {
        argv: [...argv],
        exitCode: exit.timedOut ? null : exit.exitCode,
        signal: exit.timedOut ? "SIGKILL" : null,
        stdout,
        stderr,
        stdoutTruncated: process.stdout.snapshot().truncated,
        stderrTruncated: process.stderr.snapshot().truncated,
        timedOut: exit.timedOut,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        files,
        logsRef,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      };
    } finally {
      state.commands.delete(process);
    }
  }

  destroy(env: PreparedEnv): Promise<void> {
    const state = this.envs.get(env.id);
    if (!state) return Promise.resolve();
    if (state.destroying) return state.destroying;
    state.destroyed = true;
    state.destroying = (async () => {
      try {
        if (state.service) await state.service.stop();
        await Promise.all([...state.commands].map((p) => p.kill(0)));
        state.commands.clear();
      } finally {
        // 프로세스 정리에 실패해도 VM은 반드시 멈춘다
        await state.handle.stop();
        await rm(state.mirrorDir, { recursive: true, force: true });
      }
    })();
    return state.destroying;
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

  /** 차단 목록과 package.json 스크립트 본문을 검사한다. package.json은 워커 쪽 미러 사본을 읽는다 */
  private async assertAllowed(state: EnvState, argv: readonly string[]): Promise<void> {
    assertCommandAllowed(argv);
    const scripts = await readScripts(path.join(state.mirrorDir, "work", "package.json"));
    assertScriptsAllowed(argv, scripts);
  }

  /**
   * `node`·`npm`은 이미지의 것을 PATH로 찾고, 슬래시가 든 경로는 환경 루트 안이어야 하며,
   * 그 밖의 이름은 템플릿 `node_modules/.bin`의 것으로 고정한다 (제출물이 같은 이름을 둬도 가로채지 못한다).
   */
  private resolveArgv(env: PreparedEnv, argv: readonly string[]): string[] {
    const [first, ...rest] = argv;
    if (first === undefined) throw new BlockedCommandError(argv, "빈 명령");
    if (first.includes("/") || first.includes("\\")) {
      return [resolveInsideEnv(env, first), ...rest];
    }
    const name = programName(first);
    if (name === "node" || name === "npm") return [name, ...rest];
    return [`${env.templateDir}/node_modules/.bin/${name}`, ...rest];
  }

  private childEnv(
    state: EnvState,
    env: PreparedEnv,
    port: number | undefined,
  ): Record<string, string> {
    const child: Record<string, string> = {
      PATH: `${env.templateDir}/node_modules/.bin:${state.basePath}`,
      HOME: env.homeDir,
      NODE_ENV: "production",
      NODE_OPTIONS: `--max-old-space-size=${this.config.runMemoryMb}`,
    };
    if (port !== undefined) child.PORT = String(port);
    return child;
  }

  private async detectPath(handle: SandboxHandle): Promise<string> {
    const result = await handle.runCommand({ cmd: "printenv", args: ["PATH"], cwd: handle.cwd });
    const value = result.stdout.trim();
    return result.exitCode === 0 && value.length > 0 ? value : FALLBACK_PATH;
  }

  /** 준비 단계의 관리 명령. 실패하면 환경 오류다 */
  private async exec(
    handle: SandboxHandle,
    argv: string[],
    options: { sudo?: boolean } = {},
  ): Promise<void> {
    const [cmd, ...args] = argv as [string, ...string[]];
    const result = await handle.runCommand({
      cmd,
      args,
      cwd: handle.cwd,
      ...(options.sudo ? { sudo: true } : {}),
    });
    if (result.exitCode !== 0) {
      throw new RunnerEnvironmentError(
        `샌드박스 준비 명령 ${JSON.stringify(argv.join(" "))} 실패 (exit ${result.exitCode}): ${tail(
          this.mask(result.stderr || result.stdout),
          400,
        )}`,
      );
    }
  }

  private async runBounded(
    handle: SandboxHandle,
    params: { argv: string[]; cwd: string; env: Record<string, string> },
    timeoutMs: number,
  ): Promise<{ process: BoundedProcess; exitCode: number | null; timedOut: boolean }> {
    const process = await BoundedProcess.start(handle, {
      ...params,
      maxOutputBytes: this.config.maxOutputBytes,
    });
    const exit = await process.waitOrKill(timeoutMs, this.config.killGraceMs);
    return { process, ...exit };
  }

  private async collectFiles(
    handle: SandboxHandle,
    targets: readonly { path: string; absolute: string }[],
  ): Promise<CollectedFile[]> {
    const files: CollectedFile[] = [];
    for (const target of targets) {
      const bytes = await handle.readFile(target.absolute).catch(() => null);
      if (bytes !== null) files.push({ path: target.path, bytes });
    }
    return files;
  }

  private async loadTemplate(templateName: string): Promise<{
    manifest: TemplateManifest;
    packageJson: Uint8Array;
    lockfile: Uint8Array;
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
    let packageJson: Uint8Array;
    let lockfile: Uint8Array;
    try {
      packageJson = new Uint8Array(await readFile(path.join(dir, "package.json")));
      lockfile = new Uint8Array(await readFile(path.join(dir, manifest.lockfile)));
    } catch (error) {
      throw new RunnerEnvironmentError(
        `템플릿 ${templateName}의 package.json·${manifest.lockfile}을 읽을 수 없습니다: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let environmentDigest = manifest.environmentDigest;
    if (manifest.runnerKind !== this.kind) {
      // 템플릿 digest는 러너 종류를 포함한다. 매니페스트가 다른 러너로 계산됐으면 이 러너 기준으로 다시 계산한다.
      environmentDigest = computeEnvironmentDigest({
        nodeVersion: manifest.nodeVersion,
        lockfileContent: Buffer.from(lockfile).toString("utf8"),
        runnerKind: this.kind,
      });
    }
    return { manifest, packageJson, lockfile, environmentDigest };
  }
}

function remotePaths(rootDir: string): {
  rootDir: string;
  templateDir: string;
  workDir: string;
  homeDir: string;
} {
  if (!path.posix.isAbsolute(rootDir)) {
    throw new RunnerEnvironmentError(
      `샌드박스 작업 디렉터리 ${JSON.stringify(rootDir)}가 절대 경로가 아닙니다`,
    );
  }
  const root = path.posix.normalize(rootDir).replace(/\/+$/, "") || "/";
  return {
    rootDir: root,
    templateDir: `${root}/template`,
    workDir: `${root}/work`,
    homeDir: `${root}/home`,
  };
}

/** 상대 경로를 VM의 workDir 기준으로 풀되 환경 루트 밖이면 거부한다 (posix) */
function resolveInsideEnv(env: PreparedEnv, relative: string): string {
  const resolved = path.posix.resolve(env.workDir, relative.split("\\").join("/"));
  if (resolved !== env.rootDir && !resolved.startsWith(`${env.rootDir}/`)) {
    throw new RunnerEnvironmentError(`경로 ${JSON.stringify(relative)}은(는) 환경 루트 밖입니다`);
  }
  return resolved;
}

interface BoundedProcessInit {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  maxOutputBytes: number;
}

interface BoundedExit {
  exitCode: number | null;
  timedOut: boolean;
}

/** detached 명령 + 상한 버퍼 + 종료 대기·강제 종료 */
class BoundedProcess {
  readonly stdout: BoundedBuffer;
  readonly stderr: BoundedBuffer;
  readonly startedAtMs = Date.now();
  private exited: { exitCode: number | null } | null = null;
  private readonly exitPromise: Promise<{ exitCode: number | null }>;
  private killed: Promise<BoundedExit> | null = null;

  private constructor(
    private readonly process: SandboxProcess,
    stdout: BoundedBuffer,
    stderr: BoundedBuffer,
  ) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitPromise = process
      .wait()
      .then((exit) => ({ exitCode: exit.exitCode }))
      // 세션이 먼저 끝나 종료 코드를 받지 못한 경우
      .catch(() => ({ exitCode: null }))
      .then((exit) => {
        this.exited = exit;
        return exit;
      });
  }

  static async start(handle: SandboxHandle, init: BoundedProcessInit): Promise<BoundedProcess> {
    const [cmd, ...args] = init.argv as [string, ...string[]];
    const stdout = new BoundedBuffer(init.maxOutputBytes);
    const stderr = new BoundedBuffer(init.maxOutputBytes);
    const proc = await handle.startCommand({
      cmd,
      args,
      cwd: init.cwd,
      env: init.env,
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    });
    return new BoundedProcess(proc, stdout, stderr);
  }

  get hasExited(): boolean {
    return this.exited !== null;
  }

  get exitCode(): number | null {
    return this.exited?.exitCode ?? null;
  }

  waitForExit(): Promise<{ exitCode: number | null }> {
    return this.exitPromise;
  }

  /** 제한 시간 안에 끝나기를 기다리고, 넘기면 SIGTERM → 유예 → SIGKILL */
  async waitOrKill(timeoutMs: number, graceMs: number): Promise<BoundedExit> {
    const outcome = await Promise.race([
      this.exitPromise.then(() => "exit" as const),
      sleep(timeoutMs).then(() => "timeout" as const),
    ]);
    if (outcome === "exit") return { exitCode: this.exitCode, timedOut: false };
    const exit = await this.kill(graceMs);
    return { ...exit, timedOut: true };
  }

  /** SIGTERM 뒤 `graceMs` 안에 끝나지 않으면 SIGKILL. 여러 번 호출해도 같은 결과 */
  kill(graceMs: number): Promise<BoundedExit> {
    if (this.killed) return this.killed;
    this.killed = (async () => {
      if (this.exited) return { exitCode: this.exited.exitCode, timedOut: false };
      await this.process.kill("SIGTERM").catch(() => undefined);
      const graceful = await Promise.race([
        this.exitPromise.then(() => true),
        sleep(graceMs).then(() => false),
      ]);
      if (!graceful) {
        await this.process.kill("SIGKILL").catch(() => undefined);
        await Promise.race([this.exitPromise, sleep(KILL_SETTLE_MS)]);
      }
      return { exitCode: this.exitCode, timedOut: false };
    })();
    return this.killed;
  }
}

interface VercelRunningServiceInit {
  runner: VercelSandboxRunner;
  env: PreparedEnv;
  process: BoundedProcess;
  baseUrl: string;
  port: number;
  logsRef: ServiceLogsRef;
  maxLifetimeMs: number;
  onStopped: () => void;
}

class VercelRunningService implements RunningService {
  readonly baseUrl: string;
  readonly port: number;
  /** VM 안의 pid는 워커에서 의미가 없다 */
  readonly pid = 0;
  readonly logsRef: ServiceLogsRef;
  startup: ServiceStartupObservation;
  private readonly runner: VercelSandboxRunner;
  private readonly process: BoundedProcess;
  private readonly startedAt: Date;
  private readonly lifetimeTimer: NodeJS.Timeout;
  private timedOut = false;
  private stoppedByCaller = false;
  private stopping: Promise<ProcessExit> | null = null;
  private readonly onStopped: () => void;

  constructor(init: VercelRunningServiceInit) {
    this.runner = init.runner;
    this.process = init.process;
    this.baseUrl = init.baseUrl;
    this.port = init.port;
    this.logsRef = init.logsRef;
    this.onStopped = init.onStopped;
    this.startedAt = new Date(init.process.startedAtMs);
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
    void this.process.waitForExit().then(() => this.finish());
  }

  isRunning(): boolean {
    return !this.process.hasExited;
  }

  stop(): Promise<ProcessExit> {
    if (!this.process.hasExited) this.stoppedByCaller = true;
    return this.finish();
  }

  private finish(): Promise<ProcessExit> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      clearTimeout(this.lifetimeTimer);
      const exit = await this.process.kill(this.runner.killGraceMs);
      const finishedAt = new Date();
      const stdout = this.runner.mask(this.process.stdout.snapshot().text);
      const stderr = this.runner.mask(this.process.stderr.snapshot().text);
      await this.runner.storeServiceLogs(this.logsRef, { stdout, stderr });
      this.onStopped();
      return {
        exitCode: exit.exitCode,
        signal: null,
        timedOut: this.timedOut,
        stoppedByCaller: this.stoppedByCaller,
        stdout,
        stderr,
        stdoutTruncated: this.process.stdout.snapshot().truncated,
        stderrTruncated: this.process.stderr.snapshot().truncated,
        durationMs: finishedAt.getTime() - this.startedAt.getTime(),
        startedAt: this.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      };
    })();
    return this.stopping;
  }
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

function tail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}
