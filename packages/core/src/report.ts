/**
 * 평가 조회 API 응답 스키마 (TICKET.md T-207). web의 라우트 핸들러가 만들고 워크벤치(3단계)·게이트 스크립트(T-208)가 읽는다.
 *
 * - 점수(`score`)는 `evaluations` 행에 저장된 값을 그대로 옮긴다. API는 `aggregateScore`를 부르지 않는다.
 *   `display`는 저장된 `earned`·`min`·`max`·`pendingPoints`를 부록 C 표기로 바꾼 문자열이다 (`formatStoredScoreDisplay`).
 * - 기준별 판정·근거·실행 기록은 PRD 9장 계약(`contracts.ts`) 그대로다. 실행 기록의 본문(input·expected·actual·timeline)은
 *   `GET /api/evaluations/[id]/runs/[runId]`(`RunRecordReport`)가 `actualRef` 등의 아티팩트를 읽어 돌려준다.
 * - 응답 봉투는 `{ ok: true, data }` / `{ ok: false, code, message }`다 (T-206 `/status`와 같다).
 */
import { z } from "zod";
import { IdSchema, NonNegativeIntSchema, ShaSchema, TimestampSchema, DigestSchema } from "./common";
import { CriterionResultSchema, EvidenceSchema, ExecutionRecordSchema } from "./contracts";
import { RubricAreaSchema, SubmissionStatusSchema } from "./enums";
import {
  EvaluationStageRecordSchema,
  ExecutionContractSchema,
  MutationExperimentSchema,
  ReviewEventSchema,
} from "./entities";
import { DesignSignalsSchema } from "./design-signals";
import { FunctionGraphAnalysisSchema } from "./function-graph";
import { RUBRIC_TOTAL_POINTS, RubricSchema } from "./rubric";

/** `evaluations.score_by_area`에 저장된 영역 소계 하나 (`AreaScore`와 같은 형태). 워커가 판정 저장 시 함께 쓴다 */
export const StoredAreaScoreSchema = z.strictObject({
  area: RubricAreaSchema,
  earned: NonNegativeIntSchema,
  min: NonNegativeIntSchema,
  max: NonNegativeIntSchema,
  pendingPoints: NonNegativeIntSchema,
  /** 영역 배점 합 */
  total: NonNegativeIntSchema,
});
export type StoredAreaScore = z.infer<typeof StoredAreaScoreSchema>;

/** `evaluations` 행의 점수 필드. 집계 전(판정 저장 전)이면 리포트의 `score`는 null이다 */
export const StoredScoreSchema = z.strictObject({
  earned: NonNegativeIntSchema,
  min: NonNegativeIntSchema,
  max: NonNegativeIntSchema,
  pendingPoints: NonNegativeIntSchema,
  /** rubric 배점 합 (100) */
  total: NonNegativeIntSchema,
  /** 부록 C 표기. `87/100` 또는 `54~69/100 · 15점 검토 대기` */
  display: z.string().min(1),
  /**
   * 영역별 소계 (RubricArea 열거 순서). 저장된 값 그대로이며 API·화면은 다시 더하지 않는다.
   * `score_by_area` 컬럼(마이그레이션 0005) 이전에 저장된 평가는 null
   */
  byArea: z.array(StoredAreaScoreSchema).nullable(),
});
export type StoredScore = z.infer<typeof StoredScoreSchema>;

/**
 * 저장된 점수 필드만으로 부록 C 표기를 만든다. `min`·`max`는 저장된 값을 그대로 쓰고 더하지 않는다
 * (`formatScoreDisplay`는 집계 엔진용이며 `earned + pendingPoints`를 계산한다).
 */
export function formatStoredScoreDisplay(
  score: Pick<StoredScore, "earned" | "min" | "max" | "pendingPoints">,
  total: number = RUBRIC_TOTAL_POINTS,
): string {
  if (score.pendingPoints === 0) return `${score.earned}/${total}`;
  return `${score.min}~${score.max}/${total} · ${score.pendingPoints}점 검토 대기`;
}

