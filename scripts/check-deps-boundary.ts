/**
 * `apps/web`의 워크스페이스 의존성 그래프(직접·간접)에 실행 계열 패키지가 없는지 확인한다 (G-05, T-007).
 * web은 제출 코드를 실행하지 않으므로 runner·harness·analysis·llm이 번들에 들어가면 안 된다.
 * dependencies·devDependencies·peerDependencies·optionalDependencies를 모두 따라간다.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const WEB_PACKAGE = "@ohmyti/web";
export const FORBIDDEN_FOR_WEB = [
  "@ohmyti/runner",
  "@ohmyti/harness",
  "@ohmyti/analysis",
  "@ohmyti/llm",
] as const;

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

type Manifest = { name: string } & Record<string, Record<string, string> | string | undefined>;

/** 워크스페이스의 모든 package.json을 이름으로 색인한다. */
export function loadWorkspaceManifests(root = repoRoot): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  for (const dir of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, dir, entry.name, "package.json");
      const json = JSON.parse(readFileSync(file, "utf8")) as Manifest;
      manifests.set(json.name, json);
    }
  }
  return manifests;
}

/** 시작 패키지에서 도달 가능한 워크스페이스 패키지 집합(시작 패키지 제외)과 경로를 돌려준다. */
export function collectWorkspaceGraph(
  start: string,
  manifests: Map<string, Manifest>,
): Map<string, string[]> {
  const reached = new Map<string, string[]>();
  const queue: Array<{ name: string; trail: string[] }> = [{ name: start, trail: [start] }];
  while (queue.length > 0) {
    const { name, trail } = queue.shift()!;
    const manifest = manifests.get(name);
    if (!manifest) continue;
    for (const field of DEP_FIELDS) {
      const deps = manifest[field];
      if (!deps || typeof deps === "string") continue;
      for (const dep of Object.keys(deps)) {
        if (!manifests.has(dep) || reached.has(dep) || dep === start) continue;
        const nextTrail = [...trail, dep];
        reached.set(dep, nextTrail);
        queue.push({ name: dep, trail: nextTrail });
      }
    }
  }
  return reached;
}

export function findBoundaryViolations(manifests: Map<string, Manifest>): string[] {
  const graph = collectWorkspaceGraph(WEB_PACKAGE, manifests);
  return FORBIDDEN_FOR_WEB.filter((name) => graph.has(name)).map(
    (name) => `${name} (경로: ${graph.get(name)!.join(" → ")})`,
  );
}

function main(): void {
  const manifests = loadWorkspaceManifests();
  if (!manifests.has(WEB_PACKAGE)) {
    console.error(`${WEB_PACKAGE} package.json을 찾지 못했습니다`);
    process.exit(1);
  }
  const graph = collectWorkspaceGraph(WEB_PACKAGE, manifests);
  const violations = findBoundaryViolations(manifests);
  if (violations.length > 0) {
    console.error(`${WEB_PACKAGE}가 실행 계열 패키지에 의존합니다 (G-05):`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  const reached = [...graph.keys()].sort().join(", ") || "(없음)";
  console.log(
    `deps:boundary-check OK — ${WEB_PACKAGE}의 워크스페이스 의존성: ${reached}. 금지 패키지(${FORBIDDEN_FOR_WEB.join(", ")}) 없음.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
