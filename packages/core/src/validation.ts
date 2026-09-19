/**
 * 채점기 사전 검증과 승인 게이트 (TICKET.md T-405, PRD 2장 W3).
 *
 * - `compareValidationSample`: 검증 샘플 하나의 기대 결과(`validation_samples.expected`)와 실제 채점 결과를 기준별·그룹별로 대조한다.
 *   기준은 verdict·earnedPoints(기대에 reviewState가 있으면 그것도), mutation은 결과, 제출 테스트는 상태·테스트 수를 본다.
 * - `buildValidationResult`: 샘플별 대조를 모아 `validation_result { perSample, mismatches[], pass }`를 만든다.
 *   정답·대안·결함 샘플이 하나씩은 있어야 pass다 (다른 해법을 오답 처리하지 않는지, 결함을 잡는지 모두 봐야 한다).
 * - `approvalBlockers`: 승인 조건(검증 pass + 모든 샘플 사람 검토 + 승인자 이름)을 검사해 막는 사유를 모두 돌려준다.
 *
 * 판정은 모두 결정적 비교이며 LLM을 쓰지 않는다 (G-01).
 */
import { z } from "zod";
import { IdSchema } from "./common";
import {
  MutationOutcomeSchema,
  ReviewStateSchema,
  VerdictSchema,
  type AssignmentVersionStatus,
  type MutationOutcome,
  type ReviewState,
  type Verdict,
} from "./enums";

export const ValidationSampleKindSchema = z.enum([
  "CORRECT",
  "ALTERNATIVE",
  "DEFECTIVE",
  "ADVERSARIAL",
]);
export type ValidationSampleKind = z.infer<typeof ValidationSampleKindSchema>;

/** 검증 결과 표의 샘플 종류별 확인 항목 (T-406 결과 표 문구) */
export const VALIDATION_SAMPLE_KIND_CHECK: Record<ValidationSampleKind, string> = {
  CORRECT: "정답 통과",
  ALTERNATIVE: "대안 통과",
  DEFECTIVE: "결함 탐지",
  ADVERSARIAL: "적대 샘플 동일",
};

/** 검증이 pass가 되려면 반드시 있어야 하는 샘플 종류 (PRD 2장 W3) */
export const REQUIRED_VALIDATION_SAMPLE_KINDS: readonly ValidationSampleKind[] = [
  "CORRECT",
  "ALTERNATIVE",
  "DEFECTIVE",
];

/** 시드가 부트스트랩으로 승인한 버전의 `approved_by` (T-201 `db:seed:sample`) */
export const BOOTSTRAP_APPROVED_BY = "seed";
export const BOOTSTRAP_APPROVAL_BADGE = "부트스트랩 승인 · 샘플 검토 대기";

export const ExpectedCriterionOutcomeSchema = z.looseObject({
  verdict: VerdictSchema,
  earnedPoints: z.int().min(0).nullable(),
  reviewState: ReviewStateSchema.optional(),
});

/** `validation_samples.expected`에서 대조에 쓰는 부분. 나머지 필드(설명, 점수 표기 등)는 그대로 둔다 */
export const ValidationExpectedSchema = z.looseObject({
  criteria: z.record(z.string().min(1), ExpectedCriterionOutcomeSchema),
  mutations: z.record(z.string().min(1), MutationOutcomeSchema).optional(),
  submittedTests: z
    .looseObject({
      status: z.string().min(1),
      total: z.int().min(0).optional(),
      files: z.int().min(0).optional(),
    })
    .optional(),
});
export type ValidationExpected = z.infer<typeof ValidationExpectedSchema>;

export interface ActualCriterionOutcome {
  verdict: Verdict;
  earnedPoints: number | null;
  reviewState: ReviewState;
}

/** 샘플 하나를 파이프라인으로 채점한 실제 결과 */
export interface ValidationSampleActual {
  submissionId: string | null;
  evaluationId: string | null;
  /** 제출의 최종 상태 (COMPLETED가 아니면 결과를 믿을 수 없어 오류로 본다) */
  submissionStatus: string;
  /** 파이프라인이 던진 오류 (환경 장애 등). 마스킹된 문자열 */
  error: string | null;
  criteria: Record<string, ActualCriterionOutcome>;
  mutations: Record<string, MutationOutcome>;
  submittedTests: { status: string; total: number; files: number } | null;
  scoreDisplay: string | null;
}

export const ValidationSubjectSchema = z.enum([
  "SAMPLE_SET",
  "EVALUATION",
  "CRITERION",
  "MUTATION",
  "SUBMITTED_TESTS",
]);
export type ValidationSubject = z.infer<typeof ValidationSubjectSchema>;

const JsonValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ValidationMismatchSchema = z.strictObject({
  /** 샘플 행 ID. 샘플 집합 문제(SAMPLE_SET)면 null */
  sampleId: IdSchema.nullable(),
  sampleName: z.string().nullable(),
  sampleKind: ValidationSampleKindSchema.nullable(),
  subject: ValidationSubjectSchema,
  /** 기준 ID·mutation ID·필드 이름 */
  ref: z.string().min(1),
  field: z.string().min(1).nullable(),
  expected: JsonValueSchema,
  actual: JsonValueSchema,
  message: z.string().min(1),
});
export type ValidationMismatch = z.infer<typeof ValidationMismatchSchema>;

export const ValidationSampleStatusSchema = z.enum(["MATCH", "MISMATCH", "ERROR"]);
export type ValidationSampleStatus = z.infer<typeof ValidationSampleStatusSchema>;

export const ValidationPerSampleSchema = z.strictObject({
  sampleId: IdSchema,
  name: z.string().min(1),
  kind: ValidationSampleKindSchema,
  /** 확인 항목 (`정답 통과` 등) */
  check: z.string().min(1),
  /** 검증에 쓴 샘플 내용 해시. 승인 시 현재 샘플과 다르면 검증을 다시 해야 한다 */
  submissionSha: z.string().min(1),
  submissionId: IdSchema.nullable(),
  evaluationId: IdSchema.nullable(),
  status: ValidationSampleStatusSchema,
  mismatchCount: z.int().min(0),
  scoreDisplay: z.string().nullable(),
  error: z.string().nullable(),
});
export type ValidationPerSample = z.infer<typeof ValidationPerSampleSchema>;

