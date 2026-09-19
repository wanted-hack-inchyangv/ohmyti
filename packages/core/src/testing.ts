/**
 * 통합 테스트가 파이프라인·러너·워커에 주입하는 벽시계 예산 (T-607). 테스트 전용이다.
 * 제품 기본값(`RUN_TIMEOUT_MS`·`HEALTH_TIMEOUT_MS`·`HARNESS_REQUEST_TIMEOUT_MS`·`PIPELINE_STAGE_TIMEOUT_MS` 등)과
 * 별개이며 그 값을 바꾸지 않는다. CI 러너(4 vCPU)나 다른 작업과 병행하는 로컬에서 CPU가 모자라도
 * 넘지 않도록 제품 기본값보다 여유를 둔다. 제한 시간 자체를 검증하는 테스트(TIMEOUT 분류, 수명 제한,
 * 벽시계 상한 등)는 이 값을 쓰지 않고 짧은 값을 직접 둔다.
 */
export const TEST_TIME_BUDGETS = {
  /** 하네스 요청 하나의 제한 (`PipelineConfig.requestTimeoutMs`, 제품 기본 5초) */
  harnessRequestMs: 20_000,
  /** 파이프라인 단계 하나의 제한 (`PipelineConfig.stageTimeoutMs`) */
  stageMs: 300_000,
  /** 워커 `drain()` 대기 */
  drainMs: 120_000,
  /** 러너 명령·제출 테스트(vitest) 실행의 제한 (`LocalRunnerConfig.runTimeoutMs`) */
  runMs: 120_000,
  /** 조건이 참이 되기를 폴링으로 기다리는 테스트 보조 함수의 기본 제한 */
  waitForMs: 30_000,
  /**
   * 제한을 명시하지 않은 테스트의 제한 (vitest 기본 5초). vitest 4는 루트 설정의 `testTimeout`을 프로젝트에
   * 물려주지 않으므로 루트 `package.json`의 `test` 스크립트가 `--testTimeout`으로 같은 값을 넘긴다
   */
  defaultTestMs: 30_000,
} as const;
