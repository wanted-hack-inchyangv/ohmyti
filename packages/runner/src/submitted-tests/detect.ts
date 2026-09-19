/**
 * 테스트 프레임워크 감지 (T-109). `package.json`과 설정 파일만 본다. vitest만 실행 대상이다.
 * README·주석의 문구는 데이터이므로 판단에 쓰지 않는다 (G-06).
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SUPPORTED_TEST_FRAMEWORKS, type FrameworkDetection, type TestFramework } from "./schema";

/** 스냅샷 파일에 접근하는 최소 인터페이스. 러너 종류와 무관하게 감지 로직을 재사용한다. */
export interface SubmissionFiles {
  /** `node_modules`·`.git`을 뺀 파일의 상대 경로(`/` 구분). 심볼릭 링크는 따라가지 않는다 */
  listFiles(): Promise<string[]>;
  /** 없으면 null */
  readText(relativePath: string): Promise<string | null>;
}

const IGNORED_DIRS = new Set(["node_modules", ".git"]);

/** 디렉터리를 `SubmissionFiles`로 감싼다. `maxFiles`를 넘으면 그 이후는 열거하지 않는다 */
export function directoryFiles(dir: string, options: { maxFiles?: number } = {}): SubmissionFiles {
  const maxFiles = options.maxFiles ?? 5000;
  return {
    async listFiles() {
      const out: string[] = [];
      const walk = async (relative: string): Promise<void> => {
        if (out.length >= maxFiles) return;
        const entries = await readdir(path.join(dir, relative), { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          if (out.length >= maxFiles) return;
          const rel = relative === "" ? entry.name : `${relative}/${entry.name}`;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) continue;
            await walk(rel);
          } else if (entry.isFile()) {
            out.push(rel);
          }
        }
      };
      await walk("");
      return out;
    },
    async readText(relativePath) {
      const target = path.join(dir, relativePath);
      try {
        const info = await lstat(target);
        if (!info.isFile()) return null;
        return await readFile(target, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** 테스트용: 메모리 파일 맵 */
export function inMemoryFiles(files: Record<string, string>): SubmissionFiles {
  return {
    listFiles: () => Promise.resolve(Object.keys(files).sort()),
    readText: (relativePath) => Promise.resolve(files[relativePath] ?? null),
  };
}

/** 의존성 이름 → 프레임워크 */
const DEPENDENCY_FRAMEWORKS: ReadonlyArray<readonly [string, TestFramework]> = [
  ["vitest", "vitest"],
  ["jest", "jest"],
  ["@jest/core", "jest"],
  ["ts-jest", "jest"],
  ["mocha", "mocha"],
  ["ava", "ava"],
  ["jasmine", "jasmine"],
  ["tap", "tap"],
  ["node-tap", "tap"],
];

/** 설정 파일 이름 패턴 → 프레임워크 */
const CONFIG_FILE_FRAMEWORKS: ReadonlyArray<readonly [RegExp, TestFramework]> = [
  [/^vitest\.(config|workspace)\.[cm]?[jt]s$/, "vitest"],
  [/^jest\.config\.([cm]?[jt]s|json)$/, "jest"],
  [/^\.mocharc(\.[cm]?js|\.json|\.yml|\.yaml)?$/, "mocha"],
  [/^ava\.config\.[cm]?js$/, "ava"],
  [/^\.taprc(\.[cm]?js|\.json|\.yml|\.yaml)?$/, "tap"],
];

/** `test` 스크립트 본문의 첫 프로그램 → 프레임워크 */
const SCRIPT_FRAMEWORKS: ReadonlyArray<readonly [RegExp, TestFramework]> = [
  [/(^|[\s/])vitest(\s|$)/, "vitest"],
  [/(^|[\s/])jest(\s|$)/, "jest"],
  [/(^|[\s/])mocha(\s|$)/, "mocha"],
  [/(^|[\s/])ava(\s|$)/, "ava"],
  [/(^|[\s/])jasmine(\s|$)/, "jasmine"],
  [/(^|[\s/])tap(\s|$)/, "tap"],
  [/(^|\s)node\s+(--test|--experimental-test)/, "node-test"],
];

const TEST_FILE_PATTERN =
  /(^|\/)([^/]+\.(test|spec)\.[cm]?[jt]sx?|__tests__\/[^/]+\.[cm]?[jt]sx?)$/;

interface PackageJsonShape {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  jest?: unknown;
  ava?: unknown;
  mocha?: unknown;
}

/**
 * 우선순위: `scripts.test` 본문 > 설정 파일·package.json 키 > 의존성. 어느 신호도 없고 테스트 파일도
 * 없으면 `none`, 테스트 파일만 있으면 `unknown`(실행하지 않는다, G-09).
 */
export async function detectTestFramework(files: SubmissionFiles): Promise<FrameworkDetection> {
  const paths = await files.listFiles();
  const testFilePaths = paths.filter((p) => TEST_FILE_PATTERN.test(p)).sort();
  const signals: string[] = [];
  const fromScript: TestFramework[] = [];
  const fromConfig: TestFramework[] = [];
  const fromDeps: TestFramework[] = [];

  const pkg = parsePackageJson(await files.readText("package.json"));
  if (pkg) {
    const testScript = pkg.scripts?.test;
    if (typeof testScript === "string") {
      for (const [pattern, framework] of SCRIPT_FRAMEWORKS) {
        if (pattern.test(testScript)) {
          fromScript.push(framework);
          signals.push(`package.json scripts.test: ${JSON.stringify(testScript)}`);
        }
      }
    }
    for (const key of ["jest", "ava", "mocha"] as const) {
      if (pkg[key] !== undefined) {
        fromConfig.push(key);
        signals.push(`package.json "${key}" 설정 키`);
      }
    }
    for (const field of ["dependencies", "devDependencies"] as const) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const [name, framework] of DEPENDENCY_FRAMEWORKS) {
        if (name in deps) {
          fromDeps.push(framework);
          signals.push(`package.json ${field}.${name}`);
        }
      }
    }
  }
  for (const p of paths) {
    if (p.includes("/")) continue; // 루트 설정 파일만
    for (const [pattern, framework] of CONFIG_FILE_FRAMEWORKS) {
      if (pattern.test(p)) {
        fromConfig.push(framework);
        signals.push(p);
      }
    }
  }

  const framework =
    firstDistinct(fromScript) ??
    firstDistinct(fromConfig) ??
    firstDistinct(fromDeps) ??
    (testFilePaths.length > 0 ? "unknown" : "none");
  if (framework === "unknown")
    signals.push(`테스트 파일 ${testFilePaths.length}개, 프레임워크 신호 없음`);
  if (framework === "none") signals.push("테스트 파일과 프레임워크 신호 없음");
  return {
    framework,
    supported: SUPPORTED_TEST_FRAMEWORKS.includes(framework),
    signals,
    testFilePaths,
  };
}

/** 같은 단계에 서로 다른 프레임워크가 섞여 있으면 vitest가 있을 때만 vitest, 아니면 첫 번째 */
function firstDistinct(list: readonly TestFramework[]): TestFramework | undefined {
  if (list.length === 0) return undefined;
  const distinct = [...new Set(list)];
  if (distinct.length === 1) return distinct[0];
  return distinct.includes("vitest") ? "vitest" : distinct[0];
}

function parsePackageJson(raw: string | null): PackageJsonShape | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    return {
      ...(isRecord(obj.scripts) ? { scripts: obj.scripts } : {}),
      ...(isRecord(obj.dependencies) ? { dependencies: obj.dependencies } : {}),
      ...(isRecord(obj.devDependencies) ? { devDependencies: obj.devDependencies } : {}),
      ...(obj.jest !== undefined ? { jest: obj.jest } : {}),
      ...(obj.ava !== undefined ? { ava: obj.ava } : {}),
      ...(obj.mocha !== undefined ? { mocha: obj.mocha } : {}),
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
