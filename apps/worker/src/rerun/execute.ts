/**
 * 재실행 (TICKET.md T-307). `RERUN_EXECUTION { evaluationId, caseId }` job 하나가 하네스 케이스 하나를
 * 원본 평가와 같은 SHA·기준·환경에서 다시 실행하고 `execution_records`(kind RERUN) + 근거를 추가한다.
 *
 * 순서: 평가·제출·과제 버전 읽기 → 조건 대조(기준 버전, 하네스 버전, 환경 digest, 스냅샷 SHA·digest) → 원본 기록 찾기
 * → 상한 확인 → 러너 prepare(digest 재확인) → 서비스 기동 → 해당 케이스만 하네스 → 종료 → 원본 `actual.json`과 비교 → 저장.
 *
 * - 기존 기록은 어떤 경우에도 바꾸지 않는다 (G-03). 판정·점수·observation도 그대로다. 재실행 근거는 케이스를 참조하는
 *   기준의 `evidence_ids` 뒤에만 붙여 재생 뷰(T-303)의 기록 목록에 나타나게 한다.
 * - 조건이 다르면(템플릿 갱신으로 환경 digest 변경, 기준 버전 변경, 스냅샷 유실) `NonRetryableJobError`로 즉시 FAILED다.
 *   사유는 job `last_error`에 남고 화면이 "재실행 거부"로 보여 준다 (G-09: 다른 조건으로 실행한 척하지 않는다).
 * - 러너·스토어·DB 오류는 환경 장애(ENVIRONMENT)로 밖으로 던져 job 재시도·FAILED가 된다. 제출 서비스 탓(기동 실패·크래시)은
 *   기록을 남긴다(failureKind SUBMISSION, 관측한 만큼만) (G-11·G-14).
 * - 원본 비교(`RerunComparison`)는 관측값끼리의 대조이며 점수 계산이 아니다. LLM은 관여하지 않는다 (G-01).
 */
import {
  canonicalJson,
  HarnessCaseActualSchema,
  maskSensitive,
  RerunComparisonSchema,
  type ExecutionContract,
  type FailureKind,
  type HarnessCaseActual,
  type RerunComparison,
  type Rubric,
} from "@ohmyti/core";
import {
  appendCriterionResultEvidence,
  getAssignmentVersion,
  getEvaluation,
  getEvaluationResults,
  getSubmission,
  insertEvidences,
  insertExecutionRecords,
  listRerunJobs,
  stageRecordOf,
  type Database,
  type EvaluationRow,
  type ExecutionRecordRow,
  type NewEvidence,
  type NewExecutionRecord,
} from "@ohmyti/db";
import {
  DEFAULT_CASE_SET,
  getCaseSet,
  harnessVersionOf,
  runHarness,
  type CaseDefinition,
  type CaseResult,
  type HarnessReport,
} from "@ohmyti/harness";
import {
  BlockedCommandError,
  ServiceStartError,
  type PreparedEnv,
  type ProcessExit,
  type SandboxRunner,
  type ServiceLogsRef,
  type ServiceStartupObservation,
} from "@ohmyti/runner";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logger";
import { expectedEnvironmentDigest, PipelineEnvironmentError, withStageTimeout } from "../pipeline";
import { SnapshotManifestSchema } from "../repo";
import { NonRetryableJobError } from "../registry";
import type { PipelineConfig } from "../pipeline";

/** 하네스 연결 실패 뒤 서비스 종료를 기다리는 시간 (`requirement-verify.ts`의 `CRASH_SETTLE_MS`와 같은 뜻) */
const CRASH_SETTLE_MS = 3000;

export interface RerunInput {
  jobId: string;
  evaluationId: string;
  caseId: string;
}

export interface RerunDeps {
  db: Database;
  store: ArtifactStore;
  runner: SandboxRunner;
  config: PipelineConfig;
  logger: Logger;
  /** evaluation당 재실행 상한 */
  limit: number;
  secrets?: readonly string[] | undefined;
  heartbeat?: (() => Promise<void>) | undefined;
  signal?: AbortSignal | undefined;
  /** UUID 생성기 (테스트에서 고정한다) */
  newId?: (() => string) | undefined;
}

export interface RerunResult {
  evaluationId: string;
  caseId: string;
  runId: string;
  evidenceId: string;
  originalRunId: string;
  failureKind: FailureKind;
  verdict: string;
  comparison: RerunComparison;
  /** 재실행 근거를 붙인 판정 행 ID */
  updatedCriterionResultIds: string[];
}

