import { createServer, type Server } from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  isHttpUp,
  spawnManaged,
  STACK_DEFAULTS,
  stackArtifactRoot,
  stackPorts,
  stackTemplateRoot,
  waitForHttp,
  webCommand,
  webEnv,
  workerCommand,
  workerEnv,
  workerHealthUrl,
  webUrl,
} from "./stack-local";

const ROOT = "/repo";

describe("stackPorts", () => {
  it("기본값은 웹 4310·워커 4320이고 환경변수·인자로 바꾼다", () => {
    expect(stackPorts({})).toEqual({ webPort: 4310, workerPort: 4320 });
    expect(stackPorts({ E2E_PORT: "5000", E2E_WORKER_PORT: "5001" })).toEqual({
      webPort: 5000,
      workerPort: 5001,
    });
    expect(stackPorts({ E2E_PORT: "5000" }, { webPort: 6000 })).toEqual({
      webPort: 6000,
      workerPort: STACK_DEFAULTS.workerPort,
    });
    expect(stackPorts({ E2E_PORT: "  " }).webPort).toBe(4310);
  });

  it("잘못된 포트는 즉시 오류다", () => {
    expect(() => stackPorts({ E2E_PORT: "abc" })).toThrow("E2E_PORT");
    expect(() => stackPorts({ E2E_WORKER_PORT: "0" })).toThrow("E2E_WORKER_PORT");
    expect(() => stackPorts({ E2E_WORKER_PORT: "70000" })).toThrow("1~65535");
  });
});

describe("경로·환경", () => {
  it("아티팩트 루트는 apps/web 기준 절대 경로이며 웹·워커·시드가 같은 값을 쓴다", () => {
    expect(stackArtifactRoot({}, ROOT)).toBe(path.join(ROOT, "apps", "web", ".artifacts-e2e"));
    expect(stackArtifactRoot({ E2E_ARTIFACT_FS_ROOT: "tmp-store" }, ROOT)).toBe(
      path.join(ROOT, "apps", "web", "tmp-store"),
    );
    expect(stackArtifactRoot({ E2E_ARTIFACT_FS_ROOT: "/abs/store" }, ROOT)).toBe("/abs/store");
    expect(webEnv({}, ROOT).ARTIFACT_FS_ROOT).toBe(workerEnv({}, ROOT).ARTIFACT_FS_ROOT);
  });

  it("워커 환경은 로컬 러너·fs 스토어·절대 경로 템플릿·헬스 포트를 고정하고 나머지는 상속한다", () => {
    const env = workerEnv(
      { DATABASE_URL: "postgres://x", ARTIFACT_STORE: "blob", TEMPLATE_ROOT: "./templates" },
      ROOT,
      { webPort: 4310, workerPort: 4444 },
    );
    expect(env).toMatchObject({
      DATABASE_URL: "postgres://x",
      SANDBOX_RUNNER: "local",
      ARTIFACT_STORE: "fs",
      ARTIFACT_FS_ROOT: path.join(ROOT, "apps", "web", ".artifacts-e2e"),
      TEMPLATE_ROOT: path.join(ROOT, "templates"),
      PORT: "4444",
      LOG_LEVEL: "info",
    });
    expect(path.isAbsolute(env.TEMPLATE_ROOT!)).toBe(true);
    expect(env.WORKER_ID).toMatch(/^stack-local-\d+$/);
    expect(workerEnv({ WORKER_ID: "w1", LOG_LEVEL: "debug" }, ROOT)).toMatchObject({
      WORKER_ID: "w1",
      LOG_LEVEL: "debug",
    });
    expect(stackTemplateRoot(ROOT)).toBe(path.join(ROOT, "templates"));
  });

  it("undefined 값은 자식 환경에 넘기지 않는다", () => {
    const env = webEnv({ A: undefined, B: "b" }, ROOT);
    expect("A" in env).toBe(false);
    expect(env.B).toBe("b");
    expect(env.ARTIFACT_STORE).toBe("fs");
    // 로컬 스택은 샘플 체험(T-505)을 연다. .env.example을 복사한 DEMO_MODE=false도 덮어쓴다 (T-507)
    expect(env.DEMO_MODE).toBe("true");
    expect(webEnv({ DEMO_MODE: "false" }, ROOT).DEMO_MODE).toBe("true");
  });

  it("명령은 루트 tsx로 워커 소스를, pnpm으로 웹 dev 서버를 띄운다", () => {
    expect(workerCommand(ROOT)).toEqual({
      command: path.join(ROOT, "node_modules", ".bin", "tsx"),
      args: [path.join(ROOT, "apps", "worker", "src", "index.ts")],
      cwd: path.join(ROOT, "apps", "worker"),
    });
    expect(webCommand(4310, ROOT)).toEqual({
      command: "pnpm",
      args: ["--filter", "@ohmyti/web", "dev", "--port", "4310"],
      cwd: ROOT,
    });
    expect(workerHealthUrl({ webPort: 1, workerPort: 4320 })).toBe("http://localhost:4320/healthz");
    expect(webUrl({ webPort: 4310, workerPort: 1 })).toBe("http://localhost:4310/");
  });
});

