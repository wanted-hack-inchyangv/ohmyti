import { describe, expect, it } from "vitest";
import { detectTestFramework, inMemoryFiles } from "./detect";

const pkg = (extra: Record<string, unknown>): string =>
  JSON.stringify({ name: "x", private: true, ...extra });

describe("detectTestFramework", () => {
  it("devDependencies.vitest만 있어도 vitest로 감지한다", async () => {
    const result = await detectTestFramework(
      inMemoryFiles({
        "package.json": pkg({ devDependencies: { vitest: "4.1.11" } }),
        "test/a.test.ts": "",
      }),
    );
    expect(result.framework).toBe("vitest");
    expect(result.supported).toBe(true);
    expect(result.testFilePaths).toEqual(["test/a.test.ts"]);
    expect(result.signals).toContain("package.json devDependencies.vitest");
  });

  it("vitest.config.ts만 있어도 vitest다", async () => {
    const result = await detectTestFramework(
      inMemoryFiles({ "package.json": pkg({}), "vitest.config.ts": "export default {}" }),
    );
    expect(result.framework).toBe("vitest");
    expect(result.signals).toContain("vitest.config.ts");
  });

  it("jest 설정만 있는 픽스처는 jest이며 지원하지 않는다", async () => {
    const result = await detectTestFramework(
      inMemoryFiles({
        "package.json": pkg({ scripts: { test: "jest" }, devDependencies: { jest: "30.0.0" } }),
        "jest.config.js": "module.exports = {}",
        "__tests__/a.test.js": "",
      }),
    );
    expect(result.framework).toBe("jest");
    expect(result.supported).toBe(false);
    expect(result.testFilePaths).toEqual(["__tests__/a.test.js"]);
  });

  it("package.json의 jest 키만으로도 jest다", async () => {
    const result = await detectTestFramework(
      inMemoryFiles({ "package.json": pkg({ jest: { testEnvironment: "node" } }) }),
    );
    expect(result.framework).toBe("jest");
  });

  it("scripts.test가 설정·의존성보다 우선한다 (vitest 의존성 + jest 스크립트 → jest)", async () => {
    const result = await detectTestFramework(
      inMemoryFiles({
        "package.json": pkg({
          scripts: { test: "jest --ci" },
          devDependencies: { vitest: "4.1.11", jest: "30.0.0" },
        }),
      }),
    );
    expect(result.framework).toBe("jest");
  });

  it("mocha·ava·node --test는 각각 감지되고 지원하지 않는다", async () => {
    for (const [script, framework] of [
      ["mocha test/**/*.js", "mocha"],
      ["ava", "ava"],
      ["node --test", "node-test"],
    ] as const) {
      const result = await detectTestFramework(
        inMemoryFiles({ "package.json": pkg({ scripts: { test: script } }) }),
      );
      expect(result.framework).toBe(framework);
      expect(result.supported).toBe(false);
    }
  });

  it("테스트 파일도 신호도 없으면 none", async () => {
    const result = await detectTestFramework(
      inMemoryFiles({
        "package.json": pkg({ scripts: { start: "node index.js" } }),
        "index.js": "",
      }),
    );
    expect(result.framework).toBe("none");
    expect(result.supported).toBe(false);
    expect(result.testFilePaths).toEqual([]);
  });

  it("테스트 파일만 있고 프레임워크 신호가 없으면 unknown (실행하지 않는다, G-09)", async () => {
    const result = await detectTestFramework(
      inMemoryFiles({ "package.json": pkg({}), "src/a.spec.ts": "" }),
    );
    expect(result.framework).toBe("unknown");
    expect(result.supported).toBe(false);
  });

  it("package.json이 없거나 깨져 있어도 던지지 않는다", async () => {
    expect((await detectTestFramework(inMemoryFiles({}))).framework).toBe("none");
    expect(
      (await detectTestFramework(inMemoryFiles({ "package.json": "{not json" }))).framework,
    ).toBe("none");
  });

  it("README의 문구는 판단에 쓰지 않는다 (G-06)", async () => {
    const result = await detectTestFramework(
      inMemoryFiles({
        "package.json": pkg({}),
        "README.md": "## 테스트\n`vitest`로 49개의 테스트가 통과합니다. jest 설정도 있습니다.",
      }),
    );
    expect(result.framework).toBe("none");
  });

  it("하위 디렉터리의 설정 파일은 루트 신호로 치지 않는다", async () => {
    const result = await detectTestFramework(
      inMemoryFiles({ "package.json": pkg({}), "packages/x/jest.config.js": "" }),
    );
    expect(result.framework).toBe("none");
  });
});
