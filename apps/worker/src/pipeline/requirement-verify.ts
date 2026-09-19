/**
 * REQUIREMENT_VERIFY 단계 (TICKET.md T-204): 서비스 기동 → 신뢰 하네스 → 서비스 종료 → 제출 테스트.
 *
 * 관측 원문(기동 관측, 하네스 보고서, 서비스 종료 정보, 제출 테스트 결과)은 ArtifactStore의
 * `evaluations/<id>/stages/REQUIREMENT_VERIFY/*.json`에 그대로 두고, `stage_log.detail`에는 요약만 남긴다.
 * T-205가 이 원문을 ExecutionRecord·Evidence·CriterionResult로 옮긴다.
 *
 * 실패 분류 (G-11):
 * - 서비스가 `/health`를 주지 못함, 하네스 도중 스스로 종료함, 시작 명령이 차단됨 → `FAILED`·`SUBMISSION`.
 *   이미 끝난 케이스 결과는 보고서에 그대로 남고, 나머지 기준은 `deriveCriteria`가 INCONCLUSIVE로 접는다.
 * - 러너가 수명 제한으로 서비스를 종료함 → `FAILED`·`TIMEOUT`.
 * - 러너·스토어 예외 → 그대로 던진다 (오케스트레이터가 ENVIRONMENT로 다룬다).
 * 제출 테스트는 서비스 결과와 무관하게 항상 실행한다 (T-403이 같은 결과를 쓴다).
 */
import type { ExecutionContract, FailureKind, Rubric } from "@ohmyti/core";
import {
  deriveCriteria,
  getCaseSet,
  runHarness,
  type DerivedCriterion,
  type HarnessReport,
} from "@ohmyti/harness";
import {
  BlockedCommandError,
  runSubmittedTests,
  ServiceStartError,
  type PreparedEnv,
  type ProcessExit,
  type RunningService,
  type SandboxRunner,
  type ServiceLogsRef,
  type ServiceStartupObservation,
  type SubmittedTestResult,
} from "@ohmyti/runner";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import type { Logger } from "../logger";
import { abortReason } from "./errors";

export const REQUIREMENT_VERIFY_STAGE = "REQUIREMENT_VERIFY" as const;

/**
 * 하네스가 연결 실패를 관측했을 때 서비스 종료를 기다리는 최대 시간. 스스로 죽은 프로세스 그룹은 곧 닫히므로
 * 이 시간 안에 `isRunning()`이 false가 되면 크래시로, 여전히 살아 있으면 정상 종료 대상으로 본다.
 * (연결 실패 뒤 남은 케이스는 수 ms 만에 끝나 `stop()`이 프로세스 종료 통지보다 먼저 올 수 있다)
 */
export const CRASH_SETTLE_MS = 3000;

export interface RequirementVerifyInput {
  evaluationId: string;
  env: PreparedEnv;
  rubric: Rubric;
  contract: ExecutionContract;
  caseSet: string;
}

export interface RequirementVerifyDeps {
  runner: SandboxRunner;
  store: ArtifactStore;
  /** 하네스 요청당 제한 시간 (`HARNESS_REQUEST_TIMEOUT_MS`) */
  requestTimeoutMs: number;
  /** 케이스 하나가 끝날 때마다 호출한다 (heartbeat). 던지면 하네스가 끝난 뒤 그 오류를 다시 던진다 */
  heartbeat?: (() => Promise<void>) | undefined;
  /**
   * job 신호 (T-506). 소유권을 잃으면(취소) 하네스가 끝나기를 기다리지 않고 서비스를 곧바로 멈춘다.
   * 남은 케이스는 연결 실패로 빨리 끝나며, 그 뒤 신호의 사유를 다시 던진다
   */
  signal?: AbortSignal | undefined;
  secrets?: readonly string[] | undefined;
  logger?: Logger | undefined;
}

