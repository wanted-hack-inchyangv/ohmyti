/**
 * Vercel Blob ArtifactStore (`@vercel/blob` 2.8.0).
 *
 * - 키를 blob pathname으로 그대로 쓴다 (`addRandomSuffix: false`).
 * - 이력서 원본이 들어가므로 기본 접근 수준은 `private`이다. 스토어 종류와 맞춰야 하므로 옵션으로 바꿀 수 있다.
 * - 읽기는 `useCache: false`로 CDN 캐시를 우회해 덮어쓴 직후에도 최신 본문을 받는다.
 */
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";
import { parseArtifactKey, parseArtifactPrefix } from "./keys";
import { ArtifactStoreConfigError } from "./errors";
import {
  assertContentType,
  DEFAULT_MAX_ARTIFACT_BYTES,
  toArtifactBytes,
  type ArtifactBody,
  type ArtifactMeta,
  type ArtifactObject,
  type ArtifactStore,
  type ArtifactStream,
  type PutArtifactOptions,
} from "./store";

export type BlobAccess = "public" | "private";

export interface BlobArtifactStoreOptions {
  /** `BLOB_READ_WRITE_TOKEN` */
  token: string;
  /** 스토어의 접근 수준. 기본 `private`. */
  access?: BlobAccess;
  maxBytes?: number;
  /** 삭제 시 한 번에 지울 blob 수. Blob API 한도 안에서 조정한다. */
  deleteBatchSize?: number;
}

export class BlobArtifactStore implements ArtifactStore {
  readonly kind = "blob" as const;
  readonly maxBytes: number;
  readonly access: BlobAccess;
  private readonly token: string;
  private readonly deleteBatchSize: number;

  constructor(options: BlobArtifactStoreOptions) {
    if (!options.token) {
      throw new ArtifactStoreConfigError(
        "BlobArtifactStore에는 token(BLOB_READ_WRITE_TOKEN)이 필요합니다",
      );
    }
    this.token = options.token;
    this.access = options.access ?? "private";
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.deleteBatchSize = options.deleteBatchSize ?? 100;
  }

  async put(key: string, body: ArtifactBody, options: PutArtifactOptions): Promise<ArtifactMeta> {
    parseArtifactKey(key);
    const contentType = assertContentType(options.contentType);
    const bytes = toArtifactBytes(key, body, this.maxBytes, options);
    await put(key, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      access: this.access,
      token: this.token,
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      maximumSizeInBytes: this.maxBytes,
    });
    return { key, size: bytes.byteLength, contentType };
  }

  async get(key: string): Promise<ArtifactObject | null> {
    const found = await this.getStream(key);
    if (found === null) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of found.stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const body = Buffer.concat(chunks);
    return {
      key,
      size: body.byteLength,
      contentType: found.contentType,
      body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    };
  }

  async getStream(key: string): Promise<ArtifactStream | null> {
    parseArtifactKey(key);
    const result = await get(key, { access: this.access, token: this.token, useCache: false });
    if (result === null || result.statusCode !== 200) return null;
    return {
      key,
      size: result.blob.size,
      contentType: result.blob.contentType,
      // DOM lib를 포함한 소비자(apps/web)에서는 전역 ReadableStream 타입이 Node의 것과 달라 명시적으로 맞춘다.
      // 이 패키지의 tsconfig(DOM 없음)에서는 단언이 불필요해 lint 규칙을 이 줄에서만 끈다.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      stream: Readable.fromWeb(result.stream as unknown as NodeReadableStream),
    };
  }

  async exists(key: string): Promise<boolean> {
    parseArtifactKey(key);
    try {
      await head(key, { token: this.token });
      return true;
    } catch (error) {
      if (error instanceof BlobNotFoundError) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    parseArtifactKey(key);
    try {
      await del(key, { token: this.token });
    } catch (error) {
      if (error instanceof BlobNotFoundError) return;
      throw error;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    parseArtifactPrefix(prefix);
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const page = await list({
        token: this.token,
        prefix,
        limit: 1000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const pathnames = page.blobs.map((blob) => blob.pathname);
      for (let i = 0; i < pathnames.length; i += this.deleteBatchSize) {
        const batch = pathnames.slice(i, i + this.deleteBatchSize);
        await del(batch, { token: this.token });
        deleted += batch.length;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor !== undefined);
    return deleted;
  }
}