describe("waitForHttp", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("주소 없음");
    return `http://127.0.0.1:${address.port}/healthz`;
  }

  it("2xx가 될 때까지 기다리고, 그 전엔 false다", async () => {
    let ready = false;
    const url = await listen((_req, res) => {
      res.statusCode = ready ? 200 : 503;
      res.end();
    });
    expect(await isHttpUp(url)).toBe(false);
    setTimeout(() => {
      ready = true;
    }, 150);
    await expect(
      waitForHttp(url, { timeoutMs: 5_000, intervalMs: 20, label: "test" }),
    ).resolves.toBeUndefined();
    expect(await isHttpUp(url)).toBe(true);
  });

  it("상한을 넘기면 오류이고 프로세스가 먼저 끝나면 즉시 오류다", async () => {
    const url = await listen((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    await expect(
      waitForHttp(url, { timeoutMs: 120, intervalMs: 20, label: "slow" }),
    ).rejects.toThrow("slow이(가) 120ms 안에 응답하지 않았습니다");
    await expect(
      waitForHttp(url, { timeoutMs: 5_000, intervalMs: 20, exited: () => true, label: "dead" }),
    ).rejects.toThrow("dead 프로세스가 준비되기 전에 끝났습니다");
    expect(await isHttpUp("http://127.0.0.1:1/healthz")).toBe(false);
  });
});

describe("spawnManaged", () => {
  it("출력에 이름 접두사를 붙이고 종료 코드를 기록한다", async () => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    const proc = spawnManaged(
      "child",
      {
        command: process.execPath,
        args: ["-e", "console.log('hello'); console.error('warn'); process.exit(3)"],
        cwd: process.cwd(),
      },
      { PATH: process.env.PATH ?? "" },
      output,
    );
    await new Promise<void>((resolve) => proc.child.once("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(proc.exited()).toBe(true);
    expect(proc.exitCode()).toBe(3);
    expect(text).toContain("[child] hello");
    expect(text).toContain("[child] warn");
    // 이미 끝난 프로세스의 stop은 아무것도 하지 않는다
    await expect(proc.stop(10)).resolves.toBeUndefined();
  });

  it("stop은 SIGTERM을 보내고, 무시하면 유예 뒤 SIGKILL한다", async () => {
    const graceful = spawnManaged(
      "graceful",
      {
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
      },
      { PATH: process.env.PATH ?? "" },
      new PassThrough(),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await graceful.stop(5_000);
    expect(graceful.exited()).toBe(true);
    expect(graceful.exitCode()).toBe(0);

    const stubborn = spawnManaged(
      "stubborn",
      {
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
      },
      { PATH: process.env.PATH ?? "" },
      new PassThrough(),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    await stubborn.stop(200);
    expect(stubborn.exited()).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    // SIGKILL로 죽으면 종료 코드가 없다
    expect(stubborn.exitCode()).toBeNull();
  });
});
