import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cancelJob,
  claimJob,
  completeJob,
  defaultBackoffMs,
  enqueue,
  failJob,
  getJob,
  heartbeatJob,
  reclaimStaleJobs,
  releaseJob,
} from "./queue";
import { jobs } from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

describe("defaultBackoffMs", () => {
  it("시도 횟수에 따라 지수적으로 늘고 5분을 넘지 않는다", () => {
    expect(defaultBackoffMs(1)).toBeGreaterThanOrEqual(1_000);
    expect(defaultBackoffMs(1)).toBeLessThanOrEqual(1_200);
    expect(defaultBackoffMs(3)).toBeGreaterThanOrEqual(4_000);
    expect(defaultBackoffMs(3)).toBeLessThanOrEqual(4_800);
    expect(defaultBackoffMs(30)).toBeLessThanOrEqual(6 * 60_000);
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/db] DATABASE_URL_TEST가 없어 큐 통합 테스트를 건너뜁니다");
}

describe.skipIf(!hasTestDb)("작업 큐 (통합)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
  });

  // 테스트마다 큐를 비워 claim 순서가 앞 테스트의 잔여 job에 영향을 받지 않게 한다.
  beforeEach(async () => {
    await tdb.db.delete(jobs);
  });

  it("같은 dedupeKey로 두 번 enqueue하면 두 번째는 기존 job id를 돌려준다", async () => {
    const key = `dedupe:${crypto.randomUUID()}`;
    const first = await enqueue(tdb.db, {
      type: "EVALUATE_SUBMISSION",
      payload: { n: 1 },
      dedupeKey: key,
    });
    const second = await enqueue(tdb.db, {
      type: "EVALUATE_SUBMISSION",
      payload: { n: 2 },
      dedupeKey: key,
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });

    // 동시에 들어와도 하나만 만들어진다.
    const concurrentKey = `dedupe:${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        enqueue(tdb.db, { type: "RERUN_EXECUTION", payload: {}, dedupeKey: concurrentKey }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);

    // 끝난 뒤에는 같은 키로 새 job을 만들 수 있다.
    const claimed = await claimJob(tdb.db, {
      workerId: "w-dedupe",
      types: ["EVALUATE_SUBMISSION"],
    });
    expect(claimed?.id).toBe(first.id);
    expect(await completeJob(tdb.db, first.id, "w-dedupe")).toBe(true);
    const third = await enqueue(tdb.db, {
      type: "EVALUATE_SUBMISSION",
      payload: {},
      dedupeKey: key,
    });
    expect(third.created).toBe(true);
    expect(third.id).not.toBe(first.id);
  });

  it("maxAttempts가 1 미만이면 거절한다", async () => {
    await expect(
      enqueue(tdb.db, { type: "DELETE_SUBMISSION", payload: {}, maxAttempts: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it("claim은 runAfter가 지난 QUEUED job만 잡고 attempts를 올린다", async () => {
    const future = await enqueue(tdb.db, {
      type: "VALIDATE_RUBRIC",
      payload: {},
      runAfter: new Date(Date.now() + 60_000),
    });
    const ready = await enqueue(tdb.db, { type: "VALIDATE_RUBRIC", payload: { ready: true } });

    const claimed = await claimJob(tdb.db, { workerId: "w1", types: ["VALIDATE_RUBRIC"] });
    expect(claimed?.id).toBe(ready.id);
    expect(claimed?.status).toBe("RUNNING");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.lockedBy).toBe("w1");
    expect(claimed?.heartbeatAt).toBeInstanceOf(Date);
    expect(claimed?.payload).toEqual({ ready: true });

    expect(await claimJob(tdb.db, { workerId: "w1", types: ["VALIDATE_RUBRIC"] })).toBeNull();
    expect(await completeJob(tdb.db, ready.id, "w1")).toBe(true);
    expect((await getJob(tdb.db, future.id))?.status).toBe("QUEUED");
  });

  it("여러 워커가 동시에 claim해도 같은 job을 두 번 잡지 않는다", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      ids.add(
        (await enqueue(tdb.db, { type: "REEVALUATE_ASSIGNMENT_VERSION", payload: { i } })).id,
      );
    }
    const claimed = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        claimJob(tdb.db, { workerId: `w${i % 3}`, types: ["REEVALUATE_ASSIGNMENT_VERSION"] }),
      ),
    );
    const claimedIds = claimed.filter((j) => j !== null).map((j) => j.id);
    expect(claimedIds).toHaveLength(20);
    expect(new Set(claimedIds)).toEqual(ids);
    await Promise.all(
      claimed.map((j) => (j ? completeJob(tdb.db, j.id, j.lockedBy ?? "") : Promise.resolve(true))),
    );
  });

  it("실패하면 백오프 후 QUEUED로 돌아가고, max_attempts 초과 시 FAILED와 last_error가 남는다", async () => {
    const { id } = await enqueue(tdb.db, {
      type: "DELETE_SUBMISSION",
      payload: {},
      maxAttempts: 2,
    });
    const now = new Date();

    const first = await claimJob(tdb.db, { workerId: "w1", types: ["DELETE_SUBMISSION"] });
    expect(first?.id).toBe(id);
    expect(await failJob(tdb.db, id, "w1", { error: "boom 1", backoff: () => 30_000, now })).toBe(
      "RETRY",
    );
    let row = await getJob(tdb.db, id);
    expect(row?.status).toBe("QUEUED");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("boom 1");
    expect(row?.lockedBy).toBeNull();
    expect(row?.runAfter.getTime()).toBe(now.getTime() + 30_000);

    // 백오프 시간이 지나기 전에는 잡히지 않는다.
    expect(
      await claimJob(tdb.db, { workerId: "w1", types: ["DELETE_SUBMISSION"], now }),
    ).toBeNull();
    const second = await claimJob(tdb.db, {
      workerId: "w2",
      types: ["DELETE_SUBMISSION"],
      now: new Date(now.getTime() + 30_001),
    });
    expect(second?.id).toBe(id);
    expect(second?.attempts).toBe(2);

    expect(await failJob(tdb.db, id, "w2", { error: "boom 2" })).toBe("FAILED");
    row = await getJob(tdb.db, id);
    expect(row?.status).toBe("FAILED");
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBe("boom 2");
  });

  it("nonRetryable 실패는 남은 시도와 무관하게 FAILED다", async () => {
    const { id } = await enqueue(tdb.db, {
      type: "DELETE_SUBMISSION",
      payload: {},
      maxAttempts: 5,
    });
    await claimJob(tdb.db, { workerId: "w1", types: ["DELETE_SUBMISSION"] });
    expect(await failJob(tdb.db, id, "w1", { error: "핸들러 없음", nonRetryable: true })).toBe(
      "FAILED",
    );
    expect((await getJob(tdb.db, id))?.status).toBe("FAILED");
  });

  it("heartbeat가 끊긴 RUNNING job은 회수되어 다른 워커가 잡는다", async () => {
    const { id } = await enqueue(tdb.db, { type: "RERUN_EXECUTION", payload: {}, maxAttempts: 3 });
    const claimed = await claimJob(tdb.db, { workerId: "w-dead", types: ["RERUN_EXECUTION"] });
    expect(claimed?.id).toBe(id);

    // 아직 살아 있는 heartbeat는 회수하지 않는다.
    expect(await reclaimStaleJobs(tdb.db, { staleMs: 60_000 })).toEqual({
      requeued: [],
      failed: [],
    });

    const later = new Date(Date.now() + 120_000);
    const reclaimed = await reclaimStaleJobs(tdb.db, { staleMs: 60_000, now: later });
    expect(reclaimed).toEqual({ requeued: [id], failed: [] });

    const row = await getJob(tdb.db, id);
    expect(row?.status).toBe("QUEUED");
    expect(row?.lockedBy).toBeNull();
    expect(row?.lastError).toMatch(/ENVIRONMENT.*w-dead/);

    // 원래 워커는 소유권을 잃었다.
    expect(await heartbeatJob(tdb.db, id, "w-dead")).toBe(false);
    expect(await completeJob(tdb.db, id, "w-dead")).toBe(false);
    expect(await failJob(tdb.db, id, "w-dead", { error: "late" })).toBe("LOST");

    const again = await claimJob(tdb.db, { workerId: "w-alive", types: ["RERUN_EXECUTION"] });
    expect(again?.id).toBe(id);
    expect(again?.attempts).toBe(2);
    expect(await heartbeatJob(tdb.db, id, "w-alive")).toBe(true);
    expect(await completeJob(tdb.db, id, "w-alive")).toBe(true);
  });

  it("시도 횟수를 다 쓴 job이 회수되면 FAILED가 된다", async () => {
    const { id } = await enqueue(tdb.db, { type: "RERUN_EXECUTION", payload: {}, maxAttempts: 1 });
    await claimJob(tdb.db, { workerId: "w-dead", types: ["RERUN_EXECUTION"] });
    const reclaimed = await reclaimStaleJobs(tdb.db, {
      staleMs: 1_000,
      now: new Date(Date.now() + 10_000),
    });
    expect(reclaimed).toEqual({ requeued: [], failed: [id] });
    expect((await getJob(tdb.db, id))?.status).toBe("FAILED");
  });

  it("release는 attempts를 되돌리고 QUEUED로 반납한다", async () => {
    const { id } = await enqueue(tdb.db, { type: "EVALUATE_SUBMISSION", payload: {} });
    await claimJob(tdb.db, { workerId: "w1", types: ["EVALUATE_SUBMISSION"] });
    expect(await releaseJob(tdb.db, id, "w1")).toBe(true);
    const row = await getJob(tdb.db, id);
    expect(row?.status).toBe("QUEUED");
    expect(row?.attempts).toBe(0);
    expect(row?.lockedBy).toBeNull();
    const again = await claimJob(tdb.db, { workerId: "w2", types: ["EVALUATE_SUBMISSION"] });
    expect(again?.id).toBe(id);
    await completeJob(tdb.db, id, "w2");
  });

  it("cancel은 QUEUED·RUNNING job만 CANCELLED로 바꾸고 워커는 heartbeat로 알게 된다", async () => {
    const { id } = await enqueue(tdb.db, { type: "EVALUATE_SUBMISSION", payload: {} });
    await claimJob(tdb.db, { workerId: "w1", types: ["EVALUATE_SUBMISSION"] });
    expect(await cancelJob(tdb.db, id)).toBe(true);
    expect(await heartbeatJob(tdb.db, id, "w1")).toBe(false);
    expect(await cancelJob(tdb.db, id)).toBe(false);
    expect((await getJob(tdb.db, id))?.status).toBe("CANCELLED");
  });
});
