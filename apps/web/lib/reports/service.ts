/**
 * 평가 결과 조회 (TICKET.md T-207). 라우트 핸들러 `app/api/evaluations/[id]`, `app/api/evaluations/[id]/runs/[runId]`,
 * `app/api/submissions/[id]`가 이 함수들을 부른다.
 *
 * - 점수는 `evaluations` 행의 저장 값을 그대로 옮긴다. 이 모듈은 `aggregateScore`를 부르지 않으며 배점을 더하지 않는다
 *   (테스트가 소스에서 대조한다).
 * - 실행 기록 본문(input·expected·actual·timeline)은 기록의 `inputRef`·`expectedRef`·`actualRef`가 가리키는 아티팩트를
 *   그대로 JSON으로 읽는다. 리포트의 기록과 run 엔드포인트의 본문은 같은 `runId`·같은 ref에서 나온다.
 * - 응답은 core의 `EvaluationReportSchema` 등으로 검증한 뒤 돌려준다. 접근 보호는 proxy(T-008)가 모든 `/api/*`에 적용한다.
 */
import { z } from "zod";
import {
  EvaluationReportSchema,
  DesignSignalsReportSchema,
  FunctionGraphReportSchema,
  MutationDiffReportSchema,
  RunRecordReportSchema,
  SubmissionSummarySchema,
  formatStoredScoreDisplay,
  RUBRIC_TOTAL_POINTS,
  type ApiErrorCode,
  type EvaluationReport,
  type DesignSignalsReport,
  type FunctionGraphReport,
  type MutationDiffReport,
  type RunRecordReport,
  type StoredScore,
  type SubmissionSummary,
} from "@ohmyti/core";
import {
  findLatestEvaluation,
  getAssignment,
  getAssignmentVersion,
  getEvaluation,
  getEvaluationResults,
  getExecutionRecord,
  getSubmission,
  listEvidencesForRun,
  listMutationExperiments,
  listReviewEvents,
  toCriterionResult,
  toEvidence,
  toExecutionRecord,
  toIsoTimestamp,
  toMutationExperiment,
  toReviewEvent,
  type Database,
  type EvaluationRow,
} from "@ohmyti/db";
import { artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import { isTerminalSubmissionStatus } from "@/lib/submissions/service";

export interface ReportDeps {
  db: Database;
  store: ArtifactStore;
}

export type ReportResult<T> =
  { ok: true; data: T } | { ok: false; code: ApiErrorCode; message: string };

/** 오류 코드 → HTTP 상태 */
export function httpStatusOf(code: ApiErrorCode): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "EVALUATION_NOT_FOUND":
    case "RUN_NOT_FOUND":
    case "SUBMISSION_NOT_FOUND":
    case "ARTIFACT_NOT_FOUND":
    case "VERSION_NOT_FOUND":
      return 404;
    case "MUTATION_NOT_FOUND":
      return 404;
    case "RUBRIC_NOT_APPROVED":
      return 409;
  }
}

function invalidId(label: string): ReportResult<never> {
  return { ok: false, code: "INVALID_INPUT", message: `${label} 형식이 올바르지 않습니다` };
}

function isUuid(value: string): boolean {
  return z.uuid().safeParse(value).success;
}

/**
 * `evaluations` 행의 점수 네 필드가 모두 있으면 저장된 값 그대로, 아니면 null (판정 저장 전).
 * 영역 소계(`scoreByArea`)도 저장된 값 그대로이며 0005 이전 행은 null이다
 */
export function storedScoreOf(
  row: Pick<
    EvaluationRow,
    "scoreEarned" | "scoreMin" | "scoreMax" | "pendingPoints" | "scoreByArea"
  >,
): StoredScore | null {
  if (
    row.scoreEarned === null ||
    row.scoreMin === null ||
    row.scoreMax === null ||
    row.pendingPoints === null
  ) {
    return null;
  }
  const score = {
    earned: row.scoreEarned,
    min: row.scoreMin,
    max: row.scoreMax,
    pendingPoints: row.pendingPoints,
  };
  return {
    ...score,
    total: RUBRIC_TOTAL_POINTS,
    display: formatStoredScoreDisplay(score),
    byArea: row.scoreByArea ?? null,
  };
}