export const EvaluationReportSchema = z.strictObject({
  evaluation: z.strictObject({
    id: IdSchema,
    submissionId: IdSchema,
    assignmentVersionId: IdSchema,
    rubricVersion: z.string().min(1),
    harnessVersion: z.string().min(1),
    environmentDigest: DigestSchema,
    submissionSha: ShaSchema,
    /** 샘플의 사전 계산 결과 (G-08: `저장된 실행`으로 표시) */
    isSample: z.boolean(),
    createdAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
  }),
  submission: z.strictObject({
    id: IdSchema,
    status: SubmissionStatusSchema,
    repoUrl: z.url(),
    repoRef: z.string().min(1).nullable(),
    isSample: z.boolean(),
  }),
  assignment: z.strictObject({
    id: IdSchema,
    name: z.string().min(1),
    version: z.int().min(1),
    title: z.string().min(1),
  }),
  /** 판정에 쓰인 기준. 기준별 결과의 `criterionId`·`maxPoints`는 여기와 대조할 수 있다 */
  rubric: RubricSchema,
  executionContract: ExecutionContractSchema,
  /** `evaluations`의 점수 필드. 판정 저장 전이면 null */
  score: StoredScoreSchema.nullable(),
  /** 기준 ID 순 */
  criterionResults: z.array(CriterionResultSchema),
  evidences: z.array(EvidenceSchema),
  /** 본문은 run 엔드포인트로 읽는다 */
  executionRecords: z.array(ExecutionRecordSchema),
  /** `stage_log` 그대로 (기록이 없는 단계는 없다) */
  stages: z.array(EvaluationStageRecordSchema),
  /** 사람 수정 이력 (`review_events`, 시각 순) */
  reviewEvents: z.array(ReviewEventSchema),
  /** mutation 실험 (`mutation_experiments`, 변형 ID 순, T-403). 테스트 실효성 그룹 판정(T-404)의 원문이다 */
  mutationExperiments: z.array(MutationExperimentSchema),
});
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

/** 실행 기록 본문. `record.actualRef` 등이 가리키는 아티팩트를 JSON으로 읽은 값이다 */
export const RunRecordReportSchema = z.strictObject({
  evaluationId: IdSchema,
  runId: IdSchema,
  record: ExecutionRecordSchema,
  /** 이 기록을 참조하는 근거 (`runId` 일치) */
  evidences: z.array(EvidenceSchema),
  input: z.json(),
  expected: z.json(),
  actual: z.json(),
  /** 하네스 케이스 기록에만 있다 */
  timeline: z.json().nullable(),
  /** 근거의 `artifactRefs` 중 러너 로그(`stdout.txt`·`stderr.txt`) 키. 본문은 담지 않는다 */
  logs: z.strictObject({
    stdout: z.array(z.string().min(1)),
    stderr: z.array(z.string().min(1)),
  }),
});
export type RunRecordReport = z.infer<typeof RunRecordReportSchema>;

/**
 * `GET /api/evaluations/[id]/graph` (T-304): 워커가 저장한 관련 함수 그래프 분석 결과 그대로.
 * 아티팩트가 없으면(분석 이전 평가·판정 저장 전) `ARTIFACT_NOT_FOUND`다
 */
export const FunctionGraphReportSchema = z.strictObject({
  evaluationId: IdSchema,
  artifactKey: z.string().min(1),
  analysis: FunctionGraphAnalysisSchema,
});
export type FunctionGraphReport = z.infer<typeof FunctionGraphReportSchema>;

/** `GET /api/evaluations/[id]/design-signals`: 설계 평가용 코드 신호 (T-605). 워커가 저장한 아티팩트 그대로 */
export const DesignSignalsReportSchema = z.strictObject({
  evaluationId: IdSchema,
  artifactKey: z.string().min(1),
  signals: DesignSignalsSchema,
});
export type DesignSignalsReport = z.infer<typeof DesignSignalsReportSchema>;

/** `GET /api/submissions/[id]`: 제출 상태와 최신 평가 */
export const SubmissionSummarySchema = z.strictObject({
  id: IdSchema,
  assignmentVersionId: IdSchema,
  status: SubmissionStatusSchema,
  repoUrl: z.url(),
  repoRef: z.string().min(1).nullable(),
  submissionSha: ShaSchema.nullable(),
  snapshotRef: z.string().min(1).nullable(),
  unsupportedReason: z.string().min(1).nullable(),
  isSample: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** 종료 상태(COMPLETED·FAILED·UNSUPPORTED·DELETED)면 true. 폴링을 멈춘다 */
  terminal: z.boolean(),
  /** 가장 최근 평가. 없으면 null */
  latestEvaluation: z
    .strictObject({
      id: IdSchema,
      createdAt: TimestampSchema,
      finishedAt: TimestampSchema.nullable(),
      score: StoredScoreSchema.nullable(),
    })
    .nullable(),
});
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;

