/**
 * TEST_EFFECTIVENESS 단계: mutation 실험 파이프라인 (TICKET.md T-403, PRD 2장 W2).
 *
 * 전제 조건: REQUIREMENT_VERIFY의 제출 테스트 기준 실행(T-109)이 PASSED여야 한다.
 * - NO_TESTS → 모든 그룹 "테스트 미제출", UNSUPPORTED_FRAMEWORK·BUILD_FAIL·INCONCLUSIVE·TIMEOUT → "환경 미지원",
 *   FAILED → "기준 실행 실패". 실험 행은 만들지 않고 단계 detail에 그룹별로 남긴다 (T-404가 점수로 옮긴다).
 *
 * 변형마다 (rubric 그룹의 `mutationIds` 순서)
 * 1. 적용(T-402 `applyMutations`): NOT_APPLICABLE·BUILD_FAIL이면 그대로 기록한다.
 * 2. 원본 하네스에서 대상 기준의 케이스가 모두 PASS였는지 확인한다. 원본부터 실패한 동작은 변형으로 결함을 "주입"할 수 없다.
 * 3. 변형 스냅샷 아티팩트 → 러너 `prepare` → 서비스 기동 → 대상 기준의 하네스 케이스만 실행(유효성 검증, MUTATION_VALIDATION 기록)
 *    - 하네스 FAIL → 유효한 결함. 4로 간다.
 *    - 하네스 PASS → EQUIVALENT (제출 테스트를 돌리지 않는다. SURVIVED로 세지 않는다)
 *    - 기동 실패 → BUILD_FAIL, 미확정 → TIMEOUT 또는 ENV_ERROR
 * 4. 같은 환경에서 제출 테스트 실행(MUTATION_TESTS 기록, 타입 검사 끔): 실패 → KILLED, 통과 → SURVIVED,
 *    TIMEOUT → TIMEOUT, 로드 실패 → BUILD_FAIL, 그 밖 → ENV_ERROR.
 *
 * 단계 전체 벽시계 상한(`MUTATION_STAGE_TIMEOUT_MS`, 기본 5분)을 넘기면 진행 중인 변형은 환경을 파괴해 멈추고 TIMEOUT,
 * 남은 변형은 실행하지 않고 TIMEOUT으로 기록한다. 단계 자체는 DONE이다.
 * 변형 환경(러너 환경, 변형 스냅샷 임시 디렉터리)은 결과와 무관하게 항상 정리한다.
 *
 * 판정은 러너가 수집한 구조화 결과(하네스 verdict, vitest JSON)만 쓴다 (G-07). LLM은 위치 탐색(T-402)에만 쓰고
 * KILLED/SURVIVED 판정에는 관여하지 않는다 (G-01). 실행 기록은 새로 쓰기만 한다 (G-03).
 */
import {
  maskSensitive,
  type ExecutionContract,
  type FailureKind,
  type MutationOutcome,
  type Rubric,
  type Verdict,
} from "@ohmyti/core";
import {
  applyMutations,
  MUTATION_CATALOG,
  type MutationApplyResult,
  type MutationDefinition,
} from "@ohmyti/analysis";
import {
  listMutationExperiments,
  persistMutationExperiment,
  type Database,
  type MutationExperimentRow,
  type NewExecutionRecord,
  type NewMutationExperiment,
} from "@ohmyti/db";
import {
  foldVerdicts,
  getCaseSet,
  runHarness,
  type CaseDefinition,
  type HarnessReport,
} from "@ohmyti/harness";
import type { LlmClient } from "@ohmyti/llm";
import {
  BlockedCommandError,
  runSubmittedTests,
  ServiceStartError,
  type PreparedEnv,
  type ProcessExit,
  type SandboxRunner,
  type ServiceLogsRef,
  type ServiceStartupObservation,
  type SubmittedTestResult,
} from "@ohmyti/runner";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logger";
import {
  abortReason,
  errorMessageOf,
  PipelineAbortedError,
  PipelineEnvironmentError,
} from "../pipeline/errors";
import { templateNodeModulesDir } from "../results";
import { readSnapshotEntries, snapshotFilesFromEntries } from "../support";
import { buildMutantSnapshot } from "./snapshot";

export const TEST_EFFECTIVENESS_STAGE = "TEST_EFFECTIVENESS" as const;

export const MUTATION_STAGE_DEFAULTS = {
  /** 단계 전체 벽시계 상한 (`MUTATION_STAGE_TIMEOUT_MS`) */
  timeoutMs: 5 * 60 * 1000,
} as const;

