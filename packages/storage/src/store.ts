import type { Readable } from "node:stream";
import { ArtifactTooLargeError, InvalidContentTypeError } from "./errors";

/** 객체 크기 기본 상한: 64 MiB. 스냅샷 tar.gz(원본 상한 20 MiB)와 실행 기록 본문을 넉넉히 담는다. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface ArtifactMeta {
  key: string;
  /** 바이트 수 */
  size: number;
  contentType: string;
}

export interface ArtifactObject extends ArtifactMeta {
  body: Uint8Array;
}

export interface ArtifactStream extends ArtifactMeta {
  stream: Readable;
}

export interface PutArtifactOptions {
  /** `type/subtype` 형식. 필수다. */
  contentType: string;
  /** 이 호출에만 적용하는 상한. 스토어 상한보다 클 수 없다. */
  maxBytes?: number;
}

export type ArtifactBody = Uint8Array | string;

/**
 * 코드 스냅샷, 이력서 원본, 실행 기록 본문을 저장하는 추상화.
 * 구현: `FsArtifactStore`(개발·테스트), `BlobArtifactStore`(Vercel Blob).
 *
 * - 모든 메서드는 키를 `parseArtifactKey`로 검증한다.
 * - `put`은 같은 키를 덮어쓴다. 불변성이 필요한 레코드(G-03)는 호출자가 새 키를 쓴다.
 * - `get`·`getStream`은 없는 키에 `null`을 돌려준다. `delete`는 없는 키에도 성공한다.
 */
export interface ArtifactStore {
  readonly kind: "fs" | "blob";
  readonly maxBytes: number;
  put(key: string, body: ArtifactBody, options: PutArtifactOptions): Promise<ArtifactMeta>;
  get(key: string): Promise<ArtifactObject | null>;
  getStream(key: string): Promise<ArtifactStream | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** 접두사(`.../`) 아래의 모든 객체를 지우고 지운 개수를 돌려준다. */
  deletePrefix(prefix: string): Promise<number>;
}

const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;.*)?$/;

export function assertContentType(contentType: string): string {
  if (typeof contentType !== "string" || !CONTENT_TYPE.test(contentType)) {
    throw new InvalidContentTypeError(contentType);
  }
  return contentType;
}

/** 본문을 바이트로 정규화하고 크기 상한을 검사한다. */
export function toArtifactBytes(
  key: string,
  body: ArtifactBody,
  maxBytes: number,
  options: PutArtifactOptions,
): Uint8Array {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const limit = Math.min(maxBytes, options.maxBytes ?? maxBytes);
  if (bytes.byteLength > limit) {
    throw new ArtifactTooLargeError(key, bytes.byteLength, limit);
  }
  return bytes;
}
