import {
  acknowledgeCancelledJob,
  claimJob,
  completeJob,
  failJob,
  heartbeatJob,
  reclaimStaleJobs,
  releaseJob,
  type Database,
  type JobRow,
} from "@ohmyti/db";
import type { ArtifactStore } from "@ohmyti/storage";
import type { WorkerConfig } from "./config";
import type { Logger } from "./logger";
import {
  JobLostError,
  NonRetryableJobError,
  type HandlerRegistry,
  type JobContext,
} from "./registry";

/** 유휴 상태에서도 배포 로그에 남기는 "폴링 중" info 로그의 최소 간격 */
export const POLL_LOG_INTERVAL_MS = 60_000;

export interface WorkerDeps {
  db: Database;
  store: ArtifactStore;
  registry: HandlerRegistry;
  config: WorkerConfig;
  logger: Logger;
}

export interface WorkerStatus {
  workerId: string;
  running: boolean;
  stopping: boolean;
  activeJobs: number;
  /** 마지막 폴링 시각. 루프가 멈췄는지 판단하는 근거 */
  lastPollAt: Date | null;
  processed: { succeeded: number; retried: number; failed: number; released: number };
}

export interface Worker {
  start(): void;
  /** 진행 중 job이 끝나거나 반납될 때까지 기다린 뒤 resolve한다 */
  stop(): Promise<void>;
  status(): WorkerStatus;
  /** 테스트용: 큐가 빌 때까지(진행 중 job 포함) 기다린다 */
  drain(options?: { timeoutMs?: number }): Promise<void>;
}

interface ActiveJob {
  job: JobRow;
  done: Promise<void>;
  /** 반납 시 함께 멈춰야 하는 heartbeat 타이머 */
  heartbeatTimer: NodeJS.Timeout | null;
  /** 소유권을 잃으면(회수·취소) abort한다. 핸들러의 `ctx.signal`에 합쳐진다 */
  lostController: AbortController;
}

/**
 * 폴링 루프. 동시 실행 수만큼 job을 claim해 핸들러에 넘기고, heartbeat와 오래된 lock 회수를 주기적으로 수행한다.
 * 종료 요청이 오면 새 job을 받지 않고 진행 중 job이 끝나기를 `shutdownGraceMs`까지 기다린 뒤 남은 것은 QUEUED로 반납한다.
 */
