/**
 * `RERUN_EXECUTION` job 핸들러 (TICKET.md T-307). payload는 `RerunExecutionPayloadSchema`(`@ohmyti/core`)로 검증한다.
 * 상한은 `RERUN_LIMIT_PER_EVALUATION`(기본 20)이며 web(`requestRerun`)과 워커가 같은 값을 읽어야 한다.
 */
import { DEFAULT_RERUN_LIMIT_PER_EVALUATION, RerunExecutionPayloadSchema } from "@ohmyti/core";
import type { SandboxRunner } from "@ohmyti/runner";
import type { PipelineConfig } from "../pipeline";
import { NonRetryableJobError, type HandlerRegistry, type JobHandler } from "../registry";
import { runRerunExecution } from "./execute";

type Env = Record<string, string | undefined>;

/** `RERUN_LIMIT_PER_EVALUATION`. 없으면 기본 20, 잘못된 값은 오류 */
export function loadRerunLimit(env: Env = process.env): number {
  const raw = env.RERUN_LIMIT_PER_EVALUATION;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RERUN_LIMIT_PER_EVALUATION;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `RERUN_LIMIT_PER_EVALUATION 값 ${JSON.stringify(raw)}은 1 이상의 정수여야 합니다`,
    );
  }
  return value;
}

export interface RerunExecutionHandlerDeps {
  runner: SandboxRunner;
  config: PipelineConfig;
  limit: number;
  secrets?: readonly string[] | undefined;
}

export function createRerunExecutionHandler(deps: RerunExecutionHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const payload = RerunExecutionPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new NonRetryableJobError(
        `RERUN_EXECUTION payload가 올바르지 않습니다: ${payload.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    await runRerunExecution(
      { jobId: job.id, evaluationId: payload.data.evaluationId, caseId: payload.data.caseId },
      {
        db: ctx.db,
        store: ctx.store,
        runner: deps.runner,
        config: deps.config,
        logger: ctx.logger,
        limit: deps.limit,
        secrets: deps.secrets,
        heartbeat: ctx.heartbeat,
        signal: ctx.signal,
      },
    );
  };
}

export function registerRerunExecution(
  registry: HandlerRegistry,
  deps: RerunExecutionHandlerDeps,
): HandlerRegistry {
  return registry.register("RERUN_EXECUTION", createRerunExecutionHandler(deps));
}
