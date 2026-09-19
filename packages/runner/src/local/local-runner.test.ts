import { lstat, readFile, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { ExecutionContractSchema, type ExecutionContract } from "@ohmyti/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_RUNNER_DEFAULTS } from "../config";
import {
  BlockedCommandError,
  EnvironmentDestroyedError,
  ServiceStartError,
  SnapshotRejectedError,
  type PreparedEnv,
} from "../runner";
import { LocalProcessRunner, splitCommand } from "./local-runner";
import { isGroupAlive } from "./process";
import {
  createTestWorkspace,
  packToStore,
  repoRoot,
  sampleDir,
  templateRoot,
  writeFiles,
  type TestWorkspace,
} from "../test-support/snapshots";

const contract: ExecutionContract = ExecutionContractSchema.parse(
  JSON.parse(
    await readFile(path.join(repoRoot, "samples", "order-api", "execution-contract.json"), "utf8"),
  ),
);

/** 손자 프로세스를 만드는 HTTP 서비스 픽스처. `npm start`로 기동되며 `/health`에 200을 준다. */
const GRANDCHILD_SERVICE: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "fixture-grandchild",
    private: true,
    type: "module",
    scripts: { start: "node server.mjs" },
  }),
  "server.mjs": `
import http from "node:http";
import { spawn } from "node:child_process";
// 손자: 부모가 죽어도 스스로는 끝나지 않는 프로세스
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
console.log("grandchild pid " + grandchild.pid);
const port = Number(process.env.PORT);
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", grandchild: grandchild.pid }));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(port, "127.0.0.1", () => console.log("listening " + port));
`,
};

let ws: TestWorkspace;
let runner: LocalProcessRunner;
const envs: PreparedEnv[] = [];

beforeAll(async () => {
  ws = await createTestWorkspace();
  runner = new LocalProcessRunner({
    config: {
      ...LOCAL_RUNNER_DEFAULTS,
      templateRoot,
      workRoot: path.join(ws.root, "work"),
      runTimeoutMs: 30_000,
      killGraceMs: 500,
    },
    artifactStore: ws.store,
    secrets: ["super-secret-value"],
  });
});

afterAll(async () => {
  await Promise.all(envs.map((env) => runner.destroy(env)));
  await ws.cleanup();
});

async function packFixture(
  key: string,
  files: Record<string, string>,
  exclude: readonly string[] = ["node_modules"],
): Promise<void> {
  const dir = path.join(ws.root, "fixtures", key.replace(/[^A-Za-z0-9]+/g, "-"));
  await writeFiles(dir, files);
  await packToStore(ws.store, key, dir, ["."], { exclude });
}

async function prepareFixture(
  key: string,
  files: Record<string, string>,
  options: Parameters<LocalProcessRunner["prepare"]>[2] = {},
  using: LocalProcessRunner = runner,
): Promise<PreparedEnv> {
  await packFixture(key, files);
  const env = await using.prepare(key, contract, options);
  envs.push(env);
  return env;
}