export function createWorker(deps: WorkerDeps): Worker {
  const { db, store, registry, config } = deps;
  const logger = deps.logger.child({ workerId: config.workerId });
  const active = new Map<string, ActiveJob>();
  /** 종료 유예 시간이 지나 QUEUED로 반납한 job. 뒤늦게 끝나도 결과를 기록하지 않는다 */
  const releasedOnShutdown = new Set<string>();
  const shutdown = new AbortController();
  const counters = { succeeded: 0, retried: 0, failed: 0, released: 0 };

  let running = false;
  let stopping = false;
  let loopPromise: Promise<void> | null = null;
  let lastPollAt: Date | null = null;
  /** 마지막 claim이 비었고 진행 중 job도 없는 상태가 시작된 시각 */
  let idleSince: Date | null = null;
  let lastReclaimAt = 0;
  let lastPollLogAt = 0;
  let wake: (() => void) | null = null;

  /** 배포 로그에서 루프가 살아 있는지 볼 수 있도록 폴링 기록을 남긴다. 매 폴링은 debug, 1분에 한 번은 info. */
  function logPoll(claimed: boolean): void {
    logger.debug({ claimed, activeJobs: active.size }, "폴링");
    const now = Date.now();
    if (now - lastPollLogAt < POLL_LOG_INTERVAL_MS) return;
    lastPollLogAt = now;
    logger.info(
      { activeJobs: active.size, processed: counters, pollIntervalMs: config.pollIntervalMs },
      "폴링 중",
    );
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = finish;
    });
  }

  function wakeUp(): void {
    wake?.();
  }

  async function reclaimIfDue(): Promise<void> {
    const now = Date.now();
    if (now - lastReclaimAt < config.reclaimIntervalMs) return;
    lastReclaimAt = now;
    try {
      const result = await reclaimStaleJobs(db, { staleMs: config.staleMs });
      if (result.requeued.length > 0 || result.failed.length > 0) {
        logger.warn(
          { requeued: result.requeued, failed: result.failed, staleMs: config.staleMs },
          "heartbeat가 끊긴 job을 회수했습니다",
        );
      }
    } catch (error) {
      logger.error({ err: error }, "오래된 lock 회수에 실패했습니다");
    }
  }

  async function loop(): Promise<void> {
    while (!stopping) {
      await reclaimIfDue();
      let claimed: JobRow | null = null;
      if (active.size < config.concurrency) {
        try {
          claimed = await claimJob(db, { workerId: config.workerId, types: registry.types() });
          lastPollAt = new Date();
          logPoll(claimed !== null);
          if (claimed) idleSince = null;
          else if (active.size === 0) idleSince ??= lastPollAt;
        } catch (error) {
          logger.error({ err: error }, "job claim에 실패했습니다");
        }
      }
      if (stopping) {
        // 종료 직전에 잡은 job은 실행하지 않고 바로 돌려준다.
        if (claimed) await safeRelease(claimed);
        break;
      }
      if (claimed) {
        runJob(claimed);
        continue;
      }
      await sleep(config.pollIntervalMs);
    }
  }

  function runJob(job: JobRow): void {
    const jobLogger = logger.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    const entry: ActiveJob = {
      job,
      done: Promise.resolve(),
      heartbeatTimer: null,
      lostController: new AbortController(),
    };
    active.set(job.id, entry);
    entry.done = execute(entry, jobLogger)
      .then(() => acknowledgeIfCancelled(job, jobLogger))
      .finally(() => {
        stopHeartbeat(entry);
        active.delete(job.id);
        wakeUp();
      });
  }

  /**
   * 핸들러(러너 정리 포함)가 끝난 뒤, 그 사이 job이 취소됐으면 `locked_by`를 비워 실행이 멈췄음을 알린다.
   * 제출 삭제(T-506)가 이 신호를 기다린 뒤 아티팩트와 행을 지운다. 취소되지 않은 job이면 아무것도 바뀌지 않는다.
   */
  async function acknowledgeIfCancelled(job: JobRow, jobLogger: Logger): Promise<void> {
    try {
      if (await acknowledgeCancelledJob(db, job.id, config.workerId)) {
        jobLogger.info("취소된 job의 실행을 정리하고 빠져나왔습니다");
      }
    } catch (error) {
      jobLogger.error({ err: error }, "취소된 job의 정리 완료를 기록하지 못했습니다");
    }
  }

  function stopHeartbeat(entry: ActiveJob): void {
    if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
  }

  async function execute(entry: ActiveJob, jobLogger: Logger): Promise<void> {
    const { job } = entry;
    const handler = registry.get(job.type);
    const startedAt = Date.now();
    jobLogger.info("job 시작");

    let lost = false;
    const heartbeat = async () => {
      const owned = await heartbeatJob(db, job.id, config.workerId);
      if (!owned) {
        lost = true;
        entry.lostController.abort(new JobLostError(job.id));
        throw new JobLostError(job.id);
      }
    };
    entry.heartbeatTimer = setInterval(() => {
      heartbeat().catch((error: unknown) => {
        if (error instanceof JobLostError) {
          stopHeartbeat(entry);
          jobLogger.warn(
            "heartbeat 중 소유권을 잃었습니다. 핸들러는 다음 heartbeat나 신호 확인에서 중단됩니다",
          );
        } else {
          jobLogger.error({ err: error }, "heartbeat 기록에 실패했습니다");
        }
      });
    }, config.heartbeatIntervalMs);

    const ctx: JobContext = {
      logger: jobLogger,
      db,
      store,
      heartbeat,
      signal: AbortSignal.any([shutdown.signal, entry.lostController.signal]),
      workerId: config.workerId,
    };

    try {
      if (!handler) {
        throw new NonRetryableJobError(`job 타입 ${job.type}에 등록된 핸들러가 없습니다`);
      }
      await handler(job, ctx);
      stopHeartbeat(entry);
      if (releasedOnShutdown.has(job.id)) {
        jobLogger.warn("반납된 뒤 끝난 job이므로 결과를 기록하지 않습니다");
        return;
      }
      const completed = await completeJob(db, job.id, config.workerId);
      if (completed) {
        counters.succeeded += 1;
        jobLogger.info({ durationMs: Date.now() - startedAt }, "job 성공");
      } else {
        jobLogger.warn("job은 끝났지만 소유권을 잃어 SUCCEEDED로 기록하지 못했습니다");
      }
    } catch (error) {
      stopHeartbeat(entry);
      if (lost || error instanceof JobLostError) {
        jobLogger.warn("소유권을 잃은 job의 실행을 중단했습니다");
        return;
      }
      if (releasedOnShutdown.has(job.id)) {
        jobLogger.warn({ err: error }, "반납된 뒤 실패한 job이므로 결과를 기록하지 않습니다");
        return;
      }
      const message = errorMessage(error);
      const nonRetryable = error instanceof NonRetryableJobError;
      const outcome = await failJob(db, job.id, config.workerId, { error: message, nonRetryable });
      if (outcome === "RETRY") {
        counters.retried += 1;
        jobLogger.warn(
          { err: error, durationMs: Date.now() - startedAt },
          "job 실패. 백오프 후 재시도합니다",
        );
      } else if (outcome === "FAILED") {
        counters.failed += 1;
        jobLogger.error(
          { err: error, durationMs: Date.now() - startedAt },
          "job 실패. 더 이상 재시도하지 않습니다",
        );
      } else {
        jobLogger.warn({ err: error }, "job이 실패했지만 소유권을 잃어 기록하지 못했습니다");
      }
    }
  }

  async function safeRelease(job: JobRow): Promise<void> {
    try {
      const released = await releaseJob(db, job.id, config.workerId);
      if (released) {
        counters.released += 1;
        releasedOnShutdown.add(job.id);
        logger.info(
          { jobId: job.id, jobType: job.type },
          "종료를 위해 job을 QUEUED로 반납했습니다",
        );
      }
    } catch (error) {
      logger.error(
        { err: error, jobId: job.id },
        "job 반납에 실패했습니다. 오래된 lock 회수로 복구됩니다",
      );
    }
  }

  async function waitForActive(timeoutMs: number): Promise<boolean> {
    if (active.size === 0) return true;
    if (timeoutMs === 0) return false;
    const all = Promise.all([...active.values()].map((a) => a.done)).then(() => true);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([all, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      stopping = false;
      lastReclaimAt = 0;
      idleSince = null;
      loopPromise = loop().catch((error: unknown) => {
        logger.fatal({ err: error }, "워커 루프가 예외로 끝났습니다");
      });
      logger.info(
        {
          concurrency: config.concurrency,
          pollIntervalMs: config.pollIntervalMs,
          staleMs: config.staleMs,
          types: registry.types(),
        },
        "워커 시작",
      );
    },

    async stop() {
      if (!running) return;
      stopping = true;
      wakeUp();
      await loopPromise;
      logger.info(
        { activeJobs: active.size, graceMs: config.shutdownGraceMs },
        "종료 요청. 진행 중 job을 기다립니다",
      );

      const finished = await waitForActive(config.shutdownGraceMs);
      if (!finished) {
        // 유예 시간이 지났다. 아직 도는 job은 QUEUED로 돌려 다른 워커가 이어서 하게 한다.
        // 먼저 반납해 소유권을 넘긴 뒤 abort 신호를 보낸다. 반대 순서면 신호를 받고 곧바로 끝난 핸들러가
        // 반납 전에 SUCCEEDED를 기록할 수 있다.
        for (const entry of active.values()) {
          stopHeartbeat(entry);
          await safeRelease(entry.job);
        }
        shutdown.abort();
        // 핸들러가 abort 신호에 반응해 빠져나올 시간을 짧게 준다.
        await waitForActive(1_000);
      }
      running = false;
      logger.info({ processed: counters }, "워커 종료");
    },

    status() {
      return {
        workerId: config.workerId,
        running,
        stopping,
        activeJobs: active.size,
        lastPollAt,
        processed: { ...counters },
      };
    },

    async drain(options = {}) {
      const deadline = Date.now() + (options.timeoutMs ?? 30_000);
      while (Date.now() < deadline) {
        if (idleSince !== null && active.size === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("drain 시간 초과");
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack
      ? `${error.name}: ${error.message}\n${error.stack}`
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}
