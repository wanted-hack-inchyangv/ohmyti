import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources";
import { LlmConfigError, LlmProviderError } from "./errors";
import { computeDeepSeekCostUsd } from "./pricing";
import { completeStructured, type ChatTransport, type RawCompletion } from "./structured";
import type { LlmClient, LlmRequest, LlmResult } from "./types";
import type { ForbidScoreKeys } from "./output-guard";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
/** 요청 하나의 제한 시간. SDK 기본(10분)은 파이프라인 단계 제한보다 길다. */
export const DEFAULT_DEEPSEEK_TIMEOUT_MS = 120_000;

export interface DeepSeekOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  /** SDK의 429·5xx 재시도 횟수. 스키마 재요청과 별개다 */
  maxRetries?: number;
  /** 테스트용: 비용 계산 시각 */
  now?: () => Date;
  /** 테스트용: 전송 함수를 바꿔 끼운다. 기본은 openai SDK */
  createCompletion?: (body: ChatCompletionCreateParamsNonStreaming) => Promise<ChatCompletion>;
}

/**
 * DeepSeek(OpenAI 호환 API) 구현. 공식 문서 기준(2026-09-19):
 * - JSON 모드는 `response_format: { type: "json_object" }`이고 프롬프트에 `json` 단어와 예시가 있어야 한다.
 * - 사고 모드가 기본값이며 사고 모드에서는 temperature가 무시되므로 `thinking: { type: "disabled" }`로 끈다.
 * - `finish_reason`이 `length`면 JSON이 잘린 것이므로 오류로 처리한다.
 */
export class DeepSeekLlmClient implements LlmClient {
  readonly provider = "deepseek";
  readonly model: string;
  private readonly send: (body: ChatCompletionCreateParamsNonStreaming) => Promise<ChatCompletion>;
  private readonly now: () => Date;

  constructor(options: DeepSeekOptions) {
    if (!options.apiKey) throw new LlmConfigError("DEEP_SEEK_API_KEY가 비어 있습니다");
    this.model = options.model || DEFAULT_DEEPSEEK_MODEL;
    this.now = options.now ?? (() => new Date());
    if (options.createCompletion) {
      this.send = options.createCompletion;
    } else {
      const client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL || DEFAULT_DEEPSEEK_BASE_URL,
        timeout: options.timeoutMs ?? DEFAULT_DEEPSEEK_TIMEOUT_MS,
        maxRetries: options.maxRetries ?? 2,
      });
      this.send = (body) => client.chat.completions.create(body);
    }
  }

  complete<T>(request: LlmRequest<T> & ForbidScoreKeys<T>): Promise<LlmResult<T>> {
    return completeStructured(request, this.transport);
  }

  private readonly transport: ChatTransport = async (messages, { maxTokens }) => {
    const body = {
      model: this.model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      // DeepSeek 전용 파라미터. openai SDK는 알 수 없는 본문 키를 그대로 보낸다.
      thinking: { type: "disabled" },
    } as ChatCompletionCreateParamsNonStreaming;

    let completion: ChatCompletion;
    try {
      completion = await this.send(body);
    } catch (error) {
      throw toProviderError(error);
    }
    return this.normalize(completion);
  };

  private normalize(completion: ChatCompletion): RawCompletion {
    const choice = completion.choices[0];
    const usage = completion.usage as
      (NonNullable<ChatCompletion["usage"]> & { prompt_cache_hit_tokens?: number }) | undefined;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const cachedInputTokens =
      usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    const model = completion.model || this.model;
    const { costUsd } = computeDeepSeekCostUsd(
      model,
      { inputTokens, cachedInputTokens, outputTokens },
      this.now(),
    );
    return {
      content: choice?.message?.content ?? null,
      finishReason: choice?.finish_reason ?? "missing",
      model,
      requestId: completion.id,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      costUsd,
    };
  }
}

function toProviderError(error: unknown): LlmProviderError {
  if (error instanceof OpenAI.APIError) {
    // 메시지에 키가 섞이지 않도록 상태·유형만 남긴다.
    return new LlmProviderError(
      `DeepSeek API 호출 실패 (status=${error.status ?? "none"}, type=${error.type ?? "unknown"})`,
      typeof error.status === "number" ? error.status : undefined,
      { cause: error },
    );
  }
  return new LlmProviderError(
    `DeepSeek API 호출 실패: ${(error as Error)?.message ?? error}`,
    undefined,
    {
      cause: error,
    },
  );
}
