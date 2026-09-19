import { resolveAccessConfig } from "./config";

/**
 * Node 런타임 전용. 접근 보호 설정이 잘못되면 오류를 남기고 프로세스를 종료한다.
 * instrumentation.ts가 동적 import로만 불러 Edge 번들에 process.exit이 들어가지 않게 한다.
 */
export function assertAccessConfigOrExit(env: NodeJS.ProcessEnv): void {
  try {
    resolveAccessConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ohmyti] 접근 보호 설정 오류로 기동을 중단합니다: ${message}`);
    process.exit(1);
  }
}
