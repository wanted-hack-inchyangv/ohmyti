/**
 * T-501 이력서 텍스트 추출의 파이프라인 통합 테스트 (resume).
 *
 * - CONTEXT_LINK 단계가 이력서 원본을 추출해 `submission_context`에 저장하고, 단계 기록에는 본문 없는 요약만 남긴다.
 * - 이력서 본문에 넣은 표식 문자열이 LLM 호출(RUBRIC_DRAFT·MUTATION_TARGETS·EVIDENCE_REVIEW)의 요청과
 *   `ai_reviews` 행 어디에도 없다 (G-10). 표식이 DB에 있는 동안 세 용도의 호출을 모두 실제로 일으킨다.
 * - 워커 로그 어디에도 이력서 본문이 없다.
 * - T-502: 접근할 수 없는 GitHub 프로필은 `github_sources`에 NO_DATA + 사유로 남고 파이프라인은 끝까지 간다.
 */
import { TEST_TIME_BUDGETS } from "@ohmyti/core/testing";
import { ExecutionContractSchema, RubricSchema } from "@ohmyti/core";
import { sampleRubricDraftOutput } from "@ohmyti/core/fixtures";
import { collectGitHubSources, type GitHubSourcesCollector } from "@ohmyti/context";
import { buildTextPdf, fakeGitHubProfileApi, sampleResumeLines } from "@ohmyti/context/testing";
import { MUTATION_CATALOG, type MutationDefinition } from "@ohmyti/analysis";
import {
  aiReviews,
  approveAssignmentVersion,
  claimJob,
  completeJob,
  createAssignment,
  createAssignmentVersion,
  createRubricDraftRequest,
  createSubmission,
  createTestDatabase,
  getEvaluation,
  getSubmissionContext,
  setResumeText,
  specDigestOf,
  startAssignmentVersionValidation,
  upsertSubmissionContext,
  type TestDatabase,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import { createDbAiReviewSink, createEvaluationLlmClient, FakeLlmClient } from "@ohmyti/llm";
import { LOCAL_RUNNER_DEFAULTS, LocalProcessRunner } from "@ohmyti/runner";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, type Logger } from "../logger";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import { createDraftRubricHandler } from "../rubric-draft";
import { runEvaluationPipeline, type PipelineDeps } from ".";
import { describeStageLog } from "../testing/premise";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SHA_C = "c".repeat(40);
const MARKER = "RESUME-MARKER-3b8e51d0";

/** M-02만 남기고 AST 휴리스틱을 끈 카탈로그. 위치를 LLM 후보(MUTATION_TARGETS)로만 찾게 한다 */
const LLM_LOCATE_CATALOG: MutationDefinition[] = MUTATION_CATALOG.filter(
  (d) => d.id === "M-02",
).map((d) => ({ ...d, locate: { ...d.locate, heuristic: () => undefined } }));

const FAKE_RESPONSES = {
  RUBRIC_DRAFT: { output: sampleRubricDraftOutput() },
  MUTATION_TARGETS: { output: { candidates: [] } },
  EVIDENCE_REVIEW: { output: { failures: [], designReviews: [], suggestions: [] } },
};

async function readTree(dir: string, base = dir): Promise<FakeRepoFiles> {
  const out: FakeRepoFiles = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await readTree(full, base));
    else out[path.relative(base, full)] = await readFile(full);
  }
  return out;
}

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

