/**
 * 채점기 사전 검증 (TICKET.md T-405, PRD 2장 W3). `VALIDATE_RUBRIC { assignmentVersionId }` job 하나가 VALIDATING 버전의
 * 검증 샘플을 모두 채점하고 기대 결과표와 대조한다.
 *
 * 1. 샘플마다 검증 제출(`is_sample = true`, `validation_sample_id`)을 만들고 전체 파이프라인(하네스 + 제출 테스트 + mutation)을
 *    같은 job 안에서 순서대로 돌린다. 저장소 대신 샘플 스냅샷을 채점한다(REPO_CHECK가 복사).
 * 2. 기준별 판정·mutation 결과·제출 테스트 상태를 `compareValidationSample`로 기대값과 대조한다.
 * 3. `validation_result { perSample, mismatches[], pass }`를 기록한다: pass면 VALIDATING에 남아 사람 승인을 기다리고,
 *    불일치가 있으면 DRAFT로 돌아간다(부록 B).
 *
 * 재시도: 이 job이 만든(`created_at >= job.created_at`) 검증 제출을 샘플마다 이어서 쓴다. 끝난 샘플은 다시 채점하지 않고,
 * 도중에 멈춘 샘플은 파이프라인이 끝난 단계를 건너뛰며 이어서 한다. 환경 장애는 남은 시도가 있으면 job을 재시도하고,
 * 마지막 시도면 그 샘플을 "채점 파이프라인이 끝나지 않음" 불일치로 기록한다 (결과를 지어내지 않는다, G-09).
 */
import {
  buildValidationResult,
  formatScoreDisplay,
  type ActualCriterionOutcome,
  type MutationOutcome,
  type ValidationResult,
  type ValidationSampleActual,
  type ValidationSampleRun,
} from "@ohmyti/core";
import {
  createValidationRunSubmission,
  findLatestEvaluation,
  findValidationRunSubmission,
  getAssignmentVersion,
  getSubmission,
  listCriterionResults,
  listMutationExperiments,
  listValidationSamples,
  recordAssignmentVersionValidation,
  stageRecordOf,
  type AssignmentVersionRow,
  type Database,
} from "@ohmyti/db";
import { maskSensitive } from "@ohmyti/core";
import { NonRetryableJobError } from "../registry";
import {
  PipelineAbortedError,
  errorMessageOf,
  runEvaluationPipeline,
  type PipelineDeps,
} from "../pipeline";

export interface RubricValidationInput {
  assignmentVersionId: string;
  /** job의 시작된 시도 횟수와 상한 (파이프라인과 같은 재시도 규칙) */
  attempt: number;
  maxAttempts: number;
  /** 이 시각 이후에 만든 검증 제출만 이어서 쓴다 (job 생성 시각) */
  since: Date;
}

export type RubricValidationOutcome =
  | { status: "recorded"; version: AssignmentVersionRow; result: ValidationResult }
  | { status: "skipped"; version: AssignmentVersionRow; reason: string };

