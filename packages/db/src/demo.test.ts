import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createSubmission } from "./assignments";
import {
  findSavedDemoEvaluation,
  findSubmissionJob,
  hasLiveWorker,
  isDemoSampleId,
  listSavedDemoEvaluations,
  readRubricApproval,
} from "./demo";
import { assignmentVersions, evaluations, jobs, submissions, validationSamples } from "./schema";
import { enqueueSubmissionEvaluation, setSubmissionStatus } from "./submissions";
import { DIGEST, SHA, seedEvaluation } from "./test-fixtures";
import { createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});

afterAll(async () => {
  await tdb?.destroy();
});

async function demoEvaluation(
  versionId: string,
  sampleId: string,
  options: { status?: "COMPLETED" | "FAILED" | "QUEUED"; finishedAt?: Date | null } = {},
) {
  const submission = await createSubmission(tdb.db, {
    assignmentVersionId: versionId,
    repoUrl: `https://github.com/example/sample-${sampleId.toLowerCase()}`,
    demoSampleId: sampleId,
  });
  await setSubmissionStatus(tdb.db, submission.id, options.status ?? "COMPLETED");
  const [evaluation] = await tdb.db
    .insert(evaluations)
    .values({
      submissionId: submission.id,
      assignmentVersionId: versionId,
      rubricVersion: "rv",
      harnessVersion: "harness-0",
      environmentDigest: DIGEST,
      submissionSha: SHA,
      isSample: true,
      scoreEarned: 54,
      scoreMin: 54,
      scoreMax: 69,
      pendingPoints: 15,
      finishedAt: options.finishedAt === undefined ? new Date() : options.finishedAt,
    })
    .returning();
  return { submissionId: submission.id, evaluationId: evaluation!.id };
}

describe("demo_sample_id", () => {
  it("샘플 ID가 있으면 is_sample이 항상 true이고, 샘플이 아닌 제출에는 둘 수 없다", async () => {
    const seeded = await seedEvaluation(tdb.db);
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId: seeded.assignmentVersionId,
      repoUrl: "https://github.com/example/a",
      demoSampleId: "A",
    });
    expect(submission.isSample).toBe(true);
    expect(submission.demoSampleId).toBe("A");
    await expect(
      tdb.db.update(submissions).set({ isSample: false }).where(eq(submissions.id, submission.id)),
    ).rejects.toThrow();
    await expect(
      tdb.db
        .update(submissions)
        .set({ demoSampleId: "a1" })
        .where(eq(submissions.id, submission.id)),
    ).rejects.toThrow();
    expect(isDemoSampleId("C")).toBe(true);
    expect(isDemoSampleId("E")).toBe(false);
  });
});

describe("listSavedDemoEvaluations / findSavedDemoEvaluation", () => {
  it("샘플마다 완료된 제출의 가장 최근에 끝난 평가만 저장된 실행이다", async () => {
    const seeded = await seedEvaluation(tdb.db);
    const v = seeded.assignmentVersionId;
    const older = await demoEvaluation(v, "C", { finishedAt: new Date("2026-09-18T00:00:00Z") });
    const newer = await demoEvaluation(v, "C", { finishedAt: new Date("2026-09-19T00:00:00Z") });
    // 실패한 새 실행과 끝나지 않은 평가는 저장된 실행이 아니다
    await demoEvaluation(v, "C", {
      status: "FAILED",
      finishedAt: new Date("2026-09-20T00:00:00Z"),
    });
    await demoEvaluation(v, "D", { status: "QUEUED", finishedAt: null });
    const a = await demoEvaluation(v, "A");

    const saved = await listSavedDemoEvaluations(tdb.db);
    expect(saved.get("C")?.evaluationId).toBe(newer.evaluationId);
    expect(saved.get("A")?.evaluationId).toBe(a.evaluationId);
    expect(saved.has("D")).toBe(false);
    expect(saved.get("C")).toMatchObject({ scoreMin: 54, scoreMax: 69, pendingPoints: 15 });

    const excluded = await findSavedDemoEvaluation(tdb.db, "C", {
      excludeSubmissionId: newer.submissionId,
    });
    expect(excluded?.evaluationId).toBe(older.evaluationId);
    expect(await findSavedDemoEvaluation(tdb.db, "D")).toBeNull();

    // 지운 제출은 저장된 실행에서 빠진다
    await tdb.db
      .update(submissions)
      .set({ deletedAt: new Date() })
      .where(eq(submissions.id, newer.submissionId));
    expect((await findSavedDemoEvaluation(tdb.db, "C"))?.evaluationId).toBe(older.evaluationId);
  });
});

