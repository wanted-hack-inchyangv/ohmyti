import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EvaluationStageRecord, SubmissionStatus } from "@ohmyti/core";
import {
  createEvaluation,
  createTestDatabase,
  deleteSubmissionRows,
  getAssignmentVersion,
  getJob,
  getSubmission,
  getSubmissionContext,
  seedEvaluation,
  setResumeText,
  setSubmissionStatus,
  upsertSubmissionContext,
  updateEvaluationStage,
  type TestDatabase,
} from "@ohmyti/db";
import { FsArtifactStore } from "@ohmyti/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageDurationsOf } from "@/lib/demo/service";
import * as actions from "./actions";
import {
  buildStageViews,
  createSubmissionWithContext,
  DeletionRequestSchema,
  formatDeletionTime,
  readDeletionNotice,
  requestDeletion,
  isEnvironmentFailure,
  isTerminalSubmissionStatus,
  listApprovedVersionOptions,
  listApprovedVersionSummaries,
  MAX_RESUME_BYTES,
  parseUnsupportedReason,
  readSubmissionStatus,
  resumeTextViewOf,
  retrySubmission,
  saveManualResumeText,
  STAGE_DESCRIPTION,
  STAGE_LABEL,
  SubmissionFormSchema,
  summarizeStage,
  validateResume,
  versionSpecExcerpt,
  type SubmissionDeps,
} from "./service";

const PDF = new TextEncoder().encode("%PDF-1.4\n%fake resume\n");

describe("SubmissionFormSchema", () => {
  const base = {
    assignmentVersionId: "00000000-0000-4000-8000-000000000001",
    repoUrl: "https://github.com/octocat/order-api",
    commitSha: "",
    githubProfileUrl: "",
  };

  it("올바른 입력을 통과시키고 SHA를 소문자로 정규화한다", () => {
    const parsed = SubmissionFormSchema.parse({ ...base, commitSha: " ABCDEF1 " });
    expect(parsed.commitSha).toBe("abcdef1");
  });

  it("잘못된 저장소 URL·SHA·프로필 URL을 필드별 사유로 거부한다", () => {
    const result = SubmissionFormSchema.safeParse({
      ...base,
      repoUrl: "https://gitlab.com/octocat/order-api",
      commitSha: "main",
      githubProfileUrl: "https://github.com/octocat/repo",
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["repoUrl", "commitSha", "githubProfileUrl"]));
    expect(result.error!.issues.find((i) => i.path[0] === "repoUrl")?.message).toContain(
      "github.com 저장소만 지원",
    );
  });

  it("이력서·GitHub 없이 저장소 URL만으로 통과한다", () => {
    expect(SubmissionFormSchema.safeParse({ ...base }).success).toBe(true);
  });
});

