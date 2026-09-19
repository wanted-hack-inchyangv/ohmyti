/**
 * 평가 파이프라인 오케스트레이터 (TICKET.md T-204). `EVALUATE_SUBMISSION` job 하나가 제출 하나를 6단계로 처리한다.
 *
 * REPO_CHECK(T-202) → ENV_PREP(T-203 지원 판정 + 러너 prepare) → REQUIREMENT_VERIFY(기동 → 하네스 → 제출 테스트 → T-304 함수 그래프 분석 → T-205 판정 저장)
 * → TEST_EFFECTIVENESS(T-403 mutation 실험 → T-404 그룹 점수로 MUTATION 기준 판정 교체) → REVIEW_WRITE(T-407 LLM 근거 탐색·리뷰, 점수 불변)
 * → CONTEXT_LINK (T-501 이력서 텍스트 추출 → T-502 GitHub 보충 조회 → T-503 맥락 연결·후속 질문, 점수 불변).
 *
 * TEST_EFFECTIVENESS는 REQUIREMENT_VERIFY가 DONE일 때만 실행한다. FAILED(제출물 탓)면 변형의 효과를 원본과 비교할 수 없어
 * SKIPPED로 둔다. 변형마다 새 러너 환경을 만들므로 ENV_PREP 환경은 이 단계 전에 파괴한다.
 *
 * 판정 저장(T-205)은 단계 기록이 DONE·FAILED로 닫힌 뒤에 한다. 재시도에서 단계는 끝났지만 판정이 없으면
 * (`hasCriterionResults`) 단계 원문 아티팩트에서 입력을 되살려 저장만 다시 한다. 판정이 이미 있으면 건너뛴다.
 *
 * 멱등성: 같은 제출의 아직 끝나지 않은 평가가 있으면 이어서 쓰고, `stage_log`가 DONE인 단계는 다시 하지 않는다.
 * 단, 러너 환경은 job 시도마다 새로 만드는 일회성 자원이므로 ENV_PREP가 DONE이어도 `prepare`는 다시 한다(기록은 건드리지 않는다).
 * REQUIREMENT_VERIFY가 이미 FAILED(SUBMISSION)면 그 판정도 유지한다.
 *
 * 실패 분류 (G-11): 단계 밖으로 던져진 오류는 환경 장애다. 남은 시도가 있으면 단계를 RUNNING으로 둔 채 `detail.lastError`만
 * 남기고 job을 재시도하고, 없으면 단계 FAILED(ENVIRONMENT·TIMEOUT) → 뒤 단계 SKIPPED → 제출 FAILED로 닫는다.
 * 제출물 탓(서비스 크래시·헬스 실패)은 REQUIREMENT_VERIFY 안에서 FAILED(SUBMISSION)로 기록되고 파이프라인은 끝까지 간다.
 *
 * 평가 행은 REPO_CHECK가 SHA를 고정한 직후에 만든다(`evaluations.submission_sha`가 NOT NULL). REPO_CHECK가 UNSUPPORTED면
 * 평가 행 없이 제출만 UNSUPPORTED가 된다.
 *
 * 제출 상태 전이: RECEIVED → QUEUED → RUNNING → COMPLETED | FAILED | UNSUPPORTED (부록 B, `assertTransition`).
 *
 * 두 가지 변형 (T-405):
 * - 검증 실행: `submissions.validation_sample_id`가 있는 `is_sample` 제출. 버전은 VALIDATING이어야 하고, REPO_CHECK는
 *   저장소 대신 검증 샘플 스냅샷을 복사한다. 나머지 단계는 같다.
 * - 재평가: `input.assignmentVersionId`가 제출이 받은 버전과 다르면 같은 과제의 그 승인 버전으로 새 evaluation을 만든다.
 *   제출 상태는 바꾸지 않고(이미 끝난 제출도 평가한다), 이전 evaluation은 건드리지 않는다. 그 버전으로 끝난 evaluation이
 *   이미 있으면 다시 하지 않는다.
 */