/** 원본 기록: 케이스를 `testId`로 참조하는 근거 중 RERUN이 아닌 가장 오래된 실행 기록 */
export function findOriginalRecord(
  results: Awaited<ReturnType<typeof getEvaluationResults>>,
  caseId: string,
): ExecutionRecordRow | null {
  const recordById = new Map(results.executionRecords.map((r) => [r.id, r]));
  const candidates: ExecutionRecordRow[] = [];
  for (const evidence of results.evidences) {
    if (evidence.testId !== caseId || !evidence.runId) continue;
    const record = recordById.get(evidence.runId);
    if (!record || record.kind === "RERUN" || candidates.some((c) => c.id === record.id)) continue;
    candidates.push(record);
  }
  candidates.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  return candidates[0] ?? null;
}

/**
 * 재실행 결과를 원본 `actual.json`과 대조한다. verdict, 실패 검사 관측값 맵(`actual`), 검사별 `ok`를 비교하며
 * 값이 다른 검사 이름을 모은다. 관측끼리의 비교이지 판정이 아니다.
 */
export function compareWithOriginal(
  original: HarnessCaseActual,
  rerun: Pick<HarnessCaseActual, "verdict" | "actual" | "checks">,
  ids: { originalRunId: string; jobId: string },
): RerunComparison {
  const sameVerdict = original.verdict === rerun.verdict;
  const sameActual = canonicalJson(original.actual) === canonicalJson(rerun.actual);
  const originalChecks = new Map(original.checks.map((c) => [c.name, c]));
  const differing: string[] = [];
  const names = new Set<string>();
  for (const check of rerun.checks) {
    names.add(check.name);
    const before = originalChecks.get(check.name);
    if (
      !before ||
      before.ok !== check.ok ||
      canonicalJson(before.actual) !== canonicalJson(check.actual)
    ) {
      differing.push(check.name);
    }
  }
  for (const check of original.checks) {
    if (!names.has(check.name)) differing.push(check.name);
  }
  const sameChecks = differing.length === 0;
  return RerunComparisonSchema.parse({
    originalRunId: ids.originalRunId,
    jobId: ids.jobId,
    sameVerdict,
    sameActual,
    sameChecks,
    differingChecks: differing,
    outcome: sameVerdict && sameActual && sameChecks ? "same" : "different",
  });
}

async function readJson(store: ArtifactStore, key: string): Promise<unknown> {
  const object = await store.get(key);
  if (!object) throw new PipelineEnvironmentError(`아티팩트를 읽을 수 없습니다: ${key}`);
  return JSON.parse(Buffer.from(object.body).toString("utf8"));
}

function rejected(code: string, detail: string): NonRetryableJobError {
  return new NonRetryableJobError(`${code}: ${detail}`);
}

