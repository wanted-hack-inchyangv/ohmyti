/**
 * 스냅샷 tar.gz를 검증하고 푼다 (T-108).
 * 아카이브 전체를 먼저 훑어 규칙을 어긴 항목이 하나라도 있으면 아무것도 풀지 않는다.
 * 규칙: `..`·절대 경로·백슬래시 거부, 심볼릭 링크·하드 링크·장치 파일 거부, 파일 수·바이트 상한.
 * `node_modules` 아래 항목은 풀지 않는다 (템플릿의 것을 연결한다).
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { SnapshotRejectedError } from "../runner";

export interface UnpackLimits {
  maxFiles: number;
  maxBytes: number;
}

export interface UnpackOptions extends UnpackLimits {
  /** 앞부분 디렉터리 단계 제거 */
  stripComponents?: number;
}

export interface UnpackResult {
  fileCount: number;
  totalBytes: number;
  droppedNodeModules: boolean;
  /** 풀린 파일 경로 (workDir 기준, 정렬) */
  files: string[];
}

const ALLOWED_FILE_TYPES = new Set(["File", "OldFile", "ContiguousFile"]);
const NODE_MODULES = "node_modules";

interface PlannedEntry {
  /** strip 적용 후 상대 경로 (`/` 구분) */
  relativePath: string;
  isDirectory: boolean;
  size: number;
}

/** 아카이브 경로를 검사하고 strip을 적용한다. 규칙 위반은 `SnapshotRejectedError`. */
export function planEntryPath(
  entryPath: string,
  type: string,
  stripComponents: number,
): { relativePath: string; skip: boolean } {
  if (entryPath.includes("\\")) {
    throw new SnapshotRejectedError("PATH_TRAVERSAL", entryPath, "백슬래시가 든 경로");
  }
  if (entryPath.startsWith("/")) {
    throw new SnapshotRejectedError("ABSOLUTE_PATH", entryPath, "절대 경로");
  }
  if (/^[A-Za-z]:/.test(entryPath)) {
    throw new SnapshotRejectedError("ABSOLUTE_PATH", entryPath, "드라이브 문자로 시작하는 경로");
  }
  const segments = entryPath.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new SnapshotRejectedError("PATH_TRAVERSAL", entryPath, "`..` 세그먼트");
  }
  if (segments.some((s) => s.includes("\0"))) {
    throw new SnapshotRejectedError("PATH_TRAVERSAL", entryPath, "NUL 문자");
  }
  if (type === "SymbolicLink" || type === "Link") {
    throw new SnapshotRejectedError(
      "SYMLINK",
      entryPath,
      type === "SymbolicLink" ? "심볼릭 링크" : "하드 링크",
    );
  }
  if (type !== "Directory" && !ALLOWED_FILE_TYPES.has(type)) {
    throw new SnapshotRejectedError(
      "UNSUPPORTED_ENTRY",
      entryPath,
      `지원하지 않는 항목 종류 ${type}`,
    );
  }
  const stripped = segments.slice(stripComponents);
  if (stripped.length === 0) {
    // strip으로 사라진 상위 디렉터리 항목 (예: `owner-repo-sha/`)
    return { relativePath: "", skip: true };
  }
  if (stripped.includes(NODE_MODULES)) {
    return { relativePath: stripped.join("/"), skip: true };
  }
  return { relativePath: stripped.join("/"), skip: false };
}

/** 아카이브를 훑어 모든 항목을 검증하고 풀 계획을 세운다. */
export async function inspectSnapshot(
  archiveFile: string,
  options: UnpackOptions,
): Promise<{ entries: PlannedEntry[]; droppedNodeModules: boolean }> {
  const strip = options.stripComponents ?? 0;
  const entries: PlannedEntry[] = [];
  let droppedNodeModules = false;
  let fileCount = 0;
  let totalBytes = 0;
  // 콜백 안에서 대입하므로 객체에 담는다 (TS가 null로 좁히는 것을 막는다)
  const found: { rejection: SnapshotRejectedError | null } = { rejection: null };

  try {
    await tar.t({
      file: archiveFile,
      strict: true,
      onReadEntry: (entry) => {
        if (found.rejection) return;
        try {
          const plan = planEntryPath(entry.path, entry.type, strip);
          if (plan.skip) {
            if (plan.relativePath.split("/").includes(NODE_MODULES)) droppedNodeModules = true;
            return;
          }
          const isDirectory = entry.type === "Directory";
          if (!isDirectory) {
            fileCount += 1;
            totalBytes += entry.size;
            if (fileCount > options.maxFiles) {
              throw new SnapshotRejectedError(
                "TOO_MANY_FILES",
                entry.path,
                `파일 수가 상한 ${options.maxFiles}개를 넘습니다`,
              );
            }
            if (totalBytes > options.maxBytes) {
              throw new SnapshotRejectedError(
                "TOO_LARGE",
                entry.path,
                `누적 크기가 상한 ${options.maxBytes}바이트를 넘습니다`,
              );
            }
          }
          entries.push({ relativePath: plan.relativePath, isDirectory, size: entry.size });
        } catch (error) {
          if (error instanceof SnapshotRejectedError) found.rejection = error;
          else throw error;
        }
      },
    });
  } catch (error) {
    if (found.rejection) throw found.rejection;
    if (error instanceof SnapshotRejectedError) throw error;
    throw new SnapshotRejectedError(
      "CORRUPT_ARCHIVE",
      null,
      `tar.gz를 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (found.rejection) throw found.rejection;
  return { entries, droppedNodeModules };
}

/**
 * 검증을 통과한 아카이브를 `destDir`에 푼다. `inspectSnapshot`이 세운 계획에 있는 경로만 풀며,
 * tar의 기본 보호(`preservePaths: false`)도 그대로 둔다.
 */
export async function unpackSnapshot(
  archiveFile: string,
  destDir: string,
  options: UnpackOptions,
): Promise<UnpackResult> {
  const { entries, droppedNodeModules } = await inspectSnapshot(archiveFile, options);
  const strip = options.stripComponents ?? 0;
  const allowed = new Set(entries.map((e) => e.relativePath));
  const dest = path.resolve(destDir);
  // 검증을 통과한 뒤에만 대상 디렉터리를 만든다 (거부된 아카이브는 흔적을 남기지 않는다)
  await mkdir(dest, { recursive: true });

  await tar.x({
    file: archiveFile,
    cwd: dest,
    strict: true,
    strip,
    preservePaths: false,
    // 계획에 없는 항목(node_modules, strip으로 비는 경로, 검증 밖 항목)은 풀지 않는다.
    filter: (entryPath, entry) => {
      // 읽기 쪽 filter는 항상 ReadEntry를 받는다 (Stats는 아카이브를 만들 때만)
      const type = "type" in entry ? entry.type : "File";
      const plan = planEntryPath(entryPath, type, strip);
      if (plan.skip) return false;
      if (!allowed.has(plan.relativePath)) return false;
      const target = path.resolve(dest, ...plan.relativePath.split("/"));
      return target === dest || target.startsWith(dest + path.sep);
    },
  });

  const files = entries
    .filter((e) => !e.isDirectory)
    .map((e) => e.relativePath)
    .sort();
  return {
    fileCount: files.length,
    totalBytes: entries.reduce((sum, e) => (e.isDirectory ? sum : sum + e.size), 0),
    droppedNodeModules,
    files,
  };
}
