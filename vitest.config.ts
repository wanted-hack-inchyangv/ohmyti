import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 각 프로젝트는 루트 test 옵션을 상속하지 않으므로, 환경변수 로드는 globalSetup으로 한 번 한다.
    // globalSetup에서 설정한 process.env는 테스트 워커에 전달된다.
    projects: [
      "apps/*",
      "packages/*",
      // 루트 스크립트(scripts/*.ts)의 테스트
      { test: { name: "root-scripts", include: ["scripts/**/*.test.ts"], environment: "node" } },
    ],
    globalSetup: ["./scripts/vitest-global-setup.ts"],
    passWithNoTests: false,
  },
});