describe("LocalProcessRunner.prepare", () => {
  it("샘플 A 스냅샷을 풀고 템플릿 node_modules를 심볼릭 링크로 연결하며 템플릿 digest를 쓴다", async () => {
    await packToStore(ws.store, "snapshots/impl-a.tar.gz", sampleDir("a"));
    const env = await runner.prepare("snapshots/impl-a.tar.gz", contract);
    envs.push(env);

    expect(env.kind).toBe("local");
    expect(env.fileCount).toBeGreaterThan(5);
    expect(env.droppedNodeModules).toBe(false);
    expect(await stat(path.join(env.workDir, "src", "server.ts"))).toBeTruthy();

    const link = await lstat(path.join(env.workDir, "node_modules"));
    expect(link.isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(env.workDir, "node_modules"))).toBe(
      path.join(templateRoot, "order-api-ts", "node_modules"),
    );

    const manifest = JSON.parse(
      await readFile(path.join(templateRoot, "order-api-ts", "template.json"), "utf8"),
    ) as { environmentDigest: string; runnerKind: string };
    expect(manifest.runnerKind).toBe("local");
    expect(env.environmentDigest).toBe(manifest.environmentDigest);
    expect(env.logKeyPrefix).toBe(`sandbox/${env.id}/`);
  });

  it("제출물에 node_modules가 있어도 무시되고 템플릿의 것이 사용된다", async () => {
    await packFixture(
      "snapshots/with-node-modules.tar.gz",
      {
        "package.json": JSON.stringify({ name: "x", scripts: { start: "node index.mjs" } }),
        "index.mjs": "console.log('hi')",
        "node_modules/express/package.json": JSON.stringify({
          name: "express",
          version: "0.0.0-fake",
        }),
        "node_modules/evil/index.js": "process.exit(99)",
      },
      [],
    );
    const env = await runner.prepare("snapshots/with-node-modules.tar.gz", contract);
    envs.push(env);
    expect(env.droppedNodeModules).toBe(true);
    expect(env.fileCount).toBe(2);
    const express = JSON.parse(
      await readFile(path.join(env.workDir, "node_modules", "express", "package.json"), "utf8"),
    ) as { version: string };
    expect(express.version).toBe("5.2.1");
    await expect(stat(path.join(env.workDir, "node_modules", "evil"))).rejects.toThrow();

    // 자식 프로세스가 require하는 express도 템플릿의 것이다
    const result = await runner.runCommand(env, [
      "node",
      "-e",
      "console.log(require('express/package.json').version)",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("5.2.1");
  });

  it("스냅샷 안의 node_modules를 실제 디렉터리로 두지 않는다 (링크만 남는다)", async () => {
    const env = envs.find((e) => e.droppedNodeModules)!;
    const link = await lstat(path.join(env.workDir, "node_modules"));
    expect(link.isSymbolicLink()).toBe(true);
  });

  it("../ 경로가 든 tar는 unpack이 거부된다", async () => {
    const outer = path.join(ws.root, "traversal");
    await writeFiles(outer, { "evil.txt": "evil", "inner/package.json": "{}" });
    await packToStore(
      ws.store,
      "snapshots/traversal.tar.gz",
      path.join(outer, "inner"),
      ["package.json", "../evil.txt"],
      { preservePaths: true },
    );
    await expect(runner.prepare("snapshots/traversal.tar.gz", contract)).rejects.toMatchObject({
      name: "SnapshotRejectedError",
      code: "PATH_TRAVERSAL",
      entryPath: "../evil.txt",
    });
  });

  it("심볼릭 링크가 든 tar는 unpack이 거부되고 아무것도 풀지 않는다", async () => {
    const dir = path.join(ws.root, "symlink-fixture");
    await writeFiles(dir, { "package.json": "{}", "real.txt": "x" });
    const { symlink } = await import("node:fs/promises");
    await symlink("/etc/passwd", path.join(dir, "link.txt"));
    await packToStore(ws.store, "snapshots/symlink.tar.gz", dir);
    const error = await runner
      .prepare("snapshots/symlink.tar.gz", contract)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SnapshotRejectedError);
    expect((error as SnapshotRejectedError).code).toBe("SYMLINK");
    // 환경 디렉터리가 남지 않는다
    const { readdir } = await import("node:fs/promises");
    const leftovers = await readdir(path.join(ws.root, "work")).catch(() => []);
    expect(leftovers.filter((d) => d.startsWith("ohmyti-sandbox-")).length).toBe(envs.length);
  });

  it("파일 수 한도를 넘는 tar는 거부된다", async () => {
    const small = new LocalProcessRunner({
      config: { ...runner.config, maxSourceFiles: 1 },
      artifactStore: ws.store,
    });
    const dir = path.join(ws.root, "many-files");
    await writeFiles(dir, { "a.txt": "1", "b.txt": "2" });
    await packToStore(ws.store, "snapshots/many.tar.gz", dir);
    await expect(small.prepare("snapshots/many.tar.gz", contract)).rejects.toMatchObject({
      code: "TOO_MANY_FILES",
    });
  });

  it("없는 스냅샷은 NOT_FOUND, 손상된 아카이브는 CORRUPT_ARCHIVE다", async () => {
    await expect(runner.prepare("snapshots/nope.tar.gz", contract)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await ws.store.put("snapshots/corrupt.tar.gz", "not a tarball at all", {
      contentType: "application/gzip",
    });
    await expect(runner.prepare("snapshots/corrupt.tar.gz", contract)).rejects.toMatchObject({
      code: "CORRUPT_ARCHIVE",
    });
  });

  it("stripComponents로 GitHub tarball의 상위 디렉터리를 벗긴다", async () => {
    const dir = path.join(ws.root, "prefixed");
    await writeFiles(dir, { "package.json": "{}", "src/a.ts": "" });
    await packToStore(ws.store, "snapshots/prefixed.tar.gz", dir, ["."], {
      prefix: "owner-repo-abc123",
    });
    const env = await runner.prepare("snapshots/prefixed.tar.gz", contract, { stripComponents: 1 });
    envs.push(env);
    expect(await stat(path.join(env.workDir, "src", "a.ts"))).toBeTruthy();
    expect(env.fileCount).toBe(2);
  });

  it("없는 템플릿 이름은 RunnerEnvironmentError다", async () => {
    await expect(
      runner.prepare("snapshots/impl-a.tar.gz", { ...contract, templateName: "nope" }),
    ).rejects.toMatchObject({ name: "RunnerEnvironmentError" });
  });
});

describe("LocalProcessRunner.startService", () => {
  it("A 스냅샷으로 10초 안에 /health 200을 받고, stop() 후 프로세스 그룹에 남은 프로세스가 없다", async () => {
    const env = envs[0]!;
    const started = Date.now();
    const service = await runner.startService(env);
    try {
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(service.startup.outcome).toBe("HEALTHY");
      expect(service.startup.elapsedMs).toBeLessThan(10_000);
      expect(service.startup.lastHealthStatus).toBe(200);
      const health = await fetch(`${service.baseUrl}${contract.healthPath}`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
      const reset = await fetch(`${service.baseUrl}${contract.resetPath}`, { method: "POST" });
      expect(reset.status).toBe(200);
      expect(isGroupAlive(service.pid)).toBe(true);
    } finally {
      const exit = await service.stop();
      expect(exit.stoppedByCaller).toBe(true);
      expect(exit.timedOut).toBe(false);
    }
    expect(isGroupAlive(service.pid)).toBe(false);
    expect(service.isRunning()).toBe(false);
    // 로그가 스토어에 있다
    const stdout = await ws.store.get(service.logsRef.stdout);
    expect(stdout?.contentType).toContain("text/plain");
    expect(Buffer.from(stdout!.body).toString("utf8")).toContain("order-api listening on port");
  }, 20_000);

  it("손자 프로세스를 만드는 서비스도 stop() 후 그룹 전체가 사라진다", async () => {
    const env = await prepareFixture("snapshots/grandchild.tar.gz", GRANDCHILD_SERVICE);
    const service = await runner.startService(env);
    const health = (await (await fetch(`${service.baseUrl}/health`)).json()) as {
      grandchild: number;
    };
    expect(health.grandchild).toBeGreaterThan(0);
    // 손자가 살아 있고 같은 그룹에 있다
    expect(() => process.kill(health.grandchild, 0)).not.toThrow();
    expect(isGroupAlive(service.pid)).toBe(true);

    const exit = await service.stop();
    expect(exit.stoppedByCaller).toBe(true);
    expect(isGroupAlive(service.pid)).toBe(false);
    expect(() => process.kill(health.grandchild, 0)).toThrow();
    // stop()을 다시 불러도 같은 결과
    expect(await service.stop()).toEqual(exit);
  }, 20_000);

  it("/health를 주지 않는 서비스는 HEALTH_TIMEOUT으로 ServiceStartError를 던지고 프로세스를 정리한다", async () => {
    const env = await prepareFixture("snapshots/no-health.tar.gz", {
      "package.json": JSON.stringify({ scripts: { start: "node server.mjs" } }),
      "server.mjs": `
import http from "node:http";
http.createServer((_, res) => { res.writeHead(503); res.end(); }).listen(Number(process.env.PORT), "127.0.0.1");
`,
    });
    const error = await runner
      .startService(env, { healthTimeoutMs: 1_000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceStartError);
    const startError = error as ServiceStartError;
    expect(startError.startup.outcome).toBe("HEALTH_TIMEOUT");
    expect(startError.startup.lastHealthStatus).toBe(503);
    expect(startError.startup.healthTimeoutMs).toBe(1_000);
    expect(startError.stopped.stoppedByCaller).toBe(true);
    expect(await ws.store.exists(startError.logsRef.stderr)).toBe(true);
  }, 15_000);

  it("기동 직후 종료되는 서비스는 EXITED_BEFORE_HEALTHY다", async () => {
    const env = await prepareFixture("snapshots/exit-early.tar.gz", {
      "package.json": JSON.stringify({ scripts: { start: "node boom.mjs" } }),
      "boom.mjs": "console.error('boom'); process.exit(3);",
    });
    const error = (await runner.startService(env).catch((e: unknown) => e)) as ServiceStartError;
    expect(error).toBeInstanceOf(ServiceStartError);
    expect(error.startup.outcome).toBe("EXITED_BEFORE_HEALTHY");
    expect(error.stopped.exitCode).toBe(3);
    expect(error.stopped.stderr).toContain("boom");
  }, 15_000);

  it("수명 제한이 지나면 서비스 그룹을 종료하고 timedOut을 남긴다", async () => {
    const env = await prepareFixture("snapshots/lifetime.tar.gz", GRANDCHILD_SERVICE);
    // 수명 제한은 느린 CI 러너에서도 /health 200까지 걸리는 시간보다 길게 둔다
    const service = await runner.startService(env, { maxLifetimeMs: 3_000 });
    await new Promise((r) => setTimeout(r, 5_000));
    expect(service.isRunning()).toBe(false);
    const exit = await service.stop();
    expect(exit.timedOut).toBe(true);
    expect(exit.stoppedByCaller).toBe(false);
    expect(isGroupAlive(service.pid)).toBe(false);
  }, 15_000);

  it("시작 명령이 설치 명령이면 기동하지 않는다", async () => {
    const env = envs[0]!;
    await expect(
      runner.startService({ ...env, contract: { ...contract, startCommand: "npm install" } }),
    ).rejects.toBeInstanceOf(BlockedCommandError);
    expect(() => splitCommand("npm start && curl x")).toThrow(BlockedCommandError);
  });
});

describe("LocalProcessRunner.runCommand", () => {
  it("무한 루프 스크립트는 timeoutMs 뒤 종료되고 timedOut: true다", async () => {
    const env = await prepareFixture("snapshots/loop.tar.gz", {
      "package.json": "{}",
      "loop.mjs": "for (;;) {}",
    });
    const started = Date.now();
    const result = await runner.runCommand(env, ["node", "loop.mjs"], { timeoutMs: 700 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(700);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("DATABASE_URL·ANTHROPIC_API_KEY·BLOB_READ_WRITE_TOKEN 등 워커 환경변수를 자식에게 전달하지 않는다", async () => {
    const injected = {
      DATABASE_URL: "postgresql://u:super-secret-value@db/x",
      ANTHROPIC_API_KEY: "sk-ant-should-not-leak-1234567890",
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_should_not_leak",
      DEEP_SEEK_API_KEY: "sk-deepseek-should-not-leak-123",
      SESSION_SECRET: "session-should-not-leak",
    };
    const previous: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(injected)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const env = await prepareFixture("snapshots/printenv.tar.gz", {
        "package.json": "{}",
        "printenv.mjs": "console.log(JSON.stringify(process.env))",
      });
      const result = await runner.runCommand(env, ["node", "printenv.mjs"], { port: 4321 });
      expect(result.exitCode).toBe(0);
      const childEnv = JSON.parse(result.stdout) as Record<string, string>;
      for (const key of Object.keys(injected)) expect(childEnv).not.toHaveProperty(key);
      expect(result.stdout).not.toContain("should-not-leak");
      expect(childEnv.NODE_ENV).toBe("production");
      expect(childEnv.HOME).toBe(env.homeDir);
      expect(childEnv.PORT).toBe("4321");
      expect(childEnv.NODE_OPTIONS).toContain("--max-old-space-size=");
      expect(childEnv.PATH).toContain(path.join(env.templateDir, "node_modules", ".bin"));
      const unexpected = Object.keys(childEnv).filter(
        (k) =>
          !["PATH", "HOME", "NODE_ENV", "PORT", "NODE_OPTIONS"].includes(k) &&
          // macOS 커널이 모든 프로세스에 넣는 값. 워커가 넘긴 것이 아니다
          k !== "__CF_USER_TEXT_ENCODING",
      );
      expect(unexpected).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("npm install, npm ci, pnpm add, npx는 거부된다", async () => {
    const env = envs[0]!;
    for (const argv of [
      ["npm", "install"],
      ["npm", "i", "left-pad"],
      ["npm", "ci"],
      ["npm", "--no-audit", "install"],
      ["pnpm", "add", "left-pad"],
      ["yarn", "add", "left-pad"],
      ["npx", "cowsay"],
      ["corepack", "enable"],
    ]) {
      await expect(runner.runCommand(env, argv)).rejects.toBeInstanceOf(BlockedCommandError);
    }
  });

  it("package.json 스크립트 본문에 설치 명령이 있으면 npm start도 거부된다", async () => {
    const env = await prepareFixture("snapshots/sneaky-start.tar.gz", {
      "package.json": JSON.stringify({
        scripts: { prestart: "npm ci --silent", start: "node server.mjs" },
      }),
      "server.mjs": "",
    });
    await expect(runner.runCommand(env, ["npm", "start"])).rejects.toThrow(/prestart/);
    await expect(runner.startService(env)).rejects.toBeInstanceOf(BlockedCommandError);
  });

  it("npm 스크립트를 실행하고 stdout·stderr·종료 코드·파일을 수집하며 로그를 마스킹해 저장한다", async () => {
    const env = await prepareFixture("snapshots/npm-script.tar.gz", {
      "package.json": JSON.stringify({
        scripts: { build: "node build.mjs" },
      }),
      "build.mjs": `
import { writeFileSync } from "node:fs";
console.log("token sk-abcdefghijklmnop and super-secret-value and mail a@b.co");
console.error("warn");
writeFileSync("out.json", JSON.stringify({ ok: true }));
process.exit(2);
`,
    });
    const result = await runner.runCommand(env, ["npm", "run", "build", "--silent"], {
      collectFiles: ["out.json", "missing.json"],
      label: "build",
    });
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("[TOKEN]");
    expect(result.stdout).toContain("[SECRET]");
    expect(result.stdout).toContain("[EMAIL]");
    expect(result.stdout).not.toContain("super-secret-value");
    expect(result.stderr).toContain("warn");
    expect(result.files.map((f) => f.path)).toEqual(["out.json"]);
    expect(JSON.parse(Buffer.from(result.files[0]!.bytes).toString())).toEqual({ ok: true });
    expect(result.logsRef.stdout).toBe(`${env.logKeyPrefix}build/stdout.txt`);
    const stored = await ws.store.get(result.logsRef.stdout);
    expect(Buffer.from(stored!.body).toString()).toBe(result.stdout);
  });

  it("환경 루트 밖의 파일 수집은 거부한다", async () => {
    const env = envs[0]!;
    await expect(
      runner.runCommand(env, ["node", "-e", "0"], { collectFiles: ["../../etc/passwd"] }),
    ).rejects.toMatchObject({ name: "RunnerEnvironmentError" });
  });

  it("출력은 상한까지만 보관한다", async () => {
    const tiny = new LocalProcessRunner({
      config: { ...runner.config, maxOutputBytes: 100 },
      artifactStore: ws.store,
    });
    const env = await prepareFixture(
      "snapshots/big-output.tar.gz",
      { "package.json": "{}", "spam.mjs": "process.stdout.write('x'.repeat(10000))" },
      {},
      tiny,
    );
    const result = await tiny.runCommand(env, ["node", "spam.mjs"]);
    expect(result.stdout.length).toBe(100);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("리더가 끝난 뒤 남은 손자도 정리한다", async () => {
    const env = await prepareFixture("snapshots/orphan.tar.gz", {
      "package.json": "{}",
      "orphan.mjs": `
import { spawn } from "node:child_process";
// unref: 부모는 손자를 기다리지 않고 끝난다. 손자는 stdout 파이프를 쥔 채 남는다.
const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
c.unref();
console.log(c.pid);
`,
    });
    const result = await runner.runCommand(env, ["node", "orphan.mjs"], { timeoutMs: 5_000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const orphanPid = Number(result.stdout.trim());
    expect(() => process.kill(orphanPid, 0)).toThrow();
  }, 10_000);

  it("템플릿 .bin의 프로그램(tsx)을 이름으로 실행할 수 있다", async () => {
    const env = envs[0]!;
    const result = await runner.runCommand(env, ["tsx", "--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/tsx v4\.23\.13/);
  });
});

describe("LocalProcessRunner.destroy", () => {
  it("실행 중인 서비스를 종료하고 디렉터리를 지우며, 이후 사용은 EnvironmentDestroyedError다", async () => {
    const env = await prepareFixture("snapshots/destroy.tar.gz", GRANDCHILD_SERVICE);
    const service = await runner.startService(env);
    await runner.destroy(env);
    expect(isGroupAlive(service.pid)).toBe(false);
    await expect(stat(env.rootDir)).rejects.toThrow();
    await expect(runner.runCommand(env, ["node", "-e", "0"])).rejects.toBeInstanceOf(
      EnvironmentDestroyedError,
    );
    await expect(runner.startService(env)).rejects.toBeInstanceOf(EnvironmentDestroyedError);
    // 두 번 파괴해도 안전
    await runner.destroy(env);
  }, 15_000);
});
