import { z } from "zod";
import { definePrompt } from "./prompt";

/** 테스트용 출력 스키마. 점수·판정 키가 없다. */
export const NoteSchema = z.strictObject({
  summary: z.string().min(1),
  locations: z.array(z.strictObject({ file: z.string(), line: z.int().min(1) })),
});
export type Note = z.infer<typeof NoteSchema>;

export const VALID_NOTE: Note = {
  summary: "주문 수량 검증이 누락되었다",
  locations: [{ file: "src/order-service.ts", line: 12 }],
};

export const TEST_PROMPT = definePrompt({
  purpose: "EVIDENCE_REVIEW",
  id: "test-evidence",
  version: 1,
  system: "너는 코드 리뷰 보조자다. 관찰한 사실만 요약한다.",
});

export function noteRequest(input: string | Record<string, unknown> = { failing: "R-03" }) {
  return {
    purpose: TEST_PROMPT.purpose,
    promptVersion: TEST_PROMPT.promptVersion,
    system: TEST_PROMPT.system,
    input,
    schema: NoteSchema,
    example: VALID_NOTE,
    maxTokens: 512,
  };
}
