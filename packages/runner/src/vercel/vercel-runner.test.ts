/**
 * VercelSandboxRunner 테스트 (T-209). SDK 대신 `SandboxClient` 더블을 주입해 명령 순서, 설치 입력, teardown, 제한을 검증한다.
 * 실제 VM 검증은 `SANDBOX_RUNNER=vercel pnpm gate:phase1`(토큰 필요)이다.
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { ExecutionContractSchema, type ExecutionContract } from "@ohmyti/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LOCAL_RUNNER_DEFAULTS, VERCEL_RUNNER_DEFAULTS, type VercelRunnerConfig } from "../config";
import {
  BlockedCommandError,
  EnvironmentDestroyedError,
  RunnerEnvironmentError,
  ServiceStartError,
  SnapshotRejectedError,
} from "../runner";
import { TemplateManifestSchema, computeEnvironmentDigest } from "../template";
import {
  createTestWorkspace,
  packToStore,
  repoRoot,
  templateRoot,
  writeFiles,
  type TestWorkspace,
} from "../test-support/snapshots";
import type {
  CreateSandboxOptions,
  SandboxClient,
  SandboxCommandParams,
  SandboxHandle,
  SandboxNetworkPolicy,
  SandboxProcess,
} from "./client";
import { SANDBOX_SERVICE_PORT, VercelSandboxRunner } from "./vercel-runner";

/** 더블이 알려 주는 세션 작업 디렉터리 */
const SANDBOX_ROOT = "/vercel/sandbox";

const contract: ExecutionContract = ExecutionContractSchema.parse(
  JSON.parse(
    await readFile(path.join(repoRoot, "samples", "order-api", "execution-contract.json"), "utf8"),
  ),
);
const TEMPLATE_DIR = path.join(templateRoot, "order-api-ts");

/** 제출물: 템플릿과 다른 의존성·lockfile을 가진다. 어느 것도 설치 입력이 되면 안 된다 */
const SUBMISSION: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "submission",
    private: true,
    scripts: { start: "tsx src/server.ts", test: "vitest run" },
    dependencies: { express: "5.2.1", "left-pad": "1.3.0" },
  }),
  "package-lock.json": JSON.stringify({ name: "submission", lockfileVersion: 3, packages: {} }),
  "src/server.ts": "console.log('hi')",
  "tests/a.test.ts": "import { it } from 'vitest'; it('x', () => {});",
  "node_modules/left-pad/index.js": "module.exports = 1",
  "README.md": "# submission",
};

interface RecordedCommand extends SandboxCommandParams {
  detached: boolean;
}

interface FakeProcessControl {
  exit(code: number | null): void;
  readonly kills: string[];
  emitStdout(text: string): void;
  emitStderr(text: string): void;
}

interface FakeBehavior {
  /** 명령 결과를 정한다. 기본 exit 0 */
  onRun?: (params: SandboxCommandParams) => { exitCode: number; stdout?: string; stderr?: string };
  /** detached 프로세스가 뜨면 호출된다. 종료를 직접 제어할 수 있다 */
  onStart?: (params: SandboxCommandParams, control: FakeProcessControl) => void;
  /** writeFiles에서 예외를 낼 때 */
  failWriteFiles?: Error;
  /** create 자체가 실패할 때 */
  failCreate?: Error;
}

