import { createWorkerDb, requireDatabaseUrl } from "@ohmyti/db";
import { createArtifactStore } from "@ohmyti/storage";
import { collectSecrets, loadWorkerConfig } from "./config";
import { registerDeleteSubmission } from "./delete";
import { startHealthServer } from "./health";
import { createLogger } from "./logger";
import {
  createLlmForEvaluation,
  createProductionRuntime,
  registerEvaluateSubmission,
} from "./pipeline";
import { createGitHubClient } from "./repo";
import { createDefaultRegistry, type HandlerRegistry } from "./registry";
import { loadRerunLimit, registerRerunExecution } from "./rerun";
import { registerDraftRubric } from "./rubric-draft";
import { registerRubricValidation } from "./validate-rubric";
import { createWorker } from "./worker";

export interface RunWorkerOptions {
  /** 기본은 선언된 모든 타입에 미구현 핸들러를 채운 레지스트리 */
  registry?: HandlerRegistry | undefined;
  env?: Record<string, string | undefined> | undefined;
}

/**
 * 프로덕션 레지스트리: `EVALUATE_SUBMISSION`(T-204), `RERUN_EXECUTION`(T-307), `VALIDATE_RUBRIC`·`REEVALUATE_ASSIGNMENT_VERSION`(T-405)이
 * 러너·설정을 공유한다. `DRAFT_RUBRIC`(T-406)은 LLM만 쓴다. `DELETE_SUBMISSION`(T-506)은 DB·스토어만 쓴다
 */
export function createProductionRegistry(deps: {
  store: ReturnType<typeof createArtifactStore>;
  secrets: readonly string[];
  logger: ReturnType<typeof createLogger>;
  env: Record<string, string | undefined>;
}): HandlerRegistry {
  const runtime = createProductionRuntime(deps);
  const registry = registerEvaluateSubmission(createDefaultRegistry(), deps, runtime);
  const limit = loadRerunLimit(deps.env);
  deps.logger.info({ limit }, "RERUN_EXECUTION 핸들러를 등록합니다");
  registerRerunExecution(registry, {
    runner: runtime.runner,
    config: runtime.config,
    limit,
    secrets: deps.secrets,
  });
  deps.logger.info("DRAFT_RUBRIC 핸들러를 등록합니다");
  registerDraftRubric(registry, deps.env);
  deps.logger.info("DELETE_SUBMISSION 핸들러를 등록합니다");
  registerDeleteSubmission(registry, { cancelWaitMs: loadWorkerConfig(deps.env).staleMs });
  deps.logger.info("VALIDATE_RUBRIC·REEVALUATE_ASSIGNMENT_VERSION 핸들러를 등록합니다");
  return registerRubricValidation(registry, {
    runner: runtime.runner,
    github: createGitHubClient({ token: runtime.env.GITHUB_TOKEN?.trim() || undefined }),
    config: runtime.config,
    secrets: deps.secrets,
    llm: createLlmForEvaluation(runtime.env, deps.logger),
  });
}

/**
 * 워커 프로세스 본체. DB·스토어·로거를 만들고 루프와 헬스 서버를 띄운 뒤 SIGTERM·SIGINT를 기다린다.
 * 종료 신호가 오면 진행 중 job이 끝나거나 QUEUED로 반납된 뒤 자원을 정리하고 resolve한다.
 */
export async function runWorkerProcess(options: RunWorkerOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const config = loadWorkerConfig(env);
  const logger = createLogger({ level: config.logLevel, secrets: collectSecrets(env) });
  const dbHandle = createWorkerDb(requireDatabaseUrl());
  const store = createArtifactStore(env);
  const secrets = collectSecrets(env);
  const registry = options.registry ?? createProductionRegistry({ store, secrets, logger, env });

  const worker = createWorker({ db: dbHandle.db, store, registry, config, logger });
  worker.start();

  const health =
    config.healthPort > 0
      ? await startHealthServer({ port: config.healthPort, worker, db: dbHandle.db, logger })
      : null;

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const onSignal = (signal: NodeJS.Signals) => {
      if (shuttingDown) {
        logger.warn({ signal }, "이미 종료 중입니다");
        return;
      }
      shuttingDown = true;
      logger.info({ signal }, "종료 신호를 받았습니다");
      resolve();
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  });

  await worker.stop();
  await health?.close();
  await dbHandle.close();
  logger.info("워커 프로세스를 마칩니다");
}
