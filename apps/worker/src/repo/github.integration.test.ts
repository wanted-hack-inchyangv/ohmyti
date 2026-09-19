/**
 * 실제 GitHub API 통합 테스트. `GITHUB_INTEGRATION=1`일 때만 돈다 (T-202 인수 기준).
 * 공개 저장소 `octocat/Hello-World`(파일 1개)를 쓴다. `GITHUB_TOKEN`이 있으면 속도 제한이 완화된다.
 */
import { FsArtifactStore, artifactKeys } from "@ohmyti/storage";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectRepository, REPO_COLLECT_DEFAULTS } from "./collect";
import { createGitHubClient } from "./github";

const enabled = process.env.GITHUB_INTEGRATION === "1";
if (!enabled) {
  console.warn(
    "[@ohmyti/worker] GITHUB_INTEGRATION=1이 아니어서 실제 GitHub 통합 테스트를 건너뜁니다",
  );
}

describe.skipIf(!enabled)("GitHub 실제 호출 (통합)", () => {
  let root: string;
  let store: FsArtifactStore;
  const github = createGitHubClient({ token: process.env.GITHUB_TOKEN });

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "ohmyti-github-int-"));
    store = new FsArtifactStore({ root: path.join(root, "artifacts") });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("공개 저장소의 브랜치를 SHA로 고정하고 같은 SHA를 두 번 수집하면 digest가 같다", async () => {
    const deps = {
      github,
      store,
      limits: REPO_COLLECT_DEFAULTS,
      workRoot: path.join(root, "work"),
    };
    const first = await collectRepository(
      { submissionId: "int-1", repoUrl: "https://github.com/octocat/Hello-World/tree/master" },
      deps,
    );
    expect(first.outcome).toBe("PINNED");
    if (first.outcome !== "PINNED") return;
    expect(first.submissionSha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.manifest.files.map((f) => f.path)).toContain("README");

    const second = await collectRepository(
      {
        submissionId: "int-2",
        repoUrl: "https://github.com/octocat/Hello-World",
        repoRef: first.submissionSha,
      },
      deps,
    );
    expect(second).toMatchObject({ outcome: "PINNED", submissionSha: first.submissionSha });
    if (second.outcome !== "PINNED") return;
    expect(second.manifest.snapshotDigest).toBe(first.manifest.snapshotDigest);
    expect(await store.exists(artifactKeys.snapshot("int-1"))).toBe(true);
  }, 60_000);

  it("미존재 저장소는 REPO_NOT_ACCESSIBLE이다", async () => {
    const result = await collectRepository(
      {
        submissionId: "int-3",
        repoUrl: "https://github.com/octocat/this-repository-does-not-exist-ohmyti",
      },
      { github, store, limits: REPO_COLLECT_DEFAULTS, workRoot: path.join(root, "work") },
    );
    expect(result).toMatchObject({ outcome: "UNSUPPORTED", reason: "REPO_NOT_ACCESSIBLE" });
  }, 30_000);
});
