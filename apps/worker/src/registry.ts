import { JobTypeSchema, type JobType } from "@ohmyti/core";
import type { Database, JobRow } from "@ohmyti/db";
import type { ArtifactStore } from "@ohmyti/storage";
import type { Logger } from "./logger";

/** 핸들러가 받는 실행 문맥. */
export interface JobContext {
  /** job id·type·워커 id가 붙고 비밀값이 마스킹되는 로거 */
  logger: Logger;
  db: Database;
  store: ArtifactStore;
  /** 소유권을 아직 갖고 있는지 확인하며 heartbeat를 기록한다. 회수·취소되었으면 `JobLostError`를 던진다 */
  heartbeat: () => Promise<void>;
  /** 워커가 종료 중이거나 이 job의 소유권을 잃었으면(회수·취소, T-506) abort된다. 오래 걸리는 단계는 이 신호를 확인한다 */
  signal: AbortSignal;
  workerId: string;
}

export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<void>;

/** 다시 시도해도 의미가 없는 실패. 남은 시도와 무관하게 FAILED로 끝낸다. */
export class NonRetryableJobError extends Error {
  override readonly name = "NonRetryableJobError";
}

/** heartbeat 도중 소유권을 잃었다(회수·취소). 핸들러는 정리만 하고 빠져나와야 한다. */
export class JobLostError extends Error {
  override readonly name = "JobLostError";
  constructor(jobId: string) {
    super(`job ${jobId}의 소유권을 잃었습니다 (회수 또는 취소)`);
  }
}

export class HandlerRegistry {
  private readonly handlers = new Map<JobType, JobHandler>();

  register(type: JobType, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  get(type: JobType): JobHandler | undefined {
    return this.handlers.get(type);
  }

  types(): JobType[] {
    return [...this.handlers.keys()];
  }
}

/**
 * 아직 핸들러가 없는 타입의 기본 동작. 재시도해도 결과가 같으므로 즉시 FAILED로 끝낸다 (G-09: 처리한 척하지 않는다).
 * 각 타입의 실제 핸들러는 T-204(EVALUATE_SUBMISSION), T-307(RERUN_EXECUTION), T-405(VALIDATE_RUBRIC,
 * REEVALUATE_ASSIGNMENT_VERSION), T-506(DELETE_SUBMISSION)에서 등록한다.
 */
export const notImplementedHandler: JobHandler = (job) => {
  return Promise.reject(
    new NonRetryableJobError(`job 타입 ${job.type}의 핸들러가 아직 구현되지 않았습니다`),
  );
};

/** 선언된 모든 job 타입에 기본 핸들러를 채운 레지스트리. 이후 티켓이 `register`로 덮어쓴다. */
export function createDefaultRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry();
  for (const type of JobTypeSchema.options) {
    registry.register(type, notImplementedHandler);
  }
  return registry;
}