export const ValidationResultSchema = z.strictObject({
  kind: z.literal("rubric_validation"),
  assignmentVersionId: IdSchema,
  rubricVersion: z.string().min(1),
  harnessVersion: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  perSample: z.array(ValidationPerSampleSchema),
  mismatches: z.array(ValidationMismatchSchema),
  pass: z.boolean(),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export interface ValidationSampleRef {
  id: string;
  name: string;
  kind: ValidationSampleKind;
  submissionSha: string;
}

function mismatch(
  sample: ValidationSampleRef,
  subject: ValidationSubject,
  ref: string,
  field: string | null,
  expected: string | number | boolean | null,
  actual: string | number | boolean | null,
  message: string,
): ValidationMismatch {
  return {
    sampleId: sample.id,
    sampleName: sample.name,
    sampleKind: sample.kind,
    subject,
    ref,
    field,
    expected,
    actual,
    message,
  };
}

function points(value: number | null): string {
  return value === null ? "미확정" : `${value}점`;
}

/**
 * 샘플 하나의 기대·실제 결과를 대조한다. 파이프라인이 끝나지 않았으면(오류, COMPLETED 아님) 기준 대조 없이
 * EVALUATION 불일치 하나만 돌려준다 (끝나지 않은 결과로 통과·불일치를 판단하지 않는다, G-09).
 */
export function compareValidationSample(
  sample: ValidationSampleRef,
  expectedRaw: unknown,
  actual: ValidationSampleActual,
): ValidationMismatch[] {
  const parsed = ValidationExpectedSchema.safeParse(expectedRaw);
  if (!parsed.success) {
    return [
      mismatch(
        sample,
        "EVALUATION",
        "expected",
        null,
        null,
        null,
        `기대 결과표 형식이 올바르지 않습니다: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      ),
    ];
  }
  const expected = parsed.data;
  if (actual.error !== null || actual.submissionStatus !== "COMPLETED") {
    return [
      mismatch(
        sample,
        "EVALUATION",
        "pipeline",
        "status",
        "COMPLETED",
        actual.submissionStatus,
        actual.error
          ? `채점 파이프라인이 끝나지 않았습니다: ${actual.error}`
          : `채점 파이프라인이 ${actual.submissionStatus}로 끝났습니다`,
      ),
    ];
  }

  const out: ValidationMismatch[] = [];
  const criterionIds = [
    ...Object.keys(expected.criteria),
    ...Object.keys(actual.criteria).filter((id) => !(id in expected.criteria)),
  ];
  for (const id of criterionIds) {
    const want = expected.criteria[id];
    const got = actual.criteria[id];
    if (!want) {
      out.push(
        mismatch(
          sample,
          "CRITERION",
          id,
          null,
          null,
          got!.verdict,
          `${id}: 기대 결과표에 이 기준이 없습니다`,
        ),
      );
      continue;
    }
    if (!got) {
      out.push(
        mismatch(
          sample,
          "CRITERION",
          id,
          null,
          want.verdict,
          null,
          `${id}: 채점 결과에 이 기준이 없습니다`,
        ),
      );
      continue;
    }
    if (want.verdict !== got.verdict) {
      out.push(
        mismatch(
          sample,
          "CRITERION",
          id,
          "verdict",
          want.verdict,
          got.verdict,
          `${id}: 기대 ${want.verdict}, 실제 ${got.verdict}`,
        ),
      );
    }
    if (want.earnedPoints !== got.earnedPoints) {
      out.push(
        mismatch(
          sample,
          "CRITERION",
          id,
          "earnedPoints",
          want.earnedPoints,
          got.earnedPoints,
          `${id}: 기대 ${points(want.earnedPoints)}, 실제 ${points(got.earnedPoints)}`,
        ),
      );
    }
    if (want.reviewState !== undefined && want.reviewState !== got.reviewState) {
      out.push(
        mismatch(
          sample,
          "CRITERION",
          id,
          "reviewState",
          want.reviewState,
          got.reviewState,
          `${id}: 검토 상태 기대 ${want.reviewState}, 실제 ${got.reviewState}`,
        ),
      );
    }
  }

  for (const [id, want] of Object.entries(expected.mutations ?? {})) {
    const got = actual.mutations[id] ?? null;
    if (want !== got) {
      out.push(
        mismatch(
          sample,
          "MUTATION",
          id,
          "outcome",
          want,
          got,
          `${id}: 기대 ${want}, 실제 ${got ?? "실험 없음"}`,
        ),
      );
    }
  }

  if (expected.submittedTests) {
    const want = expected.submittedTests;
    const got = actual.submittedTests;
    if (!got) {
      out.push(
        mismatch(
          sample,
          "SUBMITTED_TESTS",
          "submittedTests",
          "status",
          want.status,
          null,
          "제출 테스트 실행 결과가 없습니다",
        ),
      );
    } else {
      const fields: Array<
        ["status" | "total" | "files", string | number | undefined, string | number]
      > = [
        ["status", want.status, got.status],
        ["total", want.total, got.total],
        ["files", want.files, got.files],
      ];
      for (const [field, w, g] of fields) {
        if (w !== undefined && w !== g) {
          out.push(
            mismatch(
              sample,
              "SUBMITTED_TESTS",
              "submittedTests",
              field,
              w,
              g,
              `제출 테스트 ${field}: 기대 ${w}, 실제 ${g}`,
            ),
          );
        }
      }
    }
  }
  return out;
}

export interface ValidationSampleRun {
  sample: ValidationSampleRef;
  expected: unknown;
  actual: ValidationSampleActual;
}

export interface BuildValidationResultInput {
  assignmentVersionId: string;
  rubricVersion: string;
  harnessVersion: string;
  startedAt: string;
  finishedAt: string;
  runs: readonly ValidationSampleRun[];
}

/** 샘플별 대조를 모아 검증 결과를 만든다. 불일치가 하나라도 있으면 pass가 아니다 */
export function buildValidationResult(input: BuildValidationResultInput): ValidationResult {
  const mismatches: ValidationMismatch[] = [];
  const kinds = new Set(input.runs.map((run) => run.sample.kind));
  for (const kind of REQUIRED_VALIDATION_SAMPLE_KINDS) {
    if (!kinds.has(kind)) {
      mismatches.push({
        sampleId: null,
        sampleName: null,
        sampleKind: kind,
        subject: "SAMPLE_SET",
        ref: kind,
        field: null,
        expected: kind,
        actual: null,
        message: `${VALIDATION_SAMPLE_KIND_CHECK[kind]}을(를) 확인할 ${kind} 샘플이 없습니다`,
      });
    }
  }
  const perSample: ValidationPerSample[] = input.runs.map((run) => {
    const found = compareValidationSample(run.sample, run.expected, run.actual);
    mismatches.push(...found);
    const errored = found.some((m) => m.subject === "EVALUATION");
    return {
      sampleId: run.sample.id,
      name: run.sample.name,
      kind: run.sample.kind,
      check: VALIDATION_SAMPLE_KIND_CHECK[run.sample.kind],
      submissionSha: run.sample.submissionSha,
      submissionId: run.actual.submissionId,
      evaluationId: run.actual.evaluationId,
      status: errored ? "ERROR" : found.length > 0 ? "MISMATCH" : "MATCH",
      mismatchCount: found.length,
      scoreDisplay: run.actual.scoreDisplay,
      error: run.actual.error,
    };
  });
  return ValidationResultSchema.parse({
    kind: "rubric_validation",
    assignmentVersionId: input.assignmentVersionId,
    rubricVersion: input.rubricVersion,
    harnessVersion: input.harnessVersion,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    perSample,
    mismatches,
    pass: mismatches.length === 0,
  });
}

export type ApprovalBlockerCode =
  | "NOT_VALIDATING"
  | "VALIDATION_MISSING"
  | "VALIDATION_FAILED"
  | "VALIDATION_STALE"
  | "SAMPLES_MISSING"
  | "SAMPLE_NOT_REVIEWED"
  | "APPROVER_MISSING";

export interface ApprovalBlocker {
  code: ApprovalBlockerCode;
  message: string;
}

export interface ApprovalCheckInput {
  version: {
    id: string;
    status: AssignmentVersionStatus;
    rubricVersion: string;
    harnessVersion: string;
    validationResult: unknown;
  };
  samples: ReadonlyArray<{
    id: string;
    name: string;
    submissionSha: string;
    humanReviewedBy: string | null;
  }>;
  approvedBy: string;
}

/**
 * 승인을 막는 사유를 모두 돌려준다 (빈 배열이면 승인 가능).
 * 조건: VALIDATING 상태, 이 버전의 검증 결과가 pass이고 현재 샘플과 같은 샘플로 만들어졌음,
 * 모든 샘플에 `human_reviewed_by`, 승인자 이름. 하나라도 빠지면 거부한다.
 */
export function approvalBlockers(input: ApprovalCheckInput): ApprovalBlocker[] {
  const blockers: ApprovalBlocker[] = [];
  const { version } = input;
  if (version.status !== "VALIDATING") {
    blockers.push({
      code: "NOT_VALIDATING",
      message: `검증 중(VALIDATING)인 버전만 승인할 수 있습니다 (현재 ${version.status})`,
    });
  }
  const parsed = ValidationResultSchema.safeParse(version.validationResult);
  if (!parsed.success) {
    blockers.push({
      code: "VALIDATION_MISSING",
      message: "채점기 검증 결과가 없습니다. 검증을 먼저 실행하세요",
    });
  } else {
    const result = parsed.data;
    if (
      result.assignmentVersionId !== version.id ||
      result.rubricVersion !== version.rubricVersion ||
      result.harnessVersion !== version.harnessVersion
    ) {
      blockers.push({
        code: "VALIDATION_STALE",
        message: "검증 결과가 이 버전의 기준·하네스로 만든 것이 아닙니다. 검증을 다시 실행하세요",
      });
    } else {
      const validated = new Map(result.perSample.map((s) => [s.sampleId, s.submissionSha]));
      const changed = input.samples.filter((s) => validated.get(s.id) !== s.submissionSha);
      if (changed.length > 0 || validated.size !== input.samples.length) {
        blockers.push({
          code: "VALIDATION_STALE",
          message: `검증 뒤에 검증 샘플이 바뀌었습니다 (${changed.map((s) => s.name).join(", ") || "샘플 수 변경"}). 검증을 다시 실행하세요`,
        });
      }
    }
    if (!result.pass) {
      blockers.push({
        code: "VALIDATION_FAILED",
        message: `채점기 검증에서 불일치 ${result.mismatches.length}건이 나왔습니다. 기준이나 샘플을 고친 새 버전을 만드세요`,
      });
    }
  }
  if (input.samples.length === 0) {
    blockers.push({ code: "SAMPLES_MISSING", message: "검증 샘플이 없습니다" });
  }
  const unreviewed = input.samples.filter((s) => !s.humanReviewedBy?.trim());
  if (unreviewed.length > 0) {
    blockers.push({
      code: "SAMPLE_NOT_REVIEWED",
      message: `사람이 검토하지 않은 검증 샘플이 있습니다: ${unreviewed.map((s) => s.name).join(", ")}`,
    });
  }
  if (!input.approvedBy.trim()) {
    blockers.push({ code: "APPROVER_MISSING", message: "승인자 이름을 입력하세요" });
  }
  return blockers;
}

/**
 * 시드가 부트스트랩으로 승인했고(`approved_by = 'seed'`) 아직 사람이 검토하지 않은 샘플이 있으면 배지를 보인다.
 * 사람이 expected-matrix에 서명하고 시드를 다시 실행하면 `human_reviewed_by`가 채워져 배지가 사라진다.
 */
export function isBootstrapApprovalPendingReview(
  version: { status: AssignmentVersionStatus; approvedBy: string | null },
  samples: ReadonlyArray<{ humanReviewedBy: string | null }>,
): boolean {
  if (version.status !== "APPROVED" && version.status !== "RETIRED") return false;
  if (version.approvedBy !== BOOTSTRAP_APPROVED_BY) return false;
  return samples.length === 0 || samples.some((s) => !s.humanReviewedBy?.trim());
}