export async function runRerunExecution(input: RerunInput, deps: RerunDeps): Promise<RerunResult> {
  const { db, store, runner, config } = deps;
  const newId = deps.newId ?? randomUUID;
  const secrets = deps.secrets ?? [];
  const mask = (text: string) => maskSensitive(text, secrets);
  const logger = deps.logger.child({ evaluationId: input.evaluationId, caseId: input.caseId });
  const caseSetName = config.caseSet ?? DEFAULT_CASE_SET;

  // ── 조건 대조: 같은 SHA·기준·환경이어야만 재실행한다 ─────────────────────────
  const evaluation = await getEvaluation(db, input.evaluationId);
  if (!evaluation) throw rejected("EVALUATION_NOT_FOUND", `평가 ${input.evaluationId}가 없습니다`);
  const submission = await getSubmission(db, evaluation.submissionId);
  if (!submission || submission.status === "DELETED" || submission.deletedAt) {
    throw rejected("SUBMISSION_DELETED", `평가 ${evaluation.id}의 제출이 삭제됐습니다`);
  }
  const version = await getAssignmentVersion(db, evaluation.assignmentVersionId);
  if (!version) {
    throw rejected("VERSION_NOT_FOUND", `과제 버전 ${evaluation.assignmentVersionId}이 없습니다`);
  }
  if (version.rubricVersion !== evaluation.rubricVersion) {
    throw rejected(
      "RUBRIC_VERSION_MISMATCH",
      `평가는 기준 ${evaluation.rubricVersion}으로 채점됐지만 과제 버전의 기준은 ${version.rubricVersion}입니다`,
    );
  }
  const cases = getCaseSet(caseSetName);
  const currentHarnessVersion = harnessVersionOf(cases);
  if (evaluation.harnessVersion !== currentHarnessVersion) {
    throw rejected(
      "HARNESS_VERSION_MISMATCH",
      `평가는 하네스 ${evaluation.harnessVersion}으로 실행됐지만 워커의 하네스는 ${currentHarnessVersion}입니다`,
    );
  }
  const contract: ExecutionContract = version.executionContract;
  const environmentDigest = await expectedEnvironmentDigest(
    config.templateRoot,
    contract.templateName,
    runner.kind,
  );
  if (environmentDigest !== evaluation.environmentDigest) {
    throw rejected(
      "ENVIRONMENT_DIGEST_MISMATCH",
      `평가의 실행 환경 digest는 ${evaluation.environmentDigest}인데 현재 템플릿(${contract.templateName}, ${runner.kind})의 digest는 ${environmentDigest}입니다. 템플릿이 바뀌어 같은 환경을 다시 만들 수 없습니다`,
    );
  }
  const snapshotRef = artifactKeys.snapshot(submission.id);
  await verifySnapshot(store, submission.id, evaluation);
  const definition: CaseDefinition | undefined = cases.find((c) => c.id === input.caseId);
  if (!definition) {
    throw rejected(
      "CASE_NOT_FOUND",
      `케이스 ${input.caseId}은(는) 케이스 집합 ${caseSetName}에 없습니다`,
    );
  }
  const results = await getEvaluationResults(db, evaluation.id);
  const original = findOriginalRecord(results, input.caseId);
  if (!original) {
    throw rejected(
      "ORIGINAL_RUN_NOT_FOUND",
      `평가 ${evaluation.id}에 케이스 ${input.caseId}의 원본 실행 기록이 없습니다 (판정 저장 전이거나 케이스가 실행되지 않음)`,
    );
  }
  const otherJobs = (await listRerunJobs(db, evaluation.id)).filter((j) => j.id !== input.jobId);
  if (otherJobs.length >= deps.limit) {
    throw rejected(
      "RERUN_LIMIT_EXCEEDED",
      `평가당 재실행 상한 ${deps.limit}회에 도달했습니다 (이미 ${otherJobs.length}회)`,
    );
  }
  const originalActual = HarnessCaseActualSchema.parse(await readJson(store, original.actualRef));

  // ── 실행 ─────────────────────────────────────────────────────────────────────
  if (deps.signal?.aborted)
    throw new PipelineEnvironmentError("워커 종료 신호로 재실행을 시작하지 않았습니다");
  await deps.heartbeat?.();
  let env: PreparedEnv | null = null;
  try {
    env = await withStageTimeout(
      "ENV_PREP",
      config.stageTimeoutMs,
      runner.prepare(snapshotRef, contract, {
        logKeyPrefix: artifactKeys.sandboxLogPrefix(evaluation.id, `rerun-${input.jobId}`),
      }),
    );
    if (env.environmentDigest !== environmentDigest) {
      throw new PipelineEnvironmentError(
        `러너 환경 digest ${env.environmentDigest}가 평가의 ${environmentDigest}와 다릅니다`,
      );
    }
    const observed = await withStageTimeout(
      "REQUIREMENT_VERIFY",
      config.stageTimeoutMs,
      observeCase(runner, env, definition, {
        caseSetName,
        contract,
        rubric: version.rubric,
        requestTimeoutMs: config.requestTimeoutMs,
        heartbeat: deps.heartbeat,
        logger,
      }),
    );
    if (observed.failure) {
      logger.warn({ failure: observed.failure }, "재실행 중 제출 서비스 문제가 관측됐습니다");
    }

    // ── 기록·근거 저장 (원본은 건드리지 않는다) ───────────────────────────────
    const runId = newId();
    const evidenceId = newId();
    const result = observed.harness?.results[0] ?? null;
    const actualBody = rerunActualBody(input.caseId, result, observed, mask);
    const comparison = compareWithOriginal(originalActual, actualBody, {
      originalRunId: original.id,
      jobId: input.jobId,
    });
    const key = (part: "input" | "expected" | "actual" | "timeline") =>
      artifactKeys.runRecord(evaluation.id, runId, part);
    const artifacts: Array<{ key: string; body: unknown }> = [
      {
        key: key("input"),
        body: {
          kind: "RERUN",
          caseId: input.caseId,
          criterionIds: definition.criterionIds,
          caseSet: caseSetName,
          harnessVersion: currentHarnessVersion,
          requestTimeoutMs: config.requestTimeoutMs,
          resetPath: contract.resetPath ?? null,
          definition,
          originalRunId: original.id,
          originalInputRef: original.inputRef,
          jobId: input.jobId,
          submissionSha: evaluation.submissionSha,
          environmentDigest,
          startup: observed.startup,
        },
      },
      {
        key: key("expected"),
        body: {
          caseId: input.caseId,
          expected: result?.expected ?? {},
          checks: result?.checks.map((c) => ({ name: c.name, expected: c.expected })) ?? [],
          originalRunId: original.id,
        },
      },
      { key: key("actual"), body: { ...actualBody, rerun: comparison } },
    ];
    const refs = [key("input"), key("expected"), key("actual")];
    if (result) {
      artifacts.push({ key: key("timeline"), body: result.timeline });
      refs.push(key("timeline"));
    }
    for (const artifact of artifacts) {
      await store.put(artifact.key, JSON.stringify(artifact.body, null, 2), {
        contentType: ARTIFACT_CONTENT_TYPES.runRecord,
      });
    }
    const failureKind: FailureKind = result
      ? result.failureKind
      : (observed.failure?.kind ?? "SUBMISSION");
    const record: NewExecutionRecord = {
      id: runId,
      evaluationId: evaluation.id,
      kind: "RERUN",
      submissionSha: evaluation.submissionSha,
      rubricVersion: evaluation.rubricVersion,
      harnessVersion: currentHarnessVersion,
      environmentDigest,
      inputRef: key("input"),
      expectedRef: key("expected"),
      actualRef: key("actual"),
      exitCode: serviceExitCode(observed.serviceExit),
      failureKind,
      startedAt: result?.startedAt ?? observed.serviceExit?.startedAt,
      finishedAt: result?.finishedAt ?? observed.serviceExit?.finishedAt,
      durationMs: result
        ? Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt))
        : observed.startup?.elapsedMs,
    };
    const evidence: NewEvidence = {
      id: evidenceId,
      evaluationId: evaluation.id,
      submissionSha: evaluation.submissionSha,
      runId,
      testId: input.caseId,
      artifactRefs: [
        ...refs,
        original.actualRef,
        ...(observed.serviceLogs ? [observed.serviceLogs.stdout, observed.serviceLogs.stderr] : []),
      ],
    };
    const updatedCriterionResultIds = await db.transaction(async (tx) => {
      await insertExecutionRecords(tx, [record]);
      await insertEvidences(tx, [evidence]);
      return appendCriterionResultEvidence(tx, evaluation.id, definition.criterionIds, [
        evidenceId,
      ]);
    });
    logger.info(
      {
        runId,
        originalRunId: original.id,
        verdict: actualBody.verdict,
        failureKind,
        comparison: comparison.outcome,
        differingChecks: comparison.differingChecks,
        updatedCriterionResultIds,
      },
      "재실행 기록을 저장했습니다",
    );
    return {
      evaluationId: evaluation.id,
      caseId: input.caseId,
      runId,
      evidenceId,
      originalRunId: original.id,
      failureKind,
      verdict: actualBody.verdict,
      comparison,
      updatedCriterionResultIds,
    };
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

