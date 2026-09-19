import { describe, expect, it } from "vitest";
import { BudgetedLlmClient, LlmBudget, llmBudgetLimitsFromEnv } from "./budget";
import { LlmBudgetExceededError, LlmConfigError } from "./errors";
import { FakeLlmClient } from "./fake";
import { llmStepOutcome, type LlmStepOutcome } from "./outcome";
import { noteRequest, VALID_NOTE, type Note } from "./test-fixtures";
import type { LlmResult } from "./types";

function budgeted(limits: { maxCalls: number; maxCostUsd: number }, costUsd = 0) {
  const fake = new FakeLlmClient({
    responses: { EVIDENCE_REVIEW: { output: VALID_NOTE } },
    usagePerRequest: { costUsd },
  });
  return { fake, client: new BudgetedLlmClient(fake, new LlmBudget(limits)) };
}

describe("evaluation 예산", () => {
  it("호출 수 상한을 넘으면 API를 부르지 않고 LlmBudgetExceededError", async () => {
    const { fake, client } = budgeted({ maxCalls: 2, maxCostUsd: 10 });
    await client.complete(noteRequest());
    await client.complete(noteRequest());
    const error = await client.complete(noteRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmBudgetExceededError);
    expect((error as LlmBudgetExceededError).limit).toBe("calls");
    expect(fake.sent).toHaveLength(2);
  });

  it("비용 상한에 도달하면 다음 호출부터 막는다 (실패한 호출 비용도 더한다)", async () => {
    const fake = new FakeLlmClient({
      responses: { EVIDENCE_REVIEW: { raw: "bad" } },
      usagePerRequest: { costUsd: 0.03 },
    });
    const budget = new LlmBudget({ maxCalls: 10, maxCostUsd: 0.05 });
    const client = new BudgetedLlmClient(fake, budget);
    await expect(client.complete(noteRequest())).rejects.toThrow("스키마 검증에 실패");
    // 재요청 포함 2회 요청 = 0.06
    expect(budget.used).toEqual({ calls: 1, costUsd: 0.06 });
    const error = await client.complete(noteRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmBudgetExceededError);
    expect((error as LlmBudgetExceededError).limit).toBe("cost");
    expect(fake.sent).toHaveLength(2);
  });

  it("호출 측 파이프라인은 예산 초과를 'LLM 미실행'으로 기록하고 나머지 단계를 계속 진행한다", async () => {
    const { client } = budgeted({ maxCalls: 1, maxCostUsd: 10 });
    const log: string[] = [];
    const llmResults: LlmStepOutcome<LlmResult<Note>>[] = [];

    // 결정적 단계와 LLM 단계가 섞인 파이프라인 흉내
    const stages: Array<() => Promise<void>> = [
      () => Promise.resolve(void log.push("REQUIREMENT_VERIFY")),
      async () => void llmResults.push(await llmStepOutcome(() => client.complete(noteRequest()))),
      async () => void llmResults.push(await llmStepOutcome(() => client.complete(noteRequest()))),
      () => Promise.resolve(void log.push("SCORE_AGGREGATE")),
    ];
    for (const stage of stages) await stage();

    expect(log).toEqual(["REQUIREMENT_VERIFY", "SCORE_AGGREGATE"]);
    expect(llmResults[0]).toMatchObject({ status: "OK", value: { output: VALID_NOTE } });
    expect(llmResults[1]).toMatchObject({ status: "NOT_RUN", errorName: "LlmBudgetExceededError" });
  });

  it("환경변수에서 상한을 읽고 잘못된 값은 거부한다", () => {
    expect(llmBudgetLimitsFromEnv({})).toEqual({ maxCalls: 20, maxCostUsd: 0.5 });
    expect(
      llmBudgetLimitsFromEnv({
        LLM_MAX_CALLS_PER_EVALUATION: "5",
        LLM_MAX_COST_USD_PER_EVALUATION: "0.1",
      }),
    ).toEqual({ maxCalls: 5, maxCostUsd: 0.1 });
    expect(() => llmBudgetLimitsFromEnv({ LLM_MAX_CALLS_PER_EVALUATION: "abc" })).toThrow(
      LlmConfigError,
    );
    expect(() => new LlmBudget({ maxCalls: 1.5, maxCostUsd: 1 })).toThrow(LlmConfigError);
  });
});
