/**
 * SandboxRunner 인터페이스 (TICKET.md 1.4, T-108).
 * 제출 서비스와 제출 테스트는 이 인터페이스 뒤의 일회성 격리 환경에서만 실행한다 (G-05).
 * 구현: `LocalProcessRunner`(MVP, 워커 컨테이너 안 자식 프로세스), `VercelSandboxRunner`(T-209).
 */
import type { ExecutionContract } from "@ohmyti/core";
import type { SubmissionFiles } from "./submitted-tests/detect";
import type { RunnerKind } from "./template";

/** 러너 오류의 공통 조상. 호출자는 `instanceof`로 원인을 구분한다. */
export class RunnerError extends Error {
  override readonly name: string = "RunnerError";
}

/** 스냅샷 tar.gz가 규칙을 어겼다: 경로 이탈, 심볼릭 링크, 파일 수·크기 초과, 손상된 아카이브 */
export class SnapshotRejectedError extends RunnerError {
  override readonly name = "SnapshotRejectedError";
  constructor(
    readonly code: SnapshotRejectionCode,
    readonly entryPath: string | null,
    reason: string,
  ) {
    super(
      entryPath === null
        ? `스냅샷을 거부했습니다 (${code}): ${reason}`
        : `스냅샷을 거부했습니다 (${code}): ${JSON.stringify(entryPath)} ${reason}`,
    );
  }
}

export type SnapshotRejectionCode =
  | "PATH_TRAVERSAL"
  | "ABSOLUTE_PATH"
  | "SYMLINK"
  | "UNSUPPORTED_ENTRY"
  | "TOO_MANY_FILES"
  | "TOO_LARGE"
  | "CORRUPT_ARCHIVE"
  | "NOT_FOUND";

/** `npm install`류처럼 차단 목록에 걸린 명령. 어떤 러너도 제출물의 설치를 실행하지 않는다 (1.4). */
export class BlockedCommandError extends RunnerError {
  override readonly name = "BlockedCommandError";
  constructor(
    readonly argv: readonly string[],
    reason: string,
  ) {
    super(`차단된 명령 ${JSON.stringify(argv.join(" "))}: ${reason}`);
  }
}

/** 템플릿·npm·작업 디렉터리 등 러너 쪽 환경이 준비되지 않았다 (ENVIRONMENT) */
export class RunnerEnvironmentError extends RunnerError {
  override readonly name = "RunnerEnvironmentError";
}

/** 서비스가 제한 시간 안에 `/health` 200을 주지 못했거나 먼저 종료됐다 */
export class ServiceStartError extends RunnerError {
  override readonly name = "ServiceStartError";
  constructor(
    readonly startup: ServiceStartupObservation,
    readonly logsRef: ServiceLogsRef,
    readonly stopped: ProcessExit,
  ) {
    super(`서비스 기동 실패: ${startup.reason ?? startup.outcome}`);
  }
}

/** 이미 파괴된 환경을 다시 쓰려 했다 */
export class EnvironmentDestroyedError extends RunnerError {
  override readonly name = "EnvironmentDestroyedError";
  constructor(readonly envId: string) {
    super(`환경 ${envId}은(는) 이미 파괴됐습니다`);
  }
}

export interface PrepareOptions {
  /**
   * 로그 아티팩트 키 접두사 (`.../`). `parseArtifactPrefix` 규약을 따라야 한다.
   * 기본 `sandbox/<envId>/`.
   */
  logKeyPrefix?: string;
  /** 아카이브 앞부분의 디렉터리 단계를 벗겨낸다 (GitHub tarball의 `owner-repo-sha/`). 기본 0 */
  stripComponents?: number;
}

/** `prepare`가 만든 일회성 환경. 러너 구현이 내부 필드를 더 가질 수 있다. */
export interface PreparedEnv {
  readonly id: string;
  readonly kind: RunnerKind;
  readonly contract: ExecutionContract;
  /** 스냅샷을 푼 디렉터리. 명령의 cwd */
  readonly workDir: string;
  /** 자식 프로세스에 `HOME`으로 주는 디렉터리. npm 캐시·설정이 여기에 생긴다 */
  readonly homeDir: string;
  /** 환경 전체를 담는 루트. `destroy`가 통째로 지운다 */
  readonly rootDir: string;
  readonly templateName: string;
  readonly templateDir: string;
  /** 템플릿 digest + 러너 종류 (T-102 `computeEnvironmentDigest`). ExecutionRecord.environmentDigest */
  readonly environmentDigest: string;
  readonly logKeyPrefix: string;
  /** 스냅샷에서 푼 파일 수와 바이트 수 (node_modules 제외) */
  readonly fileCount: number;
  readonly totalBytes: number;
  /** 제출물에 `node_modules`가 들어 있어 버렸는지 */
  readonly droppedNodeModules: boolean;
  readonly createdAt: string;
  /**
   * 스냅샷 파일 접근자. 환경이 워커 밖(원격 VM)에 있어 `workDir`를 로컬 파일 시스템으로 읽을 수 없는
   * 러너가 제공한다. 없으면 호출자는 `workDir`를 직접 읽는다 (`LocalProcessRunner`)
   */
  readonly files?: SubmissionFiles;
}

