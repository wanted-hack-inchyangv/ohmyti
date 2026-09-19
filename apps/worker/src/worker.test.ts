import {
  claimJob,
  createTestDatabase,
  enqueue,
  getJob,
  jobs,
  type Database,
  type TestDatabase,
} from "@ohmyti/db";
import { FsArtifactStore } from "@ohmyti/storage";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerConfig, type WorkerConfig } from "./config";
import { buildHealthReport, startHealthServer } from "./health";
import { createLogger } from "./logger";
import {
  createDefaultRegistry,
  HandlerRegistry,
  NonRetryableJobError,
  type JobHandler,
} from "./registry";
import { createWorker, type Worker } from "./worker";

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/worker] DATABASE_URL_TEST가 없어 워커 통합 테스트를 건너뜁니다");
}

function testConfig(workerId: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...loadWorkerConfig({
      WORKER_ID: workerId,
      WORKER_POLL_INTERVAL_MS: "20",
      WORKER_CONCURRENCY: "4",
      WORKER_STALE_MS: "3000",
      WORKER_SHUTDOWN_GRACE_MS: "2000",
      PORT: "0",
    }),
    ...overrides,
  };
}

function bufferDestination() {
  const lines: string[] = [];
  return { lines, write: (msg: string) => void lines.push(msg) };
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
  label = "조건",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label}을(를) ${timeoutMs}ms 안에 만족하지 못했습니다`);
}

async function statusCounts(db: Database): Promise<Record<string, number>> {
  const rows = await db.select({ status: jobs.status }).from(jobs);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}

describe.skipIf(!hasTestDb)("워커 루프 (통합)", () => {
  let tdb: TestDatabase;
  let storeRoot: string;
  const workers: Worker[] = [];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storeRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-worker-"));
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await tdb.db.delete(jobs);
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop()));
  });

  function makeWorker(
    workerId: string,
    registry: HandlerRegistry,
    overrides: Partial<WorkerConfig> = {},
  ) {
    const dest = bufferDestination();
    const worker = createWorker({
      db: tdb.db,
      store: new FsArtifactStore({ root: storeRoot }),
      registry,
      config: testConfig(workerId, overrides),
      logger: createLogger({ destination: dest, level: "debug", secrets: ["hunter2-secret"] }),
    });
    workers.push(worker);
    return { worker, lines: dest.lines };
  }

  it("워커 2개가 job 100개를 나눠 처리하면 각 job은 정확히 한 번 SUCCEEDED가 된다", async () => {
    const runs = new Map<string, number>();
    const handler: JobHandler = async (job, ctx) => {
      runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 10));
      await ctx.heartbeat();
    };
    const registry = new HandlerRegistry().register("EVALUATE_SUBMISSION", handler);

    const ids: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      ids.push((await enqueue(tdb.db, { type: "EVALUATE_SUBMISSION", payload: { i } })).id);
    }

    const a = makeWorker("w-a", registry);
    const b = makeWorker("w-b", registry);
    a.worker.start();
    b.worker.start();
    await Promise.all([
      a.worker.drain({ timeoutMs: 30_000 }),
      b.worker.drain({ timeoutMs: 30_000 }),
    ]);

    expect(await statusCounts(tdb.db)).toEqual({ SUCCEEDED: 100 });
    expect(runs.size).toBe(100);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    const done = a.worker.status().processed.succeeded + b.worker.status().processed.succeeded;
    expect(done).toBe(100);
    // 두 워커 모두 실제로 일을 나눠 가졌다.
    expect(a.worker.status().processed.succeeded).toBeGreaterThan(0);
    expect(b.worker.status().processed.succeeded).toBeGreaterThan(0);
    for (const id of ids) {
      const row = await getJob(tdb.db, id);
      expect(row?.attempts).toBe(1);
      expect(row?.lockedBy).toBeNull();
    }
  }, 60_000);

  it("핸들러가 예외를 던지면 attempts가 늘고 백오프 후 재시도되며 max_attempts를 넘기면 FAILED가 된다", async () => {
    let calls = 0;
    const registry = new HandlerRegistry().register("RERUN_EXECUTION", () => {
      calls += 1;
      return Promise.reject(new Error(`실패 ${calls} (token sk-abcdefghijklmnop)`));
    });
    const { id } = await enqueue(tdb.db, { type: "RERUN_EXECUTION", payload: {}, maxAttempts: 2 });

    const { worker, lines } = makeWorker("w-fail", registry);
    worker.start();

    await waitFor(
      async () => (await getJob(tdb.db, id))?.attempts === 1 && calls === 1,
      5_000,
      "1차 시도",
    );
    let row = await getJob(tdb.db, id);
    expect(row?.status).toBe("QUEUED");
    expect(row?.lastError).toContain("실패 1");
    const firstRunAfter = row?.runAfter.getTime() ?? 0;
    expect(firstRunAfter).toBeGreaterThan(Date.now() - 100);

    await waitFor(
      async () => (await getJob(tdb.db, id))?.status === "FAILED",
      10_000,
      "FAILED 전환",
    );
    row = await getJob(tdb.db, id);
    expect(calls).toBe(2);
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toContain("실패 2");
    expect(row?.lockedBy).toBeNull();
    // 2차 시도는 백오프(기본 1초 이상) 뒤에 시작됐다.
    expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(firstRunAfter);
    expect(worker.status().processed).toMatchObject({ retried: 1, failed: 1 });

    const out = lines.join("");
    expect(out).toContain("백오프 후 재시도");
    expect(out).toContain("더 이상 재시도하지 않습니다");
    expect(out).not.toContain("sk-abcdefghijklmnop");
  }, 20_000);

  it("NonRetryableJobError와 미구현 핸들러는 즉시 FAILED로 끝난다", async () => {
    const registry = createDefaultRegistry().register("DELETE_SUBMISSION", () =>
      Promise.reject(new NonRetryableJobError("삭제 대상이 없습니다")),
    );
    const nonRetryable = await enqueue(tdb.db, {
      type: "DELETE_SUBMISSION",
      payload: {},
      maxAttempts: 5,
    });
    const unimplemented = await enqueue(tdb.db, {
      type: "VALIDATE_RUBRIC",
      payload: {},
      maxAttempts: 5,
    });

    const { worker } = makeWorker("w-nr", registry);
    worker.start();
    await worker.drain();

    const a = await getJob(tdb.db, nonRetryable.id);
    expect(a?.status).toBe("FAILED");
    expect(a?.attempts).toBe(1);
    expect(a?.lastError).toContain("삭제 대상이 없습니다");
    const b = await getJob(tdb.db, unimplemented.id);
    expect(b?.status).toBe("FAILED");
    expect(b?.lastError).toContain("아직 구현되지 않았습니다");
  });

  it("heartbeat가 끊긴 RUNNING job을 다른 워커가 회수해 처리한다", async () => {
    const processedBy: string[] = [];
    const registry = new HandlerRegistry().register("EVALUATE_SUBMISSION", (_job, ctx) => {
      processedBy.push(ctx.workerId);
      return Promise.resolve();
    });
    const { id } = await enqueue(tdb.db, { type: "EVALUATE_SUBMISSION", payload: {} });

    // 죽은 워커를 흉내 낸다: 잡기만 하고 heartbeat를 보내지 않는다.
    const claimed = await claimJob(tdb.db, { workerId: "w-dead" });
    expect(claimed?.id).toBe(id);

    const { worker, lines } = makeWorker("w-alive", registry, {
      staleMs: 300,
      heartbeatIntervalMs: 100,
      reclaimIntervalMs: 100,
    });
    worker.start();

    await waitFor(
      async () => (await getJob(tdb.db, id))?.status === "SUCCEEDED",
      5_000,
      "회수 후 성공",
    );
    const row = await getJob(tdb.db, id);
    expect(row?.attempts).toBe(2);
    expect(processedBy).toEqual(["w-alive"]);
    expect(lines.join("")).toContain("heartbeat가 끊긴 job을 회수했습니다");
  });

  it("실행 중 소유권을 잃으면 ctx.heartbeat()가 JobLostError를 던지고 결과를 덮어쓰지 않는다", async () => {
    let lostSeen = false;
    const registry = new HandlerRegistry().register("EVALUATE_SUBMISSION", async (_job, ctx) => {
      // 다른 워커가 회수할 때까지 기다린다.
      await new Promise((resolve) => setTimeout(resolve, 700));
      try {
        await ctx.heartbeat();
      } catch (error) {
        lostSeen = (error as Error).name === "JobLostError";
        throw error;
      }
    });
    const { id } = await enqueue(tdb.db, { type: "EVALUATE_SUBMISSION", payload: {} });

    // heartbeat 주기를 stale보다 길게 두어 소유권을 잃게 만든다 (설정 검증은 loadWorkerConfig에서만 한다).
    const slow = makeWorker("w-slow", registry, {
      staleMs: 200,
      heartbeatIntervalMs: 10_000,
      reclaimIntervalMs: 10_000,
    });
    slow.worker.start();
    await waitFor(
      async () => (await getJob(tdb.db, id))?.lockedBy === "w-slow",
      3_000,
      "w-slow claim",
    );

    const fast = makeWorker(
      "w-fast",
      new HandlerRegistry().register("EVALUATE_SUBMISSION", () => Promise.resolve()),
      {
        staleMs: 200,
        heartbeatIntervalMs: 50,
        reclaimIntervalMs: 50,
      },
    );
    fast.worker.start();
    await waitFor(
      async () => (await getJob(tdb.db, id))?.status === "SUCCEEDED",
      5_000,
      "w-fast 성공",
    );
    await waitFor(() => Promise.resolve(lostSeen), 3_000, "JobLostError 관측");

    await new Promise((resolve) => setTimeout(resolve, 100));
    const row = await getJob(tdb.db, id);
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.attempts).toBe(2);
    expect(fast.lines.join("")).toContain("heartbeat가 끊긴 job을 회수했습니다");
    expect(slow.worker.status().processed).toMatchObject({ succeeded: 0, failed: 0, retried: 0 });
  });

  it("stop()은 진행 중 job이 끝나기를 기다린 뒤 종료한다", async () => {
    const registry = new HandlerRegistry().register("EVALUATE_SUBMISSION", async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const { id } = await enqueue(tdb.db, { type: "EVALUATE_SUBMISSION", payload: {} });
    const { worker } = makeWorker("w-stop", registry);
    worker.start();
    await waitFor(async () => (await getJob(tdb.db, id))?.status === "RUNNING", 3_000, "RUNNING");

    await worker.stop();
    expect(worker.status().running).toBe(false);
    expect((await getJob(tdb.db, id))?.status).toBe("SUCCEEDED");
  });

  it("stop()은 유예 시간이 지나면 진행 중 job을 QUEUED로 반납하고 attempts를 되돌린다", async () => {
    let aborted = false;
    const registry = new HandlerRegistry().register("EVALUATE_SUBMISSION", async (_job, ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
    });
    const { id } = await enqueue(tdb.db, { type: "EVALUATE_SUBMISSION", payload: {} });
    const { worker, lines } = makeWorker("w-hang", registry, { shutdownGraceMs: 200 });
    worker.start();
    await waitFor(async () => (await getJob(tdb.db, id))?.status === "RUNNING", 3_000, "RUNNING");

    await worker.stop();
    const row = await getJob(tdb.db, id);
    expect(row?.status).toBe("QUEUED");
    expect(row?.attempts).toBe(0);
    expect(row?.lockedBy).toBeNull();
    expect(aborted).toBe(true);
    expect(lines.join("")).toContain("QUEUED로 반납");
  });

  it("job 로거는 비밀값을 마스킹하고 job 식별자를 붙인다", async () => {
    const registry = new HandlerRegistry().register("EVALUATE_SUBMISSION", (_job, ctx) => {
      ctx.logger.info(
        { password: "hunter2-secret", mail: "who@example.org" },
        "using hunter2-secret",
      );
      return Promise.resolve();
    });
    const { id } = await enqueue(tdb.db, { type: "EVALUATE_SUBMISSION", payload: {} });
    const { worker, lines } = makeWorker("w-log", registry);
    worker.start();
    await worker.drain();

    const line = lines.find((l) => l.includes("using"));
    expect(line).toBeDefined();
    expect(line).toContain(`"jobId":"${id}"`);
    expect(line).toContain('"workerId":"w-log"');
    expect(line).not.toContain("hunter2-secret");
    expect(line).not.toContain("who@example.org");
    expect(line).toContain("[SECRET]");
  });

  it("유휴 상태에서도 폴링 기록을 남긴다 (debug 매 폴링, info 1분에 한 번)", async () => {
    const { worker, lines } = makeWorker("w-poll", new HandlerRegistry(), { pollIntervalMs: 20 });
    worker.start();
    await waitFor(() =>
      Promise.resolve(lines.filter((l) => l.includes('"msg":"폴링"')).length >= 3),
    );
    await worker.stop();

    const infoLines = lines.filter((l) => l.includes('"msg":"폴링 중"'));
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]).toContain('"workerId":"w-poll"');
    expect(infoLines[0]).toContain('"processed":');
  });

  it("/healthz는 루프가 돌고 DB가 응답하면 200, 종료 뒤에는 503을 돌려준다", async () => {
    const { worker } = makeWorker("w-health", new HandlerRegistry());
    worker.start();
    const health = await startHealthServer({
      port: 0,
      worker,
      db: tdb.db,
      logger: createLogger({ destination: bufferDestination() }),
    });
    try {
      const ok = await fetch(`http://127.0.0.1:${health.port}/healthz`);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { ok: boolean; workerId: string; db: string };
      expect(body).toMatchObject({ ok: true, workerId: "w-health", db: "ok" });

      const notFound = await fetch(`http://127.0.0.1:${health.port}/other`);
      expect(notFound.status).toBe(404);

      await worker.stop();
      const down = await fetch(`http://127.0.0.1:${health.port}/healthz`);
      expect(down.status).toBe(503);
      const report = await buildHealthReport(worker, tdb.db);
      expect(report.ok).toBe(false);
      expect(report.running).toBe(false);
    } finally {
      await health.close();
    }
  });
});

