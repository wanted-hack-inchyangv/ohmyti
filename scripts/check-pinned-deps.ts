/**
 * 모든 package.json의 의존성이 정확한 버전(예: 1.2.3) 또는 workspace:*로 고정되어 있는지 확인한다 (G-15).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirs = ["apps", "packages", "templates"];
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const PINNED = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|workspace:\*)$/;

type PackageJson = Record<string, Record<string, string> | undefined>;

const manifests = [path.join(repoRoot, "package.json")];
for (const dir of workspaceDirs) {
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) manifests.push(path.join(repoRoot, dir, entry.name, "package.json"));
  }
}

const violations: string[] = [];
for (const file of manifests) {
  const json = JSON.parse(readFileSync(file, "utf8")) as PackageJson;
  for (const field of DEP_FIELDS) {
    for (const [name, version] of Object.entries(json[field] ?? {})) {
      if (!PINNED.test(version)) {
        violations.push(`${path.relative(repoRoot, file)} ${field}: ${name}@${version}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("정확한 버전으로 고정되지 않은 의존성:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(
  `deps:check OK — ${manifests.length}개 package.json의 의존성이 모두 고정되어 있습니다.`,
);
