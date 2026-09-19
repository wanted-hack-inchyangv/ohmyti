import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DeepSeekLlmClient } from "./deepseek";
import { LlmConfigError, LlmIncompleteOutputError, LlmProviderError } from "./errors";
import { llmStepOutcome } from "./outcome";
import { noteRequest, NoteSchema, VALID_NOTE } from "./test-fixtures";

function completion(content: string, finishReason = "stop"): ChatCompletion {
  return {
    id: "req-123",
    object: "chat.completion",
    created: 0,
    model: "deepseek-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null },
        logprobs: null,
        finish_reason: finishReason as "stop",
      },
    ],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_tokens_details: { cached_tokens: 200 },
      // DeepSeek 확장 필드
      ...({ prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800 } as object),
    },
  };
}

describe("DeepSeekLlmClient (전송 함수 주입, 네트워크 없음)", () => {
  let fetchSpy: MockInstance<typeof fetch>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("JSON 모드·temperature 0·사고 모드 끔으로 요청하고 사용량과 비용을 계산한다", async () => {
    const bodies: ChatCompletionCreateParamsNonStreaming[] = [];
    const client = new DeepSeekLlmClient({
      apiKey: "sk-test",
      now: () => new Date("2026-09-21T07:00:00Z"), // 월요일 피크
      createCompletion: (body) => {
        bodies.push(body);
        return Promise.resolve(completion(JSON.stringify(VALID_NOTE)));
      },
    });
    const result = await client.complete(noteRequest());

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model: "deepseek-chat",
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 512,
      stream: false,
      thinking: { type: "disabled" },
    });
    expect(bodies[0]!.messages[0]!.content).toContain("json");
    expect(result).toMatchObject({
      output: VALID_NOTE,
      model: "deepseek-flash",
      requestId: "req-123",
      usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 },
    });
    // 200*0.006 + 800*0.3 + 100*1.2 (100만 토큰당) = 0.0000012 + 0.00024 + 0.00012
    expect(result.costUsd).toBe(0.000361);
    expect(result.usage.costUsd).toBe(0.000361);
  });

  it("finish_reason=length면 잘린 출력으로 보고 INCONCLUSIVE", async () => {
    const client = new DeepSeekLlmClient({
      apiKey: "sk-test",
      createCompletion: () => Promise.resolve(completion('{"summary":"', "length")),
    });
    const error = await client.complete(noteRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmIncompleteOutputError);
    expect((error as LlmIncompleteOutputError).call.usage.inputTokens).toBe(1000);
  });

  it("API 오류는 키를 드러내지 않는 LlmProviderError로 바꾼다", async () => {
    const client = new DeepSeekLlmClient({
      apiKey: "sk-secret-value",
      createCompletion: () =>
        Promise.reject(
          OpenAI.APIError.generate(
            401,
            { error: { message: "bad key sk-secret-value" } },
            undefined,
            new Headers(),
          ),
        ),
    });
    const error = (await client
      .complete(noteRequest())
      .catch((e: unknown) => e)) as LlmProviderError;
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.status).toBe(401);
    expect(error.message).not.toContain("sk-secret-value");
    const outcome = await llmStepOutcome(() => Promise.reject(error));
    expect(outcome.status).toBe("INCONCLUSIVE");
  });

  it("키가 없으면 설정 오류", () => {
    expect(() => new DeepSeekLlmClient({ apiKey: "" })).toThrow(LlmConfigError);
  });
});

describe.skipIf(process.env.LLM_INTEGRATION !== "1")(
  "DeepSeek 실제 호출 (LLM_INTEGRATION=1)",
  () => {
    it(".env의 키로 실제 DeepSeek을 호출해 구조화 출력이 zod를 통과한다", async () => {
      const client = new DeepSeekLlmClient({
        apiKey: process.env.DEEP_SEEK_API_KEY ?? "",
        ...(process.env.LLM_BASE_URL ? { baseURL: process.env.LLM_BASE_URL } : {}),
        ...(process.env.LLM_MODEL ? { model: process.env.LLM_MODEL } : {}),
      });
      const result = await client.complete(
        noteRequest({
          task: "아래 실패 정보를 한 문장으로 요약하고 관련 위치를 locations에 넣어라.",
          failure:
            "POST /orders에 quantity=0을 보냈더니 201이 반환됨. 기대값 400. 관련 파일 src/order-service.ts 12행",
        }),
      );
      expect(NoteSchema.parse(result.output)).toEqual(result.output);
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      console.info(
        "[LLM_INTEGRATION]",
        JSON.stringify({
          model: result.model,
          requestId: result.requestId,
          attempts: result.attempts,
          usage: result.usage,
          output: result.output,
        }),
      );
    }, 120_000);
  },
);