describe.skipIf(!hasTestDb)("워커 프로세스 SIGTERM (통합)", () => {
  let tdb: TestDatabase;
  const children: ChildProcess[] = [];
  const entry = fileURLToPath(new URL("./testing/sigterm-entry.ts", import.meta.url));
  const workerDir = path.resolve(path.dirname(entry), "..", "..");

  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await tdb?.destroy();
  });

  beforeEach(async () => {
    await tdb.db.delete(jobs);
  });

  function spawnWorker(extraEnv: Record<string, string>) {
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      cwd: workerDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "test",
        DATABASE_URL: tdb.url,
        ARTIFACT_STORE: "fs",
        ARTIFACT_FS_ROOT: path.join(os.tmpdir(), "ohmyti-sigterm-artifacts"),
        WORKER_ID: "w-child",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_STALE_MS: "3000",
        PORT: "0",
        LOG_LEVEL: "info",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    return { child, exited, output: () => output };
  }

  it("SIGTERM을 받으면 진행 중 job을 끝낸 뒤 종료한다", async () => {
    const { id } = await enqueue(tdb.db, { type: "EVALUATE_SUBMISSION", payload: {} });
    const proc = spawnWorker({ TEST_HANDLER_MS: "1500", WORKER_SHUTDOWN_GRACE_MS: "10000" });
    try {
      await waitFor(
        async () => (await getJob(tdb.db, id))?.status === "RUNNING",
        20_000,
        "RUNNING",
      );
      expect(proc.child.kill("SIGTERM")).toBe(true);
      const result = await Promise.race([
        proc.exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`종료 대기 초과\n${proc.output()}`)), 20_000),
        ),
      ]);
      expect(result.code, proc.output()).toBe(0);
      expect((await getJob(tdb.db, id))?.status).toBe("SUCCEEDED");
      expect(proc.output()).toContain("종료 신호를 받았습니다");
      expect(proc.output()).toContain("워커 프로세스를 마칩니다");
    } finally {
      if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
    }
  }, 40_000);

  it("SIGTERM 뒤 유예 시간 안에 끝나지 않는 job은 QUEUED로 반납하고 종료한다", async () => {
    const { id } = await enqueue(tdb.db, { type: "EVALUATE_SUBMISSION", payload: {} });
    const proc = spawnWorker({ TEST_HANDLER_MS: "hang", WORKER_SHUTDOWN_GRACE_MS: "300" });
    try {
      await waitFor(
        async () => (await getJob(tdb.db, id))?.status === "RUNNING",
        20_000,
        "RUNNING",
      );
      proc.child.kill("SIGTERM");
      const result = await Promise.race([
        proc.exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`종료 대기 초과\n${proc.output()}`)), 20_000),
        ),
      ]);
      expect(result.code, proc.output()).toBe(0);
      const row = await getJob(tdb.db, id);
      expect(row?.status).toBe("QUEUED");
      expect(row?.attempts).toBe(0);
      expect(row?.lockedBy).toBeNull();
      expect(proc.output()).toContain("QUEUED로 반납");
    } finally {
      if (proc.child.exitCode === null) proc.child.kill("SIGKILL");
    }
  }, 40_000);
});