export async function readEvaluationReport(
  deps: Pick<ReportDeps, "db">,
  evaluationId: string,
): Promise<ReportResult<EvaluationReport>> {
  if (!isUuid(evaluationId)) return invalidId("평가 ID");
  const evaluation = await getEvaluation(deps.db, evaluationId);
  if (!evaluation) {
    return {
      ok: false,
      code: "EVALUATION_NOT_FOUND",
      message: `평가를 찾을 수 없습니다: ${evaluationId}`,
    };
  }
  const [submission, version, results, reviewRows, experimentRows] = await Promise.all([
    getSubmission(deps.db, evaluation.submissionId),
    getAssignmentVersion(deps.db, evaluation.assignmentVersionId),
    getEvaluationResults(deps.db, evaluationId),
    listReviewEvents(deps.db, evaluationId),
    listMutationExperiments(deps.db, evaluationId),
  ]);
  if (!submission || submission.status === "DELETED" || submission.deletedAt) {
    return {
      ok: false,
      code: "EVALUATION_NOT_FOUND",
      message: `평가의 제출이 삭제되었습니다: ${evaluationId}`,
    };
  }
  if (!version) {
    throw new Error(
      `평가 ${evaluationId}의 과제 버전이 없습니다: ${evaluation.assignmentVersionId}`,
    );
  }
  const assignment = await getAssignment(deps.db, version.assignmentId);
  if (!assignment) {
    throw new Error(`과제 버전 ${version.id}의 과제가 없습니다: ${version.assignmentId}`);
  }

  const report: EvaluationReport = {
    evaluation: {
      id: evaluation.id,
      submissionId: evaluation.submissionId,
      assignmentVersionId: evaluation.assignmentVersionId,
      rubricVersion: evaluation.rubricVersion,
      harnessVersion: evaluation.harnessVersion,
      environmentDigest: evaluation.environmentDigest,
      submissionSha: evaluation.submissionSha,
      isSample: evaluation.isSample,
      createdAt: toIsoTimestamp(evaluation.createdAt),
      finishedAt: evaluation.finishedAt ? toIsoTimestamp(evaluation.finishedAt) : null,
    },
    submission: {
      id: submission.id,
      status: submission.status,
      repoUrl: submission.repoUrl,
      repoRef: submission.repoRef,
      isSample: submission.isSample,
    },
    assignment: {
      id: assignment.id,
      name: assignment.name,
      version: version.version,
      title: version.title,
    },
    rubric: version.rubric,
    executionContract: version.executionContract,
    score: storedScoreOf(evaluation),
    criterionResults: results.criterionResults.map(toCriterionResult),
    evidences: results.evidences.map(toEvidence),
    executionRecords: results.executionRecords.map(toExecutionRecord),
    stages: evaluation.stageLog,
    reviewEvents: reviewRows.map(toReviewEvent),
    mutationExperiments: experimentRows.map(toMutationExperiment),
  };
  return { ok: true, data: EvaluationReportSchema.parse(report) };
}

const LOG_STDOUT = /\/stdout\.txt$/;
const LOG_STDERR = /\/stderr\.txt$/;

/** 근거의 `artifactRefs`에서 러너 로그 키만 고른다 (중복 제거, 등장 순) */
export function logRefsOf(artifactRefs: readonly string[]): RunRecordReport["logs"] {
  const stdout: string[] = [];
  const stderr: string[] = [];
  for (const ref of artifactRefs) {
    if (LOG_STDOUT.test(ref) && !stdout.includes(ref)) stdout.push(ref);
    else if (LOG_STDERR.test(ref) && !stderr.includes(ref)) stderr.push(ref);
  }
  return { stdout, stderr };
}

async function readJsonArtifact(
  store: ArtifactStore,
  key: string,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const object = await store.get(key);
  if (!object) return { ok: false };
  return { ok: true, value: JSON.parse(Buffer.from(object.body).toString("utf8")) as unknown };
}

