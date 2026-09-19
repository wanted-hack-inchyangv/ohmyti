import { TEST_TIME_BUDGETS } from "@ohmyti/core/testing";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ExecutionContractSchema, type ExecutionContract } from "@ohmyti/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_RUNNER_DEFAULTS } from "../config";
import { LocalProcessRunner } from "../local/local-runner";
import type { PreparedEnv } from "../runner";
import {
  createTestWorkspace,
  packToStore,
  repoRoot,
  sampleDir,
  templateRoot,
  writeFiles,
  type TestWorkspace,
} from "../test-support/snapshots";
import { runSubmittedTests } from "./run";
import type { SubmittedTestResult } from "./schema";

const contract: ExecutionContract = ExecutionContractSchema.parse(
  JSON.parse(
    await readFile(path.join(repoRoot, "samples", "order-api", "execution-contract.json"), "utf8"),
  ),
);

/** 샘플별 실제 테스트 수·파일 수 (`vitest run --reporter=json`으로 확인한 값. T-106: D는 C 11 + 항상 통과 5) */
const SAMPLE_EXPECTATIONS = {
  a: { total: 49, files: 7 },
  b: { total: 61, files: 7 },
  c: { total: 11, files: 3 },
  d: { total: 16, files: 4 },
} as const;

const VITEST_PKG = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    name: "fixture",
    private: true,
    type: "module",
    scripts: { test: "vitest run" },
    devDependencies: { vitest: "4.1.11", typescript: "5.9.3", "@types/node": "22.20.3" },
    ...extra,
  });

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: "esnext",
    moduleResolution: "bundler",
    target: "es2022",
    noEmit: true,
    types: ["node"],
    skipLibCheck: true,
  },
  include: ["test", "src"],
});

let ws: TestWorkspace;
let runner: LocalProcessRunner;
const envs: PreparedEnv[] = [];

beforeAll(async () => {
  ws = await createTestWorkspace();
  runner = new LocalProcessRunner({
    config: {
      ...LOCAL_RUNNER_DEFAULTS,
      templateRoot,
      workRoot: path.join(ws.root, "work"),
      runTimeoutMs: TEST_TIME_BUDGETS.runMs,
      killGraceMs: 500,
    },
    artifactStore: ws.store,
    secrets: ["fixture-secret-value"],
  });
});

afterAll(async () => {
  await Promise.all(envs.map((env) => runner.destroy(env)));
  await ws.cleanup();
});

async function prepareSample(impl: "a" | "b" | "c" | "d"): Promise<PreparedEnv> {
  const key = `snapshots/impl-${impl}.tar.gz`;
  await packToStore(ws.store, key, sampleDir(impl));
  const env = await runner.prepare(key, contract);
  envs.push(env);
  return env;
}

async function prepareFixture(name: string, files: Record<string, string>): Promise<PreparedEnv> {
  const dir = path.join(ws.root, "fixtures", name);
  await writeFiles(dir, files);
  const key = `snapshots/${name}.tar.gz`;
  await packToStore(ws.store, key, dir);
  const env = await runner.prepare(key, contract);
  envs.push(env);
  return env;
}

/** 결정성 비교용: 시간·무작위 파일명·로그 키를 뺀 판정 부분 */
function verdictShape(result: SubmittedTestResult): unknown {
  return {
    status: result.status,
    failureKind: result.failureKind,
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    files: result.testFiles.map((f) => ({
      path: f.path,
      status: f.status,
      total: f.total,
      tests: f.tests.map((t) => ({ fullName: t.fullName, status: t.status })),
    })),
  };
}

describe("runSubmittedTests: 샘플 A/B/C/D", () => {
  for (const impl of ["a", "b", "c", "d"] as const) {
    it(`샘플 ${impl.toUpperCase()}는 PASSED이고 개수가 실제 테스트 수와 같다`, async () => {
      const env = await prepareSample(impl);
      const result = await runSubmittedTests(runner, env, { secrets: ["fixture-secret-value"] });
      const expected = SAMPLE_EXPECTATIONS[impl];
      expect(result.status, result.reason ?? "").toBe("PASSED");
      expect(result.failureKind).toBe("NONE");
      expect(result.framework.framework).toBe("vitest");
      expect(result.total).toBe(expected.total);
      expect(result.passed).toBe(expected.total);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.testFiles).toHaveLength(expected.files);
      expect(result.testFiles.reduce((n, f) => n + f.total, 0)).toBe(expected.total);
      expect(result.resultFileCollected).toBe(true);
      expect(result.typecheck?.exitCode).toBe(0);
      expect(result.run?.exitCode).toBe(0);
      // 경로는 작업 디렉터리 기준 상대 경로다
      for (const file of result.testFiles) {
        expect(file.path.startsWith("/")).toBe(false);
        expect(file.path).not.toContain(env.workDir);
      }
    }, 60_000);
  }

  it("D의 항상 통과 테스트 5건은 개수에 포함되지만 score.json·stdout 문구는 어디에도 쓰이지 않는다 (G-07)", async () => {
    const env = await prepareSample("d");
    expect(JSON.parse(await readFile(path.join(env.workDir, "score.json"), "utf8"))).toMatchObject({
      score: 100,
    });
    const result = await runSubmittedTests(runner, env);
    expect(result.status).toBe("PASSED");
    expect(result.total).toBe(16);
    const alwaysPass = result.testFiles.find((f) => f.path === "test/zz-always-pass.test.ts");
    expect(alwaysPass?.total).toBe(5);
    expect(JSON.stringify(result)).not.toContain("SCORE 100");
    expect(JSON.stringify(result)).not.toContain("score.json");
  }, 60_000);

  it("같은 스냅샷을 두 번 실행하면 판정 부분이 같다 (결정성)", async () => {
    const first = await runSubmittedTests(runner, await prepareSample("c"));
    const second = await runSubmittedTests(runner, await prepareSample("c"));
    expect(verdictShape(second)).toEqual(verdictShape(first));
  }, 60_000);
});