/** `stage_log.detail`에 남기는 요약. 원문은 `artifacts`가 가리키는 스토어 객체에 있다 */
export interface RequirementVerifyDetail {
  failureKind: FailureKind;
  startup: {
    outcome: ServiceStartupObservation["outcome"];
    elapsedMs: number;
    lastHealthStatus: number | null;
    healthAttempts: number;
    reason?: string;
  } | null;
  service: {
    exitCode: number | null;
    signal: string | null;
    stoppedByCaller: boolean;
    timedOut: boolean;
    durationMs: number;
    logs: ServiceLogsRef;
  } | null;
  harness: {
    harnessVersion: string;
    caseSet: string;
    summary: HarnessReport["summary"];
    cases: Array<{ caseId: string; verdict: string; failureKind: FailureKind }>;
  } | null;
  tests: {
    status: SubmittedTestResult["status"];
    failureKind: FailureKind;
    framework: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    files: number;
  } | null;
  criteria: DerivedCriterion[];
  artifacts: {
    startup?: string;
    harness?: string;
    tests?: string;
    serviceExit?: string;
  };
  [key: string]: unknown;
}

export interface RequirementVerifyOutcome {
  state: "DONE" | "FAILED";
  failureKind: FailureKind;
  reason?: string;
  startup: ServiceStartupObservation | null;
  serviceExit: ProcessExit | null;
  harness: HarnessReport | null;
  tests: SubmittedTestResult;
  criteria: DerivedCriterion[];
  detail: RequirementVerifyDetail;
}