/** 하네스 연결 실패 뒤 서비스 종료를 기다리는 시간 (`requirement-verify.ts`의 `CRASH_SETTLE_MS`와 같은 뜻) */
const CRASH_SETTLE_MS = 3000;

/**
 * 전제 조건 판정. `READY`만 변형을 실행한다.
 * - `NO_TESTS`: 테스트 미제출 (제출물의 선택. T-404가 0점으로 본다)
 * - `ENV_UNSUPPORTED`: 제출 테스트를 우리 환경에서 돌릴 수 없었다 (T-404가 미확정으로 본다)
 * - `BASELINE_FAILED`: 원본에서 제출 테스트가 실패했다. 변형 전부터 실패하므로 탐지 여부를 가를 수 없다
 */
export type PreconditionStatus = "READY" | "NO_TESTS" | "ENV_UNSUPPORTED" | "BASELINE_FAILED";

export const PRECONDITION_TEXT: Record<PreconditionStatus, string> = {
  READY: "제출 테스트 기준 실행 통과",
  NO_TESTS: "테스트 미제출",
  ENV_UNSUPPORTED: "환경 미지원",
  BASELINE_FAILED: "제출 테스트 기준 실행 실패",
};

export function preconditionOf(tests: Pick<SubmittedTestResult, "status">): PreconditionStatus {
  switch (tests.status) {
    case "PASSED":
      return "READY";
    case "NO_TESTS":
      return "NO_TESTS";
    case "FAILED":
      return "BASELINE_FAILED";
    case "UNSUPPORTED_FRAMEWORK":
    case "BUILD_FAIL":
    case "INCONCLUSIVE":
    case "TIMEOUT":
      return "ENV_UNSUPPORTED";
  }
}

export interface PlannedMutation {
  mutationId: string;
  groupId: string;
}

/** rubric 그룹의 `mutationIds`를 그룹 순서대로 펼친다. 같은 id가 두 그룹에 있으면 앞의 것만 쓴다 */
export function plannedMutations(rubric: Rubric): PlannedMutation[] {
  const seen = new Set<string>();
  const out: PlannedMutation[] = [];
  for (const group of rubric.groups) {
    for (const mutationId of group.mutationIds) {
      if (seen.has(mutationId)) continue;
      seen.add(mutationId);
      out.push({ mutationId, groupId: group.id });
    }
  }
  return out;
}

export interface TestEffectivenessInput {
  evaluation: {
    id: string;
    submissionSha: string;
    rubricVersion: string;
    harnessVersion: string;
    environmentDigest: string;
  };
  snapshotRef: string;
  contract: ExecutionContract;
  rubric: Rubric;
  caseSet: string;
  /** REQUIREMENT_VERIFY가 원본에서 관측한 결과 */
  baseline: { tests: Pick<SubmittedTestResult, "status">; harness: HarnessReport | null };
  /** job 시도 번호 (러너 로그 접두사 구분) */
  attempt: number;
}

export interface TestEffectivenessDeps {
  db: Database;
  store: ArtifactStore;
  runner: SandboxRunner;
  logger: Logger;
  templateRoot: string;
  /** 단계 전체 벽시계 상한 */
  timeoutMs: number;
  /** 하네스 요청당 제한 시간 */
  requestTimeoutMs: number;
  /** 변형 스냅샷 임시 디렉터리 위치 */
  workRoot?: string | undefined;
  /** 위치 탐색 2차(T-402). 없으면 휴리스틱만 쓴다 */
  llm?: LlmClient | undefined;
  /** 테스트용 카탈로그 교체 */
  catalog?: readonly MutationDefinition[] | undefined;
  secrets?: readonly string[] | undefined;
  heartbeat?: (() => Promise<void>) | undefined;
  signal?: AbortSignal | undefined;
  newId?: (() => string) | undefined;
}

export interface MutationExperimentSummary {
  mutationId: string;
  groupId: string;
  targetCriterionId: string;
  outcome: MutationOutcome;
  validationVerdict: Verdict | null;
  reason: string | null;
  patchDigest: string | null;
  patchRef: string | null;
  validationRecordId: string | null;
  testRecordId: string | null;
}

/** `stage_log.detail`. 실험 원문은 `mutation_experiments`와 실행 기록에 있다 */
export interface TestEffectivenessDetail {
  precondition: { status: PreconditionStatus; reason: string; testsStatus: string };
  timeoutMs: number;
  elapsedMs: number;
  /** 벽시계 상한에 걸린 변형이 있었는지 */
  deadlineReached: boolean;
  groups: Array<{
    groupId: string;
    mutationIds: string[];
    /** 전제 조건이 READY가 아니면 그 사유 코드, 아니면 `EXPERIMENTED` */
    status: PreconditionStatus | "EXPERIMENTED";
  }>;
  experiments: MutationExperimentSummary[];
  outcomes: Partial<Record<MutationOutcome, number>>;
  [key: string]: unknown;
}