export async function runRubricValidation(
  input: RubricValidationInput,
  deps: PipelineDeps,
): Promise<RubricValidationOutcome> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger.child({ assignmentVersionId: input.assignmentVersionId });
  const version = await getAssignmentVersion(db, input.assignmentVersionId);
  if (!version) {
    throw new NonRetryableJobError(`과제 버전을 찾을 수 없습니다: ${input.assignmentVersionId}`);
  }
  if (version.status !== "VALIDATING" || version.validationResult !== null) {
    // 결과를 이미 기록했거나(중복 job) 검증 중이 아니다. 기록을 덮어쓰지 않는다
    const reason =
      version.status === "VALIDATING"
        ? "이미 검증 결과가 기록되어 있습니다"
        : `버전 상태가 ${version.status}라 검증하지 않습니다`;
    logger.info({ status: version.status }, reason);
    return { status: "skipped", version, reason };
  }

  const samples = await listValidationSamples(db, version.id);
  const startedAt = now();
  const runs: ValidationSampleRun[] = [];
  for (const sample of samples) {
    await deps.heartbeat?.();
    const submission =
      (await findValidationRunSubmission(db, sample.id, input.since)) ??
      (await createValidationRunSubmission(db, sample));
    let error: string | null = null;
    if (!["COMPLETED", "FAILED", "UNSUPPORTED"].includes(submission.status)) {
      logger.info(
        { sample: sample.name, kind: sample.kind, submissionId: submission.id },
        "검증 샘플을 채점합니다",
      );
      try {
        await runEvaluationPipeline(
          { submissionId: submission.id, attempt: input.attempt, maxAttempts: input.maxAttempts },
          deps,
        );
      } catch (caught) {
        if (caught instanceof PipelineAbortedError || (caught as Error)?.name === "JobLostError") {
          throw caught;
        }
        const finalAttempt = input.attempt >= input.maxAttempts;
        if (!(caught instanceof NonRetryableJobError) && !finalAttempt) throw caught;
        error = maskSensitive(errorMessageOf(caught), deps.secrets ?? []);
        logger.warn(
          { sample: sample.name, err: caught },
          "검증 샘플 채점이 끝나지 않았습니다. 불일치로 기록합니다",
        );
      }
    }
    runs.push({
      sample: {
        id: sample.id,
        name: sample.name,
        kind: sample.kind,
        submissionSha: sample.submissionSha,
      },
      expected: sample.expected,
      actual: await collectSampleActual(db, submission.id, error, totalPoints(version)),
    });
  }

  const result = buildValidationResult({
    assignmentVersionId: version.id,
    rubricVersion: version.rubricVersion,
    harnessVersion: version.harnessVersion,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    runs,
  });
  const recorded = await recordAssignmentVersionValidation(db, {
    id: version.id,
    validationResult: result,
  });
  logger.info(
    {
      pass: result.pass,
      mismatches: result.mismatches.length,
      perSample: result.perSample.map((s) => `${s.name}=${s.status}`),
      status: recorded.status,
    },
    result.pass
      ? "채점기 검증 통과. 사람 승인을 기다립니다"
      : "채점기 검증 불일치. 버전을 DRAFT로 되돌립니다",
  );
  return { status: "recorded", version: recorded, result };
}

function totalPoints(version: AssignmentVersionRow): number {
  return version.rubric.criteria.reduce((sum, c) => sum + c.maxPoints, 0);
}

/** 검증 제출 하나의 최종 결과를 DB에서 읽는다 (파이프라인이 저장한 판정·실험·단계 기록) */
export async function collectSampleActual(
  db: Database,
  submissionId: string,
  error: string | null,
  total: number,
): Promise<ValidationSampleActual> {
  const submission = await getSubmission(db, submissionId);
  const evaluation = await findLatestEvaluation(db, submissionId);
  const criteria: Record<string, ActualCriterionOutcome> = {};
  const mutations: Record<string, MutationOutcome> = {};
  let submittedTests: ValidationSampleActual["submittedTests"] = null;
  let scoreDisplay: string | null = null;
  if (evaluation) {
    for (const row of await listCriterionResults(db, evaluation.id)) {
      criteria[row.criterionId] = {
        verdict: row.verdict,
        earnedPoints: row.earnedPoints,
        reviewState: row.reviewState,
      };
    }
    for (const row of await listMutationExperiments(db, evaluation.id)) {
      mutations[row.mutationId] = row.outcome;
    }
    const tests = stageRecordOf(evaluation.stageLog, "REQUIREMENT_VERIFY").detail?.tests as
      { status?: unknown; total?: unknown; files?: unknown } | undefined;
    if (tests && typeof tests.status === "string") {
      submittedTests = {
        status: tests.status,
        total: typeof tests.total === "number" ? tests.total : 0,
        files: typeof tests.files === "number" ? tests.files : 0,
      };
    }
    if (evaluation.scoreEarned !== null && evaluation.pendingPoints !== null) {
      scoreDisplay = formatScoreDisplay(evaluation.scoreEarned, evaluation.pendingPoints, total);
    }
  }
  return {
    submissionId,
    evaluationId: evaluation?.id ?? null,
    submissionStatus: submission?.status ?? "MISSING",
    error,
    criteria,
    mutations,
    submittedTests,
    scoreDisplay,
  };
}
