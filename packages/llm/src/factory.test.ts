import { describe, expect, it } from "vitest";
import { DeepSeekLlmClient } from "./deepseek";
import { LlmConfigError } from "./errors";
import { FakeLlmClient } from "./fake";
import { createLlmClient } from "./factory";

describe("createLlmClient", () => {
  it("LLM_PROVIDER로 구현을 고르고 기본값은 deepseek다", () => {
    const client = createLlmClient({ DEEP_SEEK_API_KEY: "sk-test" });
    expect(client).toBeInstanceOf(DeepSeekLlmClient);
    expect(client.model).toBe("deepseek-chat");
    expect(createLlmClient({ DEEP_SEEK_API_KEY: "k", LLM_MODEL: "deepseek-v4-pro" }).model).toBe(
      "deepseek-v4-pro",
    );
    expect(createLlmClient({ LLM_PROVIDER: "fake" })).toBeInstanceOf(FakeLlmClient);
  });

  it("키가 없거나 모르는 제공자면 설정 오류", () => {
    expect(() => createLlmClient({ LLM_PROVIDER: "deepseek" })).toThrow(LlmConfigError);
    expect(() => createLlmClient({ LLM_PROVIDER: "anthropic" })).toThrow(/지원하지 않는/);
  });
});