export async function runRequirementVerifyStage(
  input: RequirementVerifyInput,
  deps: RequirementVerifyDeps,
): Promise<RequirementVerifyOutcome> {
  const { runner, store } = deps;
  const cases = getCaseSet(input.caseSet);

  let startup: ServiceStartupObservation | null = null;
  let serviceExit: ProcessExit | null = null;
  let harness: HarnessReport | null = null;
  let serviceLogs: ServiceLogsRef | null = null;
  let failure: { kind: FailureKind; reason: string } | null = null;
  // 콜백에서 갱신하므로 객체에 둔다 (let이면 뒤에서 null로 좁혀진다)
  const lost: { error: Error | null } = { error: null };

  try {
    const service = await runner.startService(input.env, { label: "service" });
    startup = service.startup;
    serviceLogs = service.logsRef;
    deps.logger?.info(
      { port: service.port, elapsedMs: startup.elapsedMs, healthAttempts: startup.healthAttempts },
      "서비스가 기동됐습니다",
    );
    const onAbort = () => {
      lost.error ??= abortReason(deps.signal);
      deps.logger?.warn("job 신호가 abort돼 서비스를 멈춥니다");
      void service.stop();
    };
    if (deps.signal?.aborted) onAbort();
    else deps.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      harness = await runHarness(cases, {
        baseUrl: service.baseUrl,
        timeoutMs: deps.requestTimeoutMs,
        ...(input.contract.resetPath ? { resetPath: input.contract.resetPath } : {}),
        caseSet: input.caseSet,
        rubric: input.rubric,
        onCaseFinished: (result) => {
          deps.logger?.debug(
            { caseId: result.caseId, verdict: result.verdict, failureKind: result.failureKind },
            "하네스 케이스 완료",
          );
          // 케이스마다 heartbeat. 소유권을 잃었으면 하네스는 끝까지 관측한 뒤 오류를 되던진다
          if (deps.heartbeat && lost.error === null) {
            deps.heartbeat().catch((error: unknown) => {
              lost.error = error instanceof Error ? error : new Error(String(error));
            });
          }
        },
      });
      if (harness && hasConnectionFailure(harness)) {
        await waitForExit(service, CRASH_SETTLE_MS);
      }
    } finally {
      deps.signal?.removeEventListener("abort", onAbort);
      serviceExit = await service.stop();
    }
    if (lost.error !== null) throw lost.error;

    if (serviceExit.timedOut) {
      failure = {
        kind: "TIMEOUT",
        reason: `서비스가 수명 제한(${serviceExit.durationMs}ms)을 넘겨 러너가 종료했습니다`,
      };
    } else if (!serviceExit.stoppedByCaller) {
      failure = {
        kind: "SUBMISSION",
        reason: `서비스가 하네스 실행 중 스스로 종료했습니다 (exit ${serviceExit.exitCode ?? "null"}, signal ${serviceExit.signal ?? "null"})`,
      };
    }
  } catch (error) {
    if (error instanceof ServiceStartError) {
      startup = error.startup;
      serviceExit = error.stopped;
      serviceLogs = error.logsRef;
      failure = {
        kind: "SUBMISSION",
        reason: `서비스 기동 실패: ${startup.reason ?? startup.outcome}`,
      };
    } else if (error instanceof BlockedCommandError) {
      failure = { kind: "SUBMISSION", reason: `시작 명령이 차단됐습니다: ${error.message}` };
    } else {
      throw error;
    }
  }
  if (failure) deps.logger?.warn({ failure }, "요구사항 검증 중 제출 서비스 문제가 관측됐습니다");

  const tests = await runSubmittedTests(runner, input.env, {
    label: "tests",
    ...(deps.secrets ? { secrets: deps.secrets } : {}),
  });
  deps.logger?.info(
    { status: tests.status, total: tests.total, passed: tests.passed, failed: tests.failed },
    "제출 테스트를 실행했습니다",
  );

  const criteria = deriveCriteria(input.rubric, harness, startup);

  const artifacts: RequirementVerifyDetail["artifacts"] = {};
  const putJson = async (name: keyof RequirementVerifyDetail["artifacts"], value: unknown) => {
    const key = artifactKeys.stageResult(input.evaluationId, REQUIREMENT_VERIFY_STAGE, name);
    await store.put(key, JSON.stringify(value, null, 2), {
      contentType: ARTIFACT_CONTENT_TYPES.stageResult,
    });
    artifacts[name] = key;
  };
  if (startup) await putJson("startup", startup);
  if (harness) await putJson("harness", harness);
  if (serviceExit) await putJson("serviceExit", serviceExit);
  await putJson("tests", tests);

  const detail: RequirementVerifyDetail = {
    failureKind: failure?.kind ?? "NONE",
    startup: startup
      ? {
          outcome: startup.outcome,
          elapsedMs: startup.elapsedMs,
          lastHealthStatus: startup.lastHealthStatus,
          healthAttempts: startup.healthAttempts,
          ...(startup.reason !== undefined ? { reason: startup.reason } : {}),
        }
      : null,
    service:
      serviceExit && serviceLogs
        ? {
            exitCode: serviceExit.exitCode,
            signal: serviceExit.signal,
            stoppedByCaller: serviceExit.stoppedByCaller,
            timedOut: serviceExit.timedOut,
            durationMs: serviceExit.durationMs,
            logs: serviceLogs,
          }
        : null,
    harness: harness
      ? {
          harnessVersion: harness.harnessVersion,
          caseSet: harness.caseSet,
          summary: harness.summary,
          cases: harness.results.map((r) => ({
            caseId: r.caseId,
            verdict: r.verdict,
            failureKind: r.failureKind,
          })),
        }
      : null,
    tests: {
      status: tests.status,
      failureKind: tests.failureKind,
      framework: tests.framework.framework,
      total: tests.total,
      passed: tests.passed,
      failed: tests.failed,
      skipped: tests.skipped,
      files: tests.testFiles.length,
    },
    criteria,
    artifacts,
  };

  return {
    state: failure ? "FAILED" : "DONE",
    failureKind: failure?.kind ?? "NONE",
    ...(failure ? { reason: failure.reason } : {}),
    startup,
    serviceExit,
    harness,
    tests,
    criteria,
    detail,
  };
}

function hasConnectionFailure(report: HarnessReport): boolean {
  return report.results.some((r) => r.timeline.some((t) => t.error?.kind === "CONNECTION"));
}

async function waitForExit(service: RunningService, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (service.isRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
