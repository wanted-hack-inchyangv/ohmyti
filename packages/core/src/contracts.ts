import { z } from "zod";
import { EvidenceDetailSchema } from "./review-write";
import {
  DigestSchema,
  IdSchema,
  NonNegativeIntSchema,
  ShaSchema,
  SourceLocationSchema,
  TimestampSchema,
} from "./common";
import {
  ExecutionRecordKindSchema,
  FailureKindSchema,
  MethodSchema,
  ReviewStateSchema,
  VerdictSchema,
} from "./enums";

/**
 * PRD 9장 `CriterionResult`. 필드 이름은 PRD와 같아야 한다 (이름 변경 불허).
 * `earnedPoints < maxPoints`이면 `evidenceIds`가 비어 있으면 안 된다 (G-02, DB 제약과 함께 스키마에서도 검사).
 */
export const CriterionResultSchema = z
  .strictObject({
    criterionId: z.string().min(1),
    rubricVersion: z.string().min(1),
    maxPoints: NonNegativeIntSchema,
    earnedPoints: NonNegativeIntSchema.nullable(),
    verdict: VerdictSchema,
    method: MethodSchema,
    evidenceIds: z.array(IdSchema),
    issueId: z.string().min(1).optional(),
    observation: z.string(),
    interpretation: z.string().optional(),
    reviewState: ReviewStateSchema,
    // 추가 필드 (PRD 밖, 허용됨)
    id: IdSchema.optional(),
    evaluationId: IdSchema.optional(),
    /** PARTIAL일 때 충족한 rubric 하위 기준 ID. 점수는 rubric의 하위 배점으로만 계산한다 (T-004). */
    satisfiedSubCriterionIds: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.earnedPoints !== null && value.earnedPoints > value.maxPoints) {
      ctx.addIssue({
        code: "custom",
        path: ["earnedPoints"],
        message: "earnedPoints는 maxPoints를 넘을 수 없습니다",
      });
    }
    if (
      value.earnedPoints !== null &&
      value.earnedPoints < value.maxPoints &&
      value.evidenceIds.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "감점된 기준은 최소 1개의 Evidence를 참조해야 합니다 (G-02)",
      });
    }
    if (value.verdict !== "PARTIAL" && value.satisfiedSubCriterionIds !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["satisfiedSubCriterionIds"],
        message: "satisfiedSubCriterionIds는 PARTIAL 판정에만 둘 수 있습니다",
      });
    }
    if (value.verdict === "INCONCLUSIVE" && value.earnedPoints !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["earnedPoints"],
        message: "INCONCLUSIVE는 earnedPoints가 null이어야 합니다 (G-04)",
      });
    }
  });
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

/**
 * 근거의 종류 (PRD 밖 추가 필드, T-304·T-305).
 * - `STATIC_RELATION`: 실행 근거의 요청에 정적 라우트 분석으로 대응시킨 핸들러 위치. `runId`는 그 요청을 보낸 실행 기록이고
 *   `source`는 핸들러 코드 위치다. 관측이 아니라 AST 관계이므로 화면은 `정적 관계`로 표시한다
 * - `LLM_INTERPRETATION`: LLM 근거 탐색(T-407)이 제안한 코드 위치. 스냅샷과 대조해 실재하는 위치만 저장하되 원인 추정이므로
 *   화면은 `추정`으로 표시한다. 판정·점수에는 쓰지 않는다 (G-01)
 * - `HUMAN_REVIEW`: 사람이 검토 액션(T-306 OVERRIDE·APPROVE_DESIGN)으로 감점했는데 기존 근거가 없을 때 만든 근거.
 *   코드 위치·실행 기록은 없고 `review_events`의 사유·검토자가 내용이다. 감점에는 근거가 있어야 하므로(G-02) 검토 기록 자체를 근거로 남긴다
 * - 없으면(기존 근거) 실행·정적 검사 근거이며 화면은 `관측`으로 표시한다
 */
export const EvidenceKindSchema = z.enum(["STATIC_RELATION", "LLM_INTERPRETATION", "HUMAN_REVIEW"]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/** PRD 9장 `Evidence`. */
export const EvidenceSchema = z.strictObject({
  id: IdSchema,
  submissionSha: ShaSchema,
  source: SourceLocationSchema.optional(),
  runId: IdSchema.optional(),
  testId: z.string().min(1).optional(),
  artifactRefs: z.array(z.string().min(1)),
  // 추가 필드
  evaluationId: IdSchema.optional(),
  createdAt: TimestampSchema.optional(),
  kind: EvidenceKindSchema.optional(),
  /** `source` 범위의 코드 원문 (코드 근거 뷰어가 스냅샷 없이 보여 준다) */
  snippet: z.string().optional(),
  /** LLM 근거(T-407)의 출처와 제안 내용. 점수가 아니다 */
  detail: EvidenceDetailSchema.optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** PRD 9장 `ExecutionRecord`. 불변이며 재실행은 새 레코드를 만든다 (G-03). */
export const ExecutionRecordSchema = z.strictObject({
  id: IdSchema,
  submissionSha: ShaSchema,
  rubricVersion: z.string().min(1),
  harnessVersion: z.string().min(1),
  environmentDigest: DigestSchema,
  patchDigest: DigestSchema.optional(),
  seed: z.string().min(1).optional(),
  inputRef: z.string().min(1),
  expectedRef: z.string().min(1),
  actualRef: z.string().min(1),
  exitCode: z.int().nullable(),
  failureKind: FailureKindSchema,
  // 추가 필드
  evaluationId: IdSchema.optional(),
  kind: ExecutionRecordKindSchema.optional(),
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  durationMs: NonNegativeIntSchema.optional(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

/** PRD 9장 세 인터페이스의 필드명. 테스트에서 스키마 shape와 대조한다. */
export const PRD_CONTRACT_FIELDS = {
  CriterionResult: [
    "criterionId",
    "rubricVersion",
    "maxPoints",
    "earnedPoints",
    "verdict",
    "method",
    "evidenceIds",
    "issueId",
    "observation",
    "interpretation",
    "reviewState",
  ],
  Evidence: ["id", "submissionSha", "source", "runId", "testId", "artifactRefs"],
  ExecutionRecord: [
    "id",
    "submissionSha",
    "rubricVersion",
    "harnessVersion",
    "environmentDigest",
    "patchDigest",
    "seed",
    "inputRef",
    "expectedRef",
    "actualRef",
    "exitCode",
    "failureKind",
  ],
} as const;
