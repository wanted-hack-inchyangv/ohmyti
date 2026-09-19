import { DesignSignalsSchema, weakAssertionPercent, type DesignSignalsOk } from "@ohmyti/core";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { filesFromEntries } from "./child";
import { extractDesignSignals, isTestPath, tsconfigStrictOf } from "./design-signals";
import { analyzeFunctionGraphIsolated } from "./isolated";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const INLINE_FIXTURE = path.join(REPO_ROOT, "packages/analysis/fixtures/inline-order-api");

async function readTree(dir: string, base = dir): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await readTree(full, base)));
    else
      out.push([path.relative(base, full).split(path.sep).join("/"), await readFile(full, "utf8")]);
  }
  return out;
}

async function signalsOf(entries: Array<[string, string]>): Promise<DesignSignalsOk> {
  const result = DesignSignalsSchema.parse(
    await extractDesignSignals({ files: filesFromEntries(entries) }),
  );
  if (result.status !== "ok") throw new Error(result.reason);
  return result;
}

const signalsOfDir = async (dir: string) => signalsOf(await readTree(dir));

describe("extractDesignSignals: 인라인 fixture (T-602)", () => {
  it("any·바쁜 대기 1건·중복 블록이 위치와 함께 검출되고 strict가 꺼져 있다", async () => {
    const s = await signalsOfDir(INLINE_FIXTURE);
    expect(s.sourceFiles).toBe(2); // src/index.ts, vitest.config.ts
    expect(s.testFiles).toBe(1);
    expect(s.maxFileLines).toEqual({
      lines: 150,
      location: { path: "src/index.ts", startLine: 1, endLine: 150 },
    });
    expect(s.maxFunctionLines).toEqual({
      lines: 51,
      name: "app.post 콜백",
      location: { path: "src/index.ts", startLine: 56, endLine: 106 },
    });
    expect(s.explicitAny.count).toBe(12);
    expect(s.explicitAny.asAny).toBe(0);
    expect(s.explicitAny.locations.slice(0, 4)).toEqual(
      [8, 16, 17, 18].map((line) => ({ path: "src/index.ts", startLine: line, endLine: line })),
    );
    expect(s.tsconfig).toEqual({ path: "tsconfig.json", strict: false });
    // `while (busy) await wait(1);`
    expect(s.busyWaits).toEqual({
      count: 1,
      locations: [{ path: "src/index.ts", startLine: 23, endLine: 23 }],
    });
    // 상품 조회와 주문 취소의 "찾을 때까지 반복 → 없으면 404" 세 문장
    expect(s.duplicateBlocks.count).toBeGreaterThanOrEqual(1);
    expect(s.duplicateBlocks.groups[0]).toEqual({
      statements: 3,
      locations: [
        { path: "src/index.ts", startLine: 48, endLine: 52 },
        { path: "src/index.ts", startLine: 117, endLine: 121 },
      ],
    });
    expect(s.consoleLogs.count).toBe(0);
    // 제출 테스트는 `toBeLessThan(500)`·`toBeTruthy()`만 쓴다
    expect(s.weakAssertions.total).toBe(6);
    expect(s.weakAssertions.count).toBe(6);
    expect(weakAssertionPercent(s.weakAssertions)).toBe(100);
    expect(s.weakAssertions.locations[0]).toEqual({
      path: "test/api.test.ts",
      startLine: 16,
      endLine: 16,
    });
  });

  it("같은 입력이면 결과가 바이트 단위로 같다", async () => {
    const entries = await readTree(INLINE_FIXTURE);
    const a = JSON.stringify(await signalsOf(entries));
    const b = JSON.stringify(await signalsOf([...entries].reverse()));
    expect(b).toBe(a);
  });
});

