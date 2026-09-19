/**
 * GitHub tarball → 정규화된 스냅샷 (TICKET.md T-202).
 *
 * 1. 아카이브 전체를 먼저 훑는다: 최상위 디렉터리(`owner-repo-sha/`) 한 단계를 벗기고, `.git` 세그먼트가 든 경로와
 *    심볼릭·하드 링크, 파일·디렉터리가 아닌 항목은 제외 목록에 넣는다. 파일 수·바이트 한도를 넘으면
 *    `SnapshotLimitExceededError`로 끝내고 아무것도 풀지 않는다.
 * 2. 통과한 항목만 임시 디렉터리에 푼다 (`preservePaths: false`, umask 고정).
 * 3. 정렬된 경로 목록으로 tar를 다시 만든다. `portable`(소유자 없음), 고정 mtime, 명시적 항목 순서라
 *    같은 SHA를 두 번 수집해도 바이트가 같다. digest는 gzip 전 tar 바이트의 sha256이다.
 *
 * 결과 스냅샷은 `LocalProcessRunner.prepare()`가 `stripComponents: 0`으로 그대로 푼다 (`..`·링크가 없다).
 */
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { z } from "zod";

export interface SnapshotLimits {
  /** `MAX_SOURCE_FILES` */
  maxFiles: number;
  /** `MAX_SOURCE_BYTES` (파일 내용 합계) */
  maxBytes: number;
}

export const SnapshotFileSchema = z.strictObject({
  /** 스냅샷 루트 기준 상대 경로 (`/` 구분) */
  path: z.string().min(1),
  size: z.int().min(0),
});
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