/** 변형 실험의 diff (T-404). 워커가 `evaluations/<id>/mutations/<mutationId>/diff.patch`에 저장한 본문 그대로 */
export const MutationDiffReportSchema = z.strictObject({
  evaluationId: IdSchema,
  mutationId: z.string().min(1),
  patchRef: z.string().min(1),
  patchDigest: DigestSchema.nullable(),
  diff: z.string(),
});
export type MutationDiffReport = z.infer<typeof MutationDiffReportSchema>;

export const ApiErrorCodeSchema = z.enum([
  "INVALID_INPUT",
  "EVALUATION_NOT_FOUND",
  "RUN_NOT_FOUND",
  "SUBMISSION_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
  /** `POST /api/submissions` (T-208): 과제 버전이 없거나 승인되지 않았다 */
  "VERSION_NOT_FOUND",
  "RUBRIC_NOT_APPROVED",
  /** `GET /api/evaluations/[id]/mutations/[mutationId]` (T-404): 평가에 그 변형 실험이 없다 */
  "MUTATION_NOT_FOUND",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.strictObject({
  ok: z.literal(false),
  code: ApiErrorCodeSchema,
  message: z.string().min(1),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** 성공 봉투. `data`는 엔드포인트별 스키마다 */
export function apiOkSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ ok: z.literal(true), data });
}

export const EvaluationReportResponseSchema = z.union([
  apiOkSchema(EvaluationReportSchema),
  ApiErrorSchema,
]);
export const RunRecordReportResponseSchema = z.union([
  apiOkSchema(RunRecordReportSchema),
  ApiErrorSchema,
]);
export const FunctionGraphReportResponseSchema = z.union([
  apiOkSchema(FunctionGraphReportSchema),
  ApiErrorSchema,
]);
export const DesignSignalsReportResponseSchema = z.union([
  apiOkSchema(DesignSignalsReportSchema),
  ApiErrorSchema,
]);
export const SubmissionSummaryResponseSchema = z.union([
  apiOkSchema(SubmissionSummarySchema),
  ApiErrorSchema,
]);

/**
 * `POST /api/submissions` (T-208 게이트가 쓰는 제출 생성 API). 폼(T-206)과 같은 검사를 거치며 이력서는 받지 않는다
 * (이력서 업로드는 폼 전용). `commitSha`를 비우면 워커가 입력 시점의 기본 브랜치 HEAD를 고정한다.
 */
export const CreateSubmissionRequestSchema = z.strictObject({
  assignmentVersionId: IdSchema,
  repoUrl: z.string().min(1),
  /** 7~40자 hex. 생략하거나 비우면 HEAD 고정 */
  commitSha: z.string().optional(),
  githubProfileUrl: z.string().optional(),
});
export type CreateSubmissionRequest = z.infer<typeof CreateSubmissionRequestSchema>;

export const CreatedSubmissionSchema = z.strictObject({
  submissionId: IdSchema,
  jobId: IdSchema,
  /** 이 API는 이력서를 받지 않으므로 항상 null */
  resumeRef: z.string().min(1).nullable(),
  githubLogin: z.string().min(1).nullable(),
});
export type CreatedSubmissionResponse = z.infer<typeof CreatedSubmissionSchema>;
export const CreatedSubmissionResponseSchema = z.union([
  apiOkSchema(CreatedSubmissionSchema),
  ApiErrorSchema,
]);

/** `GET /api/assignment-versions`: 제출할 수 있는(APPROVED) 과제 버전 목록 */
export const ApprovedVersionOptionSchema = z.strictObject({
  id: IdSchema,
  label: z.string().min(1),
  assignmentName: z.string().min(1),
  version: z.int().min(1),
  rubricVersion: z.string().min(1),
});
export type ApprovedVersionOptionView = z.infer<typeof ApprovedVersionOptionSchema>;
export const ApprovedVersionListResponseSchema = z.union([
  apiOkSchema(z.array(ApprovedVersionOptionSchema)),
  ApiErrorSchema,
]);