describe("extractDesignSignals: 계층이 나뉜 샘플", () => {
  it("샘플 A는 바쁜 대기 0건, 중복 0건, any 0곳, strict 켜짐이다", async () => {
    const s = await signalsOfDir(path.join(SAMPLES_DIR, "impl-a"));
    expect(s.busyWaits.count).toBe(0);
    expect(s.duplicateBlocks).toEqual({ count: 0, groups: [] });
    expect(s.explicitAny.count).toBe(0);
    expect(s.tsconfig).toEqual({ path: "tsconfig.json", strict: true });
    expect(s.sourceFiles).toBe(14);
    expect(s.testFiles).toBe(8);
    expect(s.weakAssertions.count).toBe(0);
    expect(s.weakAssertions.total).toBeGreaterThan(50);
  });

  it.each(["impl-b", "impl-c", "impl-d"])("%s도 바쁜 대기·중복이 0건이다", async (impl) => {
    const s = await signalsOfDir(path.join(SAMPLES_DIR, impl));
    expect(s.busyWaits.count).toBe(0);
    expect(s.duplicateBlocks.count).toBe(0);
  });
});

describe("extractDesignSignals: 규칙", () => {
  it("바쁜 대기는 플래그 조건(식별자·속성·부정)의 while·do 안에 직접 있는 await만 센다", async () => {
    const s = await signalsOf([
      [
        "src/lock.ts",
        [
          "export class Lock {",
          "  private locked = false;",
          "  async a() { while (this.locked) { await tick(); } }",
          "  async b() { while (!ready) await tick(); }",
          "  async c() { do { await tick(); } while (busy); }",
          "  async d() { for (let i = 0; i < 3; i++) await tick(); }",
          "  async e() { while (i < 3) { await tick(); i++; } }",
          "  async f() { while (busy) { queue.push(async () => { await tick(); }); } }",
          "  g() { while (busy) spin(); }",
          "}",
        ].join("\n"),
      ],
    ]);
    expect(s.busyWaits.locations.map((l) => l.startLine)).toEqual([3, 4, 5]);
  });

  it("as any·<any>는 any 수와 asAny 수에 함께 세고, 테스트 파일의 any는 세지 않는다", async () => {
    const s = await signalsOf([
      ["src/a.ts", "const x = y as any;\nconst z = <any>w;\nlet v: any;\nconsole.log(x);\n"],
      ["test/a.test.ts", "const t: any = 1;\nconsole.log(t);\n"],
    ]);
    expect(s.explicitAny.count).toBe(3);
    expect(s.explicitAny.asAny).toBe(2);
    expect(s.consoleLogs).toEqual({
      count: 1,
      locations: [{ path: "src/a.ts", startLine: 4, endLine: 4 }],
    });
  });

  it("약한 단언: truthy·defined·부정 null, 상태 범위 숫자 비교만 약하다", async () => {
    const s = await signalsOf([
      [
        "test/x.test.ts",
        [
          "expect(a).toBeTruthy();",
          "expect(a).toBeDefined();",
          "expect(a).not.toBeNull();",
          "expect(res.status).toBeLessThan(500);",
          "expect(res.status).toBeGreaterThanOrEqual(200);",
          "expect(res.status).toBe(201);",
          "expect(stock).toBeLessThan(3);",
          "expect(a).toBeNull();",
          "await expect(p).resolves.toBeTruthy();",
          "expect.soft(b).toEqual({ ok: true });",
          "request(app).get('/').expect(200);",
        ].join("\n"),
      ],
    ]);
    expect(s.weakAssertions.total).toBe(10);
    expect(s.weakAssertions.locations.map((l) => l.startLine)).toEqual([1, 2, 3, 4, 5, 9]);
    expect(weakAssertionPercent(s.weakAssertions)).toBe(60);
  });

  it("같은 모양이 이어지는 창은 한 묶음이고, import 문과 짧은 문장은 비교하지 않는다", async () => {
    const block = (name: string) =>
      [
        `  const ${name} = await repo.find(id);`,
        `  if (!${name}) return fail(res, 404, "NOT_FOUND", "${name} missing");`,
        `  ${name}.updatedAt = Date.now();`,
        `  await repo.save(${name});`,
      ].join("\n");
    const s = await signalsOf([
      [
        "src/a.ts",
        [
          'import { a } from "./a";',
          'import { b } from "./b";',
          'import { c } from "./c";',
          `export async function one(id) {\n${block("order")}\n}`,
          `export async function two(id) {\n${block("item")}\n}`,
          "x = []; y = []; z = [];",
          "x = []; y = []; z = [];",
        ].join("\n"),
      ],
      [
        "src/b.ts",
        'import { a } from "./a";\nimport { b } from "./b";\nimport { c } from "./c";\n',
      ],
    ]);
    expect(s.duplicateBlocks).toEqual({
      count: 1,
      groups: [
        {
          statements: 4,
          locations: [
            { path: "src/a.ts", startLine: 5, endLine: 8 },
            { path: "src/a.ts", startLine: 11, endLine: 14 },
          ],
        },
      ],
    });
  });

  it("tsconfig strict: 주석이 있어도 읽고, 없으면 false, extends만 있으면 알 수 없음(null)이다", async () => {
    expect(tsconfigStrictOf('{ // c\n "compilerOptions": { "strict": true, } }')).toBe(true);
    expect(tsconfigStrictOf('{ "compilerOptions": {} }')).toBe(false);
    expect(tsconfigStrictOf('{ "extends": "./base.json" }')).toBeNull();
    expect(tsconfigStrictOf("{ nope")).toBeNull();
    const none = await signalsOf([["src/a.ts", "export const a = 1;\n"]]);
    expect(none.tsconfig).toEqual({ path: null, strict: null });
    expect(none.maxFunctionLines).toBeNull();
    expect(weakAssertionPercent(none.weakAssertions)).toBeNull();
  });

  it("테스트 파일 경로 규칙", () => {
    expect(isTestPath("test/a.ts")).toBe(true);
    expect(isTestPath("src/__tests__/a.ts")).toBe(true);
    expect(isTestPath("spec/stock-guard.spec.ts")).toBe(true);
    expect(isTestPath("src/order.test.ts")).toBe(true);
    expect(isTestPath("src/testing.ts")).toBe(false);
    expect(isTestPath("vitest.config.ts")).toBe(false);
  });

  it("파일 수 상한을 넘으면 분석 불가 결과다", async () => {
    const result = await extractDesignSignals({
      files: filesFromEntries([
        ["src/a.ts", "a"],
        ["src/b.ts", "b"],
      ]),
      limits: { maxFiles: 1 },
    });
    expect(result).toMatchObject({ status: "unavailable" });
  });
});