/** 수집 결과 기록. `submissions/<id>/snapshot-manifest.json`에 저장한다 */
export const SnapshotManifestSchema = z.strictObject({
  version: z.literal(1),
  repo: z.strictObject({ owner: z.string().min(1), name: z.string().min(1) }),
  /** 고정한 커밋 SHA */
  submissionSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** 사용자가 요청한 ref (브랜치·태그·SHA). 기본 브랜치면 그 이름 */
  requestedRef: z.string().min(1),
  /** gzip 전 tar 바이트의 sha256 hex */
  snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
  fileCount: z.int().min(0),
  totalBytes: z.int().min(0),
  files: z.array(SnapshotFileSchema),
  /** 제외한 항목 수. 스냅샷에는 들어가지 않았다 */
  dropped: z.strictObject({
    gitEntries: z.int().min(0),
    links: z.int().min(0),
    unsupported: z.int().min(0),
  }),
  collectedAt: z.string().min(1),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export type SnapshotLimitKind = "TOO_MANY_FILES" | "TOO_LARGE";

export class SnapshotLimitExceededError extends Error {
  override readonly name = "SnapshotLimitExceededError";
  constructor(
    readonly kind: SnapshotLimitKind,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/** GitHub가 준 아카이브를 읽을 수 없거나 항목 경로가 안전하지 않다 */
export class SnapshotArchiveError extends Error {
  override readonly name = "SnapshotArchiveError";
  constructor(readonly detail: string) {
    super(detail);
  }
}

export interface BuiltSnapshot {
  /** gzip 압축된 tar 바이트 */
  bytes: Uint8Array;
  /** gzip 전 tar 바이트의 sha256 hex */
  digest: string;
  files: SnapshotFile[];
  fileCount: number;
  totalBytes: number;
  dropped: SnapshotManifest["dropped"];
}

/** 아카이브 안 항목의 처리 계획 */
export interface EntryPlan {
  /** strip 적용 후 경로 (`/` 구분). 빈 문자열이면 벗겨진 최상위 디렉터리 */
  relativePath: string;
  action: "FILE" | "DIRECTORY" | "DROP_TOP" | "DROP_GIT" | "DROP_LINK" | "DROP_UNSUPPORTED";
}

const FILE_TYPES = new Set(["File", "OldFile", "ContiguousFile"]);
const GIT_DIR = ".git";
/** 재생성한 스냅샷의 모든 항목 mtime. 실제 수정 시각은 커밋 SHA가 대신한다 */
const FIXED_MTIME = new Date("2000-01-01T00:00:00Z");
const EXTRACT_UMASK = 0o022;

/** GitHub tarball 항목 하나의 처리 계획을 정한다. 위험한 경로는 `SnapshotArchiveError`. */
export function planTarballEntry(entryPath: string, type: string): EntryPlan {
  if (entryPath.includes("\\") || entryPath.includes("\0")) {
    throw new SnapshotArchiveError(`안전하지 않은 항목 경로: ${JSON.stringify(entryPath)}`);
  }
  if (entryPath.startsWith("/") || /^[A-Za-z]:/.test(entryPath)) {
    throw new SnapshotArchiveError(`절대 경로 항목: ${JSON.stringify(entryPath)}`);
  }
  const segments = entryPath.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) {
    throw new SnapshotArchiveError(`상위 디렉터리 참조 항목: ${JSON.stringify(entryPath)}`);
  }
  // GitHub tarball은 항상 `owner-repo-sha/` 한 단계 아래에 파일을 둔다
  const stripped = segments.slice(1);
  if (stripped.length === 0) return { relativePath: "", action: "DROP_TOP" };
  const relativePath = stripped.join("/");
  if (stripped.includes(GIT_DIR)) return { relativePath, action: "DROP_GIT" };
  if (type === "SymbolicLink" || type === "Link") return { relativePath, action: "DROP_LINK" };
  if (type === "Directory") return { relativePath, action: "DIRECTORY" };
  if (FILE_TYPES.has(type)) return { relativePath, action: "FILE" };
  return { relativePath, action: "DROP_UNSUPPORTED" };
}

interface ScanResult {
  files: SnapshotFile[];
  directories: string[];
  dropped: SnapshotManifest["dropped"];
}

/** 아카이브를 훑어 계획을 세운다. 한도 초과·손상은 예외이며 이 단계에서는 디스크에 아무것도 쓰지 않는다 */
export async function scanTarball(
  archiveFile: string,
  limits: SnapshotLimits,
): Promise<ScanResult> {
  const files = new Map<string, number>();
  const directories = new Set<string>();
  const dropped = { gitEntries: 0, links: 0, unsupported: 0 };
  let totalBytes = 0;
  const found: { failure: Error | null } = { failure: null };

  try {
    await tar.t({
      file: archiveFile,
      strict: true,
      onReadEntry: (entry) => {
        if (found.failure) return;
        try {
          const plan = planTarballEntry(entry.path, entry.type);
          switch (plan.action) {
            case "DROP_TOP":
              return;
            case "DROP_GIT":
              dropped.gitEntries += 1;
              return;
            case "DROP_LINK":
              dropped.links += 1;
              return;
            case "DROP_UNSUPPORTED":
              dropped.unsupported += 1;
              return;
            case "DIRECTORY":
              directories.add(plan.relativePath);
              return;
            case "FILE": {
              // 같은 경로가 두 번 나오면(드물지만 tar에서는 가능) 마지막 것이 남는다. tar.x도 같은 동작이다
              const previous = files.get(plan.relativePath);
              if (previous !== undefined) totalBytes -= previous;
              files.set(plan.relativePath, entry.size);
              totalBytes += entry.size;
              if (files.size > limits.maxFiles) {
                throw new SnapshotLimitExceededError(
                  "TOO_MANY_FILES",
                  `파일 수가 한도 ${limits.maxFiles}개를 넘습니다`,
                );
              }
              if (totalBytes > limits.maxBytes) {
                throw new SnapshotLimitExceededError(
                  "TOO_LARGE",
                  `소스 크기가 한도 ${limits.maxBytes}바이트를 넘습니다`,
                );
              }
              return;
            }
          }
        } catch (error) {
          found.failure = error instanceof Error ? error : new Error(String(error));
        }
      },
    });
  } catch (error) {
    if (found.failure) throw found.failure;
    throw new SnapshotArchiveError(
      `tarball을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (found.failure) throw found.failure;

  // 파일의 상위 디렉터리는 항목이 없어도 스냅샷에 디렉터리로 들어간다
  for (const filePath of files.keys()) {
    const segments = filePath.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join("/"));
    }
  }
  // 파일 경로와 겹치는 디렉터리 항목은 무시한다 (손상된 아카이브 방어)
  for (const filePath of files.keys()) directories.delete(filePath);

  return {
    files: [...files.entries()]
      .map(([p, size]) => ({ path: p, size }))
      .sort((a, b) => comparePath(a.path, b.path)),
    directories: [...directories].sort(comparePath),
    dropped,
  };
}

/** 코드 포인트 순 비교. 로케일에 따라 달라지는 `localeCompare`는 쓰지 않는다 */
export function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * tarball을 검증하고 정규화된 스냅샷을 만든다. `workDir`는 비어 있는 임시 디렉터리여야 하며 호출자가 지운다.
 */
export async function buildSnapshotFromTarball(
  archiveFile: string,
  workDir: string,
  limits: SnapshotLimits,
): Promise<BuiltSnapshot> {
  const scan = await scanTarball(archiveFile, limits);
  const extractDir = path.join(workDir, "tree");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });

  const allowed = new Set([...scan.files.map((f) => f.path), ...scan.directories]);
  const dest = path.resolve(extractDir);
  await tar.x({
    file: archiveFile,
    cwd: dest,
    strict: true,
    strip: 1,
    preservePaths: false,
    umask: EXTRACT_UMASK,
    filter: (entryPath, entry) => {
      const type = "type" in entry ? entry.type : "File";
      const plan = planTarballEntry(entryPath, type);
      if (plan.action !== "FILE" && plan.action !== "DIRECTORY") return false;
      if (!allowed.has(plan.relativePath)) return false;
      const target = path.resolve(dest, ...plan.relativePath.split("/"));
      return target === dest || target.startsWith(dest + path.sep);
    },
  });

  // 디렉터리와 파일을 경로 순으로 섞어 넣는다. 상위 디렉터리가 항상 먼저 온다
  const entries = [...scan.directories, ...scan.files.map((f) => f.path)].sort(comparePath);
  const tarBytes = await packDeterministic(dest, entries);
  const digest = createHash("sha256").update(tarBytes).digest("hex");
  const bytes = new Uint8Array(gzipSync(tarBytes));
  return {
    bytes,
    digest,
    files: scan.files,
    fileCount: scan.files.length,
    totalBytes: scan.files.reduce((sum, f) => sum + f.size, 0),
    dropped: scan.dropped,
  };
}

/** 정렬된 항목을 명시적으로 넣어 tar를 만든다. 디렉터리 재귀를 끄고 순서를 직접 정한다 */
async function packDeterministic(cwd: string, entries: readonly string[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = tar.c(
    {
      cwd,
      portable: true,
      noDirRecurse: true,
      mtime: FIXED_MTIME,
      // GitHub tarball에는 없는 디렉터리를 명시적으로 넣으므로 필터는 필요 없다
    },
    [...entries],
  );
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}
