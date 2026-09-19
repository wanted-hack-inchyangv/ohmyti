import { LlmBudgetExceededError, LlmConfigError, failedCallOf } from "./errors";
import type { ForbidScoreKeys } from "./output-guard";
import { roundUsd } from "./pricing";
import type { LlmClient, LlmRequest, LlmResult } from "./types";

export const DEFAULT_LLM_MAX_CALLS_PER_EVALUATION = 20;
export const DEFAULT_LLM_MAX_COST_USD_PER_EVALUATION = 0.5;

export interface LlmBudgetLimits {
  maxCalls: number;
  maxCostUsd: number;
}

/**
 * evaluation 하나의 LLM 호출 수·비용 상한. 워커가 evaluation마다 새로 만든다.
 * 호출 수는 `complete()` 단위로 센다(스키마 재요청은 같은 호출에 포함). 비용은 실패한 호출도 더한다.
 * 비용은 호출 후에만 알 수 있으므로 상한을 넘긴 뒤의 다음 호출부터 막는다.
 */
export class LlmBudget {
  private calls = 0;
  private costUsd = 0;

  constructor(readonly limits: LlmBudgetLimits) {
    if (!Number.isInteger(limits.maxCalls) || limits.maxCalls < 0) {
      throw new LlmConfigError("LLM_MAX_CALLS_PER_EVALUATION은 0 이상의 정수여야 합니다");
    }
    if (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd < 0) {
      throw new LlmConfigError("LLM_MAX_COST_USD_PER_EVALUATION은 0 이상의 숫자여야 합니다");
    }
  }

  get used(): { calls: number; costUsd: number } {
    return { calls: this.calls, costUsd: this.costUsd };
  }

  /** 호출 직전에 부른다. 상한에 도달했으면 던지고, 아니면 호출 수를 하나 늘린다. */
  reserve(): void {
    const max = { calls: this.limits.maxCalls, costUsd: this.limits.maxCostUsd };
    if (this.calls >= this.limits.maxCalls) {
      throw new LlmBudgetExceededError("calls", this.used, max);
    }
    if (this.costUsd >= this.limits.maxCostUsd) {
      throw new LlmBudgetExceededError("cost", this.used, max);
    }
    this.calls += 1;
  }

  addCost(costUsd: number): void {
    this.costUsd = roundUsd(this.costUsd + costUsd);
  }
}

/** 예산을 확인한 뒤 내부 클라이언트를 호출하는 데코레이터. */
export class BudgetedLlmClient implements LlmClient {
  readonly provider: string;
  readonly model: string;

  constructor(
    private readonly inner: LlmClient,
    readonly budget: LlmBudget,
  ) {
    this.provider = inner.provider;
    this.model = inner.model;
  }

  async complete<T>(request: LlmRequest<T> & ForbidScoreKeys<T>): Promise<LlmResult<T>> {
    this.budget.reserve();
    try {
      const result = await this.inner.complete(request);
      this.budget.addCost(result.costUsd);
      return result;
    } catch (error) {
      const failed = failedCallOf(error);
      if (failed) this.budget.addCost(failed.costUsd);
      throw error;
    }
  }
}

/** `LLM_MAX_CALLS_PER_EVALUATION`, `LLM_MAX_COST_USD_PER_EVALUATION`에서 상한을 읽는다. */
export function llmBudgetLimitsFromEnv(env: Record<string, string | undefined>): LlmBudgetLimits {
  return {
    maxCalls: parseNumber(
      env.LLM_MAX_CALLS_PER_EVALUATION,
      DEFAULT_LLM_MAX_CALLS_PER_EVALUATION,
      "LLM_MAX_CALLS_PER_EVALUATION",
    ),
    maxCostUsd: parseNumber(
      env.LLM_MAX_COST_USD_PER_EVALUATION,
      DEFAULT_LLM_MAX_COST_USD_PER_EVALUATION,
      "LLM_MAX_COST_USD_PER_EVALUATION",
    ),
  };
}

function parseNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new LlmConfigError(`${name} 값이 올바르지 않습니다: ${raw}`);
  }
  return value;
}