export async function readRunRecord(
  deps: ReportDeps,
  evaluationId: string,
  runId: string,
): Promise<ReportResult<RunRecordReport>> {
  if (!isUuid(evaluationId)) return invalidId("평가 ID");
  if (!isUuid(runId)) return invalidId("실행 기록 ID");
  const row = await getExecutionRecord(deps.db, evaluationId, runId);
  if (!row) {
    return {
      ok: false,
      code: "RUN_NOT_FOUND",
      message: `평가 ${evaluationId}에 실행 기록 ${runId}가 없습니다`,
    };
  }
  const record = toExecutionRecord(row);
  const evidenceRows = await listEvidencesForRun(deps.db, evaluationId, runId);
  const evidences = evidenceRows.map(toEvidence);

  // 본문은 기록이 가리키는 ref에서만 읽는다. timeline은 키 규약(`runs/<runId>/timeline.json`)으로 찾고 없으면 null이다.
  const [input, expected, actual, timeline] = await Promise.all([
    readJsonArtifact(deps.store, record.inputRef),
    readJsonArtifact(deps.store, record.expectedRef),
    readJsonArtifact(deps.store, record.actualRef),
    readJsonArtifact(deps.store, artifactKeys.runRecord(evaluationId, runId, "timeline")),
  ]);
  const missing = (
    [
      ["input", input],
      ["expected", expected],
      ["actual", actual],
    ] as const
  ).filter(([, part]) => !part.ok);
  if (missing.length > 0) {
    return {
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
      message: `실행 기록 ${runId}의 본문 아티팩트가 없습니다: ${missing.map(([name]) => name).join(", ")}`,
    };
  }
  const report: RunRecordReport = {
    evaluationId,
    runId,
    record,
    evidences,
    input: input.ok ? (input.value as RunRecordReport["input"]) : null,
    expected: expected.ok ? (expected.value as RunRecordReport["expected"]) : null,
    actual: actual.ok ? (actual.value as RunRecordReport["actual"]) : null,
    timeline: timeline.ok ? (timeline.value as RunRecordReport["timeline"]) : null,
    logs: logRefsOf(evidences.flatMap((e) => e.artifactRefs)),
  };
  return { ok: true, data: RunRecordReportSchema.parse(report) };
}

/**
 * 관련 함수 그래프 분석 결과 (T-304). 워커가 `artifactKeys.functionGraph`에 저장한 JSON을 스키마로 확인해 그대로 돌려준다.
 * 이 모듈은 그래프를 다시 계산하거나 관측 여부를 추정하지 않는다.
 */
