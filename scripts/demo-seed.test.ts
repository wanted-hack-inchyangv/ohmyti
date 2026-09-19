import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractResumeText } from "@ohmyti/context";
import {
  createTestDatabase,
  findSubmissionJob,
  getSubmission,
  getSubmissionContext,
  seedEvaluation,
  type TestDatabase,
} from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDemoSeedSubmission,
  DEMO_RESUME_FILE,
  demoResumePdf,
  hasStoredDemoSnapshot,
  inspectDemoEvaluation,
  readDemoSampleSources,
  saveDemoSnapshot,
  wrapLine,
} from "./demo-seed";

describe("예시 이력서", () => {
  it("긴 줄을 단어 단위로 나누고, 만든 PDF에서 이력서 문장이 그대로 추출된다", async () => {
    expect(wrapLine("short")).toEqual(["short"]);
    const wrapped = wrapLine("a ".repeat(60).trim(), 20);
    expect(wrapped.every((line) => line.length <= 20)).toBe(true);
    expect(wrapped.join(" ").replace(/\s+/g, " ")).toBe("a ".repeat(60).trim());

    const text = await readFile(DEMO_RESUME_FILE, "utf8");
    expect(text).toContain("fictional person");
    // PDF 빌더는 Latin-1만 쓴다. 한글 등 범위 밖 문자가 있으면 추출 결과가 원문과 달라진다
    expect(/^[\x20-\xff\n]*$/.test(text)).toBe(true);
    const extracted = await extractResumeText(demoResumePdf(text));
    expect(extracted.status).toBe("EXTRACTED");
    if (extracted.status !== "EXTRACTED") return;
    expect(extracted.text.replace(/\s+/g, " ")).toContain(
      "Designed an idempotent order API using the Idempotency-Key header",
    );
  });
});

describe("샘플 저장소", () => {
  it("A/B/C/D의 공개 저장소와 고정 커밋을 읽는다", async () => {
    const sources = await readDemoSampleSources();
    expect(sources.map((s) => s.id)).toEqual(["A", "B", "C", "D"]);
    for (const source of sources) {
      expect(source.repoUrl).toMatch(/^https:\/\/github\.com\//);
      expect(source.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("시드 제출 (DB·fs 스토어)", () => {
  let tdb: TestDatabase;
  let root: string;
  let store: FsArtifactStore;
  let versionId: string;
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const resumeRef = artifactKeys.demoResume();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    root = await mkdtemp(path.join(os.tmpdir(), "ohmyti-demo-seed-"));
    store = new FsArtifactStore({ root });
    versionId = (await seedEvaluation(tdb.db)).assignmentVersionId;
    await store.put(resumeRef, demoResumePdf("Jordan Lee"), {
      contentType: ARTIFACT_CONTENT_TYPES.resume,
    });
  });

  afterAll(async () => {
    await tdb?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("저장된 샘플 스냅샷이 없으면 SHA를 고정하지 않고 워커의 GitHub 수집에 맡긴다", async () => {
    const source = { id: "A" as const, repoUrl: "https://github.com/example/sample-a", sha };
    expect(await hasStoredDemoSnapshot(store, "A", sha)).toBe(false);
    const seeded = await createDemoSeedSubmission(
      { db: tdb.db, store },
      { assignmentVersionId: versionId, source, resumeRef },
    );
    expect(seeded.fromStoredSnapshot).toBe(false);
    const row = await getSubmission(tdb.db, seeded.submissionId);
    expect(row).toMatchObject({
      demoSampleId: "A",
      isSample: true,
      repoRef: sha,
      submissionSha: null,
      status: "QUEUED",
    });
    expect((await getSubmissionContext(tdb.db, seeded.submissionId))?.resumeRef).toBe(
      artifactKeys.resume(seeded.submissionId),
    );
    expect(await findSubmissionJob(tdb.db, seeded.submissionId)).not.toBeNull();

    // 평가가 없으면 인수 기준 확인이 실패 사유를 모두 적는다
    const check = await inspectDemoEvaluation(tdb.db, seeded);
    expect(check.problems).toEqual(["제출 상태가 QUEUED입니다", "평가가 없습니다"]);

    // 워커가 수집한 스냅샷을 저장된 샘플 스냅샷으로 복사하면 다음 시드부터 재사용한다
    const snapshot = new Uint8Array([1, 2, 3]);
    await store.put(artifactKeys.snapshot(seeded.submissionId), snapshot, {
      contentType: ARTIFACT_CONTENT_TYPES.snapshot,
    });
    await store.put(
      artifactKeys.snapshotManifest(seeded.submissionId),
      new TextEncoder().encode(JSON.stringify({ submissionSha: sha })),
      { contentType: ARTIFACT_CONTENT_TYPES.snapshotManifest },
    );
    await saveDemoSnapshot(store, "A", seeded.submissionId);
    expect(await hasStoredDemoSnapshot(store, "A", sha)).toBe(true);
    // 다른 커밋을 고정한 샘플 목록과는 맞지 않는다
    expect(await hasStoredDemoSnapshot(store, "A", "f".repeat(40))).toBe(false);

    const again = await createDemoSeedSubmission(
      { db: tdb.db, store },
      { assignmentVersionId: versionId, source, resumeRef },
    );
    expect(again.fromStoredSnapshot).toBe(true);
    expect(await getSubmission(tdb.db, again.submissionId)).toMatchObject({
      submissionSha: sha,
      snapshotRef: artifactKeys.snapshot(again.submissionId),
    });
    expect((await store.get(artifactKeys.snapshot(again.submissionId)))?.body).toEqual(snapshot);
  });
});
