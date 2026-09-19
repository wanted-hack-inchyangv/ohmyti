import {
  LlmBudgetExceededError,
  LlmConfigError,
  LlmError,
  LlmForbiddenOutputKeyError,
} from "./errors";

/**
 * LLM 단계의 결과 상태. 파이프라인은 LLM 실패로 중단하지 않는다 (G-14).
 * - `OK`: 검증된 출력이 있다.
 * - `INCONCLUSIVE`: 호출했지만 쓸 수 있는 출력이 없다(스키마 불일치, 잘린 응답, 제공자 오류).
 *   이 단계에 의존하는 항목은 미확정으로 남기고 0점으로 만들지 않는다 (G-04).
 * - `NOT_RUN`: 예산 초과·설정 없음으로 호출하지 않았다. UI에는 "LLM 미실행"으로 표시한다.
 */
export type LlmStepOutcome<T> =
  | { status: "OK"; value: T }
  | { status: "INCONCLUSIVE"; reason: string; errorName: string }
  | { status: "NOT_RUN"; reason: string; errorName: string };

/**
 * LLM 단계를 실행하고 오류를 결과 상태로 바꾼다. LLM 어댑터 오류가 아닌 예외(DB 기록 실패 등)와
 * 프로그래밍 오류(금지 키 스키마)는 그대로 던진다.
 */
export async function llmStepOutcome<T>(run: () => Promise<T>): Promise<LlmStepOutcome<T>> {
  try {
    return { status: "OK", value: await run() };
  } catch (error) {
    if (error instanceof LlmForbiddenOutputKeyError || !(error instanceof LlmError)) throw error;
    if (error instanceof LlmBudgetExceededError || error instanceof LlmConfigError) {
      return { status: "NOT_RUN", reason: error.message, errorName: error.name };
    }
    // LlmOutputInvalidError, LlmIncompleteOutputError, LlmProviderError
    return { status: "INCONCLUSIVE", reason: error.message, errorName: error.name };
  }
}