export interface TestEffectivenessResult {
  detail: TestEffectivenessDetail;
  experiments: MutationExperimentRow[];
}

export async function runTestEffectivenessStage(
  input: TestEffectivenessInput,
  deps: TestEffectivenessDeps,
): Promise<TestEffectivenessResult> {
  const { db, store } = deps;
  const startedAt = Date.now();
  const deadline = startedAt + deps.timeoutMs;
  const newId = deps.newId ?? randomUUID;
  const logger = deps.logger.child({ stage: TEST_EFFECTIVENESS_STAGE });
  const planned = plannedMutations(input.rubric);
  const precondition = preconditionOf(input.baseline.tests);
  const state = { deadlineReached: false };

  if (precondition !== "READY") {
    logger.info(
      { precondition, testsStatus: input.baseline.tests.status },
      "제출 테스트 기준 실행이 통과하지 않아 mutation 실험을 하지 않습니다",
    );
  } else {
    const existing = new Set(
      (await listMutationExperiments(db, input.evaluation.id)).map((e) => e.mutationId),
    );
    const todo = planned.filter((p) => !existing.has(p.mutationId));
    if (existing.size > 0) {
      logger.info({ existing: [...existing] }, "이미 기록된 mutation 실험은 다시 하지 않습니다");
    }
    if (todo.length > 0) {
      const snapshot = await store.get(input.snapshotRef);
      if (!snapshot) {
        throw new PipelineEnvironmentError(`스냅샷을 읽을 수 없습니다: ${input.snapshotRef}`);
      }
      const entries = await readSnapshotEntries(snapshot.body);
      const applied = await applyMutations({
        files: snapshotFilesFromEntries(entries),
        mutationIds: todo.map((p) => p.mutationId),
        catalog: deps.catalog ?? MUTATION_CATALOG,
        llm: deps.llm,
        logger,
        nodeModulesDir: templateNodeModulesDir(deps.templateRoot, input.contract.templateName),
      });
      for (const [index, plan] of todo.entries()) {
        if (deps.signal?.aborted) throw new PipelineAbortedError(TEST_EFFECTIVENESS_STAGE);
        await deps.heartbeat?.();
        const result = applied[index]!;
        const experiment = await runExperiment(plan, result, {
          input,
          deps,
          entries,
          deadline,
          state,
          newId,
          logger: logger.child({ mutationId: plan.mutationId }),
        });
        await persistMutationExperiment(db, experiment.row, experiment.records);
        logger.info(
          {
            mutationId: plan.mutationId,
            outcome: experiment.row.outcome,
            validationVerdict: experiment.row.validationVerdict ?? null,
            reason: experiment.row.reason ?? null,
          },
          "mutation 실험을 기록했습니다",
        );
      }
    }
  }

  const experiments = await listMutationExperiments(db, input.evaluation.id);
  const byId = new Map(experiments.map((e) => [e.mutationId, e]));
  const summaries: MutationExperimentSummary[] = planned
    .map((p) => byId.get(p.mutationId))
    .filter((e): e is MutationExperimentRow => e !== undefined)
    .map((e) => ({
      mutationId: e.mutationId,
      groupId: e.groupId,
      targetCriterionId: e.targetCriterionId,
      outcome: e.outcome,
      validationVerdict: e.validationVerdict,
      reason: e.reason,
      patchDigest: e.patchDigest,
      patchRef: e.patchRef,
      validationRecordId: e.validationRecordId,
      testRecordId: e.testRecordId,
    }));
  const outcomes: Partial<Record<MutationOutcome, number>> = {};
  for (const s of summaries) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
  const detail: TestEffectivenessDetail = {
    precondition: {
      status: precondition,
      reason: PRECONDITION_TEXT[precondition],
      testsStatus: input.baseline.tests.status,
    },
    timeoutMs: deps.timeoutMs,
    elapsedMs: Date.now() - startedAt,
    deadlineReached: state.deadlineReached,
    groups: input.rubric.groups.map((g) => ({
      groupId: g.id,
      mutationIds: [...g.mutationIds],
      status: precondition === "READY" ? "EXPERIMENTED" : precondition,
    })),
    experiments: summaries,
    outcomes,
  };
  return { detail, experiments };
}

