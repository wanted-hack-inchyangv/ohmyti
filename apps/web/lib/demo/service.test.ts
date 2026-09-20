import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSubmission,
  createTestDatabase,
  evaluations,
  findSubmissionJob,
  getAssignmentVersion,
  getSubmission,
  getSubmissionContext,
  jobs,
  seedEvaluation,
  setSubmissionStatus,
  submissions,
  type RubricApproval,
  type TestDatabase,
} from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvalBadgeView,
  DEMO_NOTICE,
  demoRunStartTimeoutMs,
  formatSavedAt,
  isDemoModeEnabled,
  readDemoOverview,
  readDemoPersonas,
  readDemoRunStatus,
  savedRunLabel,
  specExcerptOf,
  startDemoRun,
} from "./service";
import { sampleRunLabel } from "./format";

const SHA = "89abcdef0123456789abcdef0123456789abcdef";
const DIGEST = "b".repeat(64);

describe("표기", () => {
  it("저장 시각은 KST로 고정해 `저장된 실행 · YYYY-MM-DD HH:MM KST`로 쓴다", () => {
    expect(formatSavedAt("2026-09-18T20:54:30.000Z")).toBe("2026-09-19 05:54 KST");
    expect(savedRunLabel(new Date("2026-09-18T15:00:00Z"))).toBe(
      "저장된 실행 · 2026-09-19 00:00 KST",
    );
    expect(sampleRunLabel(null)).toBe("샘플 · 실행 중");
    expect(sampleRunLabel("2026-09-18T20:54:30.000Z")).toBe("저장된 실행 · 2026-09-19 05:54 KST");
    expect(DEMO_NOTICE).toBe("준비된 샘플입니다. 결과와 숫자는 실제 실행에서 생성했습니다");
  });

  it("설정값: DEMO_MODE=true일 때만 켜고, 대기 상한은 1초 이상 정수만 받는다", () => {
    expect(isDemoModeEnabled({})).toBe(false);
    expect(isDemoModeEnabled({ DEMO_MODE: "false" })).toBe(false);
    expect(isDemoModeEnabled({ DEMO_MODE: "true" })).toBe(true);
    expect(demoRunStartTimeoutMs({})).toBe(30_000);
    expect(demoRunStartTimeoutMs({ DEMO_RUN_START_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(demoRunStartTimeoutMs({ DEMO_RUN_START_TIMEOUT_MS: "10" })).toBe(30_000);
  });
});

describe("approvalBadgeView", () => {
  const base: RubricApproval = {
    assignmentVersionId: "00000000-0000-4000-8000-000000000001",
    version: 2,
    status: "APPROVED",
    approvedBy: "seed",
    approvedAt: new Date("2026-09-18T13:10:00Z"),
    validated: true,
    validationSource: "PHASE1_GATE",
    validatedAt: "2026-09-18T13:06:30.248Z",
    samplesTotal: 4,
    samplesReviewed: 0,
    bootstrapPendingReview: true,
  };

  it("통과한 검증 결과가 있는 승인 버전만 `채점기 사전 검증 완료`이고, 시드 승인은 샘플 검토 대기를 함께 알린다", () => {
    const view = approvalBadgeView(base);
    expect(view).toMatchObject({
      validated: true,
      label: "채점기 사전 검증 완료",
      pendingHumanReview: true,
    });
    expect(view.detail).toContain("v2 · 1단계 게이트(샘플 A/B/C/D 판별) 통과");
    expect(view.detail).toContain("승인 seed · 2026-09-18 22:10 KST");
    expect(view.detail).toContain("샘플 검토 0/4");
  });

  it("검증 결과가 없거나 실패했거나 승인 전이면 완료로 표시하지 않는다", () => {
    for (const approval of [
      { ...base, validated: false },
      { ...base, status: "DRAFT" as const, approvedAt: null },
      { ...base, validationSource: null, validated: false },
    ]) {
      expect(approvalBadgeView(approval)).toMatchObject({
        validated: false,
        label: "사전 검증 기록 없음",
      });
    }
    expect(approvalBadgeView(null).validated).toBe(false);
  });
});

describe("새 실행 (DB·fs 스토어)", () => {
  let tdb: TestDatabase;
  let root: string;
  let store: FsArtifactStore;
  let versionId: string;

  async function savedEvaluation(sampleId: string, finishedAt: Date) {
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId: versionId,
      repoUrl: `https://github.com/example/sample-${sampleId.toLowerCase()}`,
      demoSampleId: sampleId,
    });
    await setSubmissionStatus(tdb.db, submission.id, "COMPLETED");
    const [row] = await tdb.db
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
        finishedAt,
      })
      .returning();
    return row!;
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    root = await mkdtemp(path.join(os.tmpdir(), "ohmyti-demo-web-"));
    store = new FsArtifactStore({ root });
    versionId = (await seedEvaluation(tdb.db)).assignmentVersionId;
  });

  afterAll(async () => {
    await tdb?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("저장된 실행이 없으면 거절하고, 저장된 스냅샷이 없으면 제출을 만들지 않는다", async () => {
    expect(await startDemoRun({ db: tdb.db, store }, "E")).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await startDemoRun({ db: tdb.db, store }, "B")).toMatchObject({
      ok: false,
      code: "NO_SAVED_RUN",
    });
    await savedEvaluation("B", new Date("2026-09-18T20:00:00Z"));
    expect(await startDemoRun({ db: tdb.db, store }, "B")).toMatchObject({
      ok: false,
      code: "SNAPSHOT_MISSING",
    });
  });

  it("저장된 스냅샷·manifest·예시 이력서를 새 제출로 복사하고 SHA를 고정한 뒤 job을 넣는다", async () => {
    const saved = await savedEvaluation("C", new Date("2026-09-18T20:54:30Z"));
    const snapshot = new Uint8Array([31, 139, 8, 0, 1, 2, 3]);
    const manifest = new TextEncoder().encode(JSON.stringify({ submissionSha: SHA, files: [] }));
    const resume = new TextEncoder().encode("%PDF-1.4\nresume");
    await store.put(artifactKeys.demoSampleSnapshot("C"), snapshot, {
      contentType: ARTIFACT_CONTENT_TYPES.snapshot,
    });
    await store.put(artifactKeys.demoSampleManifest("C"), manifest, {
      contentType: ARTIFACT_CONTENT_TYPES.snapshotManifest,
    });
    await store.put(artifactKeys.demoResume(), resume, {
      contentType: ARTIFACT_CONTENT_TYPES.resume,
    });

    const started = await startDemoRun({ db: tdb.db, store }, "C");
    if (!started.ok) throw new Error(started.message);
    const id = started.data.submissionId;
    const row = await getSubmission(tdb.db, id);
    expect(row).toMatchObject({
      demoSampleId: "C",
      isSample: true,
      submissionSha: SHA,
      snapshotRef: artifactKeys.snapshot(id),
      status: "QUEUED",
      assignmentVersionId: versionId,
    });
    expect((await store.get(artifactKeys.snapshot(id)))?.body).toEqual(snapshot);
    expect((await store.get(artifactKeys.snapshotManifest(id)))?.body).toEqual(manifest);
    const context = await getSubmissionContext(tdb.db, id);
    expect(context?.resumeRef).toBe(artifactKeys.resume(id));
    expect((await store.get(artifactKeys.resume(id)))?.body).toEqual(resume);
    expect((await findSubmissionJob(tdb.db, id))?.status).toBe("QUEUED");

    // 대기 상한 전: 대기 중. 결과·실패 사유를 보이지 않는다
    const createdAt = row!.createdAt.getTime();
    const waiting = await readDemoRunStatus({ db: tdb.db }, id, {
      now: new Date(createdAt + 1_000),
      startTimeoutMs: 5_000,
    });
    expect(waiting).toMatchObject({
      ok: true,
      data: { phase: "WAITING", failureReason: null, evaluationHref: null, terminal: false },
    });

    // 대기 상한을 넘기고 진행 중인 다른 작업도 없다: 워커 응답 없음 실패 + 이전의 저장된 실행. 폴링은 계속한다
    const later = new Date(createdAt + 60_000);
    const failed = await readDemoRunStatus({ db: tdb.db }, id, {
      now: later,
      startTimeoutMs: 5_000,
    });
    if (!failed.ok) throw new Error(failed.message);
    expect(failed.data).toMatchObject({
      phase: "FAILED",
      message: "새 실행을 시작하지 못했습니다",
      evaluationHref: null,
      terminal: false,
      saved: {
        evaluationId: saved.id,
        href: `/evaluations/${saved.id}`,
        label: "저장된 실행 · 2026-09-19 05:54 KST",
        scoreDisplay: "54~69/100 · 15점 검토 대기",
      },
    });
    expect(failed.data.failureReason).toContain("워커 응답 없음");

    // 다른 job이 진행 중이면(워커가 살아 있으면) 여전히 대기 중이다
    const other = await createSubmission(tdb.db, {
      assignmentVersionId: versionId,
      repoUrl: "https://github.com/example/other",
    });
    await tdb.db.insert(jobs).values({
      type: "EVALUATE_SUBMISSION",
      payload: { submissionId: other.id },
      status: "RUNNING",
      heartbeatAt: new Date(later.getTime() - 1_000),
    });
    const busy = await readDemoRunStatus({ db: tdb.db }, id, { now: later, startTimeoutMs: 5_000 });
    expect(busy.ok && busy.data.phase).toBe("WAITING");
    await tdb.db.update(jobs).set({ status: "CANCELLED" }).where(eq(jobs.status, "RUNNING"));
  });

  it("실패·미지원으로 끝나면 사유와 저장된 실행을, 완료되면 이번 실행 결과 링크를 보인다", async () => {
    await savedEvaluation("D", new Date("2026-09-18T21:00:00Z"));
    const run = await createSubmission(tdb.db, {
      assignmentVersionId: versionId,
      repoUrl: "https://github.com/example/sample-d",
      demoSampleId: "D",
    });
    await setSubmissionStatus(tdb.db, run.id, "UNSUPPORTED");
    await tdb.db
      .update(submissions)
      .set({ unsupportedReason: "REPO_NOT_ACCESSIBLE: 저장소를 읽을 수 없습니다" })
      .where(eq(submissions.id, run.id));
    const unsupported = await readDemoRunStatus({ db: tdb.db }, run.id);
    expect(unsupported).toMatchObject({
      ok: true,
      data: {
        phase: "FAILED",
        terminal: true,
        failureReason: "REPO_NOT_ACCESSIBLE: 저장소를 읽을 수 없습니다",
        saved: { label: "저장된 실행 · 2026-09-19 06:00 KST" },
      },
    });

    const done = await savedEvaluation("D", new Date("2026-09-18T22:00:00Z"));
    const completed = await readDemoRunStatus({ db: tdb.db }, done.submissionId);
    expect(completed).toMatchObject({
      ok: true,
      data: {
        phase: "SUCCEEDED",
        terminal: true,
        evaluationHref: `/evaluations/${done.id}`,
        failureReason: null,
      },
    });

    expect(await readDemoRunStatus({ db: tdb.db }, "not-a-uuid")).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    const plain = await createSubmission(tdb.db, {
      assignmentVersionId: versionId,
      repoUrl: "https://github.com/example/plain",
    });
    expect(await readDemoRunStatus({ db: tdb.db }, plain.id)).toMatchObject({
      ok: false,
      code: "RUN_NOT_FOUND",
    });
  });

  it("개요는 샘플 4개를 늘 보이고 저장된 실행이 있는 샘플만 링크한다", async () => {
    const overview = await readDemoOverview({ db: tdb.db, store });
    expect(overview.notice).toBe(DEMO_NOTICE);
    expect(overview.samples.map((s) => s.id)).toEqual(["A", "B", "C", "D"]);
    expect(overview.samples[0]!.saved).toBeNull();
    expect(overview.samples[3]!.saved?.label).toBe("저장된 실행 · 2026-09-19 07:00 KST");
    // seedEvaluation 버전은 검증 결과가 없으므로 완료 배지가 아니다
    expect(overview.approval).toMatchObject({ validated: false });
  });

  it("T-901: 확인할 것은 저장된 실행이 있을 때만 워크벤치 딥링크가 되고 카드에 고정 커밋 링크가 있다", async () => {
    const overview = await readDemoOverview({ db: tdb.db, store });
    const a = overview.samples.find((s) => s.id === "A")!;
    const d = overview.samples.find((s) => s.id === "D")!;
    // A는 이 테스트 DB에 저장된 실행이 없다
    expect(a.saved).toBeNull();
    expect(a.checkViews.every((c) => c.href === null)).toBe(true);
    expect(a.prefillHref).toBe("/submissions/new?sample=A");

    expect(d.saved).not.toBeNull();
    const mutationCheck = d.checkViews.find((c) => c.mutationId)!;
    expect(mutationCheck.href).toBe(
      `/evaluations/${d.saved!.evaluationId}?criterion=${mutationCheck.criterionId}&mutation=${mutationCheck.mutationId}`,
    );
    expect(d.commitHref).toBe(`${d.repoUrl}/tree/${d.commitSha}`);
    expect(d.shortCommit).toBe(d.commitSha.slice(0, 12));
    expect(overview.recommendedOrder.length).toBeGreaterThanOrEqual(4);
  });

  it("T-901: 과제 요약의 요구사항 수·총 배점은 저장된 rubric에서 읽는다", async () => {
    const overview = await readDemoOverview({ db: tdb.db, store });
    const version = await getAssignmentVersion(tdb.db, versionId);
    const criteria = version!.rubric.criteria;
    expect(overview.assignment).toMatchObject({
      assignmentVersionId: versionId,
      requirementCount: criteria.length,
      totalPoints: criteria.reduce((sum, c) => sum + c.maxPoints, 0),
    });
  });
});

