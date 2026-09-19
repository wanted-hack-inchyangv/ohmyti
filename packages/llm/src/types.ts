import type { AiReviewKind, AiUsage } from "@ohmyti/core";
import type { ZodType } from "zod";
import type { ForbidScoreKeys } from "./output-guard";

/** LLM 호출 용도. TICKET.md 1.5의 네 곳과 같다. */
export type LlmPurpose = AiReviewKind;

/** 호출 사용량. `AiUsage`에 비용까지 포함한다. */
export type LlmUsage = AiUsage;

export interface LlmRequest<T> {
  purpose: LlmPurpose;
  /** `definePrompt()`가 만든 `<상수>+<내용 해시>` 문자열 */
  promptVersion: string;
  /** 용도별 시스템 프롬프트 본문. 출력 형식 안내와 데이터 경계 문구는 어댑터가 덧붙인다 */
  system: string;
  /**
   * 사용자 메시지로 보낼 입력. 문자열이면 그대로, 객체면 JSON으로 보낸다.
   * 신뢰하지 않는 텍스트는 반드시 `untrusted()`로 감싸 넣는다 (G-06).
   */
  input: string | Record<string, unknown>;
  /** 출력 스키마. 점수·판정 키(score, points, earned, verdict)를 둘 수 없다 (G-01) */
  schema: ZodType<T>;
  /** 출력이 스키마를 따르게 하는 예시. 시스템 프롬프트에 JSON으로 들어간다 */
  example?: T;
  maxTokens: number;
}

export interface LlmResult<T> {
  output: T;
  /** 응답이 보고한 실제 모델 이름 (요청한 별칭과 다를 수 있다) */
  model: string;
  usage: LlmUsage;
  costUsd: number;
  requestId: string;
  /** 스키마 검증 실패로 재요청한 횟수를 포함한 전체 요청 수 (1 또는 2) */
  attempts: number;
}

export interface LlmClient {
  /** 기록용 제공자 이름 (`deepseek`, `fake`) */
  readonly provider: string;
  /** 설정된 모델 이름. 응답 모델을 모를 때(제공자 오류) 기록에 쓴다 */
  readonly model: string;
  complete<T>(request: LlmRequest<T> & ForbidScoreKeys<T>): Promise<LlmResult<T>>;
}
