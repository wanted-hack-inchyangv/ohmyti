// Railway 프로젝트 `ohmyti`의 Infrastructure as Code (railway.json은 플랫폼에서 폐기됨).
//   railway config plan   # 변경 미리보기
//   railway config apply  # 적용 (서비스 설정·비밀 아닌 변수)
// 비밀값(DATABASE_URL 참조, Blob 토큰, DeepSeek 키)은 preserve()로 두고 `railway variable set`으로 넣는다 (docs/deploy.md).
// 워커 소스는 `railway up --service worker`로 저장소 루트를 올린다. GitHub 자동 배포는 쓰지 않는다.
import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

const REGION = "us-east4-eqdc4a";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: REGION });
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: REGION,
    sizeMB: 50000,
  });

  const worker = service("worker", {
    replicas: { [REGION]: 1 },
    build: {
      builder: "DOCKERFILE",
      // 빌드 컨텍스트는 저장소 루트(railway up이 올리는 디렉터리)
      // watchPatterns는 두지 않는다. CLI 업로드(railway up)는 변경 파일 비교가 없어 SKIPPED가 된다
      dockerfilePath: "apps/worker/Dockerfile",
    },
    deploy: {
      // 컨테이너 안에서 마이그레이션을 먼저 적용한다 (두 번 실행해도 안전)
      preDeployCommand: ["node dist/migrate.js"],
      startCommand: "node dist/index.js",
      healthcheckPath: "/healthz",
      healthcheckTimeout: 120,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      // SIGTERM 후 SIGKILL까지. 워커의 WORKER_SHUTDOWN_GRACE_MS(25초)보다 길어야 한다
      drainingSeconds: 30,
    },
    env: {
      // 비밀값: railway variable set으로 넣는다
      DATABASE_URL: preserve(), // ${{Postgres.DATABASE_URL}} (내부 네트워크)
      BLOB_READ_WRITE_TOKEN: preserve(),
      DEEP_SEEK_API_KEY: preserve(),
      // 공개 설정값 (TICKET.md 1.6)
      ARTIFACT_STORE: "blob",
      BLOB_ACCESS: "private",
      SANDBOX_RUNNER: "local",
      TEMPLATE_ROOT: "/opt/templates",
      MIGRATIONS_FOLDER: "/app/drizzle",
      RUN_TIMEOUT_MS: "60000",
      RUN_MEMORY_MB: "512",
      HEALTH_TIMEOUT_MS: "10000",
      MAX_SOURCE_FILES: "500",
      MAX_SOURCE_BYTES: "20971520",
      MAX_PROFILE_REPOS: "3",
      LLM_PROVIDER: "deepseek",
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_MODEL: "deepseek-chat",
      LLM_MAX_CALLS_PER_EVALUATION: "20",
      LLM_MAX_COST_USD_PER_EVALUATION: "0.50",
      WORKER_POLL_INTERVAL_MS: "1000",
      WORKER_CONCURRENCY: "1",
      WORKER_STALE_MS: "60000",
      WORKER_SHUTDOWN_GRACE_MS: "25000",
      PORT: "8080",
      LOG_LEVEL: "info",
    },
  });

  return project("ohmyti", {
    resources: [worker, Postgres, postgresVolume],
  });
});
