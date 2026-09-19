/** 테스트용: 디렉터리나 파일 목록을 tar.gz 스냅샷으로 만들어 FsArtifactStore에 넣는다. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsArtifactStore } from "@ohmyti/storage";
import { packDirectoryToTarGz, type PackDirectoryOptions } from "../local/pack";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const templateRoot = path.join(repoRoot, "templates");
export const sampleDir = (impl: "a" | "b" | "c" | "d"): string =>
  path.join(repoRoot, "samples", "order-api", `impl-${impl}`);

export interface TestWorkspace {
  root: string;
  store: FsArtifactStore;
  cleanup(): Promise<void>;
}

export async function createTestWorkspace(): Promise<TestWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmyti-runner-test-"));
  const store = new FsArtifactStore({ root: path.join(root, "artifacts") });
  return {
    root,
    store,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** 파일 맵(`상대경로 → 내용`)을 디렉터리에 쓴다 */
export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
}

export type PackOptions = Omit<PackDirectoryOptions, "entries">;

/** `cwd`의 내용을 tar.gz로 만들어 `key`에 저장한다 */
export async function packToStore(
  store: FsArtifactStore,
  key: string,
  cwd: string,
  entries: readonly string[] = ["."],
  options: PackOptions = {},
): Promise<Uint8Array> {
  const bytes = await packToBuffer(cwd, entries, options);
  await store.put(key, bytes, { contentType: "application/gzip" });
  return bytes;
}

export async function packToBuffer(
  cwd: string,
  entries: readonly string[] = ["."],
  options: PackOptions = {},
): Promise<Uint8Array> {
  return packDirectoryToTarGz(cwd, { ...options, entries });
}
