/**
 * AI 채점 기준 초안 (TICKET.md T-406, 1.5의 첫 번째 LLM 용도).
 *
 * web이 과제 명세로 초안을 요청하면(`rubric_drafts` 행 + `DRAFT_RUBRIC` job) 워커가 LLM을 호출하고,
 * 출력(`RubricDraftOutputSchema`)을 `rubricFromDraftOutput()`으로 `Rubric`에 옮긴 뒤 `validateRubric()` 결과와 함께 저장한다.
 * 초안은 사람이 고치고 저장·검증·승인하기 전까지 채점에 쓰이지 않는다 (`AI 초안 · 미승인`).
 *
 * LLM 출력에는 점수·판정 키(score, points, earned, verdict)를 두지 않는다 (G-01, `@ohmyti/llm` 금지 키).
 * 배점은 제출물의 점수가 아니라 기준의 만점 제안이므로 `maxPoints`로 받는다.
 */
import { z } from "zod";
import { IdSchema } from "./common";
import { MethodSchema, RubricAreaSchema } from "./enums";
import type { Rubric, RubricValidationError } from "./rubric";

export const RUBRIC_DRAFT_BADGE = "AI 초안 · 미승인";

/** `rubric_drafts.status`. job 상태와 별도로 화면이 폴링한다 */
export const RubricDraftStatusSchema = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]);
export type RubricDraftStatus = z.infer<typeof RubricDraftStatusSchema>;

/** `DRAFT_RUBRIC` job payload */
export const DraftRubricPayloadSchema = z.strictObject({
  rubricDraftId: IdSchema,
});
export type DraftRubricPayload = z.infer<typeof DraftRubricPayloadSchema>;

export function draftRubricDedupeKey(rubricDraftId: string): string {
  return `DRAFT_RUBRIC:${rubricDraftId}`;
}

/** 초안 요청에 넣을 수 있는 명세 크기 상한 (64 KiB). 프롬프트 입력 한도이기도 하다 */
export const MAX_RUBRIC_DRAFT_SPEC_BYTES = 64 * 1024;

const DraftIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,32}$/, "ID는 영문·숫자·._- 1~32자여야 합니다");

/** LLM 출력: 하위 기준 하나. `maxPoints`는 PARTIAL일 때 이 하위 기준이 받는 배점이다 */
export const RubricDraftSubCriterionSchema = z.strictObject({
  id: DraftIdSchema,
  description: z.string().min(1).max(500),
  maxPoints: z.int().min(0).max(100),
});

export const RubricDraftCriterionSchema = z.strictObject({
  id: DraftIdSchema,
  area: RubricAreaSchema,
  title: z.string().min(1).max(200),
  maxPoints: z.int().min(0).max(100),
  method: MethodSchema,
  /** 관측 가능한 판정 조건. 라이브러리 이름을 필수 조건으로 쓰지 않는다 */
  condition: z.string().min(1).max(1000),
  /** MUTATION 기준이 속한 그룹. 없으면 null */
  groupId: DraftIdSchema.nullable(),
  /** 비어 있지 않으면 PARTIAL을 허용한다 */
  subCriteria: z.array(RubricDraftSubCriterionSchema).max(10),
});

export const RubricDraftOutputSchema = z.strictObject({
  criteria: z.array(RubricDraftCriterionSchema).min(1).max(40),
  groups: z
    .array(
      z.strictObject({
        id: DraftIdSchema,
        name: z.string().min(1).max(200),
        criterionIds: z.array(DraftIdSchema).min(1).max(20),
        /** 워커가 제공한 mutation 카탈로그 ID 중에서만 고른다. 모르는 ID는 워커가 버린다 */
        mutationIds: z.array(DraftIdSchema).max(10),
      }),
    )
    .max(10),
  independentReasons: z
    .array(
      z.strictObject({
        criterionIds: z.array(DraftIdSchema).min(2).max(10),
        reason: z.string().min(1).max(500),
      }),
    )
    .max(10),
  /** 명세에서 모호했던 점·가정. 기준이 아니라 검토자에게 보여 줄 메모다 */
  notes: z.array(z.string().min(1).max(500)).max(10),
});
export type RubricDraftOutput = z.infer<typeof RubricDraftOutputSchema>;

/**
 * LLM 출력 → `Rubric`. 결정적 변환이며 판단을 더하지 않는다. `version`은 저장 시 계산되므로 자리 표시값이다.
 * `allowedMutationIds`가 있으면 그 밖의 mutation ID는 버리고 `droppedMutationIds`로 알린다.
 */
export function rubricFromDraftOutput(
  output: RubricDraftOutput,
  options: { allowedMutationIds?: readonly string[] | undefined } = {},
): { rubric: Rubric; droppedMutationIds: string[] } {
  const allowed = options.allowedMutationIds ? new Set(options.allowedMutationIds) : null;
  const droppedMutationIds: string[] = [];
  const rubric: Rubric = {
    version: "draft",
    criteria: output.criteria.map((c) => ({
      id: c.id,
      area: c.area,
      title: c.title,
      maxPoints: c.maxPoints,
      method: c.method,
      condition: c.condition,
      allowPartial: c.subCriteria.length > 0,
      ...(c.groupId !== null ? { groupId: c.groupId } : {}),
    })),
    groups: output.groups.map((g) => ({
      id: g.id,
      name: g.name,
      criterionIds: g.criterionIds,
      mutationIds: g.mutationIds.filter((id) => {
        if (allowed === null || allowed.has(id)) return true;
        droppedMutationIds.push(id);
        return false;
      }),
    })),
    partialRules: output.criteria
      .filter((c) => c.subCriteria.length > 0)
      .map((c) => ({
        criterionId: c.id,
        subCriteria: c.subCriteria.map((s) => ({
          id: s.id,
          description: s.description,
          points: s.maxPoints,
        })),
      })),
    independentReasons: output.independentReasons.map((r) => ({
      criterionIds: r.criterionIds,
      reason: r.reason,
    })),
  };
  return { rubric, droppedMutationIds };
}

/** 초안 실패 사유 코드 */
export const RubricDraftFailureCodeSchema = z.enum([
  /** LLM 출력이 두 번 모두 형식을 지키지 않음 */
  "LLM_OUTPUT_INVALID",
  /** 예산 초과 등으로 LLM을 호출하지 않음 */
  "LLM_NOT_RUN",
  /** 제공자 오류(네트워크·API) */
  "LLM_PROVIDER_ERROR",
  /** LLM 설정 없음(키 누락 등) */
  "LLM_NOT_CONFIGURED",
  /** 명세 원문을 읽지 못함 */
  "SPEC_UNAVAILABLE",
]);
export type RubricDraftFailureCode = z.infer<typeof RubricDraftFailureCodeSchema>;

/** 화면이 폴링으로 받는 초안 상태 */
export interface RubricDraftView {
  id: string;
  status: RubricDraftStatus;
  /** SUCCEEDED면 변환된 rubric. 형식은 맞지만 `validateRubric()`을 통과하지 못했을 수 있다 */
  rubric: Rubric | null;
  /** `validateRubric()` 오류 목록. 통과면 빈 배열 */
  validationErrors: RubricValidationError[];
  notes: string[];
  droppedMutationIds: string[];
  failure: { code: RubricDraftFailureCode; message: string } | null;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
  finishedAt: string | null;
}
