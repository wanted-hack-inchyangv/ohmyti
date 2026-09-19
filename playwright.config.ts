import { defineConfig, devices } from "@playwright/test";
import "./scripts/load-env";
import { stackArtifactRoot, stackPorts } from "./scripts/stack-local";

// 다른 프로젝트의 dev 서버(3000·3100 등)와 겹치지 않도록 E2E 전용 포트를 쓴다.
const { webPort: port } = stackPorts();

/**
 * 워커까지 띄우는 전체 스택 시나리오(T-308 워크벤치, T-406 과제 설정). 워커가 없어야 하는 다른 스펙이 모두 끝난 뒤에 돈다.
 * 스펙마다 같은 포트(`E2E_WORKER_PORT`)에 워커를 띄우므로 한 번에 하나씩 돈다 (`workers: 1`).
 */
const STACK_SPEC = /(workbench-stack|assignment-setup)\.spec\.ts$/;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: STACK_SPEC,
    },
    {
      // 워커를 직접 띄우거나(`pnpm stack:local`의 워커가 있으면) 재사용한다. 워커가 살아 있으면 `submissions.spec`의
      // "대기열에 머문다" 검사가 깨지므로 chromium 프로젝트가 끝난 뒤에만 실행한다.
      name: "stack",
      use: { ...devices["Desktop Chrome"] },
      testMatch: STACK_SPEC,
      dependencies: ["chromium"],
      workers: 1,
    },
  ],
  webServer: {
    command: `pnpm --filter @ohmyti/web dev --port ${port}`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Next는 apps/web의 .env만 읽으므로 저장소 루트 .env.local(DATABASE_URL 등)을 여기서 넘긴다.
    // E2E는 fs 스토어를 쓴다 (제출 폼의 이력서 저장이 Blob에 닿지 않게). 경로는 워커(`stack-local`)와 같은 절대 경로다.
    env: {
      ...(process.env as Record<string, string>),
      ARTIFACT_STORE: "fs",
      ARTIFACT_FS_ROOT: stackArtifactRoot(),
      // 샘플 새 실행(T-505)의 워커 응답 없음 판단. 워커 없이 도는 `e2e/demo.spec.ts`가 기다리는 시간이다
      DEMO_RUN_START_TIMEOUT_MS: process.env.DEMO_RUN_START_TIMEOUT_MS ?? "5000",
      DEMO_MODE: "true",
    },
  },
});
