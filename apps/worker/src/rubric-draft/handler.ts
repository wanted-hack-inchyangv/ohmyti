/**
 * `DRAFT_RUBRIC` job 핸들러 (TICKET.md T-406). web이 넣은 `rubric_drafts` 행의 명세로 초안을 만들어 채운다.
 *
 * - 호출은 예산(`LLM_MAX_*_PER_EVALUATION`을 초안 하나에 적용) → `ai_reviews` 기록 → 제공자 순으로 감싼다.
 * - LLM 출력 오류·예산 초과·설정 없음은 재시도해도 같으므로 행을 FAILED로 닫고 job은 성공으로 끝낸다.
 *   제공자 오류(네트워크·API)는 시도가 남았으면 예외로 재시도하고, 마지막 시도면 FAILED로 닫는다.
 * - 이미 끝난 행(중복 job)은 건드리지 않는다.
 */
import { DraftRubricPayloadSchema } from "@ohmyti/core";
import {
  completeRubricDraft,
  failRubricDraft,
  getRubricDraft,
  insertAiReview,
  markRubricDraftRunning,
} from "@ohmyti/db";
import { MUTATION_CATALOG } from "@ohmyti/analysis";
import {
  createEvaluationLlmClient,
  llmBudgetLimitsFromEnv,
  LlmConfigError,
  type LlmClient,
} from "@ohmyti/llm";
import { createWorkerLlmClient } from "../llm";
import { NonRetryableJobError, type HandlerRegistry, type JobHandler } from "../registry";
import { generateRubricDraft, RUBRIC_DRAFT_PROMPT, type MutationCatalogHint } from "./generate";

type Env = Record<string, string | undefined>;

export interface DraftRubricHandlerDeps {
  /** 제공자 클라이언트. 설정 오류면 오류 자체를 넘겨 초안을 `LLM_NOT_CONFIGURED`로 닫는다 */
  llm: LlmClient | LlmConfigError;
  limits: { maxCalls: number; maxCostUsd: number };
  catalog?: readonly MutationCatalogHint[] | undefined;
}

export const DEFAULT_MUTATION_CATALOG_HINTS: readonly MutationCatalogHint[] = MUTATION_CATALOG.map(
  (m) => ({ id: m.id, description: m.description }),
);

export function createDraftRubricHandler(deps: DraftRubricHandlerDeps): JobHandler {
  const catalog = deps.catalog ?? DEFAULT_MUTATION_CATALOG_HINTS;
  return async (job, ctx) => {
    const payload = DraftRubricPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new NonRetryableJobError(
        `DRAFT_RUBRIC payload가 올바르지 않습니다: ${payload.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const draftId = payload.data.rubricDraftId;
    const existing = await getRubricDraft(ctx.db, draftId);
    if (!existing) throw new NonRetryableJobError(`AI 초안 요청을 찾을 수 없습니다: ${draftId}`);
    const draft = await markRubricDraftRunning(ctx.db, draftId);
    if (!draft) {
      ctx.logger.info({ draftId, status: existing.status }, "이미 끝난 AI 초안 요청입니다");
      return;
    }

    if (deps.llm instanceof LlmConfigError) {
      await failRubricDraft(ctx.db, {
        id: draftId,
        code: "LLM_NOT_CONFIGURED",
        message: `LLM 미실행: ${deps.llm.message}`,
      });
      return;
    }

    const spec = await ctx.store.get(draft.specRef);
    if (!spec) {
      await failRubricDraft(ctx.db, {
        id: draftId,
        code: "SPEC_UNAVAILABLE",
        message: `명세 원문을 찾을 수 없습니다 (${draft.specRef})`,
      });
      return;
    }

    let aiReviewId: string | null = null;
    const llm = createEvaluationLlmClient({
      base: deps.llm,
      sink: async (row) => {
        aiReviewId = (await insertAiReview(ctx.db, row)).id;
      },
      // 초안은 evaluation·과제 버전에 속하지 않는다. 행과의 연결은 rubric_drafts.ai_review_id로 남긴다
      scope: {},
      limits: deps.limits,
    });
    const result = await generateRubricDraft({
      llm,
      spec: Buffer.from(spec.body).toString("utf8"),
      catalog,
    });
    await ctx.heartbeat();

    if (result.status === "OK") {
      await completeRubricDraft(ctx.db, {
        id: draftId,
        rubric: result.rubric,
        validationErrors: result.validationErrors,
        notes: result.notes,
        droppedMutationIds: result.droppedMutationIds,
        aiReviewId,
        model: result.model,
        promptVersion: RUBRIC_DRAFT_PROMPT.promptVersion,
      });
      ctx.logger.info(
        { draftId, validationErrors: result.validationErrors.length },
        "AI 기준 초안을 만들었습니다",
      );
      return;
    }
    if (result.code === "LLM_PROVIDER_ERROR" && job.attempts < job.maxAttempts) {
      // 재시도한다. 행은 RUNNING으로 남고 다음 시도가 이어받는다
      throw new Error(`AI 초안 LLM 호출 실패(재시도 예정): ${result.message}`);
    }
    await failRubricDraft(ctx.db, {
      id: draftId,
      code: result.code,
      message: result.message,
      aiReviewId,
      model: llm.model,
      promptVersion: RUBRIC_DRAFT_PROMPT.promptVersion,
    });
    ctx.logger.warn({ draftId, code: result.code }, "AI 기준 초안을 만들지 못했습니다");
  };
}

/** 워커 레지스트리에 `DRAFT_RUBRIC`을 등록한다. LLM 설정 오류는 기동을 막지 않고 요청마다 사유로 남긴다 */
export function registerDraftRubric(registry: HandlerRegistry, env: Env): HandlerRegistry {
  let llm: LlmClient | LlmConfigError;
  let limits = { maxCalls: 0, maxCostUsd: 0 };
  try {
    llm = createWorkerLlmClient(env);
    limits = llmBudgetLimitsFromEnv(env);
  } catch (error) {
    if (!(error instanceof LlmConfigError)) throw error;
    llm = error;
  }
  return registry.register("DRAFT_RUBRIC", createDraftRubricHandler({ llm, limits }));
}
