/**
 * `EVALUATE_SUBMISSION` job 핸들러와 프로덕션 조립 (TICKET.md T-204).
 * payload는 `EvaluateSubmissionPayloadSchema`(`@ohmyti/core`)로 검증하고 파이프라인에 넘긴다.
 */
import { EvaluateSubmissionPayloadSchema } from "@ohmyti/core";
import { requestTimeoutFromEnv } from "@ohmyti/harness";
import {
  createDbAiReviewSink,
  createEvaluationLlmClient,
  llmBudgetLimitsFromEnv,
  type LlmClient,
} from "@ohmyti/llm";
import { createRunnerFromEnv as createRunner, type SandboxRunner } from "@ohmyti/runner";
import type { ArtifactStore } from "@ohmyti/storage";
import type { Database } from "@ohmyti/db";
import {
  createGitHubSourcesCollector,
  loadGitHubProfileConfig,
  type GitHubSourcesCollector,
} from "@ohmyti/context";
import { createWorkerLlmClient } from "../llm";
import type { Logger } from "../logger";
import { NonRetryableJobError, type HandlerRegistry, type JobHandler } from "../registry";
import { createGitHubClient, loadRepoCollectConfig, type GitHubClient } from "../repo";
import { MUTATION_STAGE_DEFAULTS } from "../mutation";
import {
  PIPELINE_DEFAULTS,
  runEvaluationPipeline,
  type PipelineConfig,
  type PipelineHooks,
} from "./evaluate";

type Env = Record<string, string | undefined>;

/**
 * `PIPELINE_STAGE_TIMEOUT_MS`·`HARNESS_REQUEST_TIMEOUT_MS`·`ANALYSIS_TIMEOUT_MS`·`TEMPLATE_ROOT`·수집 한도,
 * `MUTATION_STAGE_ENABLED`(기본 켜짐)·`MUTATION_STAGE_TIMEOUT_MS`(기본 5분) (TICKET.md 1.6)
 */
export function loadPipelineConfig(env: Env = process.env): PipelineConfig {
  const templateRoot = env.TEMPLATE_ROOT?.trim();
  if (!templateRoot) {
    throw new Error("TEMPLATE_ROOT가 필요합니다 (예: /opt/templates, 로컬은 ./templates)");
  }
  const raw = env.PIPELINE_STAGE_TIMEOUT_MS;
  let stageTimeoutMs: number = PIPELINE_DEFAULTS.stageTimeoutMs;
  if (raw !== undefined && raw.trim() !== "") {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1000) {
      throw new Error(
        `PIPELINE_STAGE_TIMEOUT_MS 값 ${JSON.stringify(raw)}은 1000 이상의 정수여야 합니다`,
      );
    }
    stageTimeoutMs = value;
  }
  const rawAnalysis = env.ANALYSIS_TIMEOUT_MS;
  let analysisTimeoutMs: number | undefined;
  if (rawAnalysis !== undefined && rawAnalysis.trim() !== "") {
    const value = Number(rawAnalysis);
    if (!Number.isSafeInteger(value) || value < 1000) {
      throw new Error(
        `ANALYSIS_TIMEOUT_MS 값 ${JSON.stringify(rawAnalysis)}은 1000 이상의 정수여야 합니다`,
      );
    }
    analysisTimeoutMs = value;
  }
  const rawMutationTimeout = env.MUTATION_STAGE_TIMEOUT_MS;
  let mutationTimeoutMs: number = MUTATION_STAGE_DEFAULTS.timeoutMs;
  if (rawMutationTimeout !== undefined && rawMutationTimeout.trim() !== "") {
    const value = Number(rawMutationTimeout);
    if (!Number.isSafeInteger(value) || value < 1000) {
      throw new Error(
        `MUTATION_STAGE_TIMEOUT_MS 값 ${JSON.stringify(rawMutationTimeout)}은 1000 이상의 정수여야 합니다`,
      );
    }
    mutationTimeoutMs = value;
  }
  const rawMutationEnabled = env.MUTATION_STAGE_ENABLED?.trim().toLowerCase();
  let mutationEnabled = true;
  if (rawMutationEnabled !== undefined && rawMutationEnabled !== "") {
    if (["1", "true"].includes(rawMutationEnabled)) mutationEnabled = true;
    else if (["0", "false"].includes(rawMutationEnabled)) mutationEnabled = false;
    else {
      throw new Error(
        `MUTATION_STAGE_ENABLED 값 ${JSON.stringify(env.MUTATION_STAGE_ENABLED)}은 true·false·1·0 중 하나여야 합니다`,
      );
    }
  }
  const repo = loadRepoCollectConfig(env);
  return {
    stageTimeoutMs,
    requestTimeoutMs: requestTimeoutFromEnv(env),
    templateRoot,
    repoLimits: { maxFiles: repo.maxFiles, maxBytes: repo.maxBytes },
    workRoot: env.SANDBOX_WORK_ROOT?.trim() || undefined,
    analysisTimeoutMs,
    mutation: { enabled: mutationEnabled, timeoutMs: mutationTimeoutMs },
  };
}