describe("analyzeFunctionGraphIsolated + designSignals (같은 자식 프로세스)", () => {
  it("같은 프로세스에서 추출한 결과와 같고, 그래프 결과도 함께 온다", async () => {
    const entries = await readTree(INLINE_FIXTURE);
    const isolated = await analyzeFunctionGraphIsolated({
      files: filesFromEntries(entries),
      cases: [],
      designSignals: true,
    });
    expect(isolated.analysis.status).toBe("ok");
    expect(isolated.designSignals).toEqual(await signalsOf(entries));
  }, 60_000);

  it("designSignals를 요청하지 않으면 신호가 없다", async () => {
    const entries = await readTree(INLINE_FIXTURE);
    const isolated = await analyzeFunctionGraphIsolated({
      files: filesFromEntries(entries),
      cases: [],
    });
    expect(isolated.designSignals).toBeUndefined();
  }, 60_000);

  it("제한 시간을 넘기면 그래프와 신호 모두 같은 사유의 분석 불가 결과다 (던지지 않는다)", async () => {
    const entries = await readTree(INLINE_FIXTURE);
    const result = await analyzeFunctionGraphIsolated(
      { files: filesFromEntries(entries), cases: [], designSignals: true },
      { timeoutMs: 1 },
    );
    expect(result.analysis).toMatchObject({ status: "unavailable" });
    expect(result.designSignals).toMatchObject({
      status: "unavailable",
      reason: (result.analysis as { reason: string }).reason,
    });
  });
});
