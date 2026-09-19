import { BlobArtifactStore, type BlobAccess } from "./blob-store";
import { ArtifactStoreConfigError } from "./errors";
import { FsArtifactStore } from "./fs-store";
import type { ArtifactStore } from "./store";

/** `createArtifactStore`가 읽는 환경변수 (TICKET.md 1.6) */
export interface ArtifactStoreEnv {
  /** `process.env`를 그대로 넘길 수 있게 한다 (Next.js는 ProcessEnv에 필수 NODE_ENV를 더한다) */
  [key: string]: string | undefined;
  ARTIFACT_STORE?: string | undefined;
  ARTIFACT_FS_ROOT?: string | undefined;
  BLOB_READ_WRITE_TOKEN?: string | undefined;
  BLOB_ACCESS?: string | undefined;
  ARTIFACT_MAX_BYTES?: string | undefined;
}

export const DEFAULT_FS_ROOT = "./.artifacts";

/**
 * 환경변수로 구현을 고른다.
 * - `ARTIFACT_STORE=fs`(기본): `ARTIFACT_FS_ROOT`(기본 `./.artifacts`)
 * - `ARTIFACT_STORE=blob`: `BLOB_READ_WRITE_TOKEN` 필수, `BLOB_ACCESS`(기본 `private`)
 * - `ARTIFACT_MAX_BYTES`: 선택. 객체 크기 상한(바이트)
 */
export function createArtifactStore(env: ArtifactStoreEnv = process.env): ArtifactStore {
  const kind = (env.ARTIFACT_STORE ?? "fs").trim().toLowerCase();
  const maxBytes = parseMaxBytes(env.ARTIFACT_MAX_BYTES);

  if (kind === "fs") {
    const root = env.ARTIFACT_FS_ROOT?.trim() || DEFAULT_FS_ROOT;
    return new FsArtifactStore({ root, ...(maxBytes === undefined ? {} : { maxBytes }) });
  }
  if (kind === "blob") {
    const token = env.BLOB_READ_WRITE_TOKEN?.trim();
    if (!token) {
      throw new ArtifactStoreConfigError(
        "ARTIFACT_STORE=blob에는 BLOB_READ_WRITE_TOKEN이 필요합니다",
      );
    }
    return new BlobArtifactStore({
      token,
      access: parseAccess(env.BLOB_ACCESS),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
  }
  throw new ArtifactStoreConfigError(
    `ARTIFACT_STORE 값 ${JSON.stringify(env.ARTIFACT_STORE)}은 지원하지 않습니다 (fs | blob)`,
  );
}

function parseAccess(value: string | undefined): BlobAccess {
  const access = (value ?? "private").trim().toLowerCase();
  if (access === "public" || access === "private") return access;
  throw new ArtifactStoreConfigError(
    `BLOB_ACCESS 값 ${JSON.stringify(value)}은 지원하지 않습니다 (public | private)`,
  );
}

function parseMaxBytes(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ArtifactStoreConfigError(
      `ARTIFACT_MAX_BYTES 값 ${JSON.stringify(value)}은 양의 정수여야 합니다`,
    );
  }
  return parsed;
}
