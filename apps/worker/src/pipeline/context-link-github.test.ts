/**
 * T-603 CONTEXT_LINK의 GitHub 근거 선정: 워커가 제출 저장소를 근거 후보에서 빼는지 확인한다 (context-link).
 *
 * 페르소나 제출은 이름을 바꾸기 전의 URL(`order-api-seojin`)로 들어왔고, 조직 저장소 목록에는 새 이름(`seojin-order-api`)만 있다.
 * 수집 단계가 manifest에 남긴 정식 이름으로 비교해야 제외된다.
 */
import { GitHubSourcesSchema } from "@ohmyti/core";
import { sampleRubric } from "@ohmyti/core/fixtures";
import { collectGitHubSources, type GitHubSourcesCollector } from "@ohmyti/context";
import {
  fakeGitHubProfileApi,
  PERSONA_EXPECTED,
  PERSONA_ORG_LOGIN,
  PERSONA_RESUME_TEXTS,
  personaOrgProfile,
} from "@ohmyti/context/testing";
import {
  createTestDatabase,
  getSubmissionContext,
  seedEvaluation,
  setResumeText,
  upsertSubmissionContext,
  type TestDatabase,
} from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../logger";
import type { SnapshotManifest } from "../repo";
import { runContextLinkPipelineStage, submissionRepoNames } from "./context-link";

const NOW = new Date("2026-09-19T00:00:00.000Z");
const OLD_URL = `https://github.com/${PERSONA_EXPECTED.seojin.submittedAs}`;
const CANONICAL = PERSONA_EXPECTED.seojin.submissionRepo;
/** 주소를 지운 이력서. 키워드 겹침만으로는 제출물이 다시 선택되는 조건이다 */
const RESUME = PERSONA_RESUME_TEXTS.seojin.replace(/github\.com\/\S+/g, "");

function manifest(fullName?: string): SnapshotManifest {
  const [owner, name] = PERSONA_EXPECTED.seojin.submittedAs.split("/") as [string, string];
  return {
    version: 1,
    repo: { owner, name, ...(fullName ? { fullName } : {}) },
    submissionSha: "28fec210919624306ccc3da0ca0bfd3fab8af1d5",
    requestedRef: "main",
    snapshotDigest: "b".repeat(64),
    fileCount: 1,
    totalBytes: 1,
    files: [{ path: "package.json", size: 1 }],
    dropped: { gitEntries: 0, links: 0, unsupported: 0 },
    collectedAt: NOW.toISOString(),
  };
}

let workRoot: string;
let store: FsArtifactStore;

beforeAll(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-context-github-"));
  store = new FsArtifactStore({ root: workRoot });
});

afterAll(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe("submissionRepoNames (context-link)", () => {
  it("제출 URL의 이름과 manifest의 정식 이름을 함께 돌려준다", async () => {
    await store.put(artifactKeys.snapshotManifest("renamed"), JSON.stringify(manifest(CANONICAL)), {
      contentType: ARTIFACT_CONTENT_TYPES.snapshotManifest,
    });
    expect(await submissionRepoNames(store, "renamed", OLD_URL)).toEqual([
      PERSONA_EXPECTED.seojin.submittedAs,
      CANONICAL,
    ]);
  });

  it("manifest가 없거나 정식 이름이 없으면 제출 URL의 이름만, 대소문자만 다른 중복은 하나로", async () => {
    expect(await submissionRepoNames(store, "no-manifest", OLD_URL)).toEqual([
      PERSONA_EXPECTED.seojin.submittedAs,
    ]);
    await store.put(artifactKeys.snapshotManifest("old"), JSON.stringify(manifest()), {
      contentType: ARTIFACT_CONTENT_TYPES.snapshotManifest,
    });
    expect(
      await submissionRepoNames(
        store,
        "old",
        OLD_URL.replace("order-api-seojin", "Order-API-Seojin"),
      ),
    ).toHaveLength(1);
    expect(await submissionRepoNames(store, "no-manifest", "not a url")).toEqual([]);
    expect(await submissionRepoNames(store, "no-manifest", undefined)).toEqual([]);
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

describe.skipIf(!hasTestDb)(
  "CONTEXT_LINK GitHub 근거에서 제출 저장소 제외 (context-link, DB 통합)",
  () => {
    let tdb: TestDatabase;
    const logger = createLogger({ level: "silent" });

    beforeAll(async () => {
      tdb = await createTestDatabase();
    });

    afterAll(async () => {
      await tdb?.destroy();
    });

    async function run(withCanonical: boolean) {
      const seeded = await seedEvaluation(tdb.db);
      await upsertSubmissionContext(tdb.db, seeded.submissionId, {
        githubLogin: PERSONA_ORG_LOGIN,
      });
      await setResumeText(tdb.db, seeded.submissionId, {
        text: RESUME,
        status: "EXTRACTED",
        reason: null,
      });
      await store.put(
        artifactKeys.snapshotManifest(seeded.submissionId),
        JSON.stringify(manifest(withCanonical ? CANONICAL : undefined)),
        { contentType: ARTIFACT_CONTENT_TYPES.snapshotManifest },
      );
      const api = fakeGitHubProfileApi([personaOrgProfile()]);
      const collect: GitHubSourcesCollector = (input) =>
        collectGitHubSources(input, { fetch: api.fetch, now: () => NOW });
      const outcome = await runContextLinkPipelineStage(
        {
          submissionId: seeded.submissionId,
          evaluationId: seeded.evaluationId,
          rubric: sampleRubric(),
          repoUrl: OLD_URL,
        },
        { db: tdb.db, store, logger, now: () => NOW, githubSources: collect },
      );
      const context = await getSubmissionContext(tdb.db, seeded.submissionId);
      return { outcome, sources: GitHubSourcesSchema.parse(context!.githubSources) };
    }

    it("옛 이름 URL로 제출해도 manifest의 정식 이름으로 제출 저장소를 뺀다", async () => {
      const { outcome, sources } = await run(true);
      expect(outcome.state).toBe("DONE");
      expect(outcome.detail.github?.repos).not.toContain(CANONICAL);
      expect(sources.repos.map((r) => r.fullName)).not.toContain(CANONICAL);
      expect(sources.excludedRepos).toEqual([CANONICAL]);
      expect(sources.candidateCount).toBe(13);
    });

    it("정식 이름이 없는 이전 manifest면 옛 이름만으로는 뺄 수 없다 (T-202가 정식 이름을 남겨야 하는 이유)", async () => {
      const { sources } = await run(false);
      expect(sources.excludedRepos).toEqual([]);
      expect(sources.repos.map((r) => r.fullName)).toContain(CANONICAL);
    });
  },
);