class FakeHandle implements SandboxHandle {
  readonly id: string;
  readonly cwd = SANDBOX_ROOT;
  readonly commands: RecordedCommand[] = [];
  readonly written: { path: string; content: Uint8Array }[] = [];
  readonly policies: SandboxNetworkPolicy[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly processes: FakeProcessControl[] = [];
  stopCalls = 0;

  constructor(
    id: string,
    private readonly behavior: FakeBehavior,
  ) {
    this.id = id;
  }

  domain(port: number): string {
    return `https://${this.id}-${port}.sandbox.test`;
  }

  runCommand(params: SandboxCommandParams): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    this.commands.push({ ...params, detached: false });
    const result = this.behavior.onRun?.(params) ?? { exitCode: 0 };
    if (params.cmd === "printenv" && !this.behavior.onRun) {
      return Promise.resolve({ exitCode: 0, stdout: "/usr/local/bin:/usr/bin:/bin\n", stderr: "" });
    }
    return Promise.resolve({
      exitCode: result.exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
  }

  startCommand(params: SandboxCommandParams): Promise<SandboxProcess> {
    this.commands.push({ ...params, detached: true });
    let resolveExit!: (exit: { exitCode: number | null }) => void;
    const exited = new Promise<{ exitCode: number | null }>((resolve) => {
      resolveExit = resolve;
    });
    const kills: string[] = [];
    const control: FakeProcessControl = {
      exit: (code) => resolveExit({ exitCode: code }),
      kills,
      emitStdout: (text) => params.onStdout?.(Buffer.from(text)),
      emitStderr: (text) => params.onStderr?.(Buffer.from(text)),
    };
    this.processes.push(control);
    const process: SandboxProcess = {
      wait: () => exited,
      // SIGTERM은 무시하고 SIGKILL에만 죽는 프로세스 (강제 종료 경로까지 검증한다)
      kill: (signal) => {
        kills.push(signal);
        if (signal === "SIGKILL") control.exit(137);
        return Promise.resolve();
      },
    };
    if (this.behavior.onStart) this.behavior.onStart(params, control);
    else control.exit(0);
    return Promise.resolve(process);
  }

  writeFiles(files: { path: string; content: Uint8Array; mode?: number }[]): Promise<void> {
    if (this.behavior.failWriteFiles) return Promise.reject(this.behavior.failWriteFiles);
    for (const f of files) {
      this.written.push({ path: f.path, content: f.content });
      this.files.set(f.path, f.content);
    }
    return Promise.resolve();
  }

  readFile(filePath: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(filePath) ?? null);
  }

  updateNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> {
    this.policies.push(policy);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    return Promise.resolve();
  }
}

class FakeClient implements SandboxClient {
  readonly created: { options: CreateSandboxOptions; handle: FakeHandle }[] = [];
  constructor(private readonly behavior: FakeBehavior = {}) {}
  create(options: CreateSandboxOptions): Promise<SandboxHandle> {
    if (this.behavior.failCreate) return Promise.reject(this.behavior.failCreate);
    const handle = new FakeHandle(`sbx-${this.created.length + 1}`, this.behavior);
    this.created.push({ options, handle });
    return Promise.resolve(handle);
  }
  get last(): FakeHandle {
    const entry = this.created[this.created.length - 1];
    if (!entry) throw new Error("샌드박스가 만들어지지 않았습니다");
    return entry.handle;
  }
}

let ws: TestWorkspace;
let snapshotKey: string;

/** 계약의 `npm start`인지 (템플릿 설치 `npm ci`와 구분) */
const isServiceStart = (params: SandboxCommandParams): boolean =>
  params.cmd === "npm" && params.args[0] === "start";
const cleanups: (() => Promise<void>)[] = [];

function config(overrides: Partial<VercelRunnerConfig> = {}): VercelRunnerConfig {
  return {
    ...LOCAL_RUNNER_DEFAULTS,
    ...VERCEL_RUNNER_DEFAULTS,
    templateRoot,
    workRoot: path.join(ws.root, "work"),
    credentials: { token: "tok", teamId: "team", projectId: "prj" },
    region: "icn1",
    runTimeoutMs: 5_000,
    killGraceMs: 100,
    installTimeoutMs: 2_000,
    ...overrides,
  };
}

function makeRunner(behavior: FakeBehavior = {}, overrides: Partial<VercelRunnerConfig> = {}) {
  const client = new FakeClient(behavior);
  const runner = new VercelSandboxRunner({
    config: config(overrides),
    artifactStore: ws.store,
    secrets: ["super-secret-value"],
    client,
  });
  return { runner, client };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function mirrorDirs(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const workRoot = path.join(ws.root, "work");
  if (!(await exists(workRoot))) return [];
  return (await readdir(workRoot)).filter((n) => n.startsWith("ohmyti-vercel-"));
}

beforeAll(async () => {
  ws = await createTestWorkspace();
  const dir = path.join(ws.root, "submission");
  await writeFiles(dir, SUBMISSION);
  snapshotKey = "snapshots/submission.tar.gz";
  // 제출물의 node_modules를 일부러 아카이브에 넣는다 (러너가 버려야 한다)
  await packToStore(ws.store, snapshotKey, dir, ["."], { exclude: [] });
  return async () => {
    await ws.cleanup();
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("prepare", () => {
  it("템플릿 package.json·lockfile만 올려 설치하고, 정리된 스냅샷을 풀고, 네트워크를 닫는다", async () => {
    const { runner, client } = makeRunner();
    const env = await runner.prepare(snapshotKey, contract, { logKeyPrefix: "gate/x/logs/" });
    cleanups.push(() => runner.destroy(env));
    const handle = client.last;

    // 생성 옵션: 일회성, 포트 노출, 설치 동안 네트워크 허용, 워커 환경변수 없음
    const created = client.created[0]!.options;
    expect(created.image).toBe("vercel/sandbox/node:22");
    expect(created.ports).toEqual([SANDBOX_SERVICE_PORT]);
    expect(created.networkPolicy).toBe("allow-all");
    expect(created.env).toEqual({});
    expect(created.credentials).toEqual({ token: "tok", teamId: "team", projectId: "prj" });
    expect(created.timeoutMs).toBe(VERCEL_RUNNER_DEFAULTS.sessionTimeoutMs);
    expect(created.region).toBe("icn1");

    // 템플릿 디렉터리에 올라간 파일은 템플릿의 package.json·package-lock.json 바이트 그대로다
    const templateWrites = handle.written.filter((w) =>
      w.path.startsWith(`${SANDBOX_ROOT}/template/`),
    );
    expect(templateWrites.map((w) => w.path).sort()).toEqual([
      `${SANDBOX_ROOT}/template/package-lock.json`,
      `${SANDBOX_ROOT}/template/package.json`,
    ]);
    const templatePackageJson = await readFile(path.join(TEMPLATE_DIR, "package.json"));
    const templateLock = await readFile(path.join(TEMPLATE_DIR, "package-lock.json"));
    expect(
      Buffer.from(templateWrites.find((w) => w.path.endsWith("/package.json"))!.content),
    ).toEqual(templatePackageJson);
    expect(
      Buffer.from(templateWrites.find((w) => w.path.endsWith("/package-lock.json"))!.content),
    ).toEqual(templateLock);
    // 제출물의 package.json·lockfile 내용은 어디에도 개별 파일로 올라가지 않는다
    for (const w of handle.written) {
      const text = Buffer.from(w.content).toString("utf8");
      expect(text).not.toContain("left-pad");
    }

    // 설치 명령은 매니페스트의 installCommand 그대로, cwd는 템플릿 디렉터리이며 한 번뿐이다
    const installs = handle.commands.filter((c) => c.cmd === "npm");
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      cmd: "npm",
      args: ["ci", "--no-audit", "--no-fund"],
      cwd: `${SANDBOX_ROOT}/template`,
      detached: true,
    });
    expect(installs[0]!.env).toMatchObject({
      HOME: `${SANDBOX_ROOT}/home`,
      NODE_ENV: "production",
    });

    // 순서: 설치 → root 소유·읽기 전용 → 스냅샷 풀기 → node_modules 링크 → deny-all
    const seq = handle.commands.map((c) => `${c.sudo ? "sudo " : ""}${c.cmd} ${c.args.join(" ")}`);
    const at = (needle: string) => seq.findIndex((s) => s.startsWith(needle));
    expect(at("npm ci")).toBeGreaterThan(at("mkdir -p"));
    expect(at("sudo chown -R root:root")).toBeGreaterThan(at("npm ci"));
    expect(at("sudo chmod -R go-w")).toBeGreaterThan(at("sudo chown"));
    expect(at("tar -xzf")).toBeGreaterThan(at("sudo chmod"));
    expect(at("ln -s")).toBeGreaterThan(at("tar -xzf"));
    expect(seq[at("ln -s")]).toBe(
      `ln -s ${SANDBOX_ROOT}/template/node_modules ${SANDBOX_ROOT}/work/node_modules`,
    );
    expect(handle.policies).toEqual(["deny-all"]);
    expect(handle.stopCalls).toBe(0);

    // 올라간 스냅샷에는 제출물의 node_modules가 없다
    const uploaded = handle.written.find((w) => w.path === `${SANDBOX_ROOT}/snapshot.tar.gz`)!;
    const tar = await import("tar");
    const entries: string[] = [];
    const { Readable } = await import("node:stream");
    await new Promise<void>((resolve, reject) => {
      Readable.from([Buffer.from(uploaded.content)])
        .pipe(tar.t({ onReadEntry: (e) => entries.push(e.path) }))
        .on("finish", resolve)
        .on("error", reject);
    });
    expect(entries.some((e) => e.includes("node_modules"))).toBe(false);
    expect(entries.some((e) => e.endsWith("src/server.ts"))).toBe(true);

    // PreparedEnv
    expect(env.kind).toBe("vercel");
    expect(env.rootDir).toBe(SANDBOX_ROOT);
    expect(env.workDir).toBe(`${SANDBOX_ROOT}/work`);
    expect(env.templateDir).toBe(`${SANDBOX_ROOT}/template`);
    expect(env.homeDir).toBe(`${SANDBOX_ROOT}/home`);
    expect(env.droppedNodeModules).toBe(true);
    expect(env.fileCount).toBe(5);
    expect(env.logKeyPrefix).toBe("gate/x/logs/");
    expect(await env.files!.listFiles()).toEqual([
      "README.md",
      "package-lock.json",
      "package.json",
      "src/server.ts",
      "tests/a.test.ts",
    ]);
    expect(await env.files!.readText("README.md")).toBe("# submission");

    // digest: 매니페스트는 local로 계산됐으므로 vercel 기준으로 다시 계산한 값
    const manifest = TemplateManifestSchema.parse(
      JSON.parse(await readFile(path.join(TEMPLATE_DIR, "template.json"), "utf8")),
    );
    expect(manifest.runnerKind).toBe("local");
    expect(env.environmentDigest).toBe(
      computeEnvironmentDigest({
        nodeVersion: manifest.nodeVersion,
        lockfileContent: templateLock.toString("utf8"),
        runnerKind: "vercel",
      }),
    );
    expect(env.environmentDigest).not.toBe(manifest.environmentDigest);
  });

  it("스냅샷이 거부되면 VM을 만들지 않는다", async () => {
    const dir = path.join(ws.root, "evil");
    await writeFiles(dir, { "ok.txt": "x" });
    const key = "snapshots/evil.tar.gz";
    await packToStore(ws.store, key, path.dirname(dir), ["evil/../evil/ok.txt"], {
      preservePaths: true,
    });
    const { runner, client } = makeRunner();
    await expect(runner.prepare(key, contract)).rejects.toBeInstanceOf(SnapshotRejectedError);
    expect(client.created).toHaveLength(0);
    expect(await mirrorDirs()).toEqual([]);
  });

  it("없는 스냅샷은 NOT_FOUND", async () => {
    const { runner, client } = makeRunner();
    await expect(runner.prepare("snapshots/none.tar.gz", contract)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(client.created).toHaveLength(0);
  });

  it("템플릿 설치가 실패하면 환경 오류이고 VM은 stop된다", async () => {
    const { runner, client } = makeRunner({
      onStart: (params, control) => {
        if (params.cmd === "npm") {
          control.emitStderr("npm ERR! super-secret-value network down\n");
          control.exit(1);
        } else control.exit(0);
      },
    });
    const error = await runner.prepare(snapshotKey, contract).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerEnvironmentError);
    expect((error as Error).message).toContain("exit 1");
    expect((error as Error).message).toContain("network down");
    expect((error as Error).message).not.toContain("super-secret-value");
    expect(client.last.stopCalls).toBe(1);
    expect(client.last.policies).toEqual([]);
    expect(await mirrorDirs()).toEqual([]);
  });

  it("템플릿 설치가 제한 시간을 넘기면 SIGTERM → SIGKILL 뒤 환경 오류이고 VM은 stop된다", async () => {
    const { runner, client } = makeRunner(
      {
        onStart: (params, control) => {
          if (params.cmd !== "npm") control.exit(0);
          // npm은 끝나지 않는다
        },
      },
      { installTimeoutMs: 200, killGraceMs: 50 },
    );
    const error = await runner.prepare(snapshotKey, contract).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerEnvironmentError);
    expect((error as Error).message).toContain("200ms 초과");
    const npm = client.last.processes[0]!;
    expect(npm.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(client.last.stopCalls).toBe(1);
  });

  it("파일 업로드 예외·준비 명령 실패에도 teardown이 호출된다", async () => {
    const upload = makeRunner({ failWriteFiles: new Error("upload boom") });
    await expect(upload.runner.prepare(snapshotKey, contract)).rejects.toThrow("upload boom");
    expect(upload.client.last.stopCalls).toBe(1);

    const tarFail = makeRunner({
      onRun: (params) =>
        params.cmd === "tar" ? { exitCode: 2, stderr: "tar: broken" } : { exitCode: 0 },
    });
    const error = await tarFail.runner.prepare(snapshotKey, contract).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerEnvironmentError);
    expect((error as Error).message).toContain("tar -xzf");
    expect(tarFail.client.last.stopCalls).toBe(1);
    expect(await mirrorDirs()).toEqual([]);
  });

  it("VM 생성 자체가 실패하면 미러 디렉터리를 남기지 않는다", async () => {
    const { runner, client } = makeRunner({ failCreate: new Error("quota") });
    await expect(runner.prepare(snapshotKey, contract)).rejects.toThrow("quota");
    expect(client.created).toHaveLength(0);
    expect(await mirrorDirs()).toEqual([]);
  });

  it("VM의 PATH를 읽지 못하면 대체 PATH를 쓴다", async () => {
    const { runner, client } = makeRunner({
      onRun: (params) => (params.cmd === "printenv" ? { exitCode: 1 } : { exitCode: 0 }),
    });
    const env = await runner.prepare(snapshotKey, contract);
    cleanups.push(() => runner.destroy(env));
    const result = await runner.runCommand(env, ["node", "-v"]);
    expect(result.exitCode).toBe(0);
    const cmd = client.last.commands.find((c) => c.cmd === "node" && c.detached)!;
    expect(cmd.env!.PATH).toBe(
      `${SANDBOX_ROOT}/template/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    );
  });
});

describe("runCommand", () => {
  it("화이트리스트 환경변수만 주고 프로그램을 템플릿 .bin으로 고정하며 파일을 환경 안에서만 읽는다", async () => {
    const { runner, client } = makeRunner({
      onStart: (params, control) => {
        control.emitStdout(`ran ${params.cmd} with super-secret-value\n`);
        control.exit(0);
      },
    });
    const env = await runner.prepare(snapshotKey, contract);
    cleanups.push(() => runner.destroy(env));
    const handle = client.last;
    handle.files.set(`${SANDBOX_ROOT}/test-results/out.json`, Buffer.from('{"ok":true}'));

    const result = await runner.runCommand(env, ["tsx", "src/server.ts"], {
      collectFiles: ["../test-results/out.json", "missing.json"],
      port: 4321,
      label: "cmd-a",
    });
    const cmd = handle.commands[handle.commands.length - 1]!;
    expect(cmd.cmd).toBe(`${SANDBOX_ROOT}/template/node_modules/.bin/tsx`);
    expect(cmd.args).toEqual(["src/server.ts"]);
    expect(cmd.cwd).toBe(`${SANDBOX_ROOT}/work`);
    expect(Object.keys(cmd.env!).sort()).toEqual([
      "HOME",
      "NODE_ENV",
      "NODE_OPTIONS",
      "PATH",
      "PORT",
    ]);
    expect(cmd.env).toMatchObject({
      HOME: `${SANDBOX_ROOT}/home`,
      NODE_ENV: "production",
      NODE_OPTIONS: `--max-old-space-size=${LOCAL_RUNNER_DEFAULTS.runMemoryMb}`,
      PORT: "4321",
      PATH: `${SANDBOX_ROOT}/template/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
    });
    expect(cmd.sudo).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.argv).toEqual(["tsx", "src/server.ts"]);
    expect(result.stdout).toBe(
      `ran ${SANDBOX_ROOT}/template/node_modules/.bin/tsx with [SECRET]\n`,
    );
    expect(result.files).toEqual([
      { path: "../test-results/out.json", bytes: Buffer.from('{"ok":true}') },
    ]);
    expect(result.logsRef).toEqual({
      stdout: `${env.logKeyPrefix}cmd-a/stdout.txt`,
      stderr: `${env.logKeyPrefix}cmd-a/stderr.txt`,
    });
    const stored = await ws.store.get(result.logsRef.stdout);
    expect(Buffer.from(stored!.body).toString("utf8")).toContain("[SECRET]");

    // node·npm은 이미지의 것을 PATH로 찾는다
    await runner.runCommand(env, ["node", "-e", "1"]);
    expect(handle.commands[handle.commands.length - 1]).toMatchObject({
      cmd: "node",
      args: ["-e", "1"],
    });
    // 슬래시가 든 경로는 환경 루트 안이어야 한다
    await expect(runner.runCommand(env, ["../../bin/sh"])).rejects.toBeInstanceOf(
      RunnerEnvironmentError,
    );
    await expect(
      runner.runCommand(env, ["node", "x"], { collectFiles: ["../../etc/passwd"] }),
    ).rejects.toBeInstanceOf(RunnerEnvironmentError);
  });

  it("설치 명령과 설치를 숨긴 스크립트는 VM에 보내기 전에 거부한다", async () => {
    const { runner, client } = makeRunner();
    const env = await runner.prepare(snapshotKey, contract);
    cleanups.push(() => runner.destroy(env));
    const before = client.last.commands.length;
    for (const argv of [
      ["npm", "install"],
      ["npm", "ci"],
      ["pnpm", "add", "x"],
      ["npx", "y"],
    ]) {
      await expect(runner.runCommand(env, argv)).rejects.toBeInstanceOf(BlockedCommandError);
    }
    expect(client.last.commands).toHaveLength(before);

    // prestart에 npm ci를 숨긴 제출물
    const dir = path.join(ws.root, "hidden");
    await writeFiles(dir, {
      "package.json": JSON.stringify({
        name: "hidden",
        scripts: { prestart: "npm ci", start: "node server.js" },
      }),
      "server.js": "",
    });
    const key = "snapshots/hidden.tar.gz";
    await packToStore(ws.store, key, dir);
    const env2 = await runner.prepare(key, contract);
    cleanups.push(() => runner.destroy(env2));
    const before2 = client.last.commands.length;
    await expect(runner.runCommand(env2, ["npm", "start"])).rejects.toBeInstanceOf(
      BlockedCommandError,
    );
    await expect(runner.startService(env2)).rejects.toBeInstanceOf(BlockedCommandError);
    expect(client.last.commands).toHaveLength(before2);
  });

  it("제한 시간을 넘기면 SIGTERM → SIGKILL 뒤 timedOut이며 종료 코드는 null", async () => {
    const { runner, client } = makeRunner(
      {
        onStart: (params, control) => {
          if (params.cmd === "node") return; // 무한 루프
          control.exit(0);
        },
      },
      { killGraceMs: 50 },
    );
    const env = await runner.prepare(snapshotKey, contract);
    cleanups.push(() => runner.destroy(env));
    const started = Date.now();
    const result = await runner.runCommand(env, ["node", "loop.js"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    const proc = client.last.processes[client.last.processes.length - 1]!;
    expect(proc.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stdout·stderr는 상한까지만 보관한다", async () => {
    const { runner } = makeRunner(
      {
        onStart: (params, control) => {
          if (params.cmd === "node") control.emitStdout("x".repeat(5_000));
          control.exit(0);
        },
      },
      { maxOutputBytes: 1024 },
    );
    const env = await runner.prepare(snapshotKey, contract);
    cleanups.push(() => runner.destroy(env));
    const result = await runner.runCommand(env, ["node", "big.js"]);
    expect(result.stdout).toHaveLength(1024);
    expect(result.stdoutTruncated).toBe(true);
  });
});

describe("startService", () => {
  function healthFetch(baseUrl: string, status = 200) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(url).toBe(`${baseUrl}${contract.healthPath}`);
      return Promise.resolve(new Response(status === 200 ? '{"status":"ok"}' : "", { status }));
    });
  }

  it("노출 포트로 띄우고 공개 URL의 /health 200을 기다린다. stop()은 프로세스를 종료하고 로그를 저장한다", async () => {
    const { runner, client } = makeRunner({
      onStart: (params, control) => {
        if (!isServiceStart(params)) control.exit(0);
        else control.emitStdout("order-api listening super-secret-value\n");
      },
    });
    const env = await runner.prepare(snapshotKey, contract);
    cleanups.push(() => runner.destroy(env));
    const handle = client.last;
    const baseUrl = handle.domain(SANDBOX_SERVICE_PORT);
    healthFetch(baseUrl);

    const service = await runner.startService(env, { label: "svc" });
    expect(service.baseUrl).toBe(baseUrl);
    expect(service.port).toBe(SANDBOX_SERVICE_PORT);
    expect(service.startup.outcome).toBe("HEALTHY");
    expect(service.startup.startCommand).toBe(contract.startCommand);
    expect(service.startup.lastHealthStatus).toBe(200);
    expect(service.isRunning()).toBe(true);
    const start = handle.commands[handle.commands.length - 1]!;
    expect(start).toMatchObject({ cmd: "npm", args: ["start"], cwd: `${SANDBOX_ROOT}/work` });
    expect(start.env!.PORT).toBe(String(SANDBOX_SERVICE_PORT));
    expect(start.env!.PATH!.startsWith(`${SANDBOX_ROOT}/template/node_modules/.bin:`)).toBe(true);

    // 서비스가 하나 떠 있는 동안 두 번째는 거부한다 (포트 하나)
    await expect(runner.startService(env)).rejects.toBeInstanceOf(RunnerEnvironmentError);

    const exit = await service.stop();
    expect(exit.stoppedByCaller).toBe(true);
    expect(exit.timedOut).toBe(false);
    expect(exit.stdout).toBe("order-api listening [SECRET]\n");
    const proc = handle.processes[handle.processes.length - 1]!;
    expect(proc.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(service.isRunning()).toBe(false);
    const stored = await ws.store.get(service.logsRef.stdout);
    expect(Buffer.from(stored!.body).toString("utf8")).toBe("order-api listening [SECRET]\n");
    expect(await service.stop()).toBe(exit);

    // 종료 뒤에는 다시 띄울 수 있다
    const again = await runner.startService(env);
    expect(again.startup.outcome).toBe("HEALTHY");
    await again.stop();
  });

  it("서비스가 /health 전에 죽으면 EXITED_BEFORE_HEALTHY, 응답이 없으면 HEALTH_TIMEOUT", async () => {
    const early = makeRunner({
      onStart: (params, control) => {
        if (isServiceStart(params)) {
          control.emitStderr("crash\n");
          control.exit(3);
        } else control.exit(0);
      },
    });
    const env1 = await early.runner.prepare(snapshotKey, contract);
    cleanups.push(() => early.runner.destroy(env1));
    healthFetch(early.client.last.domain(SANDBOX_SERVICE_PORT), 502);
    const e1 = await early.runner.startService(env1).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ServiceStartError);
    expect((e1 as ServiceStartError).startup.outcome).toBe("EXITED_BEFORE_HEALTHY");
    expect((e1 as ServiceStartError).stopped.exitCode).toBe(3);
    expect((e1 as ServiceStartError).stopped.stderr).toBe("crash\n");
    vi.restoreAllMocks();

    const slow = makeRunner(
      {
        onStart: (params, control) => {
          if (!isServiceStart(params)) control.exit(0);
        },
      },
      { healthTimeoutMs: 300, killGraceMs: 30 },
    );
    const env2 = await slow.runner.prepare(snapshotKey, contract);
    cleanups.push(() => slow.runner.destroy(env2));
    healthFetch(slow.client.last.domain(SANDBOX_SERVICE_PORT), 503);
    const e2 = await slow.runner.startService(env2).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(ServiceStartError);
    expect((e2 as ServiceStartError).startup.outcome).toBe("HEALTH_TIMEOUT");
    expect((e2 as ServiceStartError).startup.healthTimeoutMs).toBe(300);
    expect((e2 as ServiceStartError).startup.lastHealthStatus).toBe(503);
    expect((e2 as ServiceStartError).stopped.stoppedByCaller).toBe(true);
  });

  it("수명 제한이 지나면 러너가 종료하고 timedOut을 표시한다", async () => {
    const { runner, client } = makeRunner(
      {
        onStart: (params, control) => {
          if (!isServiceStart(params)) control.exit(0);
        },
      },
      { killGraceMs: 30 },
    );
    const env = await runner.prepare(snapshotKey, contract);
    cleanups.push(() => runner.destroy(env));
    healthFetch(client.last.domain(SANDBOX_SERVICE_PORT));
    const service = await runner.startService(env, { maxLifetimeMs: 150 });
    await new Promise((r) => setTimeout(r, 400));
    const exit = await service.stop();
    expect(exit.timedOut).toBe(true);
    expect(exit.stoppedByCaller).toBe(false);
  });
});