describe("runSubmittedTests: 상태 구분", () => {
  it("테스트 파일이 없는 픽스처는 NO_TESTS이며 아무 명령도 실행하지 않는다", async () => {
    const env = await prepareFixture("no-tests", {
      "package.json": JSON.stringify({
        name: "x",
        private: true,
        scripts: { start: "node index.js" },
      }),
      "index.js": "console.log('hi')",
    });
    const result = await runSubmittedTests(runner, env);
    expect(result.status).toBe("NO_TESTS");
    expect(result.failureKind).toBe("NONE");
    expect(result.framework.framework).toBe("none");
    expect(result.run).toBeNull();
    expect(result.typecheck).toBeNull();
    expect(result.total).toBe(0);
  });

  it("vitest는 선언했지만 테스트 파일이 없으면 vitest 결과로 NO_TESTS다", async () => {
    const env = await prepareFixture("vitest-no-files", {
      "package.json": VITEST_PKG(),
      "src/a.ts": "export const a = 1;",
    });
    const result = await runSubmittedTests(runner, env);
    expect(result.status, result.reason ?? "").toBe("NO_TESTS");
    expect(result.run).not.toBeNull();
    expect(result.resultFileCollected).toBe(true);
    expect(result.total).toBe(0);
  }, 30_000);

  it("jest 설정만 있는 픽스처는 UNSUPPORTED_FRAMEWORK이며 실행하지 않는다", async () => {
    const env = await prepareFixture("jest-only", {
      "package.json": JSON.stringify({
        name: "x",
        private: true,
        scripts: { test: "jest" },
        devDependencies: { jest: "30.0.0" },
      }),
      "jest.config.js": "module.exports = { testEnvironment: 'node' };",
      "__tests__/a.test.js": "test('x', () => { expect(1).toBe(1); });",
    });
    const result = await runSubmittedTests(runner, env);
    expect(result.status).toBe("UNSUPPORTED_FRAMEWORK");
    expect(result.failureKind).toBe("SUBMISSION");
    expect(result.framework.framework).toBe("jest");
    expect(result.reason).toContain("jest");
    expect(result.run).toBeNull();
  });

  it("stdout에 PASS·passed 문구만 있고 결과 파일이 없으면 INCONCLUSIVE다 (G-07)", async () => {
    const env = await prepareFixture("stdout-only", {
      "package.json": VITEST_PKG(),
      "vitest.config.ts": `import { defineConfig } from "vitest/config";
export default defineConfig({ test: { globalSetup: ["./fake-setup.ts"] } });`,
      "fake-setup.ts": `export default function setup() {
  console.log("✓ test/a.test.ts (49 tests) 12ms");
  console.log(" Test Files  7 passed (7)");
  console.log("      Tests  49 passed (49)");
  console.log("PASS");
  process.exit(0);
}`,
      "test/a.test.ts": `import { it, expect } from "vitest"; it("x", () => { expect(1).toBe(1); });`,
    });
    const result = await runSubmittedTests(runner, env, { typecheck: false });
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.failureKind).toBe("ENVIRONMENT");
    expect(result.run?.exitCode).toBe(0);
    expect(result.resultFileCollected).toBe(false);
    expect(result.total).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.reason).toContain("결과 파일");
    // stdout에는 문구가 실제로 있었다
    const stdout = await ws.store.get(result.run!.logsRef.stdout);
    expect(new TextDecoder().decode(stdout!.body)).toContain("49 passed");
  }, 30_000);

  it("타입 오류로 컴파일에 실패하는 픽스처는 BUILD_FAIL이다 (tsc --noEmit)", async () => {
    const env = await prepareFixture("type-error", {
      "package.json": VITEST_PKG(),
      "tsconfig.json": TSCONFIG,
      "src/math.ts": `export function add(a: number, b: number): number { return a + b; }`,
      "test/math.test.ts": `import { it, expect } from "vitest";
import { add } from "../src/math";
const n: number = "not a number";
it("adds", () => { expect(add(1, 2)).toBe(3); expect(n).toBe("not a number"); });`,
    });
    const result = await runSubmittedTests(runner, env);
    expect(result.status).toBe("BUILD_FAIL");
    expect(result.failureKind).toBe("SUBMISSION");
    expect(result.typecheck?.exitCode).not.toBe(0);
    expect(result.reason).toContain("TS2322");
    // vitest는 실행하지 않았다
    expect(result.run).toBeNull();
  }, 30_000);

  it("같은 타입 오류 픽스처도 typecheck를 끄면 vitest가 실행되어 PASSED다 (타입은 지워진다)", async () => {
    const env = await prepareFixture("type-error-no-tsc", {
      "package.json": VITEST_PKG(),
      "tsconfig.json": TSCONFIG,
      "test/t.test.ts": `import { it, expect } from "vitest";
const n: number = "not a number";
it("runs", () => { expect(n).toBe("not a number"); });`,
    });
    const result = await runSubmittedTests(runner, env, { typecheck: false });
    expect(result.status).toBe("PASSED");
    expect(result.typecheck).toBeNull();
    expect(result.total).toBe(1);
  }, 30_000);

  it("문법 오류로 테스트 파일을 불러오지 못하면 BUILD_FAIL이다 (tsconfig 없음)", async () => {
    const env = await prepareFixture("syntax-error", {
      "package.json": VITEST_PKG(),
      "test/bad.test.ts": `import { it } from "vitest";\nit("x", () => { const = ; });\n`,
      "test/good.test.ts": `import { it, expect } from "vitest"; it("ok", () => { expect(1).toBe(1); });`,
    });
    const result = await runSubmittedTests(runner, env);
    expect(result.status).toBe("BUILD_FAIL");
    expect(result.typecheck).toBeNull();
    expect(result.resultFileCollected).toBe(true);
    const bad = result.testFiles.find((f) => f.path === "test/bad.test.ts");
    expect(bad?.status).toBe("failed");
    expect(bad?.error).toContain("Transform failed");
    expect(bad?.error).not.toContain("[");
    expect(result.reason).toContain("test/bad.test.ts");
  }, 30_000);

  it("실패한 테스트가 있으면 FAILED이고 저장소의 results.json·score.json은 무시한다", async () => {
    const env = await prepareFixture("failing", {
      "package.json": VITEST_PKG(),
      "results.json": JSON.stringify({ numTotalTests: 100, numPassedTests: 100, success: true }),
      "score.json": JSON.stringify({ score: 100, verdict: "PASS" }),
      "test/a.test.ts": `import { describe, it, expect } from "vitest";
describe("orders", () => {
  it("passes", () => { expect(1).toBe(1); });
  it("fails with secret", () => { expect("fixture-secret-value").toBe("other"); });
  it.skip("skipped", () => {});
});`,
    });
    const result = await runSubmittedTests(runner, env, { secrets: ["fixture-secret-value"] });
    expect(result.status).toBe("FAILED");
    expect(result.failureKind).toBe("ASSERTION");
    expect(result).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(result.run?.exitCode).toBe(1);
    const file = result.testFiles[0]!;
    expect(file.path).toBe("test/a.test.ts");
    const failed = file.tests.find((t) => t.status === "failed")!;
    expect(failed.fullName).toBe("orders fails with secret");
    expect(failed.failureMessages[0]).toContain("AssertionError");
    expect(failed.failureMessages[0]).not.toContain("fixture-secret-value");
    expect(failed.failureMessages[0]).not.toContain(env.workDir);
    expect(file.tests.find((t) => t.title === "skipped")?.status).toBe("skipped");
  }, 30_000);

  it("무한 루프 테스트는 제한 시간 뒤 TIMEOUT이다", async () => {
    const env = await prepareFixture("infinite", {
      "package.json": VITEST_PKG(),
      "test/loop.test.ts": `import { it } from "vitest"; it("loops", () => { for (;;) {} });`,
    });
    const result = await runSubmittedTests(runner, env, { timeoutMs: 4_000 });
    expect(result.status).toBe("TIMEOUT");
    expect(result.failureKind).toBe("TIMEOUT");
    expect(result.run?.timedOut).toBe(true);
    expect(result.resultFileCollected).toBe(false);
  }, 30_000);

  it("결과 파일이 상한보다 크면 INCONCLUSIVE다", async () => {
    const env = await prepareFixture("big-result", {
      "package.json": VITEST_PKG(),
      "test/a.test.ts": `import { it, expect } from "vitest"; it("ok", () => { expect(1).toBe(1); });`,
    });
    const result = await runSubmittedTests(runner, env, { maxResultBytes: 10 });
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.reason).toContain("상한");
  }, 30_000);
});