/** 스냅샷이 평가 시점과 같은 SHA·digest인지 (매니페스트와 REPO_CHECK 단계 기록 대조) */
async function verifySnapshot(
  store: ArtifactStore,
  submissionId: string,
  evaluation: EvaluationRow,
): Promise<void> {
  const manifestObject = await store.get(artifactKeys.snapshotManifest(submissionId));
  if (!manifestObject || !(await store.exists(artifactKeys.snapshot(submissionId)))) {
    throw rejected("SNAPSHOT_MISSING", `제출 ${submissionId}의 스냅샷 또는 매니페스트가 없습니다`);
  }
  const manifest = SnapshotManifestSchema.safeParse(
    JSON.parse(Buffer.from(manifestObject.body).toString("utf8")),
  );
  if (!manifest.success) {
    throw rejected(
      "SNAPSHOT_MISSING",
      `제출 ${submissionId}의 매니페스트 형식이 올바르지 않습니다`,
    );
  }
  if (manifest.data.submissionSha !== evaluation.submissionSha) {
    throw rejected(
      "SNAPSHOT_MISMATCH",
      `스냅샷 SHA ${manifest.data.submissionSha}가 평가의 SHA ${evaluation.submissionSha}와 다릅니다`,
    );
  }
  const repoCheck = stageRecordOf(evaluation.stageLog, "REPO_CHECK");
  const recorded = repoCheck.detail?.snapshotDigest;
  if (typeof recorded === "string" && recorded !== manifest.data.snapshotDigest) {
    throw rejected(
      "SNAPSHOT_MISMATCH",
      `스냅샷 digest ${manifest.data.snapshotDigest}가 평가에 기록한 ${recorded}와 다릅니다`,
    );
  }
}