import {
  assertTransition,
  maskSensitive,
  REVIEW_WRITE_LLM_NOT_CONFIGURED_REASON,
  CONTEXT_LINK_VALIDATION_RUN_SKIP_REASON,
  STAGE_NOT_IMPLEMENTED_REASON,
  type EvaluationStage,
  type EvaluationStageRecord,
  type FailureKind,
  type SubmissionStatus,
} from "@ohmyti/core";
import {
  createEvaluation,
  findFinishedEvaluationForVersion,
  findOpenEvaluation,
  finishEvaluation,
  getAssignmentVersion,
  getEvaluation,
  getSubmission,
  hasCriterionResults,
  setSubmissionStatus,
  skipStagesAfter,
  stageRecordOf,
  updateEvaluationStage,
  type Database,
  type EvaluationRow,
  type SubmissionRow,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import { computeEnvironmentDigest, type PreparedEnv, type SandboxRunner } from "@ohmyti/runner";
import { artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger";
import { NonRetryableJobError } from "../registry";
import {
  copyValidationSampleSnapshot,
  runRepoCheckStage,
  type GitHubClient,
  type SnapshotLimits,
} from "../repo";
import {
  checkReadme,
  loadRequirementResultsSource,
  readPackageManifest,
  persistRequirementResults,
  runFunctionGraphAnalysis,
  sourceFromOutcome,
  type RequirementResultsSource,
} from "../results";
import { loadSnapshotFiles, readTemplateManifest, runSupportCheckStage } from "../support";
import {
  errorMessageOf,
  failureKindOfError,
  PipelineAbortedError,
  PipelineEnvironmentError,
  withStageTimeout,
} from "./errors";
import { runRequirementVerifyStage } from "./requirement-verify";
import { MUTATION_STAGE_DEFAULTS, runTestEffectivenessStage } from "../mutation";
import { persistEffectivenessResults } from "../effectiveness";
import type { MutationDefinition } from "@ohmyti/analysis";
import type { LlmClient } from "@ohmyti/llm";
import { runReviewWriteStage } from "../review-write";
import type { GitHubSourcesCollector } from "@ohmyti/context";
import { runContextLinkPipelineStage } from "./context-link";

/** 구현 전 단계의 SKIPPED 사유 (티켓 문구 그대로). 모든 단계가 구현된 뒤에는 쓰지 않는다 */
export const NOT_IMPLEMENTED_SKIP_REASON = STAGE_NOT_IMPLEMENTED_REASON;
/** 앞 단계가 환경 장애로 FAILED일 때 뒤 단계의 SKIPPED 사유 */
export const PRIOR_STAGE_FAILED_SKIP_REASON = "앞 단계가 실패해 건너뜀";

/** TEST_EFFECTIVENESS를 설정(`MUTATION_STAGE_ENABLED=false`)으로 끈 경우의 SKIPPED 사유 */
export const MUTATION_STAGE_DISABLED_REASON = "disabled_by_config";
/** REQUIREMENT_VERIFY가 FAILED(제출물 탓)일 때 TEST_EFFECTIVENESS의 SKIPPED 사유 */
export const REQUIREMENT_VERIFY_FAILED_SKIP_REASON = "요구사항 검증이 실패해 변형 실험을 건너뜀";

/** 채점기 사전 검증 실행(T-405)에서 REVIEW_WRITE를 건너뛸 때의 사유 */
export const REVIEW_WRITE_VALIDATION_RUN_SKIP_REASON = "검증 실행은 리뷰를 작성하지 않음";

export const PIPELINE_DEFAULTS = {
  /** 단계 하나의 벽시계 상한 (`PIPELINE_STAGE_TIMEOUT_MS`) */
  stageTimeoutMs: 10 * 60 * 1000,
} as const;

export interface PipelineConfig {
  stageTimeoutMs: number;
  /** 하네스 요청당 제한 시간 (`HARNESS_REQUEST_TIMEOUT_MS`) */
  requestTimeoutMs: number;
  templateRoot: string;
  repoLimits: SnapshotLimits;
  /** 임시 디렉터리 위치 (저장소 수집). 러너의 workRoot와 같은 값을 권장 */
  workRoot?: string | undefined;
  caseSet?: string | undefined;
  /** 관련 함수 그래프 분석 자식 프로세스의 제한 시간 (`ANALYSIS_TIMEOUT_MS`, 기본 120초, T-304) */
  analysisTimeoutMs?: number | undefined;
  /** TEST_EFFECTIVENESS (T-403). 생략하면 켜져 있고 벽시계 상한은 기본 5분 */
  mutation?: MutationStageConfig | undefined;
}

export interface MutationStageConfig {
  /** false면 단계를 SKIPPED(`disabled_by_config`)로 둔다 (`MUTATION_STAGE_ENABLED`) */
  enabled?: boolean | undefined;
  /** 단계 전체 벽시계 상한 (`MUTATION_STAGE_TIMEOUT_MS`) */
  timeoutMs?: number | undefined;
  /** 테스트용 카탈로그 교체 */
  catalog?: readonly MutationDefinition[] | undefined;
}

/** 테스트용 훅. 단계 시작 직전에 호출되며 던지면 그 오류가 파이프라인 오류가 된다 (워커 크래시 재현) */
export interface PipelineHooks {
  beforeStage?: (stage: EvaluationStage, evaluationId: string | null) => Promise<void> | void;
}

export interface PipelineDeps {
  db: Database;
  store: ArtifactStore;
  runner: SandboxRunner;
  github: GitHubClient;
  config: PipelineConfig;
  logger: Logger;
  secrets?: readonly string[] | undefined;
  heartbeat?: (() => Promise<void>) | undefined;
  signal?: AbortSignal | undefined;
  now?: (() => Date) | undefined;
  hooks?: PipelineHooks | undefined;
  /**
   * evaluation 하나에 쓸 LLM 클라이언트(mutation 위치 탐색 2차 T-402, 근거 탐색·리뷰 T-407). 파이프라인 실행 한 번에 한 번만 불러
   * 같은 예산을 단계끼리 나눠 쓴다. 없으면 mutation은 휴리스틱만 쓰고 REVIEW_WRITE는 SKIPPED다
   */
  llmForEvaluation?: ((evaluationId: string) => LlmClient | undefined) | undefined;
  /**
   * GitHub 프로필 보충 조회기(T-502, `createGitHubSourcesCollector`). 없으면 CONTEXT_LINK에서 조회하지 않는다.
   * 조회 실패는 `github_sources`에 NO_DATA로 남고 파이프라인은 계속된다
   */
  githubSources?: GitHubSourcesCollector | undefined;
}

export interface PipelineInput {
  submissionId: string;
  /** 재평가(T-405): 제출이 받은 버전 대신 이 승인 버전으로 평가한다. 같은 과제의 버전이어야 한다 */
  assignmentVersionId?: string | undefined;
  /** job의 시작된 시도 횟수와 상한. 남은 시도가 없으면 환경 장애도 FAILED로 닫는다 */
  attempt: number;
  maxAttempts: number;
}

export interface PipelineResult {
  submissionId: string;
  submissionStatus: SubmissionStatus;
  evaluationId: string | null;
  stageLog: EvaluationStageRecord[];
}

export async function runEvaluationPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const { db, store, runner, config } = deps;
  const now = deps.now ?? (() => new Date());
  const secrets = deps.secrets ?? [];
  const mask = (text: string) => maskSensitive(text, secrets);
  const logger = deps.logger.child({ submissionId: input.submissionId });
  const retriesRemain = input.attempt < input.maxAttempts;
  const caseSet = config.caseSet ?? DEFAULT_CASE_SET;

  const loaded = await getSubmission(db, input.submissionId);
  const reevaluation =
    input.assignmentVersionId !== undefined &&
    loaded !== null &&
    input.assignmentVersionId !== loaded.assignmentVersionId;
  let submission = await requireEvaluableSubmission(db, input.submissionId, reevaluation);
  // 재평가는 제출 상태를 바꾸지 않는다 (제출은 원래 버전의 결과로 이미 끝났을 수 있다)
  const failSubmission = reevaluation
    ? async () => {}
    : (row: SubmissionRow) => failOriginalSubmission(db, row);
  if (reevaluation) {
    const finished = await findFinishedEvaluationForVersion(
      db,
      submission.id,
      input.assignmentVersionId!,
    );
    if (finished) {
      logger.info(
        { evaluationId: finished.id, assignmentVersionId: input.assignmentVersionId },
        "이 버전으로 끝난 재평가가 이미 있습니다. 다시 평가하지 않습니다",
      );
      return {
        submissionId: submission.id,
        submissionStatus: submission.status,
        evaluationId: finished.id,
        stageLog: finished.stageLog,
      };
    }
  } else {
    if (submission.status === "COMPLETED") {
      logger.info("이미 완료된 제출입니다. 다시 평가하지 않습니다");
      const existing = await findOpenEvaluation(db, submission.id);
      return {
        submissionId: submission.id,
        submissionStatus: submission.status,
        evaluationId: existing?.id ?? null,
        stageLog: existing?.stageLog ?? [],
      };
    }
    submission = await advanceSubmission(db, submission, "RUNNING");
  }

  const versionId = reevaluation ? input.assignmentVersionId! : submission.assignmentVersionId;
  const version = await getAssignmentVersion(db, versionId);
  if (!version) {
    await failSubmission(submission);
    throw new NonRetryableJobError(`과제 버전을 찾을 수 없습니다: ${versionId}`);
  }
  if (reevaluation) {
    const original = await getAssignmentVersion(db, submission.assignmentVersionId);
    if (original?.assignmentId !== version.assignmentId) {
      throw new NonRetryableJobError(
        `재평가 버전 ${version.id}은 제출 ${submission.id}의 과제와 다른 과제의 버전입니다`,
      );
    }
  }
  // 검증 실행은 승인 전(VALIDATING) 버전을, 그 밖의 평가는 승인된 버전만 채점한다 (T-201·T-405)
  const validationRun = submission.validationSampleId !== null;
  const requiredStatus = validationRun ? "VALIDATING" : "APPROVED";
  if (version.status !== requiredStatus) {
    await failSubmission(submission);
    throw new NonRetryableJobError(
      validationRun
        ? `RUBRIC_NOT_VALIDATING: 과제 버전 ${version.id}의 상태가 ${version.status}입니다. 검증 실행은 VALIDATING 버전만 채점합니다`
        : `RUBRIC_NOT_APPROVED: 과제 버전 ${version.id}의 상태가 ${version.status}입니다. 승인된 버전으로만 채점합니다`,
    );
  }
  const currentHarnessVersion = harnessVersionOf(getCaseSet(caseSet));
  if (version.harnessVersion !== currentHarnessVersion) {
    await failSubmission(submission);
    throw new NonRetryableJobError(
      `HARNESS_VERSION_MISMATCH: 과제 버전은 하네스 ${version.harnessVersion}으로 승인됐지만 워커의 하네스는 ${currentHarnessVersion}입니다. 버전을 다시 검증·승인해야 합니다`,
    );
  }
  const contract = version.executionContract;
  const rubric = version.rubric;
  const environmentDigest = await expectedEnvironmentDigest(
    config.templateRoot,
    contract.templateName,
    runner.kind,
  );

  let evaluation: EvaluationRow | null = await findOpenEvaluation(
    db,
    submission.id,
    undefined,
    version.id,
  );
  // 클로저(`enter`)에서 갱신하므로 객체에 둔다 (let이면 catch 블록에서 null로 좁혀진다)
  const progress: { stage: EvaluationStage | null } = { stage: null };
  let env: PreparedEnv | null = null;
  const stageTimeout = <T>(stage: EvaluationStage, promise: Promise<T>) =>
    withStageTimeout(stage, config.stageTimeoutMs, promise);

  const enter = async (stage: EvaluationStage): Promise<void> => {
    if (deps.signal?.aborted) throw new PipelineAbortedError(stage);
    progress.stage = stage;
    await deps.hooks?.beforeStage?.(stage, evaluation?.id ?? null);
    await deps.heartbeat?.();
  };
  const stageState = (stage: EvaluationStage) =>
    evaluation ? stageRecordOf(evaluation.stageLog, stage).state : "PENDING";

  try {
    // ── REPO_CHECK ────────────────────────────────────────────────────────────────
    await enter("REPO_CHECK");
    if (stageState("REPO_CHECK") === "DONE") {
      logger.info({ evaluationId: evaluation!.id }, "REPO_CHECK는 이미 DONE입니다. 건너뜁니다");
    } else {
      const startedAt = now();
      const repoCheck = submission.validationSampleId
        ? await stageTimeout(
            "REPO_CHECK",
            copyValidationSampleSnapshot(
              { submissionId: submission.id, validationSampleId: submission.validationSampleId },
              { db, store },
            ),
          ).then((copied) => ({ outcome: "PINNED" as const, ...copied }))
        : await stageTimeout(
            "REPO_CHECK",
            runRepoCheckStage(submission.id, {
              db,
              store,
              github: deps.github,
              limits: config.repoLimits,
              logger,
              secrets,
              now,
              ...(config.workRoot ? { workRoot: config.workRoot } : {}),
            }),
          ).then(({ result }) =>
            result.outcome === "UNSUPPORTED"
              ? result
              : {
                  outcome: "PINNED" as const,
                  submissionSha: result.submissionSha,
                  detail: {
                    submissionSha: result.submissionSha,
                    requestedRef: result.manifest.requestedRef,
                    snapshotRef: result.snapshotRef,
                    manifestRef: result.manifestRef,
                    snapshotDigest: result.manifest.snapshotDigest,
                    fileCount: result.manifest.fileCount,
                    totalBytes: result.manifest.totalBytes,
                    dropped: result.manifest.dropped,
                    reused: result.reused,
                  },
                },
          );
      if (repoCheck.outcome === "UNSUPPORTED") {
        const result = repoCheck;
        // 평가 행은 SHA가 있어야 만들 수 있다. 제출은 runRepoCheckStage가 UNSUPPORTED로 바꿨다
        const updated = await getSubmission(db, submission.id);
        logger.warn({ reason: result.reason }, "저장소를 수집할 수 없어 평가를 만들지 않습니다");
        return {
          submissionId: submission.id,
          submissionStatus: updated?.status ?? "UNSUPPORTED",
          evaluationId: null,
          stageLog: [],
        };
      }
      evaluation ??= await createEvaluation(db, {
        submissionId: submission.id,
        assignmentVersionId: version.id,
        rubricVersion: version.rubricVersion,
        harnessVersion: currentHarnessVersion,
        environmentDigest,
        submissionSha: repoCheck.submissionSha,
        isSample: submission.isSample,
      });
      await updateEvaluationStage(db, evaluation.id, "REPO_CHECK", {
        state: "RUNNING",
        startedAt: startedAt.toISOString(),
        now: startedAt,
      });
      evaluation = await updateEvaluationStage(db, evaluation.id, "REPO_CHECK", {
        state: "DONE",
        detail: repoCheck.detail,
        now: now(),
      });
      logger.info(
        { evaluationId: evaluation.id, submissionSha: repoCheck.submissionSha },
        "REPO_CHECK 완료",
      );
    }
    const evaluationId = evaluation!.id;
    const snapshotRef = artifactKeys.snapshot(submission.id);
    // evaluation 예산(T-401)은 클라이언트 인스턴스에 있으므로 단계끼리 같은 인스턴스를 쓴다
    let llmClient: { client: LlmClient | undefined } | null = null;
    const llmForThisEvaluation = () =>
      (llmClient ??= { client: deps.llmForEvaluation?.(evaluationId) }).client;

    // ── ENV_PREP ──────────────────────────────────────────────────────────────────
    await enter("ENV_PREP");
    const envPrepDone = stageState("ENV_PREP") === "DONE";
    if (!envPrepDone) {
      const { report } = await stageTimeout(
        "ENV_PREP",
        runSupportCheckStage(
          {
            evaluationId,
            submissionId: submission.id,
            snapshotRef,
            templateName: contract.templateName,
          },
          { db, store, templateRoot: config.templateRoot, logger, secrets, now },
        ),
      );
      if (!report.supported) {
        evaluation = await finishEvaluation(db, evaluationId, now());
        const updated = await getSubmission(db, submission.id);
        return {
          submissionId: submission.id,
          submissionStatus: updated?.status ?? "UNSUPPORTED",
          evaluationId,
          stageLog: evaluation.stageLog,
        };
      }
    } else {
      logger.info("ENV_PREP는 이미 DONE입니다. 지원 판정을 건너뛰고 러너 환경만 다시 만듭니다");
    }
    env = await stageTimeout(
      "ENV_PREP",
      runner.prepare(snapshotRef, contract, {
        logKeyPrefix: artifactKeys.sandboxLogPrefix(evaluationId, `attempt-${input.attempt}`),
      }),
    );
    if (env.environmentDigest !== environmentDigest) {
      throw new PipelineEnvironmentError(
        `러너 환경 digest ${env.environmentDigest}가 평가에 기록한 ${environmentDigest}와 다릅니다. 템플릿이 바뀌었을 수 있습니다`,
      );
    }
    if (!envPrepDone) {
      const current = stageRecordOf((await getEvaluation(db, evaluationId))!.stageLog, "ENV_PREP");
      evaluation = await updateEvaluationStage(db, evaluationId, "ENV_PREP", {
        state: "DONE",
        detail: {
          ...(current.detail ?? {}),
          sandbox: {
            kind: env.kind,
            envId: env.id,
            environmentDigest: env.environmentDigest,
            fileCount: env.fileCount,
            totalBytes: env.totalBytes,
            droppedNodeModules: env.droppedNodeModules,
            logKeyPrefix: env.logKeyPrefix,
          },
        },
        now: now(),
      });
    }
    logger.info({ envId: env.id, environmentDigest: env.environmentDigest }, "ENV_PREP 완료");

    // ── REQUIREMENT_VERIFY ────────────────────────────────────────────────────────
    await enter("REQUIREMENT_VERIFY");
    const verifyState = stageState("REQUIREMENT_VERIFY");
    let resultsSource: RequirementResultsSource | null = null;
    if (verifyState === "DONE" || verifyState === "FAILED") {
      logger.info({ state: verifyState }, "REQUIREMENT_VERIFY는 이미 끝났습니다. 건너뜁니다");
    } else {
      await updateEvaluationStage(db, evaluationId, "REQUIREMENT_VERIFY", {
        state: "RUNNING",
        now: now(),
      });
      const outcome = await stageTimeout(
        "REQUIREMENT_VERIFY",
        runRequirementVerifyStage(
          { evaluationId, env, rubric, contract, caseSet },
          {
            runner,
            store,
            requestTimeoutMs: config.requestTimeoutMs,
            heartbeat: deps.heartbeat,
            signal: deps.signal,
            secrets,
            logger,
          },
        ),
      );
      evaluation = await updateEvaluationStage(db, evaluationId, "REQUIREMENT_VERIFY", {
        state: outcome.state,
        ...(outcome.reason ? { reason: mask(outcome.reason) } : {}),
        detail: outcome.detail,
        now: now(),
      });
      logger.info(
        {
          state: outcome.state,
          failureKind: outcome.failureKind,
          startup: outcome.startup?.outcome ?? null,
          harness: outcome.harness?.summary ?? null,
          tests: { status: outcome.tests.status, total: outcome.tests.total },
        },
        "REQUIREMENT_VERIFY 완료",
      );
      resultsSource = sourceFromOutcome(outcome);
    }

    // ── 판정 저장 (T-205) ─────────────────────────────────────────────────────────
    if (await hasCriterionResults(db, evaluationId)) {
      logger.info("기준별 판정이 이미 저장되어 있습니다. 건너뜁니다");
    } else {
      const verifyRecord = stageRecordOf(
        (await getEvaluation(db, evaluationId))!.stageLog,
        "REQUIREMENT_VERIFY",
      );
      resultsSource ??= await loadRequirementResultsSource(store, verifyRecord);
      const { summary } = await stageTimeout(
        "REQUIREMENT_VERIFY",
        (async () => {
          const files = await loadSnapshotFiles(store, snapshotRef);
          const readme = await checkReadme(files, contract);
          const packageManifest = rubric.criteria.some((c) => c.staticChecks)
            ? await readPackageManifest(files)
            : undefined;
          // 관련 함수 그래프 (T-304). 분석 실패는 "분석 불가" 결과로 저장되며 단계를 실패시키지 않는다
          const functionGraph = await runFunctionGraphAnalysis({
            files,
            harness: resultsSource.harness,
            templateRoot: config.templateRoot,
            templateName: contract.templateName,
            isolation: { timeoutMs: config.analysisTimeoutMs },
          });
          if (functionGraph.analysis.status === "unavailable") {
            logger.warn(
              { reason: functionGraph.analysis.reason },
              "관련 함수 그래프를 분석하지 못했습니다",
            );
          }
          return persistRequirementResults(
            {
              evaluation: {
                id: evaluationId,
                submissionSha: evaluation!.submissionSha,
                rubricVersion: version.rubricVersion,
                harnessVersion: currentHarnessVersion,
                environmentDigest,
              },
              rubric,
              contract,
              caseSet,
              snapshotRef,
              source: resultsSource,
              readme,
              packageManifest,
              functionGraph,
            },
            { db, store, logger },
          );
        })(),
      );
      evaluation = await updateEvaluationStage(db, evaluationId, "REQUIREMENT_VERIFY", {
        state: verifyRecord.state,
        detail: { ...(verifyRecord.detail ?? {}), results: summary },
        now: now(),
      });
      logger.info({ score: summary.score.display }, "점수를 기록했습니다");
    }

    // ── TEST_EFFECTIVENESS (T-403) ───────────────────────────────────────────────
    await enter("TEST_EFFECTIVENESS");
    const effectivenessState = stageState("TEST_EFFECTIVENESS");
    if (effectivenessState === "PENDING" || effectivenessState === "RUNNING") {
      const verifyRecord = stageRecordOf(
        (await getEvaluation(db, evaluationId))!.stageLog,
        "REQUIREMENT_VERIFY",
      );
      const mutationConfig = config.mutation ?? {};
      if (verifyRecord.state !== "DONE") {
        evaluation = await updateEvaluationStage(db, evaluationId, "TEST_EFFECTIVENESS", {
          state: "SKIPPED",
          reason: REQUIREMENT_VERIFY_FAILED_SKIP_REASON,
          detail: { requirementVerify: verifyRecord.state },
          now: now(),
        });
      } else if (mutationConfig.enabled === false) {
        evaluation = await updateEvaluationStage(db, evaluationId, "TEST_EFFECTIVENESS", {
          state: "SKIPPED",
          reason: MUTATION_STAGE_DISABLED_REASON,
          detail: { config: "MUTATION_STAGE_ENABLED" },
          now: now(),
        });
      } else {
        // 변형마다 새 환경을 만든다. 원본 환경은 더 쓰지 않으므로 먼저 정리한다 (원격 러너의 자원 점유를 줄인다)
        if (env) {
          const finished = env;
          env = null;
          try {
            await runner.destroy(finished);
          } catch (destroyError) {
            logger.error(
              { err: destroyError, envId: finished.id },
              "러너 환경 정리에 실패했습니다",
            );
          }
        }
        if (effectivenessState === "PENDING") {
          await updateEvaluationStage(db, evaluationId, "TEST_EFFECTIVENESS", {
            state: "RUNNING",
            now: now(),
          });
        }
        resultsSource ??= await loadRequirementResultsSource(store, verifyRecord);
        const mutationTimeoutMs = mutationConfig.timeoutMs ?? MUTATION_STAGE_DEFAULTS.timeoutMs;
        const { detail } = await withStageTimeout(
          "TEST_EFFECTIVENESS",
          // 단계 스스로 벽시계 상한을 지킨다. 이 제한은 그 뒤 정리까지 멈춘 경우의 안전장치다
          Math.max(config.stageTimeoutMs, mutationTimeoutMs + 120_000),
          runTestEffectivenessStage(
            {
              evaluation: {
                id: evaluationId,
                submissionSha: evaluation!.submissionSha,
                rubricVersion: version.rubricVersion,
                harnessVersion: currentHarnessVersion,
                environmentDigest,
              },
              snapshotRef,
              contract,
              rubric,
              caseSet,
              baseline: { tests: resultsSource.tests, harness: resultsSource.harness },
              attempt: input.attempt,
            },
            {
              db,
              store,
              runner,
              logger,
              templateRoot: config.templateRoot,
              timeoutMs: mutationTimeoutMs,
              requestTimeoutMs: config.requestTimeoutMs,
              workRoot: config.workRoot,
              llm: llmForThisEvaluation(),
              catalog: mutationConfig.catalog,
              secrets,
              heartbeat: deps.heartbeat,
              signal: deps.signal,
            },
          ),
        );
        evaluation = await updateEvaluationStage(db, evaluationId, "TEST_EFFECTIVENESS", {
          state: "DONE",
          detail,
          now: now(),
        });
        logger.info(
          { precondition: detail.precondition.status, outcomes: detail.outcomes },
          "TEST_EFFECTIVENESS 완료",
        );
      }
    }

    // ── 테스트 실효성 점수 (T-404) ───────────────────────────────────────────────
    // 단계가 DONE·SKIPPED로 닫혔고 아직 점수를 옮기지 않았으면(`detail.scoring` 없음) MUTATION 기준의 자리 표시 판정을 바꾼다
    {
      const effectivenessRecord = stageRecordOf(
        (await getEvaluation(db, evaluationId))!.stageLog,
        "TEST_EFFECTIVENESS",
      );
      const closed =
        effectivenessRecord.state === "DONE" || effectivenessRecord.state === "SKIPPED";
      if (closed && effectivenessRecord.detail?.scoring === undefined) {
        const saved = await stageTimeout(
          "TEST_EFFECTIVENESS",
          persistEffectivenessResults(
            {
              evaluation: { id: evaluationId, submissionSha: evaluation!.submissionSha },
              rubric,
              stage: effectivenessRecord,
            },
            { db, logger },
          ),
        );
        if (saved.status === "saved") {
          evaluation = await updateEvaluationStage(db, evaluationId, "TEST_EFFECTIVENESS", {
            state: effectivenessRecord.state,
            detail: { ...(effectivenessRecord.detail ?? {}), scoring: saved.summary },
            now: now(),
          });
          logger.info({ score: saved.summary.score.display }, "테스트 실효성 점수를 기록했습니다");
        }
      }
    }

    // ── REVIEW_WRITE (T-407) ─────────────────────────────────────────────────────
    // 부록 B: REQUIREMENT_VERIFY가 FAILED(제출물 탓)여도 저장된 판정으로 가능한 범위에서 실행한다. 점수는 바꾸지 않는다
    await enter("REVIEW_WRITE");
    const reviewState = stageState("REVIEW_WRITE");
    if (reviewState === "PENDING" || reviewState === "RUNNING") {
      const llm = validationRun ? undefined : llmForThisEvaluation();
      if (validationRun) {
        // 채점기 사전 검증(T-405)은 기대 결과표 대조만 한다. 리뷰는 대조 대상이 아니므로 LLM 비용을 쓰지 않는다
        evaluation = await updateEvaluationStage(db, evaluationId, "REVIEW_WRITE", {
          state: "SKIPPED",
          reason: REVIEW_WRITE_VALIDATION_RUN_SKIP_REASON,
          now: now(),
        });
      } else if (!llm) {
        evaluation = await updateEvaluationStage(db, evaluationId, "REVIEW_WRITE", {
          state: "SKIPPED",
          reason: REVIEW_WRITE_LLM_NOT_CONFIGURED_REASON,
          now: now(),
        });
      } else {
        if (reviewState === "PENDING") {
          await updateEvaluationStage(db, evaluationId, "REVIEW_WRITE", {
            state: "RUNNING",
            now: now(),
          });
        }
        const outcome = await stageTimeout(
          "REVIEW_WRITE",
          runReviewWriteStage(
            {
              evaluationId,
              submissionSha: evaluation!.submissionSha,
              rubric,
              snapshotRef,
            },
            { db, store, llm, logger },
          ),
        );
        evaluation = await updateEvaluationStage(db, evaluationId, "REVIEW_WRITE", {
          state: outcome.state,
          ...(outcome.reason ? { reason: mask(outcome.reason) } : {}),
          detail: outcome.detail,
          now: now(),
        });
        logger.info(
          { llm: outcome.detail.llm, reason: outcome.reason ?? null },
          "REVIEW_WRITE 완료",
        );
      }
    }

    // ── CONTEXT_LINK (T-501 → T-502 → T-503) ────────────────────────────────────
    // 이력서 텍스트 추출 → GitHub 보충 조회 → 맥락 연결. 결과는 submission_context·context_links에만 저장하고
    // 채점 단계는 읽지 않는다 (G-10). 점수는 바꾸지 않는다. 부록 B: REQUIREMENT_VERIFY가 FAILED여도 실행한다
    await enter("CONTEXT_LINK");
    const contextState = stageState("CONTEXT_LINK");
    if (contextState === "PENDING" || contextState === "RUNNING") {
      if (validationRun) {
        evaluation = await updateEvaluationStage(db, evaluationId, "CONTEXT_LINK", {
          state: "SKIPPED",
          reason: CONTEXT_LINK_VALIDATION_RUN_SKIP_REASON,
          now: now(),
        });
      } else {
        if (contextState === "PENDING") {
          await updateEvaluationStage(db, evaluationId, "CONTEXT_LINK", {
            state: "RUNNING",
            now: now(),
          });
        }
        const outcome = await stageTimeout(
          "CONTEXT_LINK",
          runContextLinkPipelineStage(
            { submissionId: submission.id, evaluationId, rubric, repoUrl: submission.repoUrl },
            {
              db,
              store,
              logger,
              now,
              llm: llmForThisEvaluation(),
              githubSources: deps.githubSources,
              secrets,
            },
          ),
        );
        evaluation = await updateEvaluationStage(db, evaluationId, "CONTEXT_LINK", {
          state: outcome.state,
          ...(outcome.reason ? { reason: mask(outcome.reason) } : {}),
          detail: outcome.detail,
          now: now(),
        });
      }
    }

    // ── 마무리 ────────────────────────────────────────────────────────────────────
    progress.stage = null;
    evaluation = await finishEvaluation(db, evaluationId, now());
    const anyFailed = evaluation.stageLog.some((record) => record.state === "FAILED");
    const finalStatus: SubmissionStatus = anyFailed ? "FAILED" : "COMPLETED";
    if (!reevaluation) submission = await advanceSubmission(db, submission, finalStatus);
    logger.info(
      {
        evaluationId,
        reevaluation,
        assignmentVersionId: version.id,
        status: finalStatus,
        stages: evaluation.stageLog.map((r) => `${r.stage}=${r.state}`),
      },
      "평가 파이프라인 종료",
    );
    return {
      submissionId: submission.id,
      submissionStatus: submission.status,
      evaluationId,
      stageLog: evaluation.stageLog,
    };
  } catch (error) {
    if (isLostOrAborted(error)) {
      logger.warn(
        { err: error, stage: progress.stage },
        "소유권을 잃거나 종료 신호를 받아 기록 없이 중단합니다",
      );
      throw error;
    }
    const nonRetryable = error instanceof NonRetryableJobError;
    const failureKind: FailureKind = nonRetryable ? "ENVIRONMENT" : failureKindOfError(error);
    const message = mask(errorMessageOf(error));
    const finalize = nonRetryable || !retriesRemain;
    logger.error(
      { err: error, stage: progress.stage, failureKind, attempt: input.attempt, finalize },
      finalize
        ? "파이프라인 실패. 더 이상 재시도하지 않습니다"
        : "파이프라인 실패. job을 재시도합니다",
    );
    if (evaluation && progress.stage) {
      await recordStageFailure(db, evaluation.id, progress.stage, {
        failureKind,
        message,
        attempt: input.attempt,
        finalize,
        now: now(),
      });
    }
    if (finalize) {
      if (evaluation) await finishEvaluation(db, evaluation.id, now());
      await failSubmission(submission);
    }
    throw error;
  } finally {
    if (env) {
      try {
        await runner.destroy(env);
      } catch (destroyError) {
        logger.error({ err: destroyError, envId: env.id }, "러너 환경 정리에 실패했습니다");
      }
    }
  }
}

/**
 * 제출 행을 읽고, 평가할 수 없는 상태면 `NonRetryableJobError`.
 * 재평가는 원래 평가가 끝난 제출(COMPLETED·FAILED)도 받는다. 삭제·UNSUPPORTED는 어느 쪽도 받지 않는다.
 */
async function requireEvaluableSubmission(
  db: Database,
  submissionId: string,
  reevaluation: boolean,
): Promise<SubmissionRow> {
  const submission = await getSubmission(db, submissionId);
  if (!submission) throw new NonRetryableJobError(`제출을 찾을 수 없습니다: ${submissionId}`);
  if (submission.status === "DELETED" || submission.deletedAt) {
    throw new NonRetryableJobError(`삭제된 제출입니다: ${submissionId}`);
  }
  if (reevaluation && submission.status === "UNSUPPORTED") {
    throw new NonRetryableJobError(`지원하지 않는 제출은 재평가하지 않습니다: ${submissionId}`);
  }
  if (!reevaluation && (submission.status === "FAILED" || submission.status === "UNSUPPORTED")) {
    throw new NonRetryableJobError(
      `제출 ${submissionId}은(는) 이미 ${submission.status}로 끝났습니다. 다시 평가하려면 새 제출을 만들어야 합니다`,
    );
  }
  return submission;
}

/** 부록 B 전이를 검사하며 제출 상태를 바꾼다. RECEIVED에서 RUNNING으로 갈 때는 QUEUED를 거친다 */
async function advanceSubmission(
  db: Database,
  submission: SubmissionRow,
  to: SubmissionStatus,
): Promise<SubmissionRow> {
  let current = submission;
  if (current.status === to) return current;
  if (current.status === "RECEIVED" && to === "RUNNING") {
    assertTransition("submission", "RECEIVED", "QUEUED");
    current = await setSubmissionStatus(db, current.id, "QUEUED");
  }
  assertTransition("submission", current.status, to);
  return setSubmissionStatus(db, current.id, to);
}

async function failOriginalSubmission(db: Database, submission: SubmissionRow): Promise<void> {
  const current = await getSubmission(db, submission.id);
  if (!current || current.status !== "RUNNING") return;
  await setSubmissionStatus(db, current.id, "FAILED");
}

/**
 * 환경 장애를 단계 기록에 남긴다. 재시도가 남았으면 RUNNING을 유지하고 `detail.lastError`만 갱신하며,
 * 마지막 시도면 FAILED로 닫고 뒤 단계를 SKIPPED로 만든다. 아직 PENDING인 단계(시작 전 오류)는 RUNNING을 거쳐 닫는다.
 */
async function recordStageFailure(
  db: Database,
  evaluationId: string,
  stage: EvaluationStage,
  failure: {
    failureKind: FailureKind;
    message: string;
    attempt: number;
    finalize: boolean;
    now: Date;
  },
): Promise<void> {
  const evaluation = await getEvaluation(db, evaluationId);
  if (!evaluation) return;
  const current = stageRecordOf(evaluation.stageLog, stage);
  const lastError = {
    kind: failure.failureKind,
    message: failure.message,
    attempt: failure.attempt,
  };
  // DONE 단계 뒤의 오류(판정 저장 실패 등)는 상태를 바꾸지 않고 `detail.lastError`만 남긴다
  if (current.state === "DONE") {
    await updateEvaluationStage(db, evaluationId, stage, {
      state: "DONE",
      detail: { ...(current.detail ?? {}), lastError },
      now: failure.now,
    });
    if (failure.finalize) {
      await skipStagesAfter(db, evaluationId, stage, PRIOR_STAGE_FAILED_SKIP_REASON, failure.now);
    }
    return;
  }
  // SKIPPED·UNSUPPORTED로 이미 닫힌 단계는 손대지 않는다 (마무리 중 오류 등)
  if (current.state !== "PENDING" && current.state !== "RUNNING" && current.state !== "FAILED") {
    return;
  }
  if (current.state === "PENDING") {
    await updateEvaluationStage(db, evaluationId, stage, { state: "RUNNING", now: failure.now });
  }
  if (!failure.finalize) {
    if (current.state === "FAILED") return;
    await updateEvaluationStage(db, evaluationId, stage, {
      state: "RUNNING",
      detail: { ...(current.detail ?? {}), lastError },
      now: failure.now,
    });
    return;
  }
  if (current.state !== "FAILED") {
    await updateEvaluationStage(db, evaluationId, stage, {
      state: "FAILED",
      reason: `${failure.failureKind}: ${failure.message}`,
      detail: { ...(current.detail ?? {}), failureKind: failure.failureKind, lastError },
      now: failure.now,
    });
  }
  await skipStagesAfter(db, evaluationId, stage, PRIOR_STAGE_FAILED_SKIP_REASON, failure.now);
}

function isLostOrAborted(error: unknown): boolean {
  if (error instanceof PipelineAbortedError) return true;
  return error instanceof Error && error.name === "JobLostError";
}

/**
 * 러너 `prepare` 전에 평가 행에 기록할 환경 digest. 템플릿 매니페스트의 값이며, 매니페스트가 다른 러너 종류로
 * 계산됐으면 러너와 같은 규칙(`computeEnvironmentDigest`)으로 다시 계산한다. `prepare` 결과와 반드시 같아야 한다.
 */
export async function expectedEnvironmentDigest(
  templateRoot: string,
  templateName: string,
  runnerKind: SandboxRunner["kind"],
): Promise<string> {
  const manifest = await readTemplateManifest(templateRoot, templateName);
  if (manifest.runnerKind === runnerKind) return manifest.environmentDigest;
  const lockfileContent = await readFile(
    path.join(path.resolve(templateRoot), templateName, manifest.lockfile),
    "utf8",
  );
  return computeEnvironmentDigest({
    nodeVersion: manifest.nodeVersion,
    lockfileContent,
    runnerKind,
  });
}