// ─── 변형 하나 ───────────────────────────────────────────────────────────────

interface ExperimentContext {
  input: TestEffectivenessInput;
  deps: TestEffectivenessDeps;
  entries: ReadonlyMap<string, Buffer>;
  deadline: number;
  state: { deadlineReached: boolean };
  newId: () => string;
  logger: Logger;
}

interface PlannedExperiment {
  row: NewMutationExperiment;
  records: NewExecutionRecord[];
}

interface ValidationObservation {
  startup: ServiceStartupObservation | null;
  serviceExit: ProcessExit | null;
  serviceLogs: ServiceLogsRef | null;
  harness: HarnessReport | null;
  /** 서비스 쪽에서 관측한 문제 (기동 실패·크래시·수명 초과) */
  failure: { kind: FailureKind; reason: string; startFailed: boolean } | null;
  verdict: Verdict;
  failureKind: FailureKind;
}

/** 진행 중에 채워지는 관측. 벽시계 상한으로 멈춰도 끝난 부분은 기록한다 */
interface MutantProgress {
  env: PreparedEnv | null;
  validation: ValidationObservation | null;
  tests: SubmittedTestResult | null;
}

class MutantAbortedError extends Error {
  override readonly name = "MutantAbortedError";
}

function reasonText(result: MutationApplyResult): string {
  const base = result.reason ?? "";
  const extra = [result.detail, ...result.buildErrors.slice(0, 3)].filter(
    (s): s is string => typeof s === "string" && s !== "",
  );
  return extra.length > 0 ? `${base} · ${extra.join(" · ")}` : base;
}

