import { describe, expect, it } from "vitest";
import { LlmIncompleteOutputError, LlmOutputInvalidError } from "./errors";
import { FakeLlmClient } from "./fake";
import { llmStepOutcome } from "./outcome";
import { noteRequest, VALID_NOTE } from "./test-fixtures";

describe("구조화 출력 검증과 재요청", () => {
  it("유효한 출력은 한 번에 통과한다", async () => {
    const client = new FakeLlmClient({ responses: { EVIDENCE_REVIEW: { output: VALID_NOTE } } });
    const result = await client.complete(noteRequest());
    expect(result.output).toEqual(VALID_NOTE);
    expect(result.attempts).toBe(1);
    expect(client.sent).toHaveLength(1);
    expect(result.model).toBe("fake-model");
  });

  it("잘못된 JSON이면 오류를 붙여 1회 재요청하고, 그래도 실패하면 LlmOutputInvalidError", async () => {
    const client = new FakeLlmClient({
      responses: { EVIDENCE_REVIEW: { raw: "{ not json" } },
      usagePerRequest: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    });
    const error = await client.complete(noteRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmOutputInvalidError);
    const invalid = error as LlmOutputInvalidError;
    expect(invalid.call.attempts).toBe(2);
    expect(invalid.call.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expect(invalid.call.costUsd).toBeCloseTo(0.002);
    expect(client.sent).toHaveLength(2);
    // 재요청에는 직전 응답과 오류 설명이 붙는다
    const retry = client.sent[1]!.messages;
    expect(retry.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(retry[3]!.content).toContain("JSON 파싱 실패");
  });

  it("호출 측은 잘못된 출력을 INCONCLUSIVE로 처리한다", async () => {
    const client = new FakeLlmClient({ responses: { EVIDENCE_REVIEW: { raw: "not json" } } });
    const outcome = await llmStepOutcome(() => client.complete(noteRequest()));
    expect(outcome).toMatchObject({ status: "INCONCLUSIVE", errorName: "LlmOutputInvalidError" });
  });

  it("스키마 불일치 뒤 재요청에서 올바른 출력이면 통과한다", async () => {
    const client = new FakeLlmClient({
      responses: {
        EVIDENCE_REVIEW: [{ output: { summary: "", locations: [] } }, { output: VALID_NOTE }],
      },
    });
    const result = await client.complete(noteRequest());
    expect(result.attempts).toBe(2);
    expect(result.output).toEqual(VALID_NOTE);
    expect(client.sent[1]!.messages.at(-1)!.content).toContain("스키마 불일치");
  });

  it("스키마에 없는 키가 섞인 출력은 거부한다", async () => {
    const client = new FakeLlmClient({
      responses: { EVIDENCE_REVIEW: { output: { ...VALID_NOTE, extra: 1 } } },
    });
    await expect(client.complete(noteRequest())).rejects.toBeInstanceOf(LlmOutputInvalidError);
  });

  it("빈 응답은 실패로 본다", async () => {
    const client = new FakeLlmClient({ responses: { EVIDENCE_REVIEW: { raw: "" } } });
    const error = (await client.complete(noteRequest()).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(LlmOutputInvalidError);
    expect(error.message).toContain("빈 응답");
  });

  it("finish_reason=length면 재요청 없이 LlmIncompleteOutputError", async () => {
    const client = new FakeLlmClient({
      responses: { EVIDENCE_REVIEW: { raw: '{"summary":"잘', finishReason: "length" } },
    });
    const error = await client.complete(noteRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmIncompleteOutputError);
    expect((error as LlmIncompleteOutputError).finishReason).toBe("length");
    expect(client.sent).toHaveLength(1);
    const outcome = await llmStepOutcome(() => Promise.reject(error as Error));
    expect(outcome.status).toBe("INCONCLUSIVE");
  });

  it("응답이 준비되지 않은 purpose는 제공자 오류로 INCONCLUSIVE", async () => {
    const client = new FakeLlmClient({ responses: {} });
    const outcome = await llmStepOutcome(() => client.complete(noteRequest()));
    expect(outcome).toMatchObject({ status: "INCONCLUSIVE", errorName: "LlmProviderError" });
  });
});
