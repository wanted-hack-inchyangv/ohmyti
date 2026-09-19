import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveAssignmentVersion,
  assignments,
  assignmentVersions,
  createAssignmentVersion,
  createSubmission,
  createTestDatabase,
  startAssignmentVersionValidation,
  validationSamples,
  type TestDatabase,
} from "@ohmyti/db";
import { FsArtifactStore } from "@ohmyti/storage";
import {
  DEFAULT_GATE_JSON,
  directoryContentSha,
  SAMPLE_ASSIGNMENT_NAME,
  SAMPLE_KIND_BY_ID,
  SeedError,
  seedSampleAssignment,
} from "./db-seed-sample";
import { SAMPLE_DIR } from "./samples-check";

describe("directoryContentSha", () => {
  it("내용이 같으면 같고 1바이트라도 다르면 다르며 node_modules는 무시한다", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ohmyti-sha-"));
    try {
      const a = path.join(root, "a");
      const b = path.join(root, "b");
      await mkdir(path.join(a, "src"), { recursive: true });
      await mkdir(path.join(b, "src"), { recursive: true });
      await mkdir(path.join(b, "node_modules", "x"), { recursive: true });
      await writeFile(path.join(a, "src", "index.ts"), "export const x = 1;\n");
      await writeFile(path.join(b, "src", "index.ts"), "export const x = 1;\n");
      await writeFile(path.join(b, "node_modules", "x", "index.js"), "module.exports = 1;\n");
      const shaA = await directoryContentSha(a);
      expect(shaA).toMatch(/^[0-9a-f]{40}$/);
      expect(await directoryContentSha(b)).toBe(shaA);

      await writeFile(path.join(b, "src", "index.ts"), "export const x = 2;\n");
      expect(await directoryContentSha(b)).not.toBe(shaA);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[db-seed-sample] DATABASE_URL_TEST가 없어 시드 통합 테스트를 건너뜁니다");
}

describe.skipIf(!hasTestDb)("db:seed:sample (통합)", () => {
  let tdb: TestDatabase;
  let storeRoot: string;
  let store: FsArtifactStore;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storeRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-seed-store-"));
    store = new FsArtifactStore({ root: storeRoot });
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  it("두 번 실행해도 과제 1개·버전 1개(APPROVED, approved_by=seed)·샘플 4개이며 제출을 받을 수 있다", async () => {
    const first = await seedSampleAssignment({ db: tdb.db, store });
    expect(first.created).toEqual({ assignment: true, version: true, approved: true });
    expect(first.status).toBe("APPROVED");
    expect(first.rubricVersion).toMatch(/^v1-[0-9a-f]{8}$/);
    expect(first.samples.map((s) => [s.id, s.kind])).toEqual([
      ["A", "CORRECT"],
      ["B", "ALTERNATIVE"],
      ["C", "DEFECTIVE"],
      ["D", "ADVERSARIAL"],
    ]);

    const second = await seedSampleAssignment({ db: tdb.db, store });
    expect(second.created).toEqual({ assignment: false, version: false, approved: false });
    expect(second.assignmentId).toBe(first.assignmentId);
    expect(second.assignmentVersionId).toBe(first.assignmentVersionId);
    expect(second.samples).toEqual(first.samples);

    const assignmentRows = await tdb.db
      .select()
      .from(assignments)
      .where(eq(assignments.name, SAMPLE_ASSIGNMENT_NAME));
    expect(assignmentRows).toHaveLength(1);

    const versionRows = await tdb.db
      .select()
      .from(assignmentVersions)
      .where(eq(assignmentVersions.assignmentId, first.assignmentId));
    expect(versionRows).toHaveLength(1);
    const version = versionRows[0]!;
    expect(version.status).toBe("APPROVED");
    expect(version.approvedBy).toBe("seed");
    expect(version.approvedAt).toBeInstanceOf(Date);
    expect(version.title).toBe(`${SAMPLE_ASSIGNMENT_NAME} v1`);
    expect(version.rubric.version).toBe(version.rubricVersion);
    expect(version.rubric.criteria).toHaveLength(15);
    expect(version.executionContract.startCommand).toBe("npm start");
    expect(version.harnessVersion).toBe(first.harnessVersion);
    expect(version.validationResult).toMatchObject({ gate: "phase1", ok: true });
    expect((version.validationResult as { harnessVersion: string }).harnessVersion).toBe(
      version.harnessVersion,
    );

    const specObject = await store.get(version.specRef);
    expect(specObject?.contentType).toBe("text/markdown");
    expect(Buffer.from(specObject!.body).toString("utf8")).toContain("# ");

    const sampleRows = await tdb.db
      .select()
      .from(validationSamples)
      .where(eq(validationSamples.assignmentVersionId, version.id));
    expect(sampleRows).toHaveLength(4);
    for (const row of sampleRows) {
      const sample = first.samples.find((s) => s.name === row.name)!;
      expect(row.kind).toBe(SAMPLE_KIND_BY_ID[sample.id as keyof typeof SAMPLE_KIND_BY_ID]);
      expect(row.submissionSha).toMatch(/^[0-9a-f]{40}$/);
      expect(row.humanReviewedBy).toBeNull();
      expect(row.humanReviewedAt).toBeNull();
      expect(row.expected).toMatchObject({ criteria: { "R-01": { verdict: "PASS" } } });
      expect(await store.exists(row.snapshotRef)).toBe(true);
    }

    // 승인된 버전이므로 제출을 만들 수 있다
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId: version.id,
      repoUrl: "https://github.com/example/order-api",
    });
    expect(submission.status).toBe("RECEIVED");
  }, 120_000);

  it("하네스 버전이 바뀌면 같은 내용의 승인 버전을 RETIRED로 내리고 다음 번호를 현재 하네스로 승인한다 (T-308)", async () => {
    const before = await seedSampleAssignment({ db: tdb.db, store });
    // 같은 내용의 버전이 옛 하네스로 승인돼 있는 상황 (승인 행은 불변이라 새 행으로 만든다)
    const [current] = await tdb.db
      .select()
      .from(assignmentVersions)
      .where(eq(assignmentVersions.id, before.assignmentVersionId));
    const stale = await createAssignmentVersion(tdb.db, {
      assignmentId: before.assignmentId,
      title: "stale",
      specRef: current!.specRef,
      specDigest: current!.specDigest,
      rubric: { ...current!.rubric, version: "ignored" },
      executionContract: current!.executionContract,
      harnessVersion: "0.0.0+stale",
    });
    await startAssignmentVersionValidation(tdb.db, stale.id);
    await approveAssignmentVersion(tdb.db, {
      id: stale.id,
      approvedBy: "test",
      validationResult: current!.validationResult,
    });
    expect(stale.version).toBe(before.versionNumber + 1);

    const result = await seedSampleAssignment({ db: tdb.db, store });
    expect(result.retiredVersionId).toBe(stale.id);
    expect(result.created).toEqual({ assignment: false, version: true, approved: true });
    expect(result.versionNumber).toBe(stale.version + 1);
    expect(result.status).toBe("APPROVED");
    expect(result.harnessVersion).toBe(before.harnessVersion);
    expect(result.rubricVersion).toBe(`v${stale.version + 1}-${before.rubricVersion.slice(3)}`);
    for (const sample of result.samples) {
      expect(sample.snapshotRef).toContain(`/versions/${result.versionNumber}/`);
      expect(await store.exists(sample.snapshotRef)).toBe(true);
    }

    const rows = await tdb.db
      .select()
      .from(assignmentVersions)
      .where(eq(assignmentVersions.assignmentId, before.assignmentId));
    const retired = rows.find((r) => r.id === stale.id)!;
    expect(retired.status).toBe("RETIRED");
    expect(retired.retiredAt).toBeInstanceOf(Date);
    expect(retired.harnessVersion).toBe("0.0.0+stale");
    const fresh = rows.find((r) => r.id === result.assignmentVersionId)!;
    expect(fresh).toMatchObject({
      status: "APPROVED",
      harnessVersion: before.harnessVersion,
      version: result.versionNumber,
      title: `${SAMPLE_ASSIGNMENT_NAME} v${result.versionNumber}`,
    });
    const sampleRows = await tdb.db
      .select()
      .from(validationSamples)
      .where(eq(validationSamples.assignmentVersionId, fresh.id));
    expect(sampleRows).toHaveLength(4);

    // 다시 실행하면 새 버전을 재사용한다
    const again = await seedSampleAssignment({ db: tdb.db, store });
    expect(again.assignmentVersionId).toBe(result.assignmentVersionId);
    expect(again.created).toEqual({ assignment: false, version: false, approved: false });
    expect(again.retiredVersionId).toBeNull();
  }, 120_000);

  it("게이트 결과가 통과가 아니면 승인하지 않는다", async () => {
    const gate = JSON.parse(await readFile(DEFAULT_GATE_JSON, "utf8")) as { ok: boolean };
    const failing = path.join(storeRoot, "failing-gate.json");
    await writeFile(failing, JSON.stringify({ ...gate, ok: false }));
    const otherStore = new FsArtifactStore({ root: path.join(storeRoot, "other") });
    await expect(
      seedSampleAssignment({ db: tdb.db, store: otherStore, gateJsonPath: failing }),
    ).rejects.toBeInstanceOf(SeedError);
  });

  it("샘플 디렉터리는 기대 결과표의 dir과 일치한다", async () => {
    for (const dir of ["impl-a", "impl-b", "impl-c", "impl-d"]) {
      const sha = await directoryContentSha(path.join(SAMPLE_DIR, dir));
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