async function runExperiment(
  plan: PlannedMutation,
  result: MutationApplyResult,
  ctx: ExperimentContext,
): Promise<PlannedExperiment> {
  const { input, deps } = ctx;
  const mask = (text: string) => maskSensitive(text, deps.secrets ?? []);
  const targetCriterionId =
    result.targetCriterionIds[0] ??
    input.rubric.groups.find((g) => g.id === plan.groupId)?.criterionIds[0] ??
    plan.groupId;
  const row: NewMutationExperiment = {
    id: ctx.newId(),
    evaluationId: input.evaluation.id,
    mutationId: plan.mutationId,
    groupId: plan.groupId,
    targetCriterionId,
    target: result.target ?? undefined,
    patchDigest: result.patchDigest ?? undefined,
    outcome: "NOT_APPLICABLE",
  };

  if (result.status === "NOT_APPLICABLE") {
    return {
      row: { ...row, outcome: "NOT_APPLICABLE", reason: mask(reasonText(result)) },
      records: [],
    };
  }

  // diff는 BUILD_FAIL이어도 남긴다 (무엇이 컴파일되지 않았는지 사람이 볼 수 있게)
  const patchRef = artifactKeys.mutationDiff(input.evaluation.id, plan.mutationId);
  await deps.store.put(patchRef, result.diff ?? "", {
    contentType: ARTIFACT_CONTENT_TYPES.mutationDiff,
  });
  row.patchRef = patchRef;
  if (result.status === "BUILD_FAIL") {
    return {
      row: { ...row, outcome: "BUILD_FAIL", reason: mask(reasonText(result)) },
      records: [],
    };
  }

  // 원본에서 대상 기준의 하네스 케이스가 모두 PASS여야 변형으로 결함을 주입했다고 말할 수 있다
  const allCases = getCaseSet(input.caseSet);
  const targetCases = allCases.filter((c) =>
    c.criterionIds.some((id) => result.targetCriterionIds.includes(id)),
  );
  if (targetCases.length === 0) {
    return {
      row: {
        ...row,
        outcome: "NOT_APPLICABLE",
        reason: `대상 기준(${result.targetCriterionIds.join(", ")})을 검사하는 하네스 케이스가 없음`,
      },
      records: [],
    };
  }
  const baselineResults = targetCases.map((c) =>
    input.baseline.harness?.results.find((r) => r.caseId === c.id),
  );
  const notPassing = targetCases.filter((_, i) => baselineResults[i]?.verdict !== "PASS");
  if (notPassing.length > 0) {
    return {
      row: {
        ...row,
        outcome: "NOT_APPLICABLE",
        reason: `원본이 대상 하네스 케이스(${notPassing.map((c) => c.id).join(", ")})를 통과하지 못해 변형의 효과를 검증할 수 없음`,
      },
      records: [],
    };
  }

  if (Date.now() >= ctx.deadline) {
    ctx.state.deadlineReached = true;
    return {
      row: {
        ...row,
        outcome: "TIMEOUT",
        reason: `단계 벽시계 상한(${deps.timeoutMs}ms)을 넘겨 실행하지 않음`,
      },
      records: [],
    };
  }

  const progress: MutantProgress = { env: null, validation: null, tests: null };
  const controller = new AbortController();
  const run = executeMutant(plan, result, targetCases, ctx, progress, controller.signal);
  let timer: NodeJS.Timeout | undefined;
  const deadlineHit = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), Math.max(0, ctx.deadline - Date.now()));
  });
  // 콜백에서 갱신하므로 객체에 둔다 (let이면 뒤에서 null로 좁혀진다)
  const failed: { error: Error | null } = { error: null };
  let timedOut = false;
  try {
    const winner = await Promise.race([
      run.then(
        () => "done" as const,
        (error: unknown) => {
          failed.error = error instanceof Error ? error : new Error(errorMessageOf(error));
          return "error" as const;
        },
      ),
      deadlineHit,
    ]);
    if (winner === "deadline") {
      timedOut = true;
      ctx.state.deadlineReached = true;
      controller.abort();
      // 진행 중인 서비스·명령을 끝내 run이 빨리 풀리게 한다
      if (progress.env) await destroyQuietly(deps.runner, progress.env, ctx.logger);
      await run.catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
    if (progress.env) await destroyQuietly(deps.runner, progress.env, ctx.logger);
  }
  if (failed.error !== null && isLostOrAborted(failed.error)) throw failed.error;

  const records: NewExecutionRecord[] = [];
  const common = {
    evaluationId: input.evaluation.id,
    submissionSha: input.evaluation.submissionSha,
    rubricVersion: input.evaluation.rubricVersion,
    harnessVersion: input.evaluation.harnessVersion,
    environmentDigest: input.evaluation.environmentDigest,
    patchDigest: result.patchDigest ?? undefined,
  };
  const meta = {
    mutationId: plan.mutationId,
    groupId: plan.groupId,
    targetCriterionIds: result.targetCriterionIds,
    target: result.target,
    locatedBy: result.locatedBy,
    patchDigest: result.patchDigest,
    patchRef,
  };
  if (progress.validation) {
    row.validationVerdict = progress.validation.verdict;
    const validationRecord = await writeValidationRecord(
      progress.validation,
      targetCases,
      { ...common, id: ctx.newId() },
      { ...meta, caseSet: input.caseSet, requestTimeoutMs: deps.requestTimeoutMs },
      deps.store,
      mask,
    );
    records.push(validationRecord);
    row.validationRecordId = validationRecord.id;
  }
  if (progress.tests) {
    const testsRecord = await writeTestsRecord(
      progress.tests,
      { ...common, id: ctx.newId() },
      meta,
      deps.store,
    );
    records.push(testsRecord);
    row.testRecordId = testsRecord.id;
  }

  const outcome = decideOutcome({
    progress,
    timedOut,
    runError: failed.error,
    timeoutMs: deps.timeoutMs,
    mask,
  });
  // TIMEOUT·ENV_ERROR로 끝난 실험이 검증 FAIL 뒤 테스트를 끝내지 못했으면 테스트 기록 없이 남는다 (CHECK 제약과 맞다)
  return { row: { ...row, outcome: outcome.outcome, reason: outcome.reason }, records };
}