describe("validateResume", () => {
  it("PDF 서명·크기·빈 파일을 검사한다", () => {
    expect(validateResume({ bytes: PDF, fileName: "r.pdf" }).ok).toBe(true);
    expect(validateResume({ bytes: new Uint8Array(0), fileName: "r.pdf" })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    const notPdf = validateResume({ bytes: new TextEncoder().encode("hello"), fileName: "r.pdf" });
    expect(!notPdf.ok && notPdf.message).toContain("PDF");
    const tooBig = validateResume({
      bytes: new Uint8Array(MAX_RESUME_BYTES + 1),
      fileName: "r.pdf",
    });
    expect(!tooBig.ok && tooBig.message).toContain("MiB");
  });
});

describe("parseUnsupportedReason", () => {
  it("<CODE>: <detail>; ... 형식을 코드와 상세로 나눈다", () => {
    expect(
      parseUnsupportedReason(
        "DISALLOWED_DEPENDENCY: fastify는 템플릿 허용 목록에 없습니다; UNSUPPORTED_LANGUAGE: go.mod 발견",
      ),
    ).toEqual([
      { code: "DISALLOWED_DEPENDENCY", detail: "fastify는 템플릿 허용 목록에 없습니다" },
      { code: "UNSUPPORTED_LANGUAGE", detail: "go.mod 발견" },
    ]);
    expect(parseUnsupportedReason("REPO_NOT_ACCESSIBLE: 저장소를 찾을 수 없음 (404)")).toEqual([
      { code: "REPO_NOT_ACCESSIBLE", detail: "저장소를 찾을 수 없음 (404)" },
    ]);
    expect(parseUnsupportedReason("형식 없는 사유")).toEqual([
      { code: "", detail: "형식 없는 사유" },
    ]);
    expect(parseUnsupportedReason(null)).toEqual([]);
  });
});

describe("buildStageViews", () => {
  it("stage_log만으로 7단계를 만들고 기록 없는 단계는 대기다", () => {
    const views = buildStageViews([]);
    expect(views.map((v) => v.label)).toEqual([
      "저장소 확인",
      "실행 준비",
      "요구사항 검증",
      "테스트 실효성",
      "리뷰 작성",
      "맥락 연결",
      "인터뷰 키트",
    ]);
    expect(views.every((v) => v.state === "PENDING" && v.stateLabel === "대기")).toBe(true);
    expect(Object.keys(STAGE_LABEL)).toHaveLength(7);
  });

  it("T-904: 7단계 모두 설명이 있고, 참고 시간은 넘겨받은 실측값만 보인다", () => {
    const plain = buildStageViews([]);
    expect(plain.every((v) => v.description.length > 20)).toBe(true);
    // 참고값을 넘기지 않으면 어떤 단계에도 시간이 없다 (진행률·예측을 만들지 않는다)
    expect(plain.every((v) => v.referenceSeconds === null)).toBe(true);
    const withReference = buildStageViews([], { REPO_CHECK: 12_400, ENV_PREP: 400 });
    expect(withReference.find((v) => v.stage === "REPO_CHECK")?.referenceSeconds).toBe(12);
    // 1초 미만도 0초로 보이지 않게 올린다
    expect(withReference.find((v) => v.stage === "ENV_PREP")?.referenceSeconds).toBe(1);
    expect(withReference.find((v) => v.stage === "REVIEW_WRITE")?.referenceSeconds).toBeNull();
    expect(Object.keys(STAGE_DESCRIPTION)).toHaveLength(7);
  });

  it("T-904: 단계별 실측 시간은 DONE이고 시작·종료 기록이 모두 있는 단계만 계산한다", () => {
    const log: EvaluationStageRecord[] = [
      {
        stage: "REPO_CHECK",
        state: "DONE",
        startedAt: "2026-09-19T06:00:00.000Z",
        finishedAt: "2026-09-19T06:00:09.000Z",
      },
      { stage: "ENV_PREP", state: "DONE", startedAt: "2026-09-19T06:00:09.000Z" },
      {
        stage: "REVIEW_WRITE",
        state: "FAILED",
        startedAt: "2026-09-19T06:01:00.000Z",
        finishedAt: "2026-09-19T06:01:30.000Z",
      },
    ];
    expect(stageDurationsOf(log)).toEqual({ REPO_CHECK: 9_000 });
    expect(stageDurationsOf([])).toEqual({});
  });

  it("완료된 단계는 기록된 값으로 요약하고 미지원 단계는 사유 코드·상세를 그대로 낸다", () => {
    const log: EvaluationStageRecord[] = [
      {
        stage: "REPO_CHECK",
        state: "DONE",
        startedAt: "2026-09-18T00:00:00.000Z",
        finishedAt: "2026-09-18T00:00:01.000Z",
        detail: {
          submissionSha: "0123456789abcdef0123456789abcdef01234567",
          fileCount: 12,
          totalBytes: 4096,
          reused: false,
        },
      },
      {
        stage: "ENV_PREP",
        state: "UNSUPPORTED",
        reason: "DISALLOWED_DEPENDENCY: fastify",
        detail: {
          supported: false,
          reasons: [{ code: "DISALLOWED_DEPENDENCY", detail: "fastify는 허용 목록에 없습니다" }],
          framework: "unknown",
          language: "typescript",
        },
      },
      { stage: "REQUIREMENT_VERIFY", state: "SKIPPED", reason: "앞 단계 미지원" },
    ];
    const views = buildStageViews(log);
    expect(views[0]).toMatchObject({
      state: "DONE",
      summary: "SHA 0123456789ab · 파일 12개 · 4.0 KB",
      startedAt: "2026-09-18T00:00:00.000Z",
    });
    expect(views[1]).toMatchObject({
      state: "UNSUPPORTED",
      unsupportedReasons: [
        { code: "DISALLOWED_DEPENDENCY", detail: "fastify는 허용 목록에 없습니다" },
      ],
    });
    expect(views[2]).toMatchObject({ state: "SKIPPED", reason: "앞 단계 미지원", summary: null });
    expect(views[3]?.state).toBe("PENDING");
  });

  it("REQUIREMENT_VERIFY 요약은 하네스·제출 테스트·점수 표기를 계산 없이 옮긴다", () => {
    const summary = summarizeStage({
      stage: "REQUIREMENT_VERIFY",
      state: "DONE",
      detail: {
        failureKind: "NONE",
        startup: { outcome: "HEALTHY", elapsedMs: 800 },
        harness: { summary: { total: 20, pass: 18, fail: 1, inconclusive: 1 } },
        tests: { status: "PASSED", total: 9, passed: 9 },
        results: { score: { display: "82~90/100 · 8점 검토 대기" } },
      },
    });
    expect(summary).toBe(
      "기동 HEALTHY · 하네스 통과 18/20 (실패 1, 미확정 1) · 제출 테스트 PASSED 9/9 · 점수 82~90/100 · 8점 검토 대기",
    );
  });

  it("INTERVIEW_KIT 요약은 질문 수·필수 질문 수·기본 질문 수를 옮긴다", () => {
    const detail = {
      slotCount: 9,
      templateCount: 9,
      priorities: { MUST: 4, SHOULD: 4, OPTIONAL: 1 },
      llm: "NOT_RUN",
    };
    expect(summarizeStage({ stage: "INTERVIEW_KIT", state: "DONE", detail })).toBe(
      "질문 9개 · 필수 4개 · 기본 질문 9개",
    );
    expect(
      summarizeStage({
        stage: "INTERVIEW_KIT",
        state: "DONE",
        detail: { ...detail, templateCount: 0 },
      }),
    ).toBe("질문 9개 · 필수 4개");
  });
});

describe("isEnvironmentFailure", () => {
  const failed = (kind: string): EvaluationStageRecord => ({
    stage: "REQUIREMENT_VERIFY",
    state: "FAILED",
    detail: { failureKind: kind },
  });
  it("ENVIRONMENT·TIMEOUT으로만 실패했을 때 true", () => {
    expect(isEnvironmentFailure([failed("ENVIRONMENT")])).toBe(true);
    expect(isEnvironmentFailure([failed("TIMEOUT")])).toBe(true);
    expect(isEnvironmentFailure([failed("SUBMISSION")])).toBe(false);
    expect(isEnvironmentFailure([{ stage: "REQUIREMENT_VERIFY", state: "FAILED" }])).toBe(false);
    expect(isEnvironmentFailure([])).toBe(false);
  });
});

describe("isTerminalSubmissionStatus", () => {
  it("COMPLETED·FAILED·UNSUPPORTED·DELETED에서 폴링을 멈춘다", () => {
    const terminal: SubmissionStatus[] = ["COMPLETED", "FAILED", "UNSUPPORTED", "DELETED"];
    const active: SubmissionStatus[] = ["RECEIVED", "QUEUED", "RUNNING"];
    expect(terminal.every(isTerminalSubmissionStatus)).toBe(true);
    expect(active.some(isTerminalSubmissionStatus)).toBe(false);
  });
});

describe("삭제 요청 입력 (T-506)", () => {
  it("검토자 이름은 앞뒤 공백을 떼고 1~100자, 제출 ID는 uuid여야 한다", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(DeletionRequestSchema.parse({ submissionId: id, reviewerName: "  김검토 " })).toEqual({
      submissionId: id,
      reviewerName: "김검토",
    });
    expect(DeletionRequestSchema.safeParse({ submissionId: id, reviewerName: "   " }).success).toBe(
      false,
    );
    expect(
      DeletionRequestSchema.safeParse({ submissionId: id, reviewerName: "가".repeat(101) }).success,
    ).toBe(false);
    expect(DeletionRequestSchema.safeParse({ submissionId: "x", reviewerName: "a" }).success).toBe(
      false,
    );
  });

  it("삭제 안내 시각은 KST 날짜·시각이다", () => {
    expect(formatDeletionTime("2026-09-19T06:04:59.000Z")).toBe("2026-09-19 15:04 KST");
  });
});