describe("findSubmissionJob / hasLiveWorker", () => {
  it("제출의 평가 job을 찾고, 최근 heartbeat가 있는 RUNNING job만 살아 있는 워커로 본다", async () => {
    const seeded = await seedEvaluation(tdb.db);
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId: seeded.assignmentVersionId,
      repoUrl: "https://github.com/example/b",
      demoSampleId: "B",
    });
    expect(await findSubmissionJob(tdb.db, submission.id)).toBeNull();
    const enqueued = await enqueueSubmissionEvaluation(tdb.db, submission.id);
    const job = await findSubmissionJob(tdb.db, submission.id);
    expect(job?.id).toBe(enqueued.id);
    expect(job?.status).toBe("QUEUED");

    const now = new Date();
    await tdb.db.update(jobs).set({ status: "CANCELLED" });
    expect(await hasLiveWorker(tdb.db, 60_000, now)).toBe(false);
    await tdb.db
      .update(jobs)
      .set({ status: "RUNNING", heartbeatAt: new Date(now.getTime() - 120_000) })
      .where(eq(jobs.id, enqueued.id));
    expect(await hasLiveWorker(tdb.db, 60_000, now)).toBe(false);
    await tdb.db
      .update(jobs)
      .set({ heartbeatAt: new Date(now.getTime() - 5_000) })
      .where(eq(jobs.id, enqueued.id));
    expect(await hasLiveWorker(tdb.db, 60_000, now)).toBe(true);
  });
});

describe("readRubricApproval", () => {
  it("버전 행의 승인·검증 결과만 옮긴다 (1단계 게이트, 사전 검증 결과, 결과 없음)", async () => {
    const seeded = await seedEvaluation(tdb.db);
    const id = seeded.assignmentVersionId;
    const none = await readRubricApproval(tdb.db, id);
    expect(none).toMatchObject({ status: "APPROVED", validated: false, validationSource: null });

    // 트리거가 승인 버전의 본문 변경을 막으므로 픽스처 버전을 DRAFT로 되돌리지 않고 validation_result만 가진 새 행을 쓴다
    const [base] = await tdb.db
      .select()
      .from(assignmentVersions)
      .where(eq(assignmentVersions.id, id));
    const insertVersion = async (
      version: number,
      validationResult: unknown,
      approvedBy: string,
    ) => {
      const [row] = await tdb.db
        .insert(assignmentVersions)
        .values({
          ...base!,
          id: undefined,
          version,
          rubricVersion: `${base!.rubricVersion}-${version}`,
          status: "APPROVED",
          approvedBy,
          approvedAt: new Date("2026-09-18T13:10:00Z"),
          validationResult,
          createdAt: undefined,
          updatedAt: undefined,
        })
        .returning();
      return row!;
    };
    const gate = await insertVersion(
      2,
      { gate: "phase1", ok: true, finishedAt: "2026-09-18T13:06:30.248Z" },
      "seed",
    );
    await tdb.db.insert(validationSamples).values([
      {
        assignmentVersionId: gate.id,
        name: "A",
        kind: "CORRECT",
        snapshotRef: "x",
        submissionSha: SHA,
        expected: {},
      },
      {
        assignmentVersionId: gate.id,
        name: "C",
        kind: "DEFECTIVE",
        snapshotRef: "y",
        submissionSha: SHA,
        expected: {},
        humanReviewedBy: "reviewer",
        humanReviewedAt: new Date(),
      },
    ]);
    expect(await readRubricApproval(tdb.db, gate.id)).toMatchObject({
      version: 2,
      validated: true,
      validationSource: "PHASE1_GATE",
      validatedAt: "2026-09-18T13:06:30.248Z",
      approvedBy: "seed",
      samplesTotal: 2,
      samplesReviewed: 1,
      bootstrapPendingReview: true,
    });

    const failedGate = await insertVersion(3, { gate: "phase1", ok: false }, "seed");
    expect(await readRubricApproval(tdb.db, failedGate.id)).toMatchObject({
      validated: false,
      validationSource: "PHASE1_GATE",
    });
    expect(await readRubricApproval(tdb.db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
