import { inMemoryFiles } from "@ohmyti/runner";
import { describe, expect, it } from "vitest";
import { evaluateStaticChecks, readPackageManifest } from "./static-checks";

const PACKAGE_JSON = `{
  "name": "order-api",
  "dependencies": {
    "express": "5.2.1",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "vitest": "4.1.11"
  }
}
`;

describe("DEPENDENCY_DECLARED 정적 검사 (T-405)", () => {
  it("dependencies·devDependencies에 선언된 패키지를 선언 라인과 함께 찾는다", async () => {
    const manifest = await readPackageManifest(inMemoryFiles({ "package.json": PACKAGE_JSON }));
    const result = evaluateStaticChecks(
      [
        { kind: "DEPENDENCY_DECLARED", packageName: "express" },
        { kind: "DEPENDENCY_DECLARED", packageName: "vitest" },
      ],
      manifest,
    );
    expect(result.pass).toBe(true);
    expect(result.outcomes.map((o) => [o.pass, o.line, o.observation])).toEqual([
      [true, 4, "package.json에 의존성 express 선언 (4행)"],
      [true, 8, "package.json에 의존성 vitest 선언 (8행)"],
    ]);
    expect(result.source).toEqual({ path: "package.json", startLine: 4, endLine: 8 });
    expect(result.snippet?.split("\n")[0]).toContain('"express"');
  });

  it("선언이 없거나 package.json이 없거나 JSON이 깨졌으면 FAIL이고 근거 위치를 남긴다", async () => {
    const hono = await readPackageManifest(
      inMemoryFiles({ "package.json": '{\n  "dependencies": { "hono": "4.13.8" }\n}\n' }),
    );
    const missing = evaluateStaticChecks(
      [{ kind: "DEPENDENCY_DECLARED", packageName: "express" }],
      hono,
    );
    expect(missing.pass).toBe(false);
    expect(missing.outcomes[0]!.observation).toBe("package.json에 의존성 express 선언 없음");
    expect(missing.source).toEqual({ path: "package.json", startLine: 1, endLine: 4 });

    const none = evaluateStaticChecks(
      [{ kind: "DEPENDENCY_DECLARED", packageName: "express" }],
      await readPackageManifest(inMemoryFiles({})),
    );
    expect(none.pass).toBe(false);
    expect(none.source).toBeNull();

    const broken = evaluateStaticChecks(
      [{ kind: "DEPENDENCY_DECLARED", packageName: "express" }],
      await readPackageManifest(inMemoryFiles({ "package.json": "{ express" })),
    );
    expect(broken.pass).toBe(false);
    expect(broken.outcomes[0]!.observation).toContain("JSON으로 읽을 수 없음");
  });
});