describe("destroy", () => {
  it("서비스·명령을 정리하고 VM을 stop하며 미러를 지운다. 이후 사용은 거부하고 재호출은 안전하다", async () => {
    const { runner, client } = makeRunner({
      onStart: (params, control) => {
        if (!isServiceStart(params)) control.exit(0);
      },
    });
    const env = await runner.prepare(snapshotKey, contract);
    expect(await mirrorDirs()).toHaveLength(1);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const service = await runner.startService(env);
    await runner.destroy(env);
    expect(client.last.stopCalls).toBe(1);
    expect(service.isRunning()).toBe(false);
    expect(await mirrorDirs()).toEqual([]);
    await expect(runner.runCommand(env, ["node", "x"])).rejects.toBeInstanceOf(
      EnvironmentDestroyedError,
    );
    await expect(runner.startService(env)).rejects.toBeInstanceOf(EnvironmentDestroyedError);
    await runner.destroy(env);
    expect(client.last.stopCalls).toBe(1);
  });

  it("프로세스 정리가 실패해도 VM은 stop된다", async () => {
    const { runner, client } = makeRunner({
      onStart: (params, control) => {
        if (!isServiceStart(params)) control.exit(0);
      },
    });
    const env = await runner.prepare(snapshotKey, contract);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const service = await runner.startService(env);
    vi.spyOn(service, "stop").mockRejectedValue(new Error("stop boom"));
    await expect(runner.destroy(env)).rejects.toThrow("stop boom");
    expect(client.last.stopCalls).toBe(1);
    expect(await mirrorDirs()).toEqual([]);
  });
});
