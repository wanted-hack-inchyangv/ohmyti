import type { ZodType } from "zod";
import { LlmIncompleteOutputError, LlmOutputInvalidError, type LlmFailedCall } from "./errors";
import { assertNoForbiddenOutputKeys, outputJsonSchema } from "./output-guard";
import { buildRetryMessage, buildSystemPrompt, buildUserMessage } from "./prompt";
import { roundUsd } from "./pricing";
import type { LlmRequest, LlmResult, LlmUsage } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 제공자 응답 하나를 정규화한 값. */
export interface RawCompletion {
  content: string | null;
  /** `stop`, `length`, `content_filter`, `insufficient_system_resource` 등 */
  finishReason: string;
  model: string;
  requestId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** 제공자별 전송 함수. 구조화 출력의 검증·재요청 규칙은 모든 구현이 공유한다. */
export type ChatTransport = (
  messages: ChatMessage[],
  options: { maxTokens: number },
) => Promise<RawCompletion>;

/** 스키마 검증 실패 시 재요청 횟수. 첫 요청 + 1회 재요청. */
export const MAX_OUTPUT_ATTEMPTS = 2;

const RAW_PREVIEW_CHARS = 2000;

/**
 * 구조화 출력 호출: 시스템 프롬프트에 JSON Schema·예시·데이터 경계 문구를 붙여 보내고,
 * 응답을 JSON 파싱 → zod 검증한다. 실패하면 오류 내용을 붙여 1회 재요청하고,
 * 그래도 실패하면 `LlmOutputInvalidError`를 던진다. `finish_reason`이 `stop`이 아니면
 * 재요청하지 않고 `LlmIncompleteOutputError`를 던진다 (잘린 JSON을 고쳐 쓰지 않는다).
 */
export async function completeStructured<T>(
  request: LlmRequest<T>,
  transport: ChatTransport,
): Promise<LlmResult<T>> {
  assertNoForbiddenOutputKeys(request.schema);
  const system = buildSystemPrompt(
    request.system,
    outputJsonSchema(request.schema),
    request.example,
  );
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: buildUserMessage(request.input) },
  ];

  const total = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
  let model = "unknown";
  let requestId: string | undefined;

  for (let attempt = 1; attempt <= MAX_OUTPUT_ATTEMPTS; attempt += 1) {
    const raw = await transport(messages, { maxTokens: request.maxTokens });
    total.inputTokens += raw.inputTokens;
    total.cachedInputTokens += raw.cachedInputTokens;
    total.outputTokens += raw.outputTokens;
    total.costUsd = roundUsd(total.costUsd + raw.costUsd);
    model = raw.model;
    requestId = raw.requestId;
    const lastRaw = raw.content ?? "";

    const failed = (): LlmFailedCall => ({
      model,
      usage: toUsage(total),
      costUsd: total.costUsd,
      attempts: attempt,
      ...(requestId ? { requestId } : {}),
    });

    if (raw.finishReason !== "stop") {
      throw new LlmIncompleteOutputError(raw.finishReason, failed());
    }

    const parsed = parseAndValidate(lastRaw, request.schema);
    if (parsed.ok) {
      return {
        output: parsed.value,
        model,
        usage: toUsage(total),
        costUsd: total.costUsd,
        requestId: raw.requestId,
        attempts: attempt,
      };
    }
    const lastProblem = parsed.problem;
    if (attempt === MAX_OUTPUT_ATTEMPTS) {
      throw new LlmOutputInvalidError(
        `LLM 출력이 ${attempt}회 모두 스키마 검증에 실패했습니다: ${lastProblem}`,
        failed(),
        lastRaw.slice(0, RAW_PREVIEW_CHARS),
      );
    }
    messages.push(
      { role: "assistant", content: lastRaw.slice(0, RAW_PREVIEW_CHARS) },
      { role: "user", content: buildRetryMessage(lastProblem) },
    );
  }
  // 반복문 안에서 반드시 반환하거나 던진다.
  throw new Error("unreachable");
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; problem: string };

export function parseAndValidate<T>(content: string, schema: ZodType<T>): ParseResult<T> {
  if (content.trim() === "") return { ok: false, problem: "빈 응답" };
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return { ok: false, problem: `JSON 파싱 실패: ${(error as Error).message}` };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, problem: `스키마 불일치: ${issues}` };
}

function toUsage(total: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}): LlmUsage {
  return {
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cachedInputTokens: total.cachedInputTokens,
    costUsd: total.costUsd,
  };
}
