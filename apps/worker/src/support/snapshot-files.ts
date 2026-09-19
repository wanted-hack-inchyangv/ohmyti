/**
 * 스냅샷(tar.gz 아티팩트)을 풀지 않고 `SubmissionFiles`로 읽는다 (T-203).
 * 지원 여부 판정은 `package.json`과 파일 목록만 보므로 러너 환경을 만들 필요가 없다.
 * 스냅샷은 T-202가 만든 정규화 아카이브(최상위 디렉터리 없음, 링크·`..` 없음)이며 크기는 `MAX_SOURCE_BYTES` 이내다.
 */
import { type ArtifactStore } from "@ohmyti/storage";
import { type SubmissionFiles } from "@ohmyti/runner";
import * as tar from "tar";

const IGNORED_SEGMENTS = new Set(["node_modules", ".git"]);

export class SnapshotReadError extends Error {
  override readonly name = "SnapshotReadError";
  constructor(readonly detail: string) {
    super(`스냅샷을 읽을 수 없습니다: ${detail}`);
  }
}

/** 아카이브의 파일 항목을 모두 메모리에 올린다. `node_modules`·`.git` 아래는 버린다 */
export async function readSnapshotEntries(bytes: Uint8Array): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    const parser = new tar.Parser({
      strict: true,
      onReadEntry: (entry) => {
        const relative = normalizeEntryPath(entry.path);
        if (entry.type !== "File" || relative === null) {
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () => files.set(relative, Buffer.concat(chunks)));
      },
    });
    parser.on("error", (error: unknown) =>
      reject(new SnapshotReadError(error instanceof Error ? error.message : String(error))),
    );
    parser.on("end", () => resolve());
    parser.end(Buffer.from(bytes));
  });
  return files;
}

/** `./a/b` → `a/b`. 무시 대상 디렉터리 아래거나 비정상 경로면 null */
function normalizeEntryPath(entryPath: string): string | null {
  const segments = entryPath
    .replace(/^(\.\/)+/, "")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return null;
  if (segments.some((s) => s === ".." || IGNORED_SEGMENTS.has(s))) return null;
  return segments.join("/");
}

/** 메모리에 올린 항목을 `SubmissionFiles`로 감싼다 */
export function snapshotFilesFromEntries(entries: ReadonlyMap<string, Buffer>): SubmissionFiles {
  const paths = [...entries.keys()].sort();
  return {
    listFiles: () => Promise.resolve([...paths]),
    readText: (relativePath) => {
      const body = entries.get(relativePath);
      return Promise.resolve(body === undefined ? null : body.toString("utf8"));
    },
  };
}

export async function snapshotFilesFromBytes(bytes: Uint8Array): Promise<SubmissionFiles> {
  return snapshotFilesFromEntries(await readSnapshotEntries(bytes));
}

/** 스토어에서 스냅샷을 읽어 `SubmissionFiles`로 만든다. 없으면 `SnapshotReadError` */
export async function loadSnapshotFiles(
  store: ArtifactStore,
  snapshotRef: string,
): Promise<SubmissionFiles> {
  const object = await store.get(snapshotRef);
  if (!object) throw new SnapshotReadError(`스토어에 ${snapshotRef}가 없습니다`);
  return snapshotFilesFromBytes(object.body);
}
