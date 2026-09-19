import { LlmProviderError } from "./errors";
import type { ForbidScoreKeys } from "./output-guard";
import { completeStructured, type ChatMessage, type RawCompletion } from "./structured";
import type { LlmClient, LlmPurpose, LlmRequest, LlmResult } from "./types";

/**
 * 가짜 응답 하나. `output`은 JSON으로 직렬화해 돌려주고, `raw`는 원문 그대로 돌려준다
 * (잘못된 JSON 재현용). `finishReason`으로 잘린 응답도 흉내 낸다.
 */
export type FakeReply =
  | { output: unknown; finishReason?: string }
  | { raw: string; finishReason?: string }
  | { error: Error };

/**
 * purpose별 응답. 배열이면 요청마다 앞에서부터 하나씩 쓰고 마지막 항목을 반복한다.
 * 함수면 요청 번호(1부터)와 보낸 메시지로 응답을 만든다.
 */
export type FakeScript =
  FakeReply | FakeReply[] | ((ctx: { attempt: number; messages: ChatMessage[] }) => FakeReply);

export interface FakeLlmOptions {
  responses: Partial<Record<LlmPurpose, FakeScript>>;
  model?: string;
  /** 요청 하나당 보고할 사용량. 예산 테스트에서 비용을 흉내 낸다 */
  usagePerRequest?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface FakeSentRequest {
  purpose: LlmPurpose;
  messages: ChatMessage[];
}

/** 단위 테스트용 LLM. 네트워크를 쓰지 않으며 검증·재요청 규칙은 실제 구현과 같다. */
export class FakeLlmClient implements LlmClient {
  readonly provider = "fake";
  readonly model: string;
  /** 전송된 요청 기록 (재요청 포함). 프롬프트 스냅샷 테스트에 쓴다 */
  readonly sent: FakeSentRequest[] = [];
  private readonly counters = new Map<LlmPurpose, number>();

  constructor(private readonly options: FakeLlmOptions) {
    this.model = options.model ?? "fake-model";
  }

  complete<T>(request: LlmRequest<T> & ForbidScoreKeys<T>): Promise<LlmResult<T>> {
    return completeStructured(request, (messages) => {
      const attempt = (this.counters.get(request.purpose) ?? 0) + 1;
      this.counters.set(request.purpose, attempt);
      this.sent.push({ purpose: request.purpose, messages: messages.map((m) => ({ ...m })) });
      const reply = this.pick(request.purpose, attempt, messages);
      if ("error" in reply) return Promise.reject(reply.error);
      return Promise.resolve(this.toRaw(reply, attempt));
    });
  }

  private pick(purpose: LlmPurpose, attempt: number, messages: ChatMessage[]): FakeReply {
    const script = this.options.responses[purpose];
    if (script === undefined) {
      return { error: new LlmProviderError(`FakeLlmClient에 ${purpose} 응답이 없습니다`) };
    }
    if (typeof script === "function") return script({ attempt, messages });
    if (Array.isArray(script)) {
      const reply = script[Math.min(attempt, script.length) - 1];
      if (!reply)
        return { error: new LlmProviderError(`FakeLlmClient ${purpose} 응답 배열이 비었습니다`) };
      return reply;
    }
    return script;
  }

  private toRaw(reply: { output: unknown } | { raw: string }, attempt: number): RawCompletion {
    const usage = this.options.usagePerRequest ?? {};
    const content = "raw" in reply ? reply.raw : JSON.stringify(reply.output);
    return {
      content,
      finishReason: (reply as { finishReason?: string }).finishReason ?? "stop",
      model: this.model,
      requestId: `fake-${attempt}`,
      inputTokens: usage.inputTokens ?? 100,
      cachedInputTokens: 0,
      outputTokens: usage.outputTokens ?? 20,
      costUsd: usage.costUsd ?? 0,
    };
  }
}