describe("서버 액션 목록", () => {
  it("제출 생성·재시도·이력서 텍스트 직접 입력·삭제 요청만 있다", () => {
    expect(Object.keys(actions).sort()).toEqual([
      "createSubmissionFromFormAction",
      "requestDeletionAction",
      "retrySubmissionAction",
      "saveManualResumeTextAction",
    ]);
  });
});

describe("resumeTextViewOf (T-501)", () => {
  const base = {
    submissionId: "00000000-0000-4000-8000-000000000000",
    resumeRef: "submissions/x/resume.pdf",
    resumeText: null,
    resumeTextStatus: "NONE" as const,
    resumeTextReason: null,
    githubLogin: null,
    githubSources: null,
    analysisScope: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("본문 없이 상태·사유·글자 수만 내고, 추출하지 못한 이력서만 직접 입력을 허용한다", () => {
    expect(resumeTextViewOf(null)).toEqual({
      status: "NONE",
      reason: null,
      chars: null,
      manualInputAllowed: false,
    });
    // 이력서는 있지만 아직 추출 전
    expect(resumeTextViewOf(base).manualInputAllowed).toBe(false);
    expect(
      resumeTextViewOf({ ...base, resumeTextStatus: "IMAGE_ONLY", resumeTextReason: "R: x" }),
    ).toEqual({ status: "IMAGE_ONLY", reason: "R: x", chars: null, manualInputAllowed: true });
    expect(
      resumeTextViewOf({ ...base, resumeTextReason: "RESUME_TOO_MANY_PAGES: 21쪽" })
        .manualInputAllowed,
    ).toBe(true);
    const extracted = resumeTextViewOf({
      ...base,
      resumeTextStatus: "EXTRACTED",
      resumeText: "secret body",
    });
    expect(extracted).toEqual({
      status: "EXTRACTED",
      reason: null,
      chars: 11,
      manualInputAllowed: false,
    });
    expect(JSON.stringify(extracted)).not.toContain("secret body");
    expect(
      resumeTextViewOf({ ...base, resumeTextStatus: "MANUAL", resumeText: "abc" })
        .manualInputAllowed,
    ).toBe(true);
    expect(
      resumeTextViewOf({ ...base, resumeRef: null, resumeTextStatus: "IMAGE_ONLY" }),
    ).toMatchObject({ manualInputAllowed: false });
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/web] DATABASE_URL_TEST가 없어 submissions 통합 테스트를 건너뜁니다");
}

describe.skipIf(!hasTestDb)("submissions 서비스 (통합)", () => {
  let tdb: TestDatabase;
  let storeRoot: string;
  let deps: SubmissionDeps;
  let approvedVersionId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storeRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-web-submissions-"));
    deps = { db: tdb.db, store: new FsArtifactStore({ root: storeRoot }) };
    const seeded = await seedEvaluation(tdb.db, `web-t206-${Date.now()}`);
    approvedVersionId = seeded.assignmentVersionId;
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  it("승인된 버전만 선택지에 나온다", async () => {
    const options = await listApprovedVersionOptions(deps);
    expect(options.some((o) => o.id === approvedVersionId)).toBe(true);
    expect(options.every((o) => o.label.endsWith("승인됨"))).toBe(true);
  });

  it("이력서·GitHub 없이 제출하면 제출 행과 job이 만들어지고 QUEUED다", async () => {
    const result = await createSubmissionWithContext(
      deps,
      {
        assignmentVersionId: approvedVersionId,
        repoUrl: "https://github.com/octocat/order-api",
        commitSha: "",
        githubProfileUrl: "",
      },
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const submission = await getSubmission(tdb.db, result.data.submissionId);
    expect(submission).toMatchObject({ status: "QUEUED", repoRef: null, submissionSha: null });
    const job = await getJob(tdb.db, result.data.jobId);
    expect(job).toMatchObject({
      type: "EVALUATE_SUBMISSION",
      status: "QUEUED",
      payload: { submissionId: result.data.submissionId },
    });
    const context = await getSubmissionContext(tdb.db, result.data.submissionId);
    expect(context).toMatchObject({ resumeRef: null, githubLogin: null });

    const status = await readSubmissionStatus(deps, result.data.submissionId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.data).toMatchObject({
      terminal: false,
      retryable: false,
      evaluation: null,
      context: { hasResume: false, githubLogin: null },
    });
    expect(status.data.stages.every((s) => s.state === "PENDING")).toBe(true);
    expect(status.data.submission.assignmentLabel).toContain("승인됨");
  });

  it("이력서 PDF와 GitHub 프로필은 submission_context에만 저장된다", async () => {
    const result = await createSubmissionWithContext(
      deps,
      {
        assignmentVersionId: approvedVersionId,
        repoUrl: "https://github.com/octocat/order-api",
        commitSha: "ABCDEF0123456789abcdef0123456789abcdef01",
        githubProfileUrl: "https://github.com/octocat/",
      },
      { bytes: PDF, fileName: "resume.pdf" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.resumeRef).toBe(`submissions/${result.data.submissionId}/resume.pdf`);
    const stored = await deps.store.get(result.data.resumeRef!);
    expect(stored?.contentType).toBe("application/pdf");
    expect(Buffer.from(stored!.body).equals(Buffer.from(PDF))).toBe(true);

    const submission = await getSubmission(tdb.db, result.data.submissionId);
    expect(submission?.repoRef).toBe("abcdef0123456789abcdef0123456789abcdef01");
    // 채점 경로가 읽는 submissions 행에는 이력서·GitHub 컬럼이 없다 (G-10)
    expect(Object.keys(submission!)).not.toEqual(
      expect.arrayContaining(["resumeRef", "resumeText", "githubLogin"]),
    );
    const context = await getSubmissionContext(tdb.db, result.data.submissionId);
    expect(context).toMatchObject({ resumeRef: result.data.resumeRef, githubLogin: "octocat" });
  });

  it("승인되지 않은 버전은 RUBRIC_NOT_APPROVED로 거부한다", async () => {
    // 승인된 버전은 트리거가 고정하므로 DRAFT 버전을 새로 만든다
    const seeded = await seedEvaluation(tdb.db, `web-t206-draft-${Date.now()}`);
    const [draft] = await tdb.sql<{ id: string }[]>`
      insert into assignment_versions
        (assignment_id, version, status, title, spec_ref, spec_digest, rubric, rubric_version, execution_contract, harness_version)
      select assignment_id, 2, 'DRAFT', 'v2', spec_ref, spec_digest, rubric, ${`draft-${Date.now()}`}, execution_contract, harness_version
      from assignment_versions where id = ${seeded.assignmentVersionId}
      returning id`;
    const result = await createSubmissionWithContext(
      deps,
      {
        assignmentVersionId: draft!.id,
        repoUrl: "https://github.com/octocat/order-api",
      },
      null,
    );
    expect(result).toMatchObject({ ok: false, code: "RUBRIC_NOT_APPROVED" });
  });

  it("미지원 제출은 사유 코드·상세를 상태 뷰에 그대로 싣고 종료 상태다", async () => {
    const seeded = await seedEvaluation(tdb.db, `web-t206-unsupported-${Date.now()}`);
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "REPO_CHECK", { state: "RUNNING" });
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "REPO_CHECK", { state: "DONE" });
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "ENV_PREP", { state: "RUNNING" });
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "ENV_PREP", {
      state: "UNSUPPORTED",
      reason: "DISALLOWED_DEPENDENCY: fastify",
      detail: {
        supported: false,
        reasons: [{ code: "DISALLOWED_DEPENDENCY", detail: "fastify는 허용 목록에 없습니다" }],
      },
    });
    await tdb.sql`update submissions set status = 'UNSUPPORTED', unsupported_reason = ${"DISALLOWED_DEPENDENCY: fastify는 허용 목록에 없습니다"} where id = ${seeded.submissionId}`;
    const status = await readSubmissionStatus(deps, seeded.submissionId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.data.terminal).toBe(true);
    expect(status.data.retryable).toBe(false);
    expect(status.data.submission.unsupportedReasons).toEqual([
      { code: "DISALLOWED_DEPENDENCY", detail: "fastify는 허용 목록에 없습니다" },
    ]);
    expect(status.data.stages[1]).toMatchObject({
      state: "UNSUPPORTED",
      unsupportedReasons: [
        { code: "DISALLOWED_DEPENDENCY", detail: "fastify는 허용 목록에 없습니다" },
      ],
    });
    expect(status.data.stages.slice(2).every((s) => s.state === "PENDING")).toBe(true);
    await expect(retrySubmission(deps, seeded.submissionId)).resolves.toMatchObject({
      ok: false,
      code: "NOT_RETRYABLE",
    });
  });

  it("IMAGE_ONLY 이력서는 상태 뷰에 안내 조건이 서고, 직접 입력하면 MANUAL로 저장된다 (T-501)", async () => {
    const created = await createSubmissionWithContext(
      deps,
      {
        assignmentVersionId: approvedVersionId,
        repoUrl: "https://github.com/octocat/order-api",
        commitSha: "",
        githubProfileUrl: "",
      },
      { bytes: PDF, fileName: "resume.pdf" },
    );
    if (!created.ok) throw new Error(created.message);
    const id = created.data.submissionId;

    // 추출 전에는 입력을 받지 않는다
    expect(await saveManualResumeText(deps, { submissionId: id, text: "경력" })).toMatchObject({
      ok: false,
      code: "RESUME_TEXT_NOT_EDITABLE",
    });

    await setResumeText(tdb.db, id, {
      status: "IMAGE_ONLY",
      text: null,
      reason: "RESUME_TEXT_NOT_FOUND: PDF에 텍스트 층이 없습니다",
    });
    const status = await readSubmissionStatus(deps, id);
    expect(status.ok && status.data.context.resumeText).toEqual({
      status: "IMAGE_ONLY",
      reason: "RESUME_TEXT_NOT_FOUND: PDF에 텍스트 층이 없습니다",
      chars: null,
      manualInputAllowed: true,
    });

    expect(await saveManualResumeText(deps, { submissionId: id, text: "  \n " })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    const saved = await saveManualResumeText(deps, {
      submissionId: id,
      text: "  백엔드 개발자\r\n주문 API 3년  ",
    });
    expect(saved).toEqual({
      ok: true,
      data: { status: "MANUAL", reason: null, chars: 17, manualInputAllowed: true },
    });
    expect(await getSubmissionContext(tdb.db, id)).toMatchObject({
      resumeTextStatus: "MANUAL",
      resumeText: "백엔드 개발자\n주문 API 3년",
      resumeTextReason: null,
    });

    // 추출된 이력서·이력서 없는 제출·잘못된 ID는 거절한다
    await setResumeText(tdb.db, id, { status: "EXTRACTED", text: "추출 본문", reason: null });
    expect(await saveManualResumeText(deps, { submissionId: id, text: "덮어쓰기" })).toMatchObject({
      ok: false,
      code: "RESUME_TEXT_NOT_EDITABLE",
    });
    const noResume = await seedEvaluation(tdb.db, `web-t501-${Date.now()}`);
    await upsertSubmissionContext(tdb.db, noResume.submissionId, { resumeRef: null });
    expect(
      await saveManualResumeText(deps, { submissionId: noResume.submissionId, text: "x" }),
    ).toMatchObject({
      ok: false,
      code: "RESUME_TEXT_NOT_EDITABLE",
      message: "이력서가 없는 제출입니다",
    });
    expect(await saveManualResumeText(deps, { submissionId: "nope", text: "x" })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
  });

  it("재시도는 직접 입력한 이력서 텍스트(MANUAL)도 새 제출로 옮긴다 (T-501)", async () => {
    const seeded = await seedEvaluation(tdb.db, `web-t501-retry-${Date.now()}`);
    const resumeRef = `submissions/${seeded.submissionId}/resume.pdf`;
    await deps.store.put(resumeRef, PDF, { contentType: "application/pdf" });
    await upsertSubmissionContext(tdb.db, seeded.submissionId, { resumeRef });
    await setResumeText(tdb.db, seeded.submissionId, {
      status: "MANUAL",
      text: "직접 입력한 경력",
      reason: null,
    });
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "REPO_CHECK", { state: "RUNNING" });
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "REPO_CHECK", {
      state: "FAILED",
      reason: "ENVIRONMENT: GitHub API 5xx",
      detail: { failureKind: "ENVIRONMENT" },
    });
    await setSubmissionStatus(tdb.db, seeded.submissionId, "FAILED");

    const retried = await retrySubmission(deps, seeded.submissionId);
    if (!retried.ok) throw new Error(retried.message);
    expect(await getSubmissionContext(tdb.db, retried.data.submissionId)).toMatchObject({
      resumeRef: `submissions/${retried.data.submissionId}/resume.pdf`,
      resumeTextStatus: "MANUAL",
      resumeText: "직접 입력한 경력",
    });
  });

  it("환경 장애로 FAILED면 재시도할 수 있고, 재시도는 고정 SHA로 새 제출을 만든다", async () => {
    const seeded = await seedEvaluation(tdb.db, `web-t206-envfail-${Date.now()}`);
    await tdb.sql`insert into submission_context (submission_id, github_login) values (${seeded.submissionId}, 'octocat')`;
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "REPO_CHECK", { state: "RUNNING" });
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "REPO_CHECK", { state: "DONE" });
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "ENV_PREP", { state: "RUNNING" });
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "ENV_PREP", {
      state: "FAILED",
      reason: "ENVIRONMENT: 러너를 만들지 못했습니다",
      detail: { failureKind: "ENVIRONMENT" },
    });
    await setSubmissionStatus(tdb.db, seeded.submissionId, "FAILED");

    const status = await readSubmissionStatus(deps, seeded.submissionId);
    expect(status.ok && status.data.retryable).toBe(true);
    expect(status.ok && status.data.failureKind).toBe("ENVIRONMENT");

    const retried = await retrySubmission(deps, seeded.submissionId);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.data.submissionId).not.toBe(seeded.submissionId);
    const created = await getSubmission(tdb.db, retried.data.submissionId);
    expect(created).toMatchObject({
      status: "QUEUED",
      repoUrl: "https://github.com/example/order-api",
      repoRef: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(await getSubmissionContext(tdb.db, retried.data.submissionId)).toMatchObject({
      githubLogin: "octocat",
    });
    // 원래 제출은 그대로 FAILED로 남는다 (G-03: 기록을 덮어쓰지 않는다)
    expect((await getSubmission(tdb.db, seeded.submissionId))?.status).toBe("FAILED");
  });

  it("제출 코드 탓(SUBMISSION)으로 FAILED면 재시도 버튼 조건이 거짓이다", async () => {
    const seeded = await seedEvaluation(tdb.db, `web-t206-subfail-${Date.now()}`);
    for (const stage of ["REPO_CHECK", "ENV_PREP"] as const) {
      await updateEvaluationStage(tdb.db, seeded.evaluationId, stage, { state: "RUNNING" });
      await updateEvaluationStage(tdb.db, seeded.evaluationId, stage, { state: "DONE" });
    }
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "REQUIREMENT_VERIFY", {
      state: "RUNNING",
    });
    await updateEvaluationStage(tdb.db, seeded.evaluationId, "REQUIREMENT_VERIFY", {
      state: "FAILED",
      reason: "SUBMISSION: 서비스가 /health를 주지 못했습니다",
      detail: { failureKind: "SUBMISSION" },
    });
    await setSubmissionStatus(tdb.db, seeded.submissionId, "FAILED");
    const status = await readSubmissionStatus(deps, seeded.submissionId);
    expect(status.ok && status.data).toMatchObject({
      terminal: true,
      retryable: false,
      failureKind: "SUBMISSION",
    });
    await expect(retrySubmission(deps, seeded.submissionId)).resolves.toMatchObject({
      ok: false,
      code: "NOT_RETRYABLE",
    });
  });

  it("삭제된 제출·잘못된 ID는 SUBMISSION_NOT_FOUND·INVALID_INPUT", async () => {
    const seeded = await seedEvaluation(tdb.db, `web-t206-deleted-${Date.now()}`);
    await setSubmissionStatus(tdb.db, seeded.submissionId, "DELETED");
    await expect(readSubmissionStatus(deps, seeded.submissionId)).resolves.toMatchObject({
      ok: false,
      code: "SUBMISSION_NOT_FOUND",
    });
    await expect(readSubmissionStatus(deps, "not-a-uuid")).resolves.toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
  });

  it("최신 평가의 stage_log를 읽는다 (재평가로 평가가 여럿이면 가장 최근 것)", async () => {
    const seeded = await seedEvaluation(tdb.db, `web-t206-latest-${Date.now()}`);
    const later = await createEvaluation(tdb.db, {
      submissionId: seeded.submissionId,
      assignmentVersionId: seeded.assignmentVersionId,
      rubricVersion: seeded.rubricVersion,
      harnessVersion: "harness-0",
      environmentDigest: "a".repeat(64),
      submissionSha: "0123456789abcdef0123456789abcdef01234567",
    });
    await updateEvaluationStage(tdb.db, later.id, "REPO_CHECK", { state: "RUNNING" });
    const status = await readSubmissionStatus(deps, seeded.submissionId);
    expect(status.ok && status.data.evaluation?.id).toBe(later.id);
    expect(status.ok && status.data.stages[0]?.state).toBe("RUNNING");
  });

  it("삭제 요청: 이름 없으면 거부, 요청하면 DELETED·삭제 job이 생기고 상태 조회는 '삭제된 제출'로 404, 워커가 지우면 DONE (T-506)", async () => {
    const seeded = await seedEvaluation(tdb.db, `web-t506-${Date.now()}`);
    await setSubmissionStatus(tdb.db, seeded.submissionId, "RUNNING");
    await expect(
      requestDeletion(deps, { submissionId: seeded.submissionId, reviewerName: " " }),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await getSubmission(tdb.db, seeded.submissionId))?.status).toBe("RUNNING");
    expect(await readDeletionNotice(deps, seeded.submissionId)).toBeNull();

    const requested = await requestDeletion(deps, {
      submissionId: seeded.submissionId,
      reviewerName: "김검토",
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error("unreachable");
    const job = await getJob(tdb.db, requested.data.jobId);
    expect(job?.type).toBe("DELETE_SUBMISSION");
    expect(job?.payload).toEqual({ submissionId: seeded.submissionId, requestedBy: "김검토" });
    const row = await getSubmission(tdb.db, seeded.submissionId);
    expect(row?.status).toBe("DELETED");
    expect(row?.deletedAt).toBeInstanceOf(Date);

    await expect(readSubmissionStatus(deps, seeded.submissionId)).resolves.toEqual({
      ok: false,
      code: "SUBMISSION_NOT_FOUND",
      message: `삭제된 제출입니다: ${seeded.submissionId}`,
    });
    expect(await readDeletionNotice(deps, seeded.submissionId)).toMatchObject({ state: "PENDING" });
    // 다시 요청하면 같은 활성 삭제 job을 돌려준다
    const again = await requestDeletion(deps, {
      submissionId: seeded.submissionId,
      reviewerName: "김검토",
    });
    expect(again.ok && again.data.jobId).toBe(requested.data.jobId);

    // 워커의 행 삭제 뒤에는 deletion_log로 DONE
    await deleteSubmissionRows(tdb.db, {
      submissionId: seeded.submissionId,
      requestedBy: "김검토",
      artifacts: { prefixes: [], deletedObjects: 0, keptSharedRefs: [] },
      cancelledJobIds: [],
    });
    expect(await readDeletionNotice(deps, seeded.submissionId)).toMatchObject({ state: "DONE" });
    await expect(
      requestDeletion(deps, { submissionId: seeded.submissionId, reviewerName: "김검토" }),
    ).resolves.toMatchObject({ ok: false, code: "SUBMISSION_NOT_FOUND" });
    // 없는 제출은 삭제 안내가 없다
    expect(await readDeletionNotice(deps, "00000000-0000-4000-8000-00000000abcd")).toBeNull();
  });
  it("T-903: 과제 요약은 저장된 rubric·실행 계약·승인 기록에서 읽는다", async () => {
    const summaries = await listApprovedVersionSummaries(deps);
    const summary = summaries.find((item) => item.id === approvedVersionId);
    expect(summary, "승인된 시드 버전이 요약에 있어야 한다").toBeDefined();
    const version = await getAssignmentVersion(tdb.db, approvedVersionId);
    const criteria = version!.rubric.criteria;
    expect(summary!.criteria).toHaveLength(criteria.length);
    expect(summary!.totalPoints).toBe(criteria.reduce((sum, c) => sum + c.maxPoints, 0));
    expect(summary!.href).toBe(
      `/assignments/${version!.assignmentId}/versions/${version!.version}`,
    );
    // 실행 계약 요약은 저장된 계약의 값을 옮기기만 한다
    const start = summary!.contract.find((item) => item.label === "기동 명령");
    expect(start?.value).toBe(version!.executionContract.startCommand);
    expect(summary!.rubricVersion).toBe(version!.rubricVersion);
  });
});

describe("versionSpecExcerpt (T-903)", () => {
  it("제목·표·목록·코드 블록을 건너뛰고 첫 문단을 한 줄로 만든다", () => {
    expect(versionSpecExcerpt("# 제목\n\n| 표 |\n\n본문 한 줄.\n이어지는 줄.")).toBe(
      "본문 한 줄. 이어지는 줄.",
    );
    expect(versionSpecExcerpt(null)).toBeNull();
    expect(versionSpecExcerpt("- 목록만")).toBeNull();
    expect(versionSpecExcerpt("가".repeat(400), 5)).toBe("가가가가가…");
  });
});
