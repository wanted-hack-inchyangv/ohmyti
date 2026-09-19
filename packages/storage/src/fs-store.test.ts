import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeArtifactStoreContract } from "./contract-suite";
import { FsArtifactStore } from "./fs-store";

const roots: string[] = [];

describeArtifactStoreContract("FsArtifactStore", {
  create: async ({ maxBytes }) => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmyti-storage-"));
    roots.push(root);
    return new FsArtifactStore({ root, maxBytes });
  },
  destroy: async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  },
});

describe("FsArtifactStore 레이아웃", () => {
  it("본문은 objects/, 메타데이터는 meta/ 아래 키 경로에 저장한다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmyti-storage-"));
    try {
      const store = new FsArtifactStore({ root });
      await store.put("submissions/s1/snapshot.tar.gz", "abc", { contentType: "application/gzip" });
      expect(await readdir(path.join(root, "objects", "submissions", "s1"))).toEqual([
        "snapshot.tar.gz",
      ]);
      expect(await readdir(path.join(root, "meta", "submissions", "s1"))).toEqual([
        "snapshot.tar.gz.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("메타데이터가 없는 본문 파일은 get이 null을 돌려준다 (부분 기록 방지)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmyti-storage-"));
    try {
      const store = new FsArtifactStore({ root });
      const dir = path.join(root, "objects", "submissions", "s2");
      await rm(dir, { recursive: true, force: true });
      await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "resume.pdf"), "orphan");
      expect(await store.get("submissions/s2/resume.pdf")).toBeNull();
      // exists는 본문 파일 기준이므로 true다. 호출자는 get의 null을 기준으로 판단한다.
      expect(await store.exists("submissions/s2/resume.pdf")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
