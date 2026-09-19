import { createHash } from "node:crypto";
import { canonicalJson } from "@ohmyti/core";
import { insertAiReview, type DbExecutor, type NewAiReview } from "@ohmyti/db";
import { LlmForbiddenOutputKeyError, failedCallOf } from "./errors";
import { outputJsonSchema, type ForbidScoreKeys } from "./output-guard";
import type { LlmClient, LlmRequest, LlmResult } from "./types";

/** 기록 대상 범위. 호출이 어느 evaluation·과제 버전·제출에 속하는지 */
export interface AiReviewScope {
  evaluationId?: string;
  assignmentVersionId?: string;
  submissionId?: string;
}

export type AiReviewSink = (row: NewAiReview) => Promise<void>;

/** `ai_reviews` 테이블에 쓰는 기본 기록처. */
export function createDbAiReviewSink(db: DbExecutor): AiReviewSink {
  return async (row) => {
    await insertAiReview(db, row);
  };
}

/**
 * 입력 다이제스트: 용도·프롬프트 버전·시스템 프롬프트·입력·출력 스키마·예시의 정규화 JSON sha256.
 * 같은 입력이면 키 순서와 무관하게 같은 값이 나온다. 모델과 max_tokens는 제외한다(출력 조건이지 입력이 아니다).
 */
export function llmInputDigest<T>(request: LlmRequest<T>): string {
  const material = canonicalJson({
    purpose: request.purpose,
    promptVersion: request.promptVersion,
    system: request.system,
    input: request.input,
    outputSchema: outputJsonSchema(request.schema),
    example: request.example ?? null,
  });
  return createHash("sha256").update(material).digest("hex");
}

/**
 * 모든 호출을 `ai_reviews`에 한 행씩 남기는 데코레이터. 성공이면 검증된 출력을,
 * 실패면 `{ error: { name, message } }`와 과금된 사용량을 남긴다.
 * API를 호출하기 전에 거부된 경우(금지 키 스키마)는 호출이 아니므로 남기지 않는다.
 * 예산 초과는 바깥의 BudgetedLlmClient가 먼저 막으므로 여기까지 오지 않는다.
 */
export class RecordingLlmClient implements LlmClient {
  readonly provider: string;
  readonly model: string;

  constructor(
    private readonly inner: LlmClient,
    private readonly sink: AiReviewSink,
    private readonly scope: AiReviewScope = {},
  ) {
    this.provider = inner.provider;
    this.model = inner.model;
  }

  async complete<T>(request: LlmRequest<T> & ForbidScoreKeys<T>): Promise<LlmResult<T>> {
    const inputDigest = llmInputDigest(request);
    const base = {
      kind: request.purpose,
      ...this.scope,
      provider: this.provider,
      promptVersion: request.promptVersion,
      inputDigest,
    };
    let result: LlmResult<T>;
    try {
      result = await this.inner.complete(request);
    } catch (error) {
      if (!(error instanceof LlmForbiddenOutputKeyError)) {
        const failed = failedCallOf(error);
        await this.sink({
          ...base,
          model: failed?.model ?? this.model,
          output: {
            error: { name: (error as Error).name, message: (error as Error).message },
          },
          usage: failed?.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          costUsd: failed?.costUsd ?? 0,
        });
      }
      throw error;
    }
    await this.sink({
      ...base,
      model: result.model,
      output: result.output,
      usage: result.usage,
      costUsd: result.costUsd,
    });
    return result;
  }
}
