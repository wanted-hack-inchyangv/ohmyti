/**
 * `VALIDATE_RUBRIC`·`REEVALUATE_ASSIGNMENT_VERSION` job 핸들러 (TICKET.md T-405).
 *
 * - `VALIDATE_RUBRIC`: `runRubricValidation`. 러너·설정·LLM은 `EVALUATE_SUBMISSION`과 공유한다.
 * - `REEVALUATE_ASSIGNMENT_VERSION`: 새 승인 버전의 재평가 대상 제출마다 `EVALUATE_SUBMISSION { submissionId, assignmentVersionId }`
 *   job을 넣는다. 제출마다 job을 나누어 한 제출의 환경 장애가 다른 제출의 재평가를 막지 않고 시도 횟수도 따로 센다.
 */
import {
  ReevaluateAssignmentVersionPayloadSchema,
  ValidateRubricPayloadSchema,
} from "@ohmyti/core";
import {
  enqueueSubmissionReevaluation,
  getAssignmentVersion,
  listReevaluationTargets,
  type Database,
} from "@ohmyti/db";
import type { LlmClient } from "@ohmyti/llm";
import type { SandboxRunner } from "@ohmyti/runner";
import type { GitHubClient } from "../repo";
import type { PipelineConfig, PipelineHooks } from "../pipeline";
import { NonRetryableJobError, type HandlerRegistry, type JobHandler } from "../registry";
import { runRubricValidation } from "./validate";

export interface ValidateRubricHandlerDeps {
  runner: SandboxRunner;
  github: GitHubClient;
  config: PipelineConfig;
  secrets?: readonly string[] | undefined;
  hooks?: PipelineHooks | undefined;
  llm?: ((db: Database, evaluationId: string) => LlmClient | undefined) | undefined;
}

export function createValidateRubricHandler(deps: ValidateRubricHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const payload = ValidateRubricPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new NonRetryableJobError(
        `VALIDATE_RUBRIC payload가 올바르지 않습니다: ${payload.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    await runRubricValidation(
      {
        assignmentVersionId: payload.data.assignmentVersionId,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        since: new Date(job.createdAt),
      },
      {
        db: ctx.db,
        store: ctx.store,
        runner: deps.runner,
        github: deps.github,
        config: deps.config,
        logger: ctx.logger,
        secrets: deps.secrets,
        heartbeat: ctx.heartbeat,
        signal: ctx.signal,
        hooks: deps.hooks,
        llmForEvaluation: deps.llm ? (evaluationId) => deps.llm!(ctx.db, evaluationId) : undefined,
      },
    );
  };
}

export function createReevaluateAssignmentVersionHandler(): JobHandler {
  return async (job, ctx) => {
    const payload = ReevaluateAssignmentVersionPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new NonRetryableJobError(
        `REEVALUATE_ASSIGNMENT_VERSION payload가 올바르지 않습니다: ${payload.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const version = await getAssignmentVersion(ctx.db, payload.data.assignmentVersionId);
    if (!version) {
      throw new NonRetryableJobError(
        `과제 버전을 찾을 수 없습니다: ${payload.data.assignmentVersionId}`,
      );
    }
    if (version.status !== "APPROVED") {
      throw new NonRetryableJobError(
        `RUBRIC_NOT_APPROVED: 과제 버전 ${version.id}의 상태가 ${version.status}입니다. 승인된 버전으로만 재평가합니다`,
      );
    }
    const targets = await listReevaluationTargets(ctx.db, version.id);
    let created = 0;
    for (const target of targets) {
      const result = await enqueueSubmissionReevaluation(ctx.db, {
        submissionId: target.id,
        assignmentVersionId: version.id,
      });
      if (result.created) created += 1;
    }
    ctx.logger.info(
      { assignmentVersionId: version.id, targets: targets.length, created },
      "재평가 job을 넣었습니다",
    );
  };
}

export function registerRubricValidation(
  registry: HandlerRegistry,
  deps: ValidateRubricHandlerDeps,
): HandlerRegistry {
  return registry
    .register("VALIDATE_RUBRIC", createValidateRubricHandler(deps))
    .register("REEVALUATE_ASSIGNMENT_VERSION", createReevaluateAssignmentVersionHandler());
}