export interface CommandOptions {
  /** 벽시계 제한. 지나면 프로세스 그룹을 종료하고 `timedOut: true` */
  timeoutMs?: number;
  /** 명령이 끝난 뒤 읽어 올 파일. `workDir` 기준 상대 경로이며 환경 루트 밖은 거부한다 */
  collectFiles?: readonly string[];
  /** `PORT`로 전달할 값. 생략하면 전달하지 않는다 */
  port?: number;
  /** 로그 아티팩트 이름. 기본 `command-<n>` */
  label?: string;
}

export interface CollectedFile {
  path: string;
  bytes: Uint8Array;
}

export interface CommandLogsRef {
  stdout: string;
  stderr: string;
}

export interface CommandResult {
  /** 실행한 인자 (프로그램 포함) */
  argv: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** 마스킹·크기 상한 적용 후 */
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** `collectFiles`로 요청한 파일 중 존재한 것 */
  files: CollectedFile[];
  logsRef: CommandLogsRef;
  startedAt: string;
  finishedAt: string;
}

export interface StartServiceOptions {
  /** 서비스 전체 수명 제한. 지나면 그룹을 종료한다. 기본 러너의 `runTimeoutMs` */
  maxLifetimeMs?: number;
  /** `/health` 대기 시간. 기본 계약의 `healthTimeoutMs`(러너 `healthTimeoutMs` 상한 적용) */
  healthTimeoutMs?: number;
  /** 로그 아티팩트 이름. 기본 `service-<n>` */
  label?: string;
}

export type ServiceStartupOutcome =
  "HEALTHY" | "HEALTH_TIMEOUT" | "EXITED_BEFORE_HEALTHY" | "START_FAILED";

/** R-10 판정 근거(T-205): 실행 계약대로 기동됐는지 관측한 값 */
export interface ServiceStartupObservation {
  outcome: ServiceStartupOutcome;
  startCommand: string;
  port: number;
  healthPath: string;
  healthTimeoutMs: number;
  /** 기동부터 `/health` 200(또는 포기)까지 */
  elapsedMs: number;
  /** 마지막으로 받은 `/health` 상태 코드. 응답을 받지 못했으면 null */
  lastHealthStatus: number | null;
  healthAttempts: number;
  reason?: string;
}

export interface ServiceLogsRef {
  stdout: string;
  stderr: string;
}

export interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** 수명 제한으로 러너가 종료했는지 */
  timedOut: boolean;
  /** `stop()` 호출로 종료했는지 */
  stoppedByCaller: boolean;
  /** 마스킹·크기 상한 적용 후 */
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

export interface RunningService {
  readonly baseUrl: string;
  readonly port: number;
  readonly pid: number;
  readonly startup: ServiceStartupObservation;
  /** 로그 객체 키. 본문은 `stop()`이 끝난 뒤(또는 수명 제한 종료 뒤) 스토어에 있다 */
  readonly logsRef: ServiceLogsRef;
  /** 프로세스 그룹 전체를 종료하고 로그를 저장한다. 여러 번 호출해도 같은 결과를 돌려준다 */
  stop(): Promise<ProcessExit>;
  /** 프로세스가 아직 살아 있는지 */
  isRunning(): boolean;
}

export interface SandboxRunner {
  readonly kind: RunnerKind;
  /** 스냅샷(tar.gz 아티팩트)을 일회성 환경에 풀고 템플릿 `node_modules`를 연결한다 */
  prepare(
    snapshotRef: string,
    contract: ExecutionContract,
    options?: PrepareOptions,
  ): Promise<PreparedEnv>;
  /** 계약의 `startCommand`로 서비스를 띄우고 `/health` 200을 기다린다. 실패하면 `ServiceStartError` */
  startService(env: PreparedEnv, options?: StartServiceOptions): Promise<RunningService>;
  /** 환경 안에서 명령 하나를 실행한다. 설치 명령은 `BlockedCommandError` */
  runCommand(
    env: PreparedEnv,
    argv: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  /** 남은 프로세스를 모두 종료하고 환경 디렉터리를 지운다. 여러 번 호출해도 안전하다 */
  destroy(env: PreparedEnv): Promise<void>;
}
