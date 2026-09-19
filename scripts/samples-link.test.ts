import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkAllSamples, linkImplNodeModules, listSampleImpls } from "./samples-link";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(options: { installed?: boolean; impls?: string[] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ohmyti-link-"));
  tmpDirs.push(root);
  const templatesDir = path.join(root, "templates");
  const nodeModules = path.join(templatesDir, "order-api-ts", "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  if (options.installed ?? true) writeFileSync(path.join(nodeModules, ".package-lock.json"), "{}");
  const samplesDir = path.join(root, "samples");
  const assignment = path.join(samplesDir, "order-api");
  mkdirSync(assignment, { recursive: true });
  writeFileSync(
    path.join(assignment, "execution-contract.json"),
    JSON.stringify({ templateName: "order-api-ts" }),
  );
  for (const impl of options.impls ?? ["impl-a", "impl-b"]) mkdirSync(path.join(assignment, impl));
  // impl- 접두사가 아닌 디렉터리는 대상이 아니다
  mkdirSync(path.join(assignment, "fixtures"));
  return { root, templatesDir, samplesDir, assignment, nodeModules };
}

describe("samples-link", () => {
  it("impl-* 디렉터리만 나열한다", () => {
    const f = fixture();
    expect(listSampleImpls(f.samplesDir)).toEqual([
      {
        dir: f.assignment,
        impls: [path.join(f.assignment, "impl-a"), path.join(f.assignment, "impl-b")],
      },
    ]);
  });

  it("상대 경로 심볼릭 링크를 만들고, 다시 실행하면 그대로 둔다", () => {
    const f = fixture();
    const first = linkAllSamples({ samplesDir: f.samplesDir, templatesDir: f.templatesDir });
    expect(first.map((r) => r.action)).toEqual(["created", "created"]);
    const link = path.join(f.assignment, "impl-a", "node_modules");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(
      path.join("..", "..", "..", "templates", "order-api-ts", "node_modules"),
    );
    expect(existsSync(path.join(link, ".package-lock.json"))).toBe(true);
    const second = linkAllSamples({ samplesDir: f.samplesDir, templatesDir: f.templatesDir });
    expect(second.map((r) => r.action)).toEqual(["kept", "kept"]);
  });

  it("다른 곳을 가리키는 링크는 바꾼다", () => {
    const f = fixture({ impls: ["impl-a"] });
    const impl = path.join(f.assignment, "impl-a");
    symlinkSync("../fixtures", path.join(impl, "node_modules"), "dir");
    expect(linkImplNodeModules(impl, f.nodeModules).action).toBe("replaced");
  });

  it("실제 node_modules 디렉터리가 있으면 실패한다", () => {
    const f = fixture({ impls: ["impl-a"] });
    const impl = path.join(f.assignment, "impl-a");
    mkdirSync(path.join(impl, "node_modules"));
    expect(() => linkImplNodeModules(impl, f.nodeModules)).toThrow(/심볼릭 링크가 아닙니다/);
  });

  it("템플릿이 설치되어 있지 않으면 template:build를 안내하며 실패한다", () => {
    const f = fixture({ installed: false });
    expect(() =>
      linkAllSamples({ samplesDir: f.samplesDir, templatesDir: f.templatesDir }),
    ).toThrow(/pnpm template:build/);
  });

  it("impl이 없으면 아무것도 하지 않는다", () => {
    const f = fixture({ impls: [], installed: false });
    expect(linkAllSamples({ samplesDir: f.samplesDir, templatesDir: f.templatesDir })).toEqual([]);
  });
});
