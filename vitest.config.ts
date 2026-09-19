import os from "node:os";
import { configDefaults, defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

/**
 * 실제 프로세스(제출 서비스·제출 테스트의 vitest·워커 프로세스)를 띄우는 DB·러너 통합 테스트 (T-607).
 * 하네스 요청·헬스·제출 테스트의 벽시계 예산에 기대므로, 단위 테스트와 CPU를 다투지 않게
 * 별도 프로젝트로 묶어 단위 테스트가 끝난 뒤(`groupOrder: 1`) 적은 수의 워커로만 돌린다.
 * 키는 패키지 디렉터리, 값은 그 디렉터리 기준 경로다.
 */
const PROCESS_TESTS: Record<"apps/worker" | "packages/runner", string[]> = {
  "apps/worker": [
    "src/delete/delete.test.ts",
    "src/effectiveness/effectiveness.test.ts",
    "src/mutation/mutation.test.ts",
    "src/pipeline/context-link.test.ts",
    "src/pipeline/pipeline.test.ts",
    "src/pipeline/resume-context.test.ts",
    "src/rerun/rerun.test.ts",
    "src/results/results.test.ts",
    "src/review-write/review-write.test.ts",
    "src/validate-rubric/validate-rubric.test.ts",
    "src/worker.test.ts",
  ],
  "packages/runner": ["src/local/local-runner.test.ts", "src/submitted-tests/run.test.ts"],
};

/** 통합 테스트 파일의 동시 실행 수. 코어 절반, 1~3. `VITEST_PROCESS_WORKERS`로 덮어쓴다 */
const processWorkers =
  Number(process.env.VITEST_PROCESS_WORKERS) ||
  Math.max(1, Math.min(3, Math.floor(os.availableParallelism() / 2)));

/** 패키지 하나를 단위 테스트 프로젝트와 통합 테스트 프로젝트로 나눈다 */
function splitProject(
  dir: keyof typeof PROCESS_TESTS,
  name: string,
): TestProjectInlineConfiguration[] {
  const files = PROCESS_TESTS[dir];
  return [
    { test: { name, root: dir, exclude: [...configDefaults.exclude, ...files] } },
    {
      test: {
        name: `${name}:process`,
        root: dir,
        include: files,
        sequence: { groupOrder: 1 },
        maxWorkers: processWorkers,
      },
    },
  ];
}

export default defineConfig({
  test: {
    // 각 프로젝트는 루트 test 옵션을 상속하지 않으므로, 환경변수 로드는 globalSetup으로 한 번 한다.
    // globalSetup에서 설정한 process.env는 테스트 워커에 전달된다.
    projects: [
      "apps/*",
      "packages/*",
      // 아래에서 단위·통합 프로젝트로 나누어 정의한다
      "!apps/worker",
      "!packages/runner",
      ...splitProject("apps/worker", "@ohmyti/worker"),
      ...splitProject("packages/runner", "@ohmyti/runner"),
      // 루트 스크립트(scripts/*.ts)의 테스트
      { test: { name: "root-scripts", include: ["scripts/**/*.test.ts"], environment: "node" } },
    ],
    globalSetup: ["./scripts/vitest-global-setup.ts"],
    passWithNoTests: false,
  },
});
