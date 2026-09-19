import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SnapshotRejectedError } from "../runner";
import { packToBuffer, writeFiles } from "../test-support/snapshots";
import { inspectSnapshot, planEntryPath, unpackSnapshot } from "./unpack";

const limits = { maxFiles: 100, maxBytes: 1024 * 1024 };
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ohmyti-unpack-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function archive(name: string, files: Record<string, string>, opts = {}): Promise<string> {
  const dir = path.join(root, name);
  await writeFiles(dir, files);
  const file = path.join(root, `${name}.tar.gz`);
  await writeFile(file, await packToBuffer(dir, ["."], { exclude: [], ...opts }));
  return file;
}

describe("planEntryPath", () => {
  it("정상 경로는 그대로 두고 `./` 접두사를 정리한다", () => {
    expect(planEntryPath("./src/a.ts", "File", 0)).toEqual({
      relativePath: "src/a.ts",
      skip: false,
    });
    expect(planEntryPath("src/", "Directory", 0)).toEqual({ relativePath: "src", skip: false });
  });

  it.each([
    ["../evil", "File", "PATH_TRAVERSAL"],
    ["a/../../evil", "File", "PATH_TRAVERSAL"],
    ["a\\b", "File", "PATH_TRAVERSAL"],
    ["/etc/passwd", "File", "ABSOLUTE_PATH"],
    ["C:/x", "File", "ABSOLUTE_PATH"],
    ["link", "SymbolicLink", "SYMLINK"],
    ["hard", "Link", "SYMLINK"],
    ["dev", "CharacterDevice", "UNSUPPORTED_ENTRY"],
    ["fifo", "FIFO", "UNSUPPORTED_ENTRY"],
  ])("%s (%s) → %s", (entryPath, type, code) => {
    try {
      planEntryPath(entryPath, type, 0);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotRejectedError);
      expect((error as SnapshotRejectedError).code).toBe(code);
    }
  });

  it("node_modules 아래는 건너뛰고 strip으로 비는 경로도 건너뛴다", () => {
    expect(planEntryPath("node_modules/x/index.js", "File", 0).skip).toBe(true);
    expect(planEntryPath("pkg/node_modules/x", "File", 0).skip).toBe(true);
    expect(planEntryPath("owner-repo-sha/", "Directory", 1).skip).toBe(true);
    expect(planEntryPath("owner-repo-sha/src/a.ts", "File", 1)).toEqual({
      relativePath: "src/a.ts",
      skip: false,
    });
  });
});

describe("unpackSnapshot", () => {
  it("파일을 풀고 개수·바이트를 센다", async () => {
    const file = await archive("plain", { "package.json": "{}", "src/a.ts": "abc" });
    const dest = path.join(root, "plain-out");
    const result = await unpackSnapshot(file, dest, limits);
    expect(result.files).toEqual(["package.json", "src/a.ts"]);
    expect(result.fileCount).toBe(2);
    expect(result.totalBytes).toBe(5);
    expect(result.droppedNodeModules).toBe(false);
    expect((await readdir(dest)).sort()).toEqual(["package.json", "src"]);
  });

  it("node_modules는 풀지 않고 droppedNodeModules를 표시한다", async () => {
    const file = await archive("nm", {
      "package.json": "{}",
      "node_modules/x/index.js": "x",
      "sub/node_modules/y.js": "y",
    });
    const dest = path.join(root, "nm-out");
    const result = await unpackSnapshot(file, dest, limits);
    expect(result.files).toEqual(["package.json"]);
    expect(result.droppedNodeModules).toBe(true);
    // 디렉터리 `sub`는 남지만 그 아래 node_modules는 없다
    expect((await readdir(dest)).sort()).toEqual(["package.json", "sub"]);
    expect(await readdir(path.join(dest, "sub"))).toEqual([]);
    await expect(readdir(path.join(dest, "node_modules"))).rejects.toThrow();
  });

  it("심볼릭 링크가 있으면 거부하고 아무것도 풀지 않는다", async () => {
    const dir = path.join(root, "sym");
    await writeFiles(dir, { "a.txt": "a", "b.txt": "b" });
    await symlink("a.txt", path.join(dir, "link.txt"));
    const file = path.join(root, "sym.tar.gz");
    await writeFile(file, await packToBuffer(dir, ["."], { exclude: [] }));
    const dest = path.join(root, "sym-out");
    await expect(unpackSnapshot(file, dest, limits)).rejects.toMatchObject({ code: "SYMLINK" });
    await expect(readdir(dest)).rejects.toThrow();
  });

  it("크기 상한을 넘으면 TOO_LARGE다", async () => {
    const file = await archive("big", { "a.txt": "x".repeat(2000) });
    await expect(inspectSnapshot(file, { ...limits, maxBytes: 1000 })).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
  });

  it("gzip이 아닌 내용은 CORRUPT_ARCHIVE다", async () => {
    const file = path.join(root, "corrupt.tar.gz");
    await writeFile(file, "definitely not a tarball");
    await expect(inspectSnapshot(file, limits)).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE" });
  });
});
