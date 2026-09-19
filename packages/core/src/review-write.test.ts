import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EvidenceReviewLenientOutputSchema,
  EvidenceReviewOutputSchema,
  ReviewWriteSummarySchema,
  evidenceReviewItemCount,
  splitEvidenceReviewOutput,
} from "./review-write";

const failure = (criterionId: string, summary = "같은 키로 두 번 주문한다") => ({
  criterionId,
  interpretation: `${criterionId} 원인 추정`,
  confidence: "LOW",
  sourceRefs: [],
  minimalReproSummary: { summary, stepIds: [] },
});

const design = { criterionId: "R-12", suggestedPoints: 6, rationale: "계층 분리", sourceRefs: [] };
const suggestion = { title: "로그", detail: "구조화 로그", outsideSpec: true };

const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { unrepresentable: "any", io: "output" });

describe("EvidenceReviewLenientOutputSchema (T-601)", () => {
  it("LLM에 보이는 JSON Schema는 엄격 스키마와 같다", () => {
    expect(jsonSchema(EvidenceReviewLenientOutputSchema)).toEqual(
      jsonSchema(EvidenceReviewOutputSchema),
    );
  });

  it("6번째 failure의 summary가 빈 문자열이면 그 항목만 버리고 위치·사유 코드를 남긴다", () => {
    const raw = {
      failures: [
        ...["R-04", "R-05", "R-06", "R-07", "R-09"].map((id) => failure(id)),
        failure("G1", ""),
      ],
      designReviews: [design],
      suggestions: [suggestion],
    };
    expect(EvidenceReviewOutputSchema.safeParse(raw).success).toBe(false);
    const { output, invalidItems } = splitEvidenceReviewOutput(
      EvidenceReviewLenientOutputSchema.parse(raw),
    );
    expect(output.failures.map((f) => f.criterionId)).toEqual([
      "R-04",
      "R-05",
      "R-06",
      "R-07",
      "R-09",
    ]);
    expect(output.designReviews).toHaveLength(1);
    expect(evidenceReviewItemCount(output)).toBe(7);
    expect(invalidItems).toEqual([
      {
        section: "failures",
        index: 5,
        criterionId: "G1",
        issueCode: "too_small",
        path: "minimalReproSummary.summary",
      },
    ]);
    // 유효 항목은 엄격 스키마를 그대로 통과한다
    expect(EvidenceReviewOutputSchema.safeParse(output).success).toBe(true);
  });

  it("rationale이 없는 designReviews 항목은 버리고 본문은 남기지 않는다", () => {
    const secret = "이 문장은 어디에도 남으면 안 된다";
    const { output, invalidItems } = splitEvidenceReviewOutput(
      EvidenceReviewLenientOutputSchema.parse({
        failures: [failure("R-05")],
        designReviews: [{ criterionId: "R-12", suggestedPoints: 3, sourceRefs: [], note: secret }],
        suggestions: [],
      }),
    );
    expect(output.designReviews).toEqual([]);
    expect(invalidItems).toEqual([
      {
        section: "designReviews",
        index: 0,
        criterionId: "R-12",
        issueCode: "invalid_type",
        path: "rationale",
      },
    ]);
    expect(JSON.stringify(invalidItems)).not.toContain(secret);
  });

  it("기준 ID 형식이 아닌 criterionId는 옮기지 않는다", () => {
    const { invalidItems } = splitEvidenceReviewOutput(
      EvidenceReviewLenientOutputSchema.parse({
        failures: [{ criterionId: "지원자가 쓴 긴 문장 R-05", interpretation: "" }, "문자열"],
        designReviews: [],
        suggestions: [],
      }),
    );
    expect(invalidItems.map((i) => [i.index, i.criterionId, i.path])).toEqual([
      [0, null, "interpretation"],
      [1, null, ""],
    ]);
  });

  it("외곽 구조가 무효면(배열 아님, 상한 초과, 필드 없음) 관대한 스키마도 실패한다", () => {
    for (const raw of [
      { failures: 1, designReviews: [], suggestions: [] },
      { failures: [], designReviews: [] },
      { failures: [], designReviews: [], suggestions: Array(9).fill(suggestion) },
      [],
    ]) {
      expect(EvidenceReviewLenientOutputSchema.safeParse(raw).success).toBe(false);
    }
  });

  it("실패 재생 스텝이 없는 기준은 minimalReproSummary를 생략할 수 있다", () => {
    const { criterionId, interpretation, confidence, sourceRefs } = failure("G1");
    const parsed = EvidenceReviewOutputSchema.safeParse({
      failures: [{ criterionId, interpretation, confidence, sourceRefs }],
      designReviews: [],
      suggestions: [],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("ReviewWriteSummarySchema", () => {
  it("T-601 이전 기록(droppedItems 없음)은 0건으로 읽는다", () => {
    const parsed = ReviewWriteSummarySchema.parse({
      llm: "OK",
      llmError: null,
      promptVersion: "evidence-review@1",
      model: "deepseek-chat",
      aiReviewId: null,
      aiReviewVersion: null,
      targets: [],
      interpretations: [],
      designSuggestions: [],
      suggestions: [],
      dropped: [],
    });
    expect(parsed.droppedItems).toBe(0);
    expect(parsed.invalidItems).toEqual([]);
  });
});
