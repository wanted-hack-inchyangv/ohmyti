import type { LlmUsage } from "./types";

/** LLM 어댑터 오류의 공통 부모. 호출 측은 `llmStepOutcome()`으로 결과 상태에 매핑한다. */
export class LlmError extends Error {
  override name = "LlmError";
}

/** 설정 누락·잘못된 값. 워커 기동 시점에 드러나야 한다. */
export class LlmConfigError extends LlmError {
  override name = "LlmConfigError";
}

/** 출력 스키마에 점수·판정 키가 있다 (G-01). 프로그래밍 오류이므로 API를 호출하기 전에 던진다. */
export class LlmForbiddenOutputKeyError extends LlmError {
  override name = "LlmForbiddenOutputKeyError";
  constructor(readonly keys: string[]) {
    super(`LLM 출력 스키마에 점수·판정 키를 둘 수 없습니다: ${keys.join(", ")}`);
  }
}

/** 호출 전에 evaluation 예산(호출 수·비용)을 넘었다. API는 호출하지 않았다. */
export class LlmBudgetExceededError extends LlmError {
  override name = "LlmBudgetExceededError";
  constructor(
    readonly limit: "calls" | "cost",
    readonly used: { calls: number; costUsd: number },
    readonly max: { calls: number; costUsd: number },
  ) {
    super(
      limit === "calls"
        ? `LLM 호출 수 상한(${max.calls}회)에 도달했습니다`
        : `LLM 비용 상한($${max.costUsd})에 도달했습니다 (사용 $${used.costUsd.toFixed(6)})`,
    );
  }
}

/** 호출은 했지만 쓸 수 있는 출력을 얻지 못했을 때의 공통 정보. 사용량은 과금되었으므로 기록한다. */
export interface LlmFailedCall {
  model: string;
  usage: LlmUsage;
  costUsd: number;
  attempts: number;
  requestId?: string;
}

/** 재요청 후에도 출력이 JSON 파싱 또는 zod 검증을 통과하지 못했다. */
export class LlmOutputInvalidError extends LlmError {
  override name = "LlmOutputInvalidError";
  constructor(
    message: string,
    readonly call: LlmFailedCall,
    /** 마지막 응답 원문 (디버깅용, 길이 제한) */
    readonly lastRaw: string,
  ) {
    super(message);
  }
}

/** 응답이 `max_tokens`에서 잘렸거나(`length`) 필터·자원 부족으로 끝났다. */
export class LlmIncompleteOutputError extends LlmError {
  override name = "LlmIncompleteOutputError";
  constructor(
    readonly finishReason: string,
    readonly call: LlmFailedCall,
  ) {
    super(`LLM 응답이 완결되지 않았습니다 (finish_reason=${finishReason})`);
  }
}

/** 네트워크·인증·속도 제한 등 제공자 호출 자체의 실패. */
export class LlmProviderError extends LlmError {
  override name = "LlmProviderError";
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** 실패한 호출에 사용량이 있으면 돌려준다 (기록·예산 반영용). */
export function failedCallOf(error: unknown): LlmFailedCall | undefined {
  if (error instanceof LlmOutputInvalidError || error instanceof LlmIncompleteOutputError) {
    return error.call;
  }
  return undefined;
}
