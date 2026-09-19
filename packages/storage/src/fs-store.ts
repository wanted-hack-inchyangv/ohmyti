/**
 * 로컬 파일 시스템 ArtifactStore (개발·테스트용).
 *
 * 레이아웃:
 *   <root>/objects/<key>          본문
 *   <root>/meta/<key>.json        { contentType, size }
 *
 * 쓰기는 같은 디렉터리의 임시 파일에 기록한 뒤 rename으로 교체해 부분 기록 상태를 남기지 않는다.
 */
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseArtifactKey, parseArtifactPrefix } from "./keys";
import { ArtifactStoreError } from "./errors";
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

export interface FsArtifactStoreOptions {
  root: string;
  maxBytes?: number;
}

interface StoredMeta {
  contentType: string;
  size: number;
}

export class FsArtifactStore implements ArtifactStore {
  readonly kind = "fs" as const;
  readonly maxBytes: number;
  readonly root: string;
  private readonly objectsRoot: string;
  private readonly metaRoot: string;

  constructor(options: FsArtifactStoreOptions) {
    this.root = path.resolve(options.root);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.objectsRoot = path.join(this.root, "objects");
    this.metaRoot = path.join(this.root, "meta");
  }

  async put(key: string, body: ArtifactBody, options: PutArtifactOptions): Promise<ArtifactMeta> {
    const segments = parseArtifactKey(key);
    const contentType = assertContentType(options.contentType);
    const bytes = toArtifactBytes(key, body, this.maxBytes, options);

    const objectPath = this.resolveUnder(this.objectsRoot, segments);
    const metaPath = this.resolveUnder(this.metaRoot, segments, ".json");
    await mkdir(path.dirname(objectPath), { recursive: true });
    await mkdir(path.dirname(metaPath), { recursive: true });

    const meta: StoredMeta = { contentType, size: bytes.byteLength };
    await writeAtomic(objectPath, bytes);
    await writeAtomic(metaPath, Buffer.from(JSON.stringify(meta), "utf8"));
    return { key, ...meta };
  }

  async get(key: string): Promise<ArtifactObject | null> {
    const segments = parseArtifactKey(key);
    const meta = await this.readMeta(key, segments);
    if (meta === null) return null;
    try {
      const body = await readFile(this.resolveUnder(this.objectsRoot, segments));
      return { key, ...meta, body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getStream(key: string): Promise<ArtifactStream | null> {
    const segments = parseArtifactKey(key);
    const meta = await this.readMeta(key, segments);
    if (meta === null) return null;
    const objectPath = this.resolveUnder(this.objectsRoot, segments);
    try {
      await stat(objectPath);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    return { key, ...meta, stream: createReadStream(objectPath) };
  }

  async exists(key: string): Promise<boolean> {
    const segments = parseArtifactKey(key);
    try {
      const info = await stat(this.resolveUnder(this.objectsRoot, segments));
      return info.isFile();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const segments = parseArtifactKey(key);
    await rm(this.resolveUnder(this.objectsRoot, segments), { force: true });
    await rm(this.resolveUnder(this.metaRoot, segments, ".json"), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const segments = parseArtifactPrefix(prefix);
    const objectsDir = this.resolveUnder(this.objectsRoot, segments);
    const metaDir = this.resolveUnder(this.metaRoot, segments);
    const count = await countFiles(objectsDir);
    await rm(objectsDir, { recursive: true, force: true });
    await rm(metaDir, { recursive: true, force: true });
    return count;
  }

  private async readMeta(key: string, segments: string[]): Promise<StoredMeta | null> {
    try {
      const raw = await readFile(this.resolveUnder(this.metaRoot, segments, ".json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as StoredMeta).contentType !== "string" ||
        typeof (parsed as StoredMeta).size !== "number"
      ) {
        throw new ArtifactStoreError(`아티팩트 ${key}의 메타데이터 파일이 손상됐습니다`);
      }
      const { contentType, size } = parsed as StoredMeta;
      return { contentType, size };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** 세그먼트를 base 아래 경로로 바꾸고, 결과가 base를 벗어나지 않는지 한 번 더 확인한다. */
  private resolveUnder(base: string, segments: string[], suffix = ""): string {
    const resolved = path.resolve(base, ...segments) + suffix;
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new ArtifactStoreError(`경로가 스토어 루트를 벗어납니다: ${segments.join("/")}`);
    }
    return resolved;
  }
}

async function writeAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, bytes, { flag: "wx" });
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

async function countFiles(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
