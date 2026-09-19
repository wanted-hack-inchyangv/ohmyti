/**
 * 샘플 구현의 `node_modules`를 템플릿 `node_modules`로 심볼릭 링크한다 (T-102).
 * 샘플을 러너 없이 로컬에서 `npm start`·`npm test`로 실행할 때 쓴다. 제출물에 `npm install`은 하지 않는다.
 *
 * 대상: `samples/<과제>/impl-*` 디렉터리. 링크 대상은 `samples/<과제>/execution-contract.json`의 `templateName`이다.
 * 이미 같은 곳을 가리키는 링크는 그대로 두고, 다른 링크는 바꾸며, 실제 디렉터리가 있으면 실패한다.
 *
 * 사용: `pnpm samples:link` (템플릿 `node_modules`가 없으면 먼저 `pnpm template:build`)
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SAMPLES_DIR = path.join(repoRoot, "samples");
export const TEMPLATES_DIR = path.join(repoRoot, "templates");

export type LinkResult = { impl: string; target: string; action: "created" | "replaced" | "kept" };

/** 샘플 과제 디렉터리(실행 계약이 있는 곳)마다 `impl-*` 목록을 돌려준다. */
export function listSampleImpls(samplesDir = SAMPLES_DIR): Array<{ dir: string; impls: string[] }> {
  if (!existsSync(samplesDir)) return [];
  return readdirSync(samplesDir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() && existsSync(path.join(samplesDir, e.name, "execution-contract.json")),
    )
    .map((e) => {
      const dir = path.join(samplesDir, e.name);
      const impls = readdirSync(dir, { withFileTypes: true })
        .filter((i) => i.isDirectory() && i.name.startsWith("impl-"))
        .map((i) => path.join(dir, i.name))
        .sort();
      return { dir, impls };
    });
}

export function linkImplNodeModules(implDir: string, templateNodeModules: string): LinkResult {
  const linkPath = path.join(implDir, "node_modules");
  const target = path.relative(implDir, templateNodeModules);
  let action: LinkResult["action"] = "created";
  if (existsSync(linkPath) || isSymlink(linkPath)) {
    if (!isSymlink(linkPath)) {
      throw new Error(
        `${linkPath}이(가) 심볼릭 링크가 아닙니다. 샘플에 node_modules를 설치하지 말고 디렉터리를 지운 뒤 다시 실행하세요`,
      );
    }
    if (readlinkSync(linkPath) === target) {
      return { impl: implDir, target, action: "kept" };
    }
    unlinkSync(linkPath);
    action = "replaced";
  }
  symlinkSync(target, linkPath, "dir");
  return { impl: implDir, target, action };
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function linkAllSamples(
  options: { samplesDir?: string; templatesDir?: string } = {},
): LinkResult[] {
  const samplesDir = options.samplesDir ?? SAMPLES_DIR;
  const templatesDir = options.templatesDir ?? TEMPLATES_DIR;
  const results: LinkResult[] = [];
  for (const { dir, impls } of listSampleImpls(samplesDir)) {
    const contract = JSON.parse(
      readFileSync(path.join(dir, "execution-contract.json"), "utf8"),
    ) as { templateName: string };
    const templateNodeModules = path.join(templatesDir, contract.templateName, "node_modules");
    if (impls.length === 0) continue;
    if (!existsSync(path.join(templateNodeModules, ".package-lock.json"))) {
      throw new Error(
        `${templateNodeModules}이(가) 설치되어 있지 않습니다. 먼저 pnpm template:build를 실행하세요`,
      );
    }
    for (const impl of impls) results.push(linkImplNodeModules(impl, templateNodeModules));
  }
  return results;
}

function main(): void {
  const results = linkAllSamples();
  for (const r of results) {
    console.log(`${path.relative(repoRoot, r.impl)}/node_modules → ${r.target} (${r.action})`);
  }
  console.log(`samples:link OK — 샘플 ${results.length}개 연결`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
