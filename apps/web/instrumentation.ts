/**
 * 서버 기동 시 접근 보호 설정을 검증한다 (T-008). production에서 `APP_ACCESS_PASSWORD`가 없으면
 * 오류를 남기고 프로세스를 종료한다. Next.js는 register가 던진 오류만으로는 프로세스를 끝내지 않고
 * 모든 요청에 500을 돌려주므로 Node 전용 모듈에서 명시적으로 종료한다.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { assertAccessConfigOrExit } = await import("./lib/auth/startup.node");
  assertAccessConfigOrExit(process.env);
}