export async function readFunctionGraph(
  deps: ReportDeps,
  evaluationId: string,
): Promise<ReportResult<FunctionGraphReport>> {
  if (!isUuid(evaluationId)) return invalidId("평가 ID");
  const row = await getEvaluation(deps.db, evaluationId);
  if (!row) {
    return {
      ok: false,
      code: "EVALUATION_NOT_FOUND",
      message: `평가 ${evaluationId}를 찾을 수 없습니다`,
    };
  }
  const artifactKey = artifactKeys.functionGraph(evaluationId);
  const artifact = await readJsonArtifact(deps.store, artifactKey);
  if (!artifact.ok) {
    return {
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
      message: `평가 ${evaluationId}의 관련 함수 그래프 분석 결과가 없습니다 (판정 저장 전이거나 분석 이전 평가)`,
    };
  }
  const parsed = FunctionGraphReportSchema.safeParse({
    evaluationId,
    artifactKey,
    analysis: artifact.value,
  });
  if (!parsed.success) {
    return {
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
      message: `관련 함수 그래프 분석 결과의 형태가 맞지 않습니다: ${parsed.error.issues[0]?.message ?? "알 수 없음"}`,
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * 설계 평가용 코드 신호 (T-605). 워커가 저장한 `evaluations/<id>/analysis/design-signals.json` 그대로 돌려준다.
 * 신호를 추출하기 전의 평가이거나 형태가 맞지 않으면 `ARTIFACT_NOT_FOUND`다
 */
export async function readDesignSignals(
  deps: ReportDeps,
  evaluationId: string,
): Promise<ReportResult<DesignSignalsReport>> {
  if (!isUuid(evaluationId)) return invalidId("평가 ID");
  const row = await getEvaluation(deps.db, evaluationId);
  if (!row) {
    return {
      ok: false,
      code: "EVALUATION_NOT_FOUND",
      message: `평가 ${evaluationId}를 찾을 수 없습니다`,
    };
  }
  const artifactKey = artifactKeys.designSignals(evaluationId);
  const artifact = await readJsonArtifact(deps.store, artifactKey);
  if (!artifact.ok) {
    return {
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
      message: `평가 ${evaluationId}의 코드 신호가 없습니다 (판정 저장 전이거나 신호를 추출하기 전의 평가)`,
    };
  }
  const parsed = DesignSignalsReportSchema.safeParse({
    evaluationId,
    artifactKey,
    signals: artifact.value,
  });
  if (!parsed.success) {
    return {
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
      message: `코드 신호의 형태가 맞지 않습니다: ${parsed.error.issues[0]?.message ?? "알 수 없음"}`,
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * 변형 실험의 diff (T-404). 실험 행의 `patchRef`가 가리키는 아티팩트를 텍스트 그대로 돌려준다.
 * 실험 행이 없으면 `MUTATION_NOT_FOUND`, diff가 없는 실험(NOT_APPLICABLE 등)이나 아티팩트 유실은 `ARTIFACT_NOT_FOUND`다
 */
export async function readMutationDiff(
  deps: ReportDeps,
  evaluationId: string,
  mutationId: string,
): Promise<ReportResult<MutationDiffReport>> {
  if (!isUuid(evaluationId)) return invalidId("평가 ID");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(mutationId)) return invalidId("변형 ID");
  const experiment = (await listMutationExperiments(deps.db, evaluationId)).find(
    (e) => e.mutationId === mutationId,
  );
  if (!experiment) {
    return {
      ok: false,
      code: "MUTATION_NOT_FOUND",
      message: `평가 ${evaluationId}에 변형 실험 ${mutationId}가 없습니다`,
    };
  }
  if (!experiment.patchRef) {
    return {
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
      message: `변형 실험 ${mutationId}(${experiment.outcome})에는 diff가 없습니다`,
    };
  }
  const object = await deps.store.get(experiment.patchRef);
  if (!object) {
    return {
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
      message: `변형 실험 ${mutationId}의 diff 아티팩트가 없습니다: ${experiment.patchRef}`,
    };
  }
  return {
    ok: true,
    data: MutationDiffReportSchema.parse({
      evaluationId,
      mutationId,
      patchRef: experiment.patchRef,
      patchDigest: experiment.patchDigest,
      diff: Buffer.from(object.body).toString("utf8"),
    }),
  };
}

export async function readSubmissionSummary(
  deps: Pick<ReportDeps, "db">,
  submissionId: string,
): Promise<ReportResult<SubmissionSummary>> {
  if (!isUuid(submissionId)) return invalidId("제출 ID");
  const submission = await getSubmission(deps.db, submissionId);
  if (!submission || submission.status === "DELETED" || submission.deletedAt) {
    return {
      ok: false,
      code: "SUBMISSION_NOT_FOUND",
      message: `제출을 찾을 수 없습니다: ${submissionId}`,
    };
  }
  const latest = await findLatestEvaluation(deps.db, submissionId);
  const summary: SubmissionSummary = {
    id: submission.id,
    assignmentVersionId: submission.assignmentVersionId,
    status: submission.status,
    repoUrl: submission.repoUrl,
    repoRef: submission.repoRef,
    submissionSha: submission.submissionSha,
    snapshotRef: submission.snapshotRef,
    unsupportedReason: submission.unsupportedReason,
    isSample: submission.isSample,
    createdAt: toIsoTimestamp(submission.createdAt),
    updatedAt: toIsoTimestamp(submission.updatedAt),
    terminal: isTerminalSubmissionStatus(submission.status),
    latestEvaluation: latest
      ? {
          id: latest.id,
          createdAt: toIsoTimestamp(latest.createdAt),
          finishedAt: latest.finishedAt ? toIsoTimestamp(latest.finishedAt) : null,
          score: storedScoreOf(latest),
        }
      : null,
  };
  return { ok: true, data: SubmissionSummarySchema.parse(summary) };
}
