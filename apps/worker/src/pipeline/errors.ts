/**
 * 파이프라인 오류 분류 (TICKET.md T-204, G-11).
 *
 * - 단계 함수 밖으로 던져진 오류는 모두 환경 장애(ENVIRONMENT 또는 TIMEOUT)다. 러너·네트워크·GitHub·DB 오류가 여기 속하며
 *   job 재시도 대상이다. 남은 시도가 없으면 단계를 FAILED로 닫고 제출을 FAILED로 바꾼다.
 * - 제출물 탓(서비스 크래시·헬스 실패·차단된 시작 명령)은 REQUIREMENT_VERIFY 단계 안에서 `FAILED(SUBMISSION)`로
 *   기록하고 예외로 나오지 않는다.
 * - `NonRetryableJobError`(등록 오류: 삭제된 제출, 승인되지 않은 버전, 하네스 버전 불일치)는 즉시 FAILED다.
 */
import type { EvaluationStage, FailureKind } from "@ohmyti/core";

/** 워커 밖의 환경이 원인인 오류. 원인을 `cause`에 보존한다 */
export class PipelineEnvironmentError extends Error {
  override readonly name: string = "PipelineEnvironmentError";
  readonly failureKind: FailureKind = "ENVIRONMENT";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** 단계 제한 시간(`PIPELINE_STAGE_TIMEOUT_MS`)을 넘겼다 */
export class StageTimeoutError extends PipelineEnvironmentError {
  override readonly name = "StageTimeoutError";
  override readonly failureKind: FailureKind = "TIMEOUT";
  constructor(
    readonly stage: EvaluationStage,
    readonly timeoutMs: number,
  ) {
    super(`${stage} 단계가 ${timeoutMs}ms 안에 끝나지 않았습니다`);
  }
}

/**
 * 워커 종료 신호 또는 job 소유권 상실(회수·취소, T-506)로 중단했다. job은 이미 QUEUED로 반납됐거나 다른 워커·취소 쪽으로
 * 넘어갔으므로 아무것도 기록하지 않는다
 */
export class PipelineAbortedError extends Error {
  override readonly name = "PipelineAbortedError";
  constructor(readonly stage: EvaluationStage | null) {
    super(
      stage
        ? `워커 종료 또는 job 취소 신호로 ${stage} 단계 전에 중단했습니다`
        : "워커 종료 또는 job 취소 신호로 파이프라인을 중단했습니다",
    );
  }
}

/** 오류에서 실패 종류를 읽는다. 환경 오류의 기본은 ENVIRONMENT, 단계 시간 초과는 TIMEOUT */
export function failureKindOfError(error: unknown): FailureKind {
  if (error instanceof PipelineEnvironmentError) return error.failureKind;
  return "ENVIRONMENT";
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** `promise`가 `timeoutMs` 안에 끝나지 않으면 `StageTimeoutError`. 타이머는 어느 쪽이든 끝나면 지운다 */
export function withStageTimeout<T>(
  stage: EvaluationStage,
  timeoutMs: number,
  promise: Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StageTimeoutError(stage, timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** abort 사유를 오류로 바꾼다. 워커는 소유권을 잃으면 `JobLostError`를 사유로 넣는다 */
export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("job 신호가 abort됐습니다");
}