describe("T-905 readDemoPersonas (DB)", () => {
  it("저장된 실행이 없는 페르소나는 프리필 링크만 보이고 오류가 나지 않는다", async () => {
    const tdb = await createTestDatabase();
    try {
      const personas = await readDemoPersonas({ db: tdb.db });
      expect(personas.map((p) => p.handle)).toEqual(["seojin", "taeyun", "gaeun", "dohyun"]);
      expect(personas.every((p) => p.saved === null)).toBe(true);
      expect(personas[0]!.prefillHref).toBe("/submissions/new?persona=seojin");
    } finally {
      await tdb.destroy();
    }
  }, 60_000);
});

describe("specExcerptOf", () => {
  it("제목·표·목록·인용을 건너뛰고 첫 문단을 한 줄로 만든다", () => {
    const markdown = [
      "# 제목",
      "| 표 | 머리 |",
      "- 목록",
      "> 인용",
      "첫 문단입니다.\n두 번째 줄입니다.",
      "두 번째 문단",
    ].join("\n\n");
    expect(specExcerptOf(markdown)).toBe("첫 문단입니다. 두 번째 줄입니다.");
    expect(specExcerptOf(null)).toBeNull();
    expect(specExcerptOf("# 제목만")).toBeNull();
    // `## 1. 과제 개요` 아래 문단을 먼저 쓴다
    expect(specExcerptOf("첫 문단.\n\n## 1. 과제 개요\n\n개요 문단.")).toBe("개요 문단.");
    expect(specExcerptOf("가".repeat(500), 10)).toBe(`${"가".repeat(10)}…`);
  });
});
