import { readFileSync } from "node:fs";
import { AiReviewKindSchema } from "@ohmyti/core";
import { createLlmClient, LlmConfigError, type FakeLlmOptions, type LlmClient } from "@ohmyti/llm";
import { z } from "zod";

type Env = Record<string, string | undefined>;

/**
 * `LLM_PROVIDER=fake`일 때 쓸 purpose별 고정 응답 파일 (T-406). E2E의 워커가 실제 API 없이 결정적인 결과를 내게 한다.
 * 형식: `{ "RUBRIC_DRAFT": { "output": {...} }, "MUTATION_TARGETS": { "output": { "candidates": [] } } }`
 * (`raw` 문자열 응답도 받는다). 파일이 없거나 형식이 틀리면 `LlmConfigError`다.
 */
const FakeReplySchema = z.union([
  z.strictObject({ output: z.unknown(), finishReason: z.string().optional() }),
  z.strictObject({ raw: z.string(), finishReason: z.string().optional() }),
]);
const FakeResponsesFileSchema = z.partialRecord(AiReviewKindSchema, FakeReplySchema);

export function loadFakeLlmOptions(env: Env): FakeLlmOptions | undefined {
  const file = env.LLM_FAKE_RESPONSES_FILE?.trim();
  if (!file) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new LlmConfigError(
      `LLM_FAKE_RESPONSES_FILE을 읽지 못했습니다 (${file}): ${(error as Error).message}`,
    );
  }
  const parsed = FakeResponsesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LlmConfigError(
      `LLM_FAKE_RESPONSES_FILE 형식이 올바르지 않습니다: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return { responses: parsed.data as FakeLlmOptions["responses"] };
}

/** 워커 공용 LLM 클라이언트. `fake`면 응답 파일을 붙인다. 설정 오류는 `LlmConfigError`로 던진다 */
export function createWorkerLlmClient(env: Env): LlmClient {
  const fake = loadFakeLlmOptions(env);
  return createLlmClient(env, fake ? { fake } : {});
}
