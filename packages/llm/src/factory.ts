import { BudgetedLlmClient, LlmBudget, type LlmBudgetLimits } from "./budget";
import { DeepSeekLlmClient } from "./deepseek";
import { LlmConfigError } from "./errors";
import { FakeLlmClient, type FakeLlmOptions } from "./fake";
import { RecordingLlmClient, type AiReviewScope, type AiReviewSink } from "./recording";
import type { LlmClient } from "./types";

export const LLM_PROVIDERS = ["deepseek", "fake"] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

/**
 * 제공자 교체 지점. `LLM_PROVIDER`(기본 `deepseek`)로 구현을 고른다.
 * deepseek: `DEEP_SEEK_API_KEY`(필수), `LLM_BASE_URL`, `LLM_MODEL`.
 * fake: 테스트·로컬 데모용. `fake` 옵션의 응답을 쓴다.
 */
export function createLlmClient(
  env: Record<string, string | undefined>,
  options: { fake?: FakeLlmOptions } = {},
): LlmClient {
  const provider = env.LLM_PROVIDER?.trim() || "deepseek";
  switch (provider) {
    case "deepseek": {
      const apiKey = env.DEEP_SEEK_API_KEY?.trim();
      if (!apiKey)
        throw new LlmConfigError("LLM_PROVIDER=deepseek에는 DEEP_SEEK_API_KEY가 필요합니다");
      return new DeepSeekLlmClient({
        apiKey,
        ...(env.LLM_BASE_URL?.trim() ? { baseURL: env.LLM_BASE_URL.trim() } : {}),
        ...(env.LLM_MODEL?.trim() ? { model: env.LLM_MODEL.trim() } : {}),
      });
    }
    case "fake":
      return new FakeLlmClient(options.fake ?? { responses: {} });
    default:
      throw new LlmConfigError(
        `지원하지 않는 LLM_PROVIDER입니다: ${provider} (지원: ${LLM_PROVIDERS.join(", ")})`,
      );
  }
}

/**
 * evaluation 하나에 쓸 클라이언트: 예산 확인 → 호출 기록 → 제공자 순서로 감싼다.
 * 예산 초과로 막힌 요청은 API를 호출하지 않았으므로 `ai_reviews`에 남지 않는다.
 */
export function createEvaluationLlmClient(options: {
  base: LlmClient;
  sink: AiReviewSink;
  scope: AiReviewScope;
  limits: LlmBudgetLimits;
}): BudgetedLlmClient {
  return new BudgetedLlmClient(
    new RecordingLlmClient(options.base, options.sink, options.scope),
    new LlmBudget(options.limits),
  );
}