/** 변형 스냅샷 → prepare → 유효성 검증 → (FAIL이면) 제출 테스트. 결과는 `progress`에 채운다 */
async function executeMutant(
  plan: PlannedMutation,
  result: MutationApplyResult,
  targetCases: readonly CaseDefinition[],
  ctx: ExperimentContext,
  progress: MutantProgress,
  signal: AbortSignal,
): Promise<void> {
  const { input, deps } = ctx;
  const check = () => {
    if (signal.aborted) throw new MutantAbortedError("벽시계 상한으로 중단");
  };
  const bytes = await buildMutantSnapshot({
    entries: ctx.entries,
    mutatedFiles: result.mutatedFiles,
    workRoot: deps.workRoot,
  });
  const snapshotRef = artifactKeys.mutationSnapshot(input.evaluation.id, plan.mutationId);
  await deps.store.put(snapshotRef, bytes, {
    contentType: ARTIFACT_CONTENT_TYPES.mutationSnapshot,
  });
  check();
  const env = await deps.runner.prepare(snapshotRef, input.contract, {
    logKeyPrefix: artifactKeys.sandboxLogPrefix(
      input.evaluation.id,
      `mutation-${plan.mutationId}-attempt-${input.attempt}`,
    ),
  });
  progress.env = env;
  if (env.environmentDigest !== input.evaluation.environmentDigest) {
    throw new PipelineEnvironmentError(
      `러너 환경 digest ${env.environmentDigest}가 평가의 ${input.evaluation.environmentDigest}와 다릅니다`,
    );
  }
  check();
  await deps.heartbeat?.();
  progress.validation = await observeValidation(env, targetCases, ctx, signal);
  ctx.logger.info(
    {
      verdict: progress.validation.verdict,
      cases: progress.validation.harness?.results.map((r) => `${r.caseId}=${r.verdict}`) ?? [],
      failure: progress.validation.failure,
    },
    "mutation 유효성 검증을 마쳤습니다",
  );
  check();
  if (progress.validation.verdict !== "FAIL") return;
  await deps.heartbeat?.();
  progress.tests = await runSubmittedTests(deps.runner, env, {
    label: "mutation-tests",
    // 변형이 타입 오류를 만들면 tsc가 BUILD_FAIL을 내 탐지 여부를 가릴 수 없다. 변형 전 타입 검사는 T-402가 했다
    typecheck: false,
    ...(deps.secrets ? { secrets: deps.secrets } : {}),
  });
  ctx.logger.info(
    { status: progress.tests.status, total: progress.tests.total, failed: progress.tests.failed },
    "변형 위에서 제출 테스트를 실행했습니다",
  );
}