describe.skipIf(!hasTestDb)("CONTEXT_LINK 이력서 텍스트 추출 (resume, DB 통합)", () => {
  let tdb: TestDatabase;
  let assignmentVersionId: string;
  let github: ReturnType<typeof fakeGitHub>;
  let workRoot: string;
  let store: FsArtifactStore;
  const logLines: string[] = [];
  let logger: Logger;
  const fake = new FakeLlmClient({ responses: FAKE_RESPONSES });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-resume-context-"));
    store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
    // 모든 수준의 로그를 모은다
    logger = createLogger({
      destination: { write: (line) => logLines.push(line) },
      level: "trace",
    });
    const rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    const contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    const assignment = await createAssignment(tdb.db, { name: "T-501 테스트 과제" });
    const draft = await createAssignmentVersion(tdb.db, {
      assignmentId: assignment.id,
      title: "v1",
      specRef: "assignments/x/specs/spec.md",
      specDigest: "a".repeat(64),
      rubric,
      executionContract: contract,
      harnessVersion: harnessVersionOf(getCaseSet(DEFAULT_CASE_SET)),
    });
    await startAssignmentVersionValidation(tdb.db, draft.id);
    assignmentVersionId = (
      await approveAssignmentVersion(tdb.db, {
        id: draft.id,
        approvedBy: "tester",
        validationResult: { ok: true },
      })
    ).id;
    const c = await readTree(path.join(SAMPLES_DIR, "impl-c"));
    github = fakeGitHub({
      "acme/order-api": {
        defaultBranch: "main",
        refs: { c: SHA_C },
        tarballs: { [SHA_C]: () => makeGitHubStyleTarball(c, SHA_C) },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  function deps(
    mutation: PipelineDeps["config"]["mutation"],
    githubSources?: GitHubSourcesCollector,
  ): PipelineDeps {
    return {
      db: tdb.db,
      store,
      runner: new LocalProcessRunner({
        config: { ...LOCAL_RUNNER_DEFAULTS, templateRoot: TEMPLATE_ROOT, workRoot },
        artifactStore: store,
      }),
      github: createGitHubClient({ fetch: github.fetch }),
      config: {
        stageTimeoutMs: TEST_TIME_BUDGETS.stageMs,
        requestTimeoutMs: TEST_TIME_BUDGETS.harnessRequestMs,
        templateRoot: TEMPLATE_ROOT,
        repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
        workRoot,
        mutation,
      },
      logger,
      llmForEvaluation: (evaluationId) =>
        createEvaluationLlmClient({
          base: fake,
          sink: createDbAiReviewSink(tdb.db),
          scope: { evaluationId },
          limits: { maxCalls: 20, maxCostUsd: 1 },
        }),
      githubSources,
    };
  }

  async function submitWithResume(): Promise<string> {
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: "https://github.com/acme/order-api",
      repoRef: "c",
    });
    const resumeRef = artifactKeys.resume(submission.id);
    await store.put(resumeRef, buildTextPdf([sampleResumeLines(MARKER)]), {
      contentType: ARTIFACT_CONTENT_TYPES.resume,
    });
    await upsertSubmissionContext(tdb.db, submission.id, { resumeRef });
    return submission.id;
  }

  async function contextStage(evaluationId: string) {
    const evaluation = (await getEvaluation(tdb.db, evaluationId))!;
    return evaluation.stageLog.find((s) => s.stage === "CONTEXT_LINK")!;
  }

  it("CONTEXT_LINK가 텍스트 PDF를 EXTRACTED로 저장하고 단계 기록에는 본문 없는 요약만 남긴다", async () => {
    const submissionId = await submitWithResume();
    const result = await runEvaluationPipeline(
      { submissionId, attempt: 1, maxAttempts: 3 },
      deps({ enabled: false }),
    );
    expect(result.submissionStatus, describeStageLog(result.stageLog)).toBe("COMPLETED");

    const context = (await getSubmissionContext(tdb.db, submissionId))!;
    expect(context.resumeTextStatus).toBe("EXTRACTED");
    expect(context.resumeText).toContain(MARKER);
    expect(context.resumeText).toContain("Backend Engineer");

    const stage = await contextStage(result.evaluationId!);
    expect(stage.state).toBe("DONE");
    expect(stage.detail).toMatchObject({
      resume: { status: "EXTRACTED", action: "EXTRACTED", pageCount: 1 },
    });
    expect(JSON.stringify(stage)).not.toContain(MARKER);
  }, 300_000);

  it("이력서 본문이 DB에 있는 동안 일어난 RUBRIC_DRAFT·MUTATION_TARGETS·EVIDENCE_REVIEW 호출과 ai_reviews 행에 표식이 없다", async () => {
    // 이미 텍스트가 저장된 제출(사람 입력)을 평가한다. 채점 단계가 도는 내내 표식이 submission_context에 있다
    const submissionId = await submitWithResume();
    await setResumeText(tdb.db, submissionId, {
      status: "MANUAL",
      text: sampleResumeLines(MARKER).join("\n"),
      reason: null,
    });
    const result = await runEvaluationPipeline(
      { submissionId, attempt: 1, maxAttempts: 3 },
      deps({ enabled: true, catalog: LLM_LOCATE_CATALOG }),
    );
    expect(result.submissionStatus, describeStageLog(result.stageLog)).toBe("COMPLETED");
    expect((await contextStage(result.evaluationId!)).detail).toMatchObject({
      resume: { status: "MANUAL", action: "KEPT" },
    });

    // 과제 명세 → 기준 초안 (T-406). 이력서와 무관한 경로지만 같은 DB에 표식이 있는 상태로 호출한다
    const spec = "# 주문·재고 API\nPOST /orders는 Idempotency-Key 헤더가 필수다.";
    const specRef = artifactKeys.rubricDraftSpec(specDigestOf(spec));
    await store.put(specRef, spec, { contentType: ARTIFACT_CONTENT_TYPES.assignmentSpec });
    await createRubricDraftRequest(tdb.db, { specRef, specDigest: specDigestOf(spec) });
    const job = await claimJob(tdb.db, { workerId: "resume-test", types: ["DRAFT_RUBRIC"] });
    await createDraftRubricHandler({ llm: fake, limits: { maxCalls: 2, maxCostUsd: 1 } })(job!, {
      logger,
      db: tdb.db,
      store,
      heartbeat: () => Promise.resolve(),
      signal: new AbortController().signal,
      workerId: "resume-test",
    });
    expect(await completeJob(tdb.db, job!.id, "resume-test")).toBe(true);

    // CONTEXT_LINK(T-503)는 이력서를 읽는 유일한 용도라 대상에서 뺀다
    const rows = (await tdb.db.select().from(aiReviews)).filter((r) => r.kind !== "CONTEXT_LINK");
    const kinds = new Set(rows.map((r) => r.kind));
    for (const kind of ["RUBRIC_DRAFT", "MUTATION_TARGETS", "EVIDENCE_REVIEW"] as const) {
      expect(kinds, `${kind} 호출이 실제로 있어야 한다`).toContain(kind);
    }
    for (const row of rows) {
      expect(JSON.stringify(row), `ai_reviews ${row.kind}`).not.toContain(MARKER);
    }
    const scoringSent = fake.sent.filter((s) => s.purpose !== "CONTEXT_LINK");
    const purposes = new Set(scoringSent.map((s) => s.purpose));
    expect([...purposes].sort()).toEqual(["EVIDENCE_REVIEW", "MUTATION_TARGETS", "RUBRIC_DRAFT"]);
    for (const sent of scoringSent) {
      expect(JSON.stringify(sent.messages), `${sent.purpose} 요청`).not.toContain(MARKER);
    }
  }, 300_000);

  it("접근할 수 없는 GitHub 프로필은 NO_DATA와 사유로 기록되고 파이프라인은 계속된다 (github)", async () => {
    const submissionId = await submitWithResume();
    await upsertSubmissionContext(tdb.db, submissionId, { githubLogin: "ghost-user" });
    const api = fakeGitHubProfileApi([]);
    const result = await runEvaluationPipeline(
      { submissionId, attempt: 1, maxAttempts: 3 },
      deps({ enabled: false }, (input) => collectGitHubSources(input, { fetch: api.fetch })),
    );
    expect(result.submissionStatus, describeStageLog(result.stageLog)).toBe("COMPLETED");
    expect(api.requests).toEqual([
      "/users/ghost-user/repos?type=owner&sort=pushed&direction=desc&per_page=100",
    ]);

    const context = (await getSubmissionContext(tdb.db, submissionId))!;
    expect(context.githubSources).toMatchObject({
      status: "NO_DATA",
      login: "ghost-user",
      repos: [],
    });
    expect((context.githubSources as { reason: string }).reason).toMatch(/^PROFILE_NOT_FOUND: /);
    // 이력서 추출도 그대로 끝났다
    expect(context.resumeTextStatus).toBe("EXTRACTED");

    const stage = await contextStage(result.evaluationId!);
    expect(stage.state).toBe("DONE");
    expect(stage.detail).toMatchObject({
      resume: { status: "EXTRACTED" },
      github: { status: "NO_DATA", action: "NO_DATA", repos: [], requestCount: 1 },
    });
    // 채점 단계는 영향을 받지 않는다
    const evaluation = (await getEvaluation(tdb.db, result.evaluationId!))!;
    expect(evaluation.stageLog.find((s) => s.stage === "REQUIREMENT_VERIFY")!.state).toBe("DONE");
    expect(logLines.some((line) => line.includes("GitHub 프로필 보충 조회"))).toBe(true);
  }, 300_000);

  it("워커 로그에 이력서 본문이 없다", () => {
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.some((line) => line.includes("이력서 텍스트 추출"))).toBe(true);
    const all = logLines.join("");
    expect(all).not.toContain(MARKER);
    expect(all).not.toContain("Designed idempotent payment endpoints");
  });
});
