import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTemplateManifest,
  listTemplateDirs,
  TEMPLATES_DIR,
  writeTemplateManifest,
} from "./template-build";

const realTemplate = path.join(TEMPLATES_DIR, "order-api-ts");
const installed = existsSync(path.join(realTemplate, "node_modules", ".package-lock.json"));
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 실제 템플릿의 package.json·lockfile·template.json만 복사하고, node_modules에는 직접 의존성의 package.json만 만든다. */
function fakeTemplate(overrides: { versions?: Record<string, string> } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ohmyti-template-"));
  tmpDirs.push(dir);
  for (const f of ["package.json", "package-lock.json", "template.json"]) {
    cpSync(path.join(realTemplate, f), path.join(dir, f));
  }
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    const pkgDir = path.join(dir, "node_modules", name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name, version: overrides.versions?.[name] ?? version }),
    );
  }
  return dir;
}

describe("template-build", () => {
  it("templates/ 아래에 order-api-ts가 있다", () => {
    expect(listTemplateDirs()).toContain("order-api-ts");
  });

  it("같은 입력으로 두 번 만들면 매니페스트가 같고 파일도 바뀌지 않는다", () => {
    const dir = fakeTemplate();
    const first = buildTemplateManifest(dir);
    expect(writeTemplateManifest(dir, first)).toBe(false); // 저장소의 template.json과 이미 같다
    const second = buildTemplateManifest(dir);
    expect(second).toEqual(first);
    expect(first.environmentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(first.allowedDependencies)).toHaveLength(11);
  });

  it("설치 버전이 선언 버전과 다르면 실패한다", () => {
    const dir = fakeTemplate({ versions: { express: "4.21.0" } });
    expect(() => buildTemplateManifest(dir)).toThrow(
      /express: 설치 버전 4\.21\.0 ≠ 선언 버전 5\.2\.1/,
    );
  });

  it("직접 의존성이 설치되어 있지 않으면 실패한다", () => {
    const dir = fakeTemplate();
    rmSync(path.join(dir, "node_modules", "zod"), { recursive: true });
    expect(() => buildTemplateManifest(dir)).toThrow(/zod: node_modules에 설치되어 있지 않습니다/);
  });

  it("package.json과 lockfile이 어긋나면 실패한다", () => {
    const dir = fakeTemplate();
    const pkgPath = path.join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies["left-pad"] = "1.3.0";
    writeFileSync(pkgPath, JSON.stringify(pkg));
    expect(() => buildTemplateManifest(dir)).toThrow(
      /left-pad: package.json 1\.3\.0 ≠ lockfile \(없음\)/,
    );
  });

  it("lockfile 내용이 바뀌면 digest가 바뀐다", () => {
    const dir = fakeTemplate();
    const before = buildTemplateManifest(dir);
    const lockPath = path.join(dir, "package-lock.json");
    writeFileSync(lockPath, `${readFileSync(lockPath, "utf8")}\n`);
    const after = buildTemplateManifest(dir);
    expect(after.lockfileDigest).not.toBe(before.lockfileDigest);
    expect(after.environmentDigest).not.toBe(before.environmentDigest);
  });

  it.skipIf(!installed)("실제 템플릿 설치본이 저장소의 template.json과 같다", () => {
    const manifest = buildTemplateManifest(realTemplate);
    expect(JSON.parse(readFileSync(path.join(realTemplate, "template.json"), "utf8"))).toEqual(
      manifest,
    );
    for (const bin of ["vitest", "tsx", "tsc"]) {
      expect(existsSync(path.join(realTemplate, "node_modules", ".bin", bin))).toBe(true);
    }
  });
});
