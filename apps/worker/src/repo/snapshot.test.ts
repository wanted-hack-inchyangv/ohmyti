import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSnapshotFromTarball,
  planTarballEntry,
  scanTarball,
  SnapshotArchiveError,
  SnapshotLimitExceededError,
  type SnapshotLimits,
} from "./snapshot";
import {
  makeGitHubStyleTarball,
  SHA_A,
  SMALL_REPO_FILES,
  type FakeRepoFiles,
} from "./test-support";

const LIMITS: SnapshotLimits = { maxFiles: 500, maxBytes: 20 * 1024 * 1024 };

let workRoot: string;
beforeEach(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-snapshot-test-"));
});
afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

async function writeArchive(name: string, bytes: Uint8Array): Promise<string> {
  const file = path.join(workRoot, name);
  await writeFile(file, bytes);
  return file;
}

/** 스냅샷 tar.gz의 항목 목록 (경로 → 종류) */
async function listEntries(bytes: Uint8Array): Promise<Map<string, string>> {
  const file = await writeArchive(`list-${Math.random().toString(16).slice(2)}.tar.gz`, bytes);
  const entries = new Map<string, string>();
  await tar.t({ file, onReadEntry: (e) => void entries.set(e.path, e.type) });
  return entries;
}

describe("planTarballEntry", () => {
  it("최상위 디렉터리를 벗기고 .git·링크·특수 항목을 제외 표시한다", () => {
    expect(planTarballEntry("owner-repo-abc/", "Directory")).toEqual({
      relativePath: "",
      action: "DROP_TOP",
    });
    expect(planTarballEntry("owner-repo-abc/src/a.ts", "File")).toEqual({
      relativePath: "src/a.ts",
      action: "FILE",
    });
    expect(planTarballEntry("owner-repo-abc/src/", "Directory")).toEqual({
      relativePath: "src",
      action: "DIRECTORY",
    });
    expect(planTarballEntry("owner-repo-abc/.git/HEAD", "File").action).toBe("DROP_GIT");
    expect(planTarballEntry("owner-repo-abc/sub/.git/config", "File").action).toBe("DROP_GIT");
    expect(planTarballEntry("owner-repo-abc/.gitignore", "File").action).toBe("FILE");
    expect(planTarballEntry("owner-repo-abc/link", "SymbolicLink").action).toBe("DROP_LINK");
    expect(planTarballEntry("owner-repo-abc/hard", "Link").action).toBe("DROP_LINK");
    expect(planTarballEntry("owner-repo-abc/dev", "CharacterDevice").action).toBe(
      "DROP_UNSUPPORTED",
    );
  });

  it("위험한 경로는 아카이브 오류다", () => {
    expect(() => planTarballEntry("/etc/passwd", "File")).toThrow(SnapshotArchiveError);
    expect(() => planTarballEntry("top/../../x", "File")).toThrow(SnapshotArchiveError);
    expect(() => planTarballEntry("top\\x", "File")).toThrow(SnapshotArchiveError);
    expect(() => planTarballEntry("C:/x", "File")).toThrow(SnapshotArchiveError);
  });
});