interface ObservedCase {
  startup: ServiceStartupObservation | null;
  serviceExit: ProcessExit | null;
  serviceLogs: ServiceLogsRef | null;
  harness: HarnessReport | null;
  failure: { kind: FailureKind; reason: string } | null;
}

/** 서비스를 띄우고 케이스 하나만 하네스로 관측한 뒤 종료한다 (REQUIREMENT_VERIFY의 하네스 부분과 같은 규칙) */
async function observeCase(
  runner: SandboxRunner,
  env: PreparedEnv,
  definition: CaseDefinition,
  options: {
    caseSetName: string;
    contract: ExecutionContract;
    rubric: Rubric;
    requestTimeoutMs: number;
    heartbeat?: (() => Promise<void>) | undefined;
    logger: Logger;
  },
): Promise<ObservedCase> {
  const observed: ObservedCase = {
    startup: null,
    serviceExit: null,
    serviceLogs: null,
    harness: null,
    failure: null,
  };
  const lost: { error: Error | null } = { error: null };
  try {
    const service = await runner.startService(env, { label: "rerun-service" });
    observed.startup = service.startup;
    observed.serviceLogs = service.logsRef;
    try {
      observed.harness = await runHarness([definition], {
        baseUrl: service.baseUrl,
        timeoutMs: options.requestTimeoutMs,
        ...(options.contract.resetPath ? { resetPath: options.contract.resetPath } : {}),
        caseSet: options.caseSetName,
        rubric: options.rubric,
        caseIds: [definition.id],
        onCaseFinished: () => {
          if (options.heartbeat && lost.error === null) {
            options.heartbeat().catch((error: unknown) => {
              lost.error = error instanceof Error ? error : new Error(String(error));
            });
          }
        },
      });
      if (
        observed.harness.results.some((r) => r.timeline.some((t) => t.error?.kind === "CONNECTION"))
      ) {
        const deadline = Date.now() + CRASH_SETTLE_MS;
        while (service.isRunning() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    } finally {
      observed.serviceExit = await service.stop();
    }
    if (lost.error !== null) throw lost.error;
    if (observed.serviceExit.timedOut) {
      observed.failure = {
        kind: "TIMEOUT",
        reason: `서비스가 수명 제한(${observed.serviceExit.durationMs}ms)을 넘겨 러너가 종료했습니다`,
      };
    } else if (!observed.serviceExit.stoppedByCaller) {
      observed.failure = {
        kind: "SUBMISSION",
        reason: `서비스가 재실행 중 스스로 종료했습니다 (exit ${observed.serviceExit.exitCode ?? "null"}, signal ${observed.serviceExit.signal ?? "null"})`,
      };
    }
  } catch (error) {
    if (error instanceof ServiceStartError) {
      observed.startup = error.startup;
      observed.serviceExit = error.stopped;
      observed.serviceLogs = error.logsRef;
      observed.failure = {
        kind: "SUBMISSION",
        reason: `서비스 기동 실패: ${error.startup.reason ?? error.startup.outcome}`,
      };
    } else if (error instanceof BlockedCommandError) {
      observed.failure = {
        kind: "SUBMISSION",
        reason: `시작 명령이 차단됐습니다: ${error.message}`,
      };
    } else {
      throw error;
    }
  }
  return observed;
}

/** RERUN 기록의 `actual.json` 본문 (하네스 케이스 기록과 같은 형태). 하네스가 돌지 못했으면 INCONCLUSIVE·검사 없음 */
function rerunActualBody(
  caseId: string,
  result: CaseResult | null,
  observed: ObservedCase,
  mask: (text: string) => string,
): HarnessCaseActual & {
  startup: ServiceStartupObservation | null;
  serviceFailure: string | null;
} {
  const serviceFailure = observed.failure ? mask(observed.failure.reason) : null;
  if (result) {
    return {
      caseId,
      verdict: result.verdict,
      failureKind: result.failureKind,
      reason: result.reason ?? null,
      actual: result.actual,
      checks: result.checks,
      startup: observed.startup,
      serviceFailure,
    };
  }
  return {
    caseId,
    verdict: "INCONCLUSIVE",
    failureKind: observed.failure?.kind ?? "SUBMISSION",
    reason: serviceFailure ?? "하네스가 실행되지 않음",
    actual: {},
    checks: [],
    startup: observed.startup,
    serviceFailure,
  };
}

function serviceExitCode(serviceExit: ProcessExit | null): number | null {
  if (!serviceExit || serviceExit.stoppedByCaller) return null;
  return serviceExit.exitCode;
}
