/**
 * 승인 실행 템플릿 빌드 (T-102).
 *
 * `templates/<name>/`마다:
 * 1. `npm ci`로 lockfile 그대로 `node_modules`를 설치한다 (제출물에는 절대 실행하지 않는다).
 * 2. 설치된 각 직접 의존성의 버전이 `package.json`의 정확한 버전과 같은지 확인한다.
 * 3. `template.json`에 `allowedDependencies`(이름 → 설치 버전), `lockfileDigest`,
 *    `environmentDigest = sha256(node 버전 + lockfile 내용 + 러너 종류)`를 기록한다.
 *    이름·버전·nodeVersion·runnerKind는 기존 `template.json`에서 읽는다. 입력이 같으면 파일 내용도 같다.
 *
 * 사용: `pnpm template:build [템플릿 이름...]` (`--no-install`이면 설치를 건너뛰고 기록만 갱신한다)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  computeEnvironmentDigest,
  sha256Hex,
  TemplateManifestSchema,
  type TemplateManifest,
} from "@ohmyti/runner";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEMPLATES_DIR = path.join(repoRoot, "templates");
export const LOCKFILE_NAME = "package-lock.json";
export const INSTALL_COMMAND = "npm ci --no-audit --no-fund";

/** 사람이 적는 필드. 나머지(계산 필드)는 있어도 무시하고 다시 계산한다. */
const ManifestInputSchema = z.looseObject({
  name: TemplateManifestSchema.shape.name,
  version: TemplateManifestSchema.shape.version,
  nodeVersion: TemplateManifestSchema.shape.nodeVersion,
  runnerKind: TemplateManifestSchema.shape.runnerKind.optional(),
});

type PackageJson = { dependencies?: Record<string, string> };
type LockfileV3 = { lockfileVersion: number; packages: Record<string, { version?: string }> };

export function listTemplateDirs(root = TEMPLATES_DIR): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, "package.json")))
    .map((e) => e.name)
    .sort();
}

export function installTemplate(templateDir: string): void {
  const [cmd, ...args] = INSTALL_COMMAND.split(" ") as [string, ...string[]];
  const result = spawnSync(cmd, args, { cwd: templateDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${INSTALL_COMMAND} 실패 (exit ${result.status}) — ${templateDir}`);
  }
}

/** 설치 결과를 검증하고 `template.json` 내용을 만든다. 파일은 쓰지 않는다. */
export function buildTemplateManifest(templateDir: string): TemplateManifest {
  const manifestPath = path.join(templateDir, "template.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath}가 없습니다. name·version·nodeVersion을 먼저 적어야 합니다`);
  }
  const input = ManifestInputSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const packageJson = JSON.parse(
    readFileSync(path.join(templateDir, "package.json"), "utf8"),
  ) as PackageJson;
  const lockfilePath = path.join(templateDir, LOCKFILE_NAME);
  if (!existsSync(lockfilePath)) {
    throw new Error(
      `${lockfilePath}가 없습니다. 템플릿 디렉터리에서 npm install --package-lock-only를 실행하세요`,
    );
  }
  const lockfileContent = readFileSync(lockfilePath, "utf8");
  const lockfile = JSON.parse(lockfileContent) as LockfileV3;
  if (lockfile.lockfileVersion !== 3) {
    throw new Error(`lockfileVersion ${lockfile.lockfileVersion}은 지원하지 않습니다 (3 필요)`);
  }

  const problems: string[] = [];
  const allowedDependencies: Record<string, string> = {};
  for (const [name, declared] of Object.entries(packageJson.dependencies ?? {}).sort()) {
    const locked = lockfile.packages[`node_modules/${name}`]?.version;
    if (locked !== declared) {
      problems.push(`${name}: package.json ${declared} ≠ lockfile ${locked ?? "(없음)"}`);
    }
    const installedPkg = path.join(templateDir, "node_modules", name, "package.json");
    if (!existsSync(installedPkg)) {
      problems.push(`${name}: node_modules에 설치되어 있지 않습니다`);
    } else {
      const installed = (JSON.parse(readFileSync(installedPkg, "utf8")) as { version: string })
        .version;
      if (installed !== declared) {
        problems.push(`${name}: 설치 버전 ${installed} ≠ 선언 버전 ${declared}`);
      }
    }
    allowedDependencies[name] = declared;
  }
  if (problems.length > 0) {
    throw new Error(`템플릿 의존성 불일치:\n  ${problems.join("\n  ")}`);
  }

  const runnerKind = input.runnerKind ?? "local";
  return TemplateManifestSchema.parse({
    name: input.name,
    version: input.version,
    nodeVersion: input.nodeVersion,
    installCommand: INSTALL_COMMAND,
    lockfile: LOCKFILE_NAME,
    allowedDependencies,
    runnerKind,
    lockfileDigest: sha256Hex(lockfileContent.replace(/\r\n/g, "\n")),
    environmentDigest: computeEnvironmentDigest({
      nodeVersion: input.nodeVersion,
      lockfileContent,
      runnerKind,
    }),
  } satisfies TemplateManifest);
}

export function writeTemplateManifest(templateDir: string, manifest: TemplateManifest): boolean {
  const manifestPath = path.join(templateDir, "template.json");
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  const prev = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null;
  if (prev === next) return false;
  writeFileSync(manifestPath, next);
  return true;
}

function main(): void {
  const args = process.argv.slice(2);
  const install = !args.includes("--no-install");
  const requested = args.filter((a) => !a.startsWith("--"));
  const names = requested.length > 0 ? requested : listTemplateDirs();
  if (names.length === 0) {
    console.error(`${TEMPLATES_DIR}에 템플릿이 없습니다`);
    process.exit(1);
  }
  for (const name of names) {
    const dir = path.join(TEMPLATES_DIR, name);
    if (!existsSync(path.join(dir, "package.json"))) {
      console.error(`템플릿 ${name}: ${dir}/package.json이 없습니다`);
      process.exit(1);
    }
    console.log(`템플릿 ${name}: ${install ? INSTALL_COMMAND : "설치 건너뜀"}`);
    if (install) installTemplate(dir);
    const manifest = buildTemplateManifest(dir);
    const changed = writeTemplateManifest(dir, manifest);
    console.log(
      `템플릿 ${name}: 의존성 ${Object.keys(manifest.allowedDependencies).length}개, ` +
        `environmentDigest=${manifest.environmentDigest} (template.json ${changed ? "갱신" : "변경 없음"})`,
    );
  }
  console.log("template:build OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