async function observeValidation(
  env: PreparedEnv,
  targetCases: readonly CaseDefinition[],
  ctx: ExperimentContext,
  signal: AbortSignal,
): Promise<ValidationObservation> {
  const { input, deps } = ctx;
  const observed: Omit<ValidationObservation, "verdict" | "failureKind"> = {
    startup: null,
    serviceExit: null,
    serviceLogs: null,
    harness: null,
    failure: null,
  };
  const lost: { error: Error | null } = { error: null };
  try {
    const service = await deps.runner.startService(env, { label: "mutation-service" });
    observed.startup = service.startup;
    observed.serviceLogs = service.logsRef;
    // job 신호(취소, T-506)가 오면 남은 케이스를 기다리지 않고 서비스를 멈춘다
    const jobSignal = deps.signal;
    const onJobAbort = () => {
      lost.error ??= abortReason(jobSignal);
      void service.stop();
    };
    if (jobSignal?.aborted) onJobAbort();
    else jobSignal?.addEventListener("abort", onJobAbort, { once: true });
    try {
      if (signal.aborted) throw new MutantAbortedError("벽시계 상한으로 중단");
      observed.harness = await runHarness(getCaseSet(input.caseSet), {
        baseUrl: service.baseUrl,
        timeoutMs: deps.requestTimeoutMs,
        ...(input.contract.resetPath ? { resetPath: input.contract.resetPath } : {}),
        caseSet: input.caseSet,
        rubric: input.rubric,
        caseIds: targetCases.map((c) => c.id),
        onCaseFinished: () => {
          if (deps.heartbeat && lost.error === null) {
            deps.heartbeat().catch((error: unknown) => {
              lost.error = error instanceof Error ? error : new Error(String(error));
            });
          }
        },
      });
      if (
        observed.harness.results.some((r) => r.timeline.some((t) => t.error?.kind === "CONNECTION"))
      ) {
        const until = Date.now() + CRASH_SETTLE_MS;
        while (service.isRunning() && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    } finally {
      jobSignal?.removeEventListener("abort", onJobAbort);
      observed.serviceExit = await service.stop();
    }
    if (lost.error !== null) throw lost.error;
    if (observed.serviceExit.timedOut) {
      observed.failure = {
        kind: "TIMEOUT",
        reason: `변형 서비스가 수명 제한(${observed.serviceExit.durationMs}ms)을 넘겨 러너가 종료했습니다`,
        startFailed: false,
      };
    } else if (!observed.serviceExit.stoppedByCaller) {
      observed.failure = {
        kind: "SUBMISSION",
        reason: `변형 서비스가 검증 중 스스로 종료했습니다 (exit ${observed.serviceExit.exitCode ?? "null"}, signal ${observed.serviceExit.signal ?? "null"})`,
        startFailed: false,
      };
    }
  } catch (error) {
    if (error instanceof ServiceStartError) {
      observed.startup = error.startup;
      observed.serviceExit = error.stopped;
      observed.serviceLogs = error.logsRef;
      observed.failure = {
        kind: "SUBMISSION",
        reason: `변형 서비스 기동 실패: ${error.startup.reason ?? error.startup.outcome}`,
        startFailed: true,
      };
    } else if (error instanceof BlockedCommandError) {
      observed.failure = {
        kind: "SUBMISSION",
        reason: `시작 명령이 차단됐습니다: ${error.message}`,
        startFailed: true,
      };
    } else {
      throw error;
    }
  }
  const results = observed.harness?.results ?? [];
  const folded =
    results.length > 0
      ? foldVerdicts(results)
      : { verdict: "INCONCLUSIVE" as const, failureKind: observed.failure?.kind ?? "ENVIRONMENT" };
  return { ...observed, verdict: folded.verdict, failureKind: folded.failureKind };
}

function decideOutcome(input: {
  progress: MutantProgress;
  timedOut: boolean;
  runError: Error | null;
  timeoutMs: number;
  mask: (text: string) => string;
}): { outcome: MutationOutcome; reason: string } {
  const { progress, mask } = input;
  if (input.timedOut) {
    const phase = progress.validation ? "제출 테스트" : "유효성 검증";
    return {
      outcome: "TIMEOUT",
      reason: `단계 벽시계 상한(${input.timeoutMs}ms)을 넘겨 ${phase} 중에 중단함`,
    };
  }
  if (input.runError !== null) {
    return {
      outcome: "ENV_ERROR",
      reason: mask(`변형 실행 환경 오류 · ${errorMessageOf(input.runError)}`),
    };
  }
  const validation = progress.validation!;
  if (validation.failure?.startFailed) {
    return { outcome: "BUILD_FAIL", reason: mask(validation.failure.reason) };
  }
  if (validation.verdict === "PASS") {
    return {
      outcome: "EQUIVALENT",
      reason: "변형 위에서도 대상 하네스 케이스가 모두 통과함 (결함으로 드러나지 않음)",
    };
  }
  if (validation.verdict === "INCONCLUSIVE") {
    const detail = validation.failure?.reason ?? `하네스 미확정(${validation.failureKind})`;
    return validation.failureKind === "TIMEOUT"
      ? { outcome: "TIMEOUT", reason: mask(`유효성 검증 시간 초과 · ${detail}`) }
      : { outcome: "ENV_ERROR", reason: mask(`유효성 검증 미확정 · ${detail}`) };
  }
  const tests = progress.tests!;
  const summary = `제출 테스트 ${tests.total}개 중 실패 ${tests.failed}개`;
  switch (tests.status) {
    case "FAILED":
      return { outcome: "KILLED", reason: `하네스가 결함을 확인했고 ${summary}로 탐지함` };
    case "PASSED":
      return { outcome: "SURVIVED", reason: `하네스가 결함을 확인했지만 ${summary}로 모두 통과함` };
    case "TIMEOUT":
      return {
        outcome: "TIMEOUT",
        reason: mask(`변형 위 제출 테스트 시간 초과 · ${tests.reason ?? ""}`),
      };
    case "BUILD_FAIL":
      return {
        outcome: "BUILD_FAIL",
        reason: mask(`변형 위 제출 테스트 로드 실패 · ${tests.reason ?? ""}`),
      };
    default:
      return {
        outcome: "ENV_ERROR",
        reason: mask(`변형 위 제출 테스트 ${tests.status} · ${tests.reason ?? ""}`),
      };
  }
}

// ─── 실행 기록 ───────────────────────────────────────────────────────────────

type RecordBase = Omit<
  NewExecutionRecord,
  "kind" | "inputRef" | "expectedRef" | "actualRef" | "exitCode" | "failureKind"
>;

async function putRecordParts(
  store: ArtifactStore,
  evaluationId: string,
  runId: string,
  parts: Partial<Record<"input" | "expected" | "actual" | "timeline", unknown>>,
): Promise<void> {
  for (const [part, body] of Object.entries(parts)) {
    await store.put(
      artifactKeys.runRecord(evaluationId, runId, part as "input"),
      JSON.stringify(body, null, 2),
      { contentType: ARTIFACT_CONTENT_TYPES.runRecord },
    );
  }
}

async function writeValidationRecord(
  validation: ValidationObservation,
  targetCases: readonly CaseDefinition[],
  base: RecordBase,
  meta: Record<string, unknown>,
  store: ArtifactStore,
  mask: (text: string) => string,
): Promise<NewExecutionRecord> {
  const key = (part: "input" | "expected" | "actual" | "timeline") =>
    artifactKeys.runRecord(base.evaluationId, base.id, part);
  const results = validation.harness?.results ?? [];
  // 재생 뷰(T-303)가 읽는 케이스 기록 형태: 대표 케이스(첫 FAIL, 없으면 첫 케이스)를 최상위에 둔다
  const primary = results.find((r) => r.verdict === "FAIL") ?? results[0] ?? null;
  const serviceFailure = validation.failure ? mask(validation.failure.reason) : null;
  await putRecordParts(store, base.evaluationId, base.id, {
    input: {
      kind: "MUTATION_VALIDATION",
      ...meta,
      caseIds: targetCases.map((c) => c.id),
      definitions: targetCases,
      startup: validation.startup,
    },
    expected: {
      // 원본은 이 케이스들을 통과했다. 변형이 유효한 결함이면 하네스가 FAIL을 관측해야 한다
      note: "원본에서 통과한 대상 케이스가 변형에서 실패해야 유효한 변형이다",
      verdict: "FAIL",
      cases: results.map((r) => ({
        caseId: r.caseId,
        expected: r.expected,
        checks: r.checks.map((c) => ({ name: c.name, expected: c.expected })),
      })),
    },
    actual: {
      caseId: primary?.caseId ?? targetCases[0]!.id,
      verdict: validation.verdict,
      failureKind: validation.failureKind,
      reason: primary?.reason ?? serviceFailure,
      actual: primary?.actual ?? {},
      checks: primary?.checks ?? [],
      cases: results.map((r) => ({
        caseId: r.caseId,
        verdict: r.verdict,
        failureKind: r.failureKind,
        reason: r.reason ?? null,
        actual: r.actual,
        checks: r.checks,
      })),
      startup: validation.startup,
      serviceFailure,
      serviceLogs: validation.serviceLogs,
    },
    ...(results.length > 0 ? { timeline: results.flatMap((r) => r.timeline) } : {}),
  });
  const first = results[0];
  const last = results.at(-1);
  return {
    ...base,
    kind: "MUTATION_VALIDATION",
    inputRef: key("input"),
    expectedRef: key("expected"),
    actualRef: key("actual"),
    exitCode:
      validation.serviceExit && !validation.serviceExit.stoppedByCaller
        ? validation.serviceExit.exitCode
        : null,
    failureKind: validation.failureKind,
    startedAt: first?.startedAt ?? validation.serviceExit?.startedAt,
    finishedAt: last?.finishedAt ?? validation.serviceExit?.finishedAt,
    durationMs:
      first && last
        ? Math.max(0, Date.parse(last.finishedAt) - Date.parse(first.startedAt))
        : validation.startup?.elapsedMs,
  };
}

async function writeTestsRecord(
  tests: SubmittedTestResult,
  base: RecordBase,
  meta: Record<string, unknown>,
  store: ArtifactStore,
): Promise<NewExecutionRecord> {
  const key = (part: "input" | "expected" | "actual") =>
    artifactKeys.runRecord(base.evaluationId, base.id, part);
  await putRecordParts(store, base.evaluationId, base.id, {
    input: {
      kind: "MUTATION_TESTS",
      ...meta,
      framework: tests.framework,
      typecheck: null,
      run: tests.run ? { argv: tests.run.argv } : null,
    },
    // 결함을 탐지했다면 제출 테스트가 하나 이상 실패해야 한다
    expected: { status: "FAILED", minFailed: 1 },
    actual: {
      status: tests.status,
      failureKind: tests.failureKind,
      reason: tests.reason,
      total: tests.total,
      passed: tests.passed,
      failed: tests.failed,
      skipped: tests.skipped,
      durationMs: tests.durationMs,
      resultFileCollected: tests.resultFileCollected,
      truncated: tests.truncated,
      run: tests.run,
      testFiles: tests.testFiles,
    },
  });
  return {
    ...base,
    kind: "MUTATION_TESTS",
    inputRef: key("input"),
    expectedRef: key("expected"),
    actualRef: key("actual"),
    exitCode: tests.run?.exitCode ?? null,
    failureKind: tests.failureKind,
    durationMs: Math.round(tests.durationMs),
  };
}

async function destroyQuietly(
  runner: SandboxRunner,
  env: PreparedEnv,
  logger: Logger,
): Promise<void> {
  try {
    await runner.destroy(env);
  } catch (error) {
    logger.error({ err: error, envId: env.id }, "변형 환경 정리에 실패했습니다");
  }
}

function isLostOrAborted(error: unknown): boolean {
  if (error instanceof PipelineAbortedError) return true;
  return error instanceof Error && error.name === "JobLostError";
}
