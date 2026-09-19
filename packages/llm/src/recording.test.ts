import {
  aiReviews,
  createTestDatabase,
  listAiReviews,
  seedEvaluation,
  type NewAiReview,
  type TestDatabase,
} from "@ohmyti/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmBudgetExceededError } from "./errors";
import { FakeLlmClient } from "./fake";
import { createEvaluationLlmClient } from "./factory";
import { llmStepOutcome } from "./outcome";
import { createDbAiReviewSink, llmInputDigest, RecordingLlmClient } from "./recording";
import { noteRequest, VALID_NOTE } from "./test-fixtures";

describe("RecordingLlmClient", () => {
  it("성공·실패 호출마다 한 행씩 남긴다", async () => {
    const rows: NewAiReview[] = [];
    const fake = new FakeLlmClient({
      responses: { EVIDENCE_REVIEW: { output: VALID_NOTE }, RUBRIC_DRAFT: { raw: "nope" } },
      usagePerRequest: { inputTokens: 7, outputTokens: 3, costUsd: 0.0001 },
    });
    const client = new RecordingLlmClient(fake, (row) => Promise.resolve(void rows.push(row)), {
      evaluationId: "e-1",
    });

    await client.complete(noteRequest());
    await llmStepOutcome(() => client.complete({ ...noteRequest(), purpose: "RUBRIC_DRAFT" }));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "EVIDENCE_REVIEW",
      evaluationId: "e-1",
      provider: "fake",
      model: "fake-model",
      output: VALID_NOTE,
      usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.0001 },
      costUsd: 0.0001,
    });
    expect(rows[1]).toMatchObject({
      kind: "RUBRIC_DRAFT",
      output: { error: { name: "LlmOutputInvalidError" } },
      usage: { inputTokens: 14, outputTokens: 6 },
      costUsd: 0.0002,
    });
  });

  it("input_digest는 같은 입력에 대해 같고(키 순서 무관), 입력이 다르면 다르다", () => {
    const a = llmInputDigest(noteRequest({ failing: "R-03", note: "x" }));
    const b = llmInputDigest(noteRequest({ note: "x", failing: "R-03" }));
    const c = llmInputDigest(noteRequest({ failing: "R-04", note: "x" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(llmInputDigest({ ...noteRequest(), promptVersion: "other@v1+00000000" })).not.toBe(
      llmInputDigest(noteRequest()),
    );
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

describe.skipIf(!hasTestDb)("ai_reviews 기록 (통합)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(async () => {
    await tdb?.destroy();
  });

  it("evaluation 클라이언트의 모든 호출이 ai_reviews에 한 행씩 남고 같은 입력의 input_digest가 같다", async () => {
    const seed = await seedEvaluation(tdb.db);
    const fake = new FakeLlmClient({
      responses: { EVIDENCE_REVIEW: { output: VALID_NOTE }, CONTEXT_LINK: { raw: "{" } },
      usagePerRequest: { inputTokens: 1000, outputTokens: 200, costUsd: 0.000123 },
    });
    const client = createEvaluationLlmClient({
      base: fake,
      sink: createDbAiReviewSink(tdb.db),
      scope: { evaluationId: seed.evaluationId, submissionId: seed.submissionId },
      limits: { maxCalls: 3, maxCostUsd: 1 },
    });

    await client.complete(noteRequest());
    await client.complete(noteRequest());
    const failed = await llmStepOutcome(() =>
      client.complete({ ...noteRequest(), purpose: "CONTEXT_LINK" }),
    );
    expect(failed.status).toBe("INCONCLUSIVE");
    // 예산 초과로 막힌 요청은 API를 부르지 않았으므로 기록하지 않는다
    await expect(client.complete(noteRequest())).rejects.toBeInstanceOf(LlmBudgetExceededError);

    const rows = await listAiReviews(tdb.db, { evaluationId: seed.evaluationId });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.kind)).toEqual(["EVIDENCE_REVIEW", "EVIDENCE_REVIEW", "CONTEXT_LINK"]);
    expect(rows[0]!.inputDigest).toBe(rows[1]!.inputDigest);
    expect(rows[2]!.inputDigest).not.toBe(rows[0]!.inputDigest);
    expect(rows[0]).toMatchObject({
      provider: "fake",
      model: "fake-model",
      promptVersion: noteRequest().promptVersion,
      submissionId: seed.submissionId,
      output: VALID_NOTE,
      usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 0, costUsd: 0.000123 },
      costUsd: "0.000123",
    });
    expect(rows[2]!.output).toMatchObject({ error: { name: "LlmOutputInvalidError" } });
    expect(rows[2]!.costUsd).toBe("0.000246");

    const all = await tdb.db.select().from(aiReviews);
    expect(all).toHaveLength(3);
  });
});