/**
 * evaluation마다 예산·기록을 감싼 LLM 클라이언트를 만든다(T-401 `createEvaluationLlmClient`).
 * 키가 없거나 설정이 잘못됐으면 LLM 없이(휴리스틱만) 진행하도록 undefined를 돌려준다.
 */
export function createLlmForEvaluation(
  env: Env,
  logger: Logger,
): (db: Database, evaluationId: string) => LlmClient | undefined {
  let base: LlmClient;
  try {
    base = createWorkerLlmClient(env);
  } catch (error) {
    logger.warn(
      { err: error },
      "LLM 클라이언트를 만들 수 없어 mutation 위치 탐색은 AST 휴리스틱만 씁니다",
    );
    return () => undefined;
  }
  const limits = llmBudgetLimitsFromEnv(env);
  return (db, evaluationId) =>
    createEvaluationLlmClient({
      base,
      sink: createDbAiReviewSink(db),
      scope: { evaluationId },
      limits,
    });
}

export interface EvaluateSubmissionHandlerDeps {
  runner: SandboxRunner;
  github: GitHubClient;
  config: PipelineConfig;
  secrets?: readonly string[] | undefined;
  hooks?: PipelineHooks | undefined;
  /** evaluation용 LLM (`createLlmForEvaluation`). 없으면 mutation 위치 탐색은 휴리스틱만 쓴다 */
  llm?: ((db: Database, evaluationId: string) => LlmClient | undefined) | undefined;
  /** GitHub 프로필 보충 조회기 (T-502). 없으면 CONTEXT_LINK에서 조회하지 않는다 */
  githubSources?: GitHubSourcesCollector | undefined;
}

export function createEvaluateSubmissionHandler(deps: EvaluateSubmissionHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const payload = EvaluateSubmissionPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new NonRetryableJobError(
        `EVALUATE_SUBMISSION payload가 올바르지 않습니다: ${payload.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    await runEvaluationPipeline(
      {
        submissionId: payload.data.submissionId,
        assignmentVersionId: payload.data.assignmentVersionId,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
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
        githubSources: deps.githubSources,
      },
    );
  };
}

/** `SANDBOX_RUNNER`로 러너를 고른다: `local`(T-108) 또는 `vercel`(T-209) */
export function createRunnerFromEnv(
  env: Env,
  store: ArtifactStore,
  secrets: readonly string[],
): SandboxRunner {
  return createRunner(env, { artifactStore: store, secrets });
}

export interface ProductionRegistryDeps {
  store: ArtifactStore;
  secrets: readonly string[];
  logger: Logger;
  env?: Env | undefined;
}

/** 프로덕션 핸들러들이 공유하는 러너·파이프라인 설정 (`TEMPLATE_ROOT`·`SANDBOX_RUNNER` 등) */
export function createProductionRuntime(deps: ProductionRegistryDeps): {
  env: Env;
  config: PipelineConfig;
  runner: SandboxRunner;
} {
  const env = deps.env ?? process.env;
  return {
    env,
    config: loadPipelineConfig(env),
    runner: createRunnerFromEnv(env, deps.store, deps.secrets),
  };
}

/**
 * 프로덕션 레지스트리: 기본(미구현) 핸들러 위에 `EVALUATE_SUBMISSION`을 등록한다.
 * 다른 job 타입은 각 티켓(T-307 `registerRerunExecution`, T-405, T-506)이 같은 방식으로 덮어쓴다.
 * `runtime`을 주면 러너·설정을 다른 핸들러와 공유한다.
 */
export function registerEvaluateSubmission(
  registry: HandlerRegistry,
  deps: ProductionRegistryDeps,
  runtime: ReturnType<typeof createProductionRuntime> = createProductionRuntime(deps),
): HandlerRegistry {
  const { env, config, runner } = runtime;
  const github = createGitHubClient({ token: env.GITHUB_TOKEN?.trim() || undefined });
  const profile = loadGitHubProfileConfig(env);
  deps.logger.info(
    {
      runner: runner.kind,
      templateRoot: config.templateRoot,
      stageTimeoutMs: config.stageTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      repoLimits: config.repoLimits,
      mutation: config.mutation,
      githubToken: Boolean(env.GITHUB_TOKEN),
      maxProfileRepos: profile.maxRepos,
    },
    "EVALUATE_SUBMISSION 핸들러를 등록합니다",
  );
  return registry.register(
    "EVALUATE_SUBMISSION",
    createEvaluateSubmissionHandler({
      runner,
      github,
      config,
      secrets: deps.secrets,
      llm: createLlmForEvaluation(env, deps.logger),
      githubSources: createGitHubSourcesCollector({
        token: profile.token,
        maxRepos: profile.maxRepos,
        secrets: deps.secrets,
      }),
    }),
  );
}
