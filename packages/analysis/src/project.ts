/**
 * 스냅샷 파일을 ts-morph 프로젝트로 연다 (TICKET.md T-304).
 *
 * 파일을 일회성 임시 디렉터리에 쓰고(실행하지 않는다. 파싱만 한다) 템플릿의 `node_modules`를 심볼릭 링크로 붙여 외부 타입을
 * 참조할 수 있게 한다. 컴파일러 옵션은 제출물의 tsconfig를 읽지 않고 고정한다(`paths`·`types` 같은 옵션이 분석에 영향을 주지 않도록).
 * 분석이 끝나면 디렉터리를 지운다.
 */
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget } from "ts-morph";

/** 분석 대상 파일 공급자. 러너의 `SubmissionFiles`와 같은 형태다 */
export interface AnalysisFiles {
  /** `node_modules`·`.git`을 뺀 파일의 상대 경로(`/` 구분) */
  listFiles(): Promise<string[]>;
  /** 없으면 null */
  readText(relativePath: string): Promise<string | null>;
}

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

export interface ProjectLimits {
  /** 분석할 소스 파일 수 상한. 넘으면 `ProjectLimitError` */
  maxFiles: number;
  /** 소스 파일 총 바이트 상한 */
  maxBytes: number;
}

export const PROJECT_LIMIT_DEFAULTS: ProjectLimits = {
  maxFiles: 500,
  maxBytes: 20 * 1024 * 1024,
};

export class ProjectLimitError extends Error {
  override readonly name = "ProjectLimitError";
}

export class InvalidSnapshotPathError extends Error {
  override readonly name = "InvalidSnapshotPathError";
  constructor(readonly relativePath: string) {
    super(`스냅샷 경로가 올바르지 않습니다: ${relativePath}`);
  }
}

export interface LoadedProject {
  project: Project;
  /** 임시 디렉터리 (절대 경로). 소스 파일 경로는 이 아래에 있다 */
  rootDir: string;
  /** 분석에 넣은 파일의 상대 경로 (정렬) */
  sourcePaths: string[];
  /** `node_modules` 링크를 실제로 붙였는지 */
  nodeModulesLinked: boolean;
}

export interface LoadProjectOptions {
  /** 템플릿의 `node_modules` 절대 경로. 없거나 접근할 수 없으면 링크 없이 진행한다 */
  nodeModulesDir?: string | undefined;
  limits?: Partial<ProjectLimits> | undefined;
}

export function isSourcePath(relativePath: string): boolean {
  if (relativePath.endsWith(".d.ts")) return false;
  return SOURCE_EXTENSIONS.some((ext) => relativePath.endsWith(ext));
}

/** 상대 경로가 스냅샷 안을 가리키는지 확인한다. 아니면 `InvalidSnapshotPathError` */
export function assertSafeRelativePath(relativePath: string): void {
  const segments = relativePath.split("/");
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new InvalidSnapshotPathError(relativePath);
  }
}

/** 프로젝트를 열고 `fn`을 실행한 뒤 임시 디렉터리를 반드시 지운다 */
export async function withSnapshotProject<T>(
  files: AnalysisFiles,
  options: LoadProjectOptions,
  fn: (loaded: LoadedProject) => Promise<T> | T,
): Promise<T> {
  const limits: ProjectLimits = { ...PROJECT_LIMIT_DEFAULTS, ...(options.limits ?? {}) };
  const sourcePaths = (await files.listFiles()).filter(isSourcePath).sort();
  if (sourcePaths.length > limits.maxFiles) {
    throw new ProjectLimitError(
      `소스 파일이 ${sourcePaths.length}개로 상한 ${limits.maxFiles}개를 넘습니다`,
    );
  }
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ohmyti-analysis-"));
  try {
    let totalBytes = 0;
    for (const relativePath of sourcePaths) {
      assertSafeRelativePath(relativePath);
      const text = await files.readText(relativePath);
      if (text === null) continue;
      totalBytes += Buffer.byteLength(text, "utf8");
      if (totalBytes > limits.maxBytes) {
        throw new ProjectLimitError(`소스 파일 총 크기가 상한 ${limits.maxBytes}바이트를 넘습니다`);
      }
      const target = path.join(rootDir, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
    }
    let nodeModulesLinked = false;
    if (options.nodeModulesDir) {
      try {
        const target = path.resolve(options.nodeModulesDir);
        if ((await stat(target)).isDirectory()) {
          await symlink(target, path.join(rootDir, "node_modules"), "dir");
          nodeModulesLinked = true;
        }
      } catch {
        nodeModulesLinked = false;
      }
    }
    const project = new Project({
      compilerOptions: {
        target: ScriptTarget.ES2022,
        module: ModuleKind.ESNext,
        moduleResolution: ModuleResolutionKind.Bundler,
        allowJs: true,
        checkJs: false,
        strict: false,
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        types: [],
      },
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
    for (const relativePath of sourcePaths) {
      project.addSourceFileAtPathIfExists(path.join(rootDir, ...relativePath.split("/")));
    }
    return await fn({ project, rootDir, sourcePaths, nodeModulesLinked });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

/** 절대 경로 → 스냅샷 상대 경로 (`/` 구분). 임시 디렉터리 밖이면 null */
export function relativeSourcePath(rootDir: string, absolutePath: string): string | null {
  const relative = path.relative(rootDir, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}
