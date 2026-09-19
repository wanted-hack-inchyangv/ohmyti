/**
 * 면접 스코어카드 (TICKET.md T-707, PRD 14.3의 8절). 면접관이 면접을 마친 뒤 역량별 척도와 메모, 최종 의견을
 * 손으로 기입한 기록이다.
 *
 * - 시스템은 값을 제안하지 않는다. 채워진 값은 모두 사람이 적은 것이다 (G-01, G-08).
 * - 평균·합산·등급을 만들지 않는다. 면접관이 여러 명이면 기록을 나란히 보일 뿐이다 (G-13, PRD 14.4).
 * - 저장은 덮어쓰기가 아니라 새 기록을 쌓는 방식이다. 같은 면접관이 다시 저장하면 이전 기록이 이력으로 남는다.
 * - 과제 점수·판정·다이제스트는 이 기록과 무관하다. 스코어카드는 `evaluations` 행을 건드리지 않는다.
 */
import { z } from "zod";
import { IdSchema, TimestampSchema } from "./common";
import { AnchorValueSchema, CompetencySchema } from "./competency";

/** 면접관 이름의 최대 길이 */
export const SCORECARD_INTERVIEWER_MAX = 80;
/** 메모 한 칸의 최대 길이 */
export const SCORECARD_NOTE_MAX = 2000;
/** 질문별 메모의 최대 개수 (인터뷰 키트의 질문 수보다 넉넉하게 둔다) */
export const SCORECARD_QUESTION_NOTES_MAX = 40;

/** 빈 문자열과 공백만 있는 칸은 "적지 않음"(null)과 같게 다룬다 */
const optionalNote = z
  .string()
  .max(SCORECARD_NOTE_MAX)
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  });

/** 역량 한 줄. 척도(`value`)와 메모(`note`) 모두 비워 둘 수 있다 */
export const ScorecardCompetencyEntrySchema = z.strictObject({
  competency: CompetencySchema,
  /** 1~4 앵커 값. 면접관이 고르지 않았으면 null */
  value: AnchorValueSchema.nullable(),
  note: optionalNote,
});
export type ScorecardCompetencyEntry = z.infer<typeof ScorecardCompetencyEntrySchema>;

/** 인터뷰 키트 질문 한 개에 대한 메모 */
export const ScorecardQuestionNoteSchema = z.strictObject({
  /** 키트 슬롯 ID (`FAILURE_DEBRIEF:R-06`) */
  questionId: z.string().min(1).max(64),
  /** 키트·리포트가 보이는 질문 번호. 키트가 없는 평가면 null */
  number: z.int().min(1).nullable(),
  note: z.string().min(1).max(SCORECARD_NOTE_MAX),
});
export type ScorecardQuestionNote = z.infer<typeof ScorecardQuestionNoteSchema>;

/** 저장 요청 본문. 화면과 서버가 같은 규칙으로 검사한다 */
export const InterviewScorecardInputSchema = z
  .strictObject({
    interviewer: z.string().trim().min(1).max(SCORECARD_INTERVIEWER_MAX),
    competencies: z.array(ScorecardCompetencyEntrySchema).max(CompetencySchema.options.length),
    questionNotes: z.array(ScorecardQuestionNoteSchema).max(SCORECARD_QUESTION_NOTES_MAX),
    finalNote: optionalNote,
  })
  .refine(
    (input) =>
      new Set(input.competencies.map((c) => c.competency)).size === input.competencies.length,
    { message: "같은 역량을 두 번 적을 수 없습니다", path: ["competencies"] },
  )
  .refine(
    (input) =>
      new Set(input.questionNotes.map((q) => q.questionId)).size === input.questionNotes.length,
    { message: "같은 질문에 메모를 두 번 적을 수 없습니다", path: ["questionNotes"] },
  )
  .refine((input) => hasScorecardContent(input), {
    message: "척도나 메모를 하나 이상 적어야 저장할 수 있습니다",
    path: ["competencies"],
  });
export type InterviewScorecardInput = z.infer<typeof InterviewScorecardInputSchema>;

/** 기입한 내용이 하나라도 있는지. 이름만 적은 빈 기록은 저장하지 않는다 */
export function hasScorecardContent(input: {
  competencies: readonly { value: number | null; note: string | null }[];
  questionNotes: readonly unknown[];
  finalNote: string | null;
}): boolean {
  if (input.finalNote !== null) return true;
  if (input.questionNotes.length > 0) return true;
  return input.competencies.some((c) => c.value !== null || c.note !== null);
}

/** 저장된 기록 하나 */
export const InterviewScorecardSchema = z.strictObject({
  id: IdSchema,
  evaluationId: IdSchema,
  interviewer: z.string().min(1).max(SCORECARD_INTERVIEWER_MAX),
  competencies: z.array(ScorecardCompetencyEntrySchema),
  questionNotes: z.array(ScorecardQuestionNoteSchema),
  finalNote: z.string().nullable(),
  /** 같은 면접관의 몇 번째 기록인지 (1부터). 이력을 읽을 때 붙인다 */
  revision: z.int().min(1),
  /** 이 면접관의 마지막 기록인지 */
  latest: z.boolean(),
  createdAt: TimestampSchema,
});
export type InterviewScorecard = z.infer<typeof InterviewScorecardSchema>;

/**
 * 같은 면접관의 기록에 순번(`revision`)과 마지막 여부(`latest`)를 붙인다.
 * 입력은 저장 순서(오래된 것부터)여야 한다.
 */
export function withScorecardRevisions<T extends { interviewer: string; createdAt: string }>(
  rows: readonly T[],
): (T & { revision: number; latest: boolean })[] {
  const seen = new Map<string, number>();
  const counted = rows.map((row) => {
    const revision = (seen.get(row.interviewer) ?? 0) + 1;
    seen.set(row.interviewer, revision);
    return { ...row, revision, latest: false };
  });
  const lastIndex = new Map<string, number>();
  counted.forEach((row, index) => lastIndex.set(row.interviewer, index));
  for (const index of lastIndex.values()) counted[index]!.latest = true;
  return counted;
}
