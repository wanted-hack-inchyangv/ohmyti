import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TemplateManifestSchema,
  checkDependencies,
  computeEnvironmentDigest,
  sha256Hex,
} from "./template";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const templateDir = path.join(repoRoot, "templates", "order-api-ts");

const template = {
  allowedDependencies: {
    express: "5.2.1",
    hono: "4.13.8",
    zod: "4.6.5",
    vitest: "4.1.11",
    "@types/node": "22.20.3",
  },
};

describe("checkDependencies", () => {
  it("허용 목록의 부분집합이면 supported다", () => {
    const result = checkDependencies(
      { dependencies: { express: "5.2.1", zod: "^4.0.0" }, devDependencies: { vitest: "~4.1.0" } },
      template,
    );
    expect(result).toEqual({ supported: true, unsupported: [], reasons: [] });
  });

  it("의존성이 없어도 supported다", () => {
    expect(checkDependencies({}, template).supported).toBe(true);
  });

  it("허용 목록에 없는 패키지는 supported: false와 해당 패키지 목록을 돌려준다", () => {
    const result = checkDependencies(
      { dependencies: { express: "5.2.1", axios: "1.7.0" }, devDependencies: { jest: "29.7.0" } },
      template,
    );
    expect(result.supported).toBe(false);
    expect(result.unsupported).toEqual(["axios", "jest"]);
    expect(result.reasons.map((r) => [r.code, r.name, r.field])).toEqual([
      ["DISALLOWED_DEPENDENCY", "axios", "dependencies"],
      ["DISALLOWED_DEPENDENCY", "jest", "devDependencies"],
    ]);
  });

  it("허용 목록에 있지만 버전 범위가 설치 버전을 만족하지 못하면 버전 불일치를 기록한다", () => {
    const result = checkDependencies({ dependencies: { express: "^4.18.0" } }, template);
    expect(result.supported).toBe(false);
    expect(result.unsupported).toEqual(["express"]);
    expect(result.reasons).toHaveLength(1);
    const [reason] = result.reasons;
    expect(reason?.code).toBe("DEPENDENCY_VERSION_MISMATCH");
    expect(reason?.installed).toBe("5.2.1");
    expect(reason?.requested).toBe("^4.18.0");
    expect(reason?.detail).toContain("5.2.1");
  });

  it("semver로 해석할 수 없는 값(latest, file:, github:)은 버전 불일치다", () => {
    const result = checkDependencies(
      { dependencies: { express: "latest", zod: "file:../zod", hono: "github:honojs/hono" } },
      template,
    );
    expect(result.supported).toBe(false);
    expect(result.reasons.every((r) => r.code === "DEPENDENCY_VERSION_MISMATCH")).toBe(true);
    expect(result.unsupported).toEqual(["express", "zod", "hono"]);
  });

  it("같은 패키지가 두 필드에서 문제면 unsupported에는 한 번만 나온다", () => {
    const result = checkDependencies(
      { dependencies: { axios: "1.0.0" }, devDependencies: { axios: "1.0.0" } },
      template,
    );
    expect(result.unsupported).toEqual(["axios"]);
    expect(result.reasons).toHaveLength(2);
  });

  it("스코프 패키지와 `*`·`>=` 범위를 처리한다", () => {
    const result = checkDependencies(
      { devDependencies: { "@types/node": "*", vitest: ">=4.0.0 <5" } },
      template,
    );
    expect(result.supported).toBe(true);
  });
});

describe("computeEnvironmentDigest", () => {
  it("같은 입력이면 같은 digest이고 어느 요소가 달라져도 값이 바뀐다", () => {
    const base = { nodeVersion: "22", lockfileContent: "{}\n", runnerKind: "local" as const };
    const digest = computeEnvironmentDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEnvironmentDigest({ ...base })).toBe(digest);
    expect(computeEnvironmentDigest({ ...base, nodeVersion: "24" })).not.toBe(digest);
    expect(computeEnvironmentDigest({ ...base, lockfileContent: "{ }\n" })).not.toBe(digest);
    expect(computeEnvironmentDigest({ ...base, runnerKind: "vercel" })).not.toBe(digest);
  });

  it("lockfile의 CRLF는 LF로 정규화한다", () => {
    const lf = computeEnvironmentDigest({
      nodeVersion: "22",
      lockfileContent: "a\nb\n",
      runnerKind: "local",
    });
    const crlf = computeEnvironmentDigest({
      nodeVersion: "22",
      lockfileContent: "a\r\nb\r\n",
      runnerKind: "local",
    });
    expect(crlf).toBe(lf);
  });

  it("sha256Hex는 알려진 값을 낸다", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("templates/order-api-ts/template.json", () => {
  const manifest = TemplateManifestSchema.parse(
    JSON.parse(readFileSync(path.join(templateDir, "template.json"), "utf8")),
  );
  const packageJson = JSON.parse(readFileSync(path.join(templateDir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

  it("스키마를 통과하고 실행 계약의 템플릿 이름·Node 버전과 같다", () => {
    const contract = JSON.parse(
      readFileSync(path.join(repoRoot, "samples", "order-api", "execution-contract.json"), "utf8"),
    ) as { templateName: string; nodeVersion: string };
    expect(manifest.name).toBe(contract.templateName);
    expect(manifest.nodeVersion).toBe(contract.nodeVersion);
  });

  it("allowedDependencies가 package.json의 dependencies와 같다 (정확한 버전)", () => {
    expect(manifest.allowedDependencies).toEqual(packageJson.dependencies);
    expect(Object.keys(manifest.allowedDependencies)).toEqual(
      expect.arrayContaining([
        "express",
        "hono",
        "@hono/node-server",
        "zod",
        "vitest",
        "supertest",
        "tsx",
        "typescript",
        "@types/node",
        "@types/express",
        "@types/supertest",
      ]),
    );
  });

  it("environmentDigest가 lockfile·Node 버전·러너 종류에서 재계산한 값과 같다", () => {
    const lockfileContent = readFileSync(path.join(templateDir, manifest.lockfile), "utf8");
    expect(manifest.lockfileDigest).toBe(sha256Hex(lockfileContent.replace(/\r\n/g, "\n")));
    expect(manifest.environmentDigest).toBe(
      computeEnvironmentDigest({
        nodeVersion: manifest.nodeVersion,
        lockfileContent,
        runnerKind: manifest.runnerKind,
      }),
    );
  });
});