describe("buildSnapshotFromTarball", () => {
  it("파일 목록·크기를 기록하고 .git과 심볼릭 링크를 뺀다", async () => {
    const bytes = await makeGitHubStyleTarball(SMALL_REPO_FILES, SHA_A, {
      withGitDir: true,
      symlinks: { "link-to-readme": "README.md", "src/link-dir": "routes" },
    });
    const archive = await writeArchive("a.tar.gz", bytes);
    const built = await buildSnapshotFromTarball(archive, workRoot, LIMITS);

    expect(built.files.map((f) => f.path)).toEqual([
      "README.md",
      "package.json",
      "src/routes/orders.ts",
      "src/server.ts",
    ]);
    expect(built.files.find((f) => f.path === "README.md")?.size).toBe(
      Buffer.byteLength(SMALL_REPO_FILES["README.md"] as string),
    );
    expect(built.fileCount).toBe(4);
    expect(built.totalBytes).toBe(built.files.reduce((s, f) => s + f.size, 0));
    expect(built.dropped.gitEntries).toBeGreaterThan(0);
    expect(built.dropped.links).toBe(2);

    const entries = await listEntries(built.bytes);
    const paths = [...entries.keys()];
    expect(paths.some((p) => p.split("/").includes(".git"))).toBe(false);
    expect([...entries.values()]).not.toContain("SymbolicLink");
    expect(paths.some((p) => p.startsWith("owner-repo-"))).toBe(false);
    expect(entries.get("README.md")).toBe("File");
    expect(entries.get("src/")).toBe("Directory");
  });

  it("같은 내용이면 최상위 디렉터리 이름·mtime이 달라도 digest와 바이트가 같다", async () => {
    const first = await makeGitHubStyleTarball(SMALL_REPO_FILES, SHA_A, {
      topDir: "owner-repo-aaaaaaa",
      mtime: new Date("2024-01-01T00:00:00Z"),
    });
    const second = await makeGitHubStyleTarball(SMALL_REPO_FILES, SHA_A, {
      topDir: "someone-else-1234567",
      mtime: new Date("2026-06-01T12:34:56Z"),
    });
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);

    const a = await buildSnapshotFromTarball(
      await writeArchive("first.tar.gz", first),
      path.join(workRoot, "w1"),
      LIMITS,
    );
    const b = await buildSnapshotFromTarball(
      await writeArchive("second.tar.gz", second),
      path.join(workRoot, "w2"),
      LIMITS,
    );
    expect(a.digest).toBe(b.digest);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("내용이 1바이트라도 다르면 digest가 다르다", async () => {
    const changed: FakeRepoFiles = {
      ...SMALL_REPO_FILES,
      "src/server.ts": "export const x = 2;\n",
    };
    const a = await buildSnapshotFromTarball(
      await writeArchive("a.tar.gz", await makeGitHubStyleTarball(SMALL_REPO_FILES, SHA_A)),
      path.join(workRoot, "w1"),
      LIMITS,
    );
    const b = await buildSnapshotFromTarball(
      await writeArchive("b.tar.gz", await makeGitHubStyleTarball(changed, SHA_A)),
      path.join(workRoot, "w2"),
      LIMITS,
    );
    expect(a.digest).not.toBe(b.digest);
  });

  it("파일 501개는 TOO_MANY_FILES다", async () => {
    const files: FakeRepoFiles = {};
    for (let i = 0; i < 501; i += 1) files[`f/${String(i).padStart(4, "0")}.txt`] = `${i}\n`;
    const archive = await writeArchive("many.tar.gz", await makeGitHubStyleTarball(files, SHA_A));
    await expect(scanTarball(archive, LIMITS)).rejects.toMatchObject({
      name: "SnapshotLimitExceededError",
      kind: "TOO_MANY_FILES",
    });
    // 500개는 통과한다
    delete files["f/0500.txt"];
    const ok = await writeArchive("ok.tar.gz", await makeGitHubStyleTarball(files, SHA_A));
    await expect(scanTarball(ok, LIMITS).then((r) => r.files.length)).resolves.toBe(500);
  });

  it("20MB를 넘는 소스는 TOO_LARGE이고 아무것도 풀지 않는다", async () => {
    const files: FakeRepoFiles = {
      "big.bin": Buffer.alloc(20 * 1024 * 1024 + 1, 0x41),
      "small.txt": "x",
    };
    const archive = await writeArchive("big.tar.gz", await makeGitHubStyleTarball(files, SHA_A));
    const work = path.join(workRoot, "w");
    await expect(buildSnapshotFromTarball(archive, work, LIMITS)).rejects.toBeInstanceOf(
      SnapshotLimitExceededError,
    );
    await expect(readFile(path.join(work, "tree", "small.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30_000);

  it("손상된 아카이브는 SnapshotArchiveError다", async () => {
    const archive = await writeArchive("corrupt.tar.gz", new Uint8Array([1, 2, 3, 4, 5]));
    await expect(scanTarball(archive, LIMITS)).rejects.toBeInstanceOf(SnapshotArchiveError);
  });
});

describe("러너 호환", () => {
  it("만든 스냅샷은 LocalProcessRunner의 unpackSnapshot이 stripComponents 0으로 그대로 푼다", async () => {
    const { unpackSnapshot } = await import("@ohmyti/runner");
    const bytes = await makeGitHubStyleTarball(SMALL_REPO_FILES, SHA_A, {
      withGitDir: true,
      symlinks: { link: "README.md" },
    });
    const built = await buildSnapshotFromTarball(
      await writeArchive("src.tar.gz", bytes),
      path.join(workRoot, "w"),
      LIMITS,
    );
    const snapshotFile = await writeArchive("snapshot.tar.gz", built.bytes);
    const dest = path.join(workRoot, "unpacked");
    const result = await unpackSnapshot(snapshotFile, dest, {
      maxFiles: LIMITS.maxFiles,
      maxBytes: LIMITS.maxBytes,
      stripComponents: 0,
    });
    expect(result.files).toEqual(built.files.map((f) => f.path));
    expect(result.droppedNodeModules).toBe(false);
    await expect(readFile(path.join(dest, "src", "server.ts"), "utf8")).resolves.toBe(
      SMALL_REPO_FILES["src/server.ts"],
    );
  });
});
