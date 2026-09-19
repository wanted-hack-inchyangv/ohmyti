/**
 * 디렉터리를 tar.gz 스냅샷으로 만든다. 로컬 디렉터리(샘플 구현, 픽스처)를 `prepare()`가 받는 형식으로
 * 바꿀 때 쓴다. GitHub tarball(T-202)은 이미 같은 형식이므로 이 함수를 거치지 않는다.
 * 기본으로 `node_modules`를 뺀다(제출물의 node_modules는 어떤 형태로든 쓰지 않는다).
 */
import * as tar from "tar";

export interface PackDirectoryOptions {
  /** 아카이브에 넣을 항목 (cwd 기준). 기본 `["."]` */
  entries?: readonly string[];
  /** 아카이브에서 뺄 경로 조각 (`/` 구분). 기본 `["node_modules"]` */
  exclude?: readonly string[];
  /** 아카이브 안에서 파일 앞에 붙일 디렉터리 (GitHub tarball의 `owner-repo-sha/` 흉내) */
  prefix?: string;
  /** `..`·절대 경로를 그대로 보존 (거부 테스트용) */
  preservePaths?: boolean;
}

export const PACK_DEFAULT_EXCLUDE = ["node_modules"] as const;

/** `cwd` 아래 항목을 gzip tar 바이트로 만든다. `portable: true`라 소유자·mtime이 결과에 들어가지 않는다 */
export async function packDirectoryToTarGz(
  cwd: string,
  options: PackDirectoryOptions = {},
): Promise<Uint8Array> {
  const exclude = options.exclude ?? PACK_DEFAULT_EXCLUDE;
  const entries = options.entries ?? ["."];
  const chunks: Buffer[] = [];
  const stream = tar.c(
    {
      cwd,
      gzip: true,
      portable: true,
      ...(options.preservePaths ? { preservePaths: true } : {}),
      ...(options.prefix ? { prefix: options.prefix } : {}),
      filter: (entryPath) => {
        const normalized = entryPath.replace(/^\.\//, "").replace(/^\//, "");
        return !exclude.some(
          (ex) =>
            normalized === ex || normalized.startsWith(`${ex}/`) || normalized.includes(`/${ex}/`),
        );
      },
    },
    [...entries],
  );
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}
