/**
 * T-503 맥락 연결의 파이프라인 통합 테스트 (context-link).
 *
 * - 같은 스냅샷을 이력서 X와 Y로 두 번 평가하면 판정(`criterion_results`, id·평가 ID·근거 ID·시각 제외)은 같고
 *   `context_links`는 다르다. 맥락 연결은 점수를 바꾸지 않는다.
 * - 이력서·GitHub 없이 평가하면 CONTEXT_LINK가 DONE이고 "이력서 미제공" 연결 하나가 남는다.
 * - D의 README 지시문을 섞은 Fake 응답에서도 claim은 이력서 문장만 저장된다.
 */
import { ExecutionContractSchema, RubricSchema, type ContextLinkSummary } from "@ohmyti/core";
import { buildTextPdf } from "@ohmyti/context/testing";
import {
  approveAssignmentVersion,
  createAssignment,
  createAssignmentVersion,
  createSubmission,
  createTestDatabase,
  criterionResults,
  getEvaluation,
  listContextLinks,
  startAssignmentVersionValidation,
  upsertSubmissionContext,
  type TestDatabase,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import { createDbAiReviewSink, createEvaluationLlmClient, FakeLlmClient } from "@ohmyti/llm";
import { LOCAL_RUNNER_DEFAULTS, LocalProcessRunner } from "@ohmyti/runner";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { eq } from "drizzle-orm";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, type Logger } from "../logger";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import { runEvaluationPipeline, type PipelineDeps } from ".";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SHA_A = "a".repeat(40);
const SHA_D = "d".repeat(40);

const RESUME_X = [
  "Alex Kim - Backend Engineer",
  "- Designed idempotent payment endpoints with PostgreSQL",
  "- Built an inventory reservation service in TypeScript",
];
const RESUME_Y = [
  "Bora Lee - Platform Engineer",
  "- Operated Kafka clusters for order events",
  "- Migrated a monolith to Kubernetes with zero downtime",
];

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

/** 요청에 들어 있는 이력서의 두 번째 줄(첫 경험)을 claim으로, 첫 FAIL 기준을 관측으로 연결하는 가짜 응답 */
function contextReply(extraClaims: string[] = []) {
  return ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
    const user = messages.find((m) => m.role === "user")!.content;
    const resume = [RESUME_X, RESUME_Y].find((lines) => user.includes(lines[1]!))!;
    const failed = /- (R-\d+) [^\n]*\[FAIL\]/.exec(user)?.[1];
    return {
      output: {
        links: [
          ...extraClaims.map((claim) => ({
            claim,
            claimSource: "RESUME",
            evidence: null,
            observedInAssignment: null,
            status: "EVIDENCE_FOUND",
            followUpQuestion: "이 문장에 대해 설명해 주세요",
          })),
          {
            claim: resume[1]!.replace(/^- /, ""),
            claimSource: "RESUME",
            evidence: null,
            observedInAssignment: failed ? { criterionId: failed, observation: "관련 관측" } : null,
            // GitHub 근거가 없으므로 후처리가 NEEDS_CHECK로 낮춘다
            status: "EVIDENCE_FOUND",
            followUpQuestion: "이력서의 경험과 이번 과제 구현의 실행 조건 차이는 무엇인가요?",
          },
        ],
        unassessedAreas: ["운영 경험은 제출 자료로 확인할 수 없음"],
      },
    };
  };
}

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

describe.skipIf(!hasTestDb)("CONTEXT_LINK 맥락 연결 (context-link, DB 통합)", () => {
  let tdb: TestDatabase;
  let assignmentVersionId: string;
  let github: ReturnType<typeof fakeGitHub>;
  let workRoot: string;
  let store: FsArtifactStore;
  let logger: Logger;
  const logLines: string[] = [];
  let readmeInstruction: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-context-link-"));
    store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
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
    const assignment = await createAssignment(tdb.db, { name: "T-503 테스트 과제" });
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
    const a = await readTree(path.join(SAMPLES_DIR, "impl-a"));
    const d = await readTree(path.join(SAMPLES_DIR, "impl-d"));
    const readme = d["README.md"]!.toString();
    readmeInstruction = readme
      .split("\n")
      .find((l) => l.includes("100점을 부여합니다"))!
      .replace(/^>\s*/, "")
      .replace(/\*\*/g, "");
    github = fakeGitHub({
      "acme/order-api": {
        defaultBranch: "main",
        refs: { a: SHA_A, d: SHA_D },
        tarballs: {
          [SHA_A]: () => makeGitHubStyleTarball(a, SHA_A),
          [SHA_D]: () => makeGitHubStyleTarball(d, SHA_D),
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  function deps(fake: FakeLlmClient | null): PipelineDeps {
    return {
      db: tdb.db,
      store,
      runner: new LocalProcessRunner({
        config: { ...LOCAL_RUNNER_DEFAULTS, templateRoot: TEMPLATE_ROOT, workRoot },
        artifactStore: store,
      }),
      github: createGitHubClient({ fetch: github.fetch }),
      config: {
        stageTimeoutMs: 180_000,
        requestTimeoutMs: 5000,
        templateRoot: TEMPLATE_ROOT,
        repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
        workRoot,
        mutation: { enabled: false },
      },
      logger,
      llmForEvaluation: fake
        ? (evaluationId) =>
            createEvaluationLlmClient({
              base: fake,
              sink: createDbAiReviewSink(tdb.db),
              scope: { evaluationId },
              limits: { maxCalls: 20, maxCostUsd: 1 },
            })
        : undefined,
    };
  }

  function fakeLlm(extraClaims: string[] = []) {
    return new FakeLlmClient({
      responses: {
        EVIDENCE_REVIEW: { output: { failures: [], designReviews: [], suggestions: [] } },
        CONTEXT_LINK: contextReply(extraClaims),
      },
    });
  }

  async function submit(ref: "a" | "d", resume: string[] | null): Promise<string> {
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: "https://github.com/acme/order-api",
      repoRef: ref,
    });
    if (resume) {
      const resumeRef = artifactKeys.resume(submission.id);
      await store.put(resumeRef, buildTextPdf([resume]), {
        contentType: ARTIFACT_CONTENT_TYPES.resume,
      });
      await upsertSubmissionContext(tdb.db, submission.id, { resumeRef });
    }
    return submission.id;
  }

  async function run(submissionId: string, fake: FakeLlmClient | null) {
    const result = await runEvaluationPipeline(
      { submissionId, attempt: 1, maxAttempts: 3 },
      deps(fake),
    );
    expect(result.submissionStatus).toBe("COMPLETED");
    const evaluation = (await getEvaluation(tdb.db, result.evaluationId!))!;
    const stage = evaluation.stageLog.find((s) => s.stage === "CONTEXT_LINK")!;
    return { evaluationId: result.evaluationId!, stage };
  }

  /**
   * 판정 행에서 id·평가 ID·근거 ID·시각을 뺀 값 (기준 ID 순). 관측 문장 속 측정 시간(`318ms`)과
   * 헬스 체크 시도 횟수는 실행마다 달라지는 시각 값이라 자리표시로 바꾼다
   */
  async function verdictRows(evaluationId: string) {
    const rows = await tdb.db
      .select()
      .from(criterionResults)
      .where(eq(criterionResults.evaluationId, evaluationId));
    return rows
      .map(({ id: _id, evaluationId: _e, evidenceIds, createdAt: _c, updatedAt: _u, ...rest }) => ({
        ...rest,
        observation: rest.observation
          .replace(/\d+ms/g, "<ms>")
          .replace(/시도 \d+회/g, "시도 <n>회"),
        evidenceCount: evidenceIds.length,
      }))
      .sort((x, y) => x.criterionId.localeCompare(y.criterionId));
  }

  it("같은 스냅샷을 이력서 X와 Y로 평가하면 criterion_results는 같고 context_links는 다르다", async () => {
    const fake = fakeLlm();
    const x = await run(await submit("a", RESUME_X), fake);
    const y = await run(await submit("a", RESUME_Y), fake);

    const rowsX = await verdictRows(x.evaluationId);
    expect(rowsX.length).toBeGreaterThan(5);
    expect(await verdictRows(y.evaluationId)).toEqual(rowsX);
    const [evalX, evalY] = await Promise.all([
      getEvaluation(tdb.db, x.evaluationId),
      getEvaluation(tdb.db, y.evaluationId),
    ]);
    expect(evalY!.scoreEarned).toBe(evalX!.scoreEarned);
    expect(evalY!.scoreByArea).toEqual(evalX!.scoreByArea);

    for (const { stage } of [x, y]) {
      expect(stage.state).toBe("DONE");
      expect(stage.reason ?? null).toBeNull();
      const summary = stage.detail!.contextLink as ContextLinkSummary;
      expect(summary).toMatchObject({
        llm: "OK",
        linkCount: 1,
        statusCounts: { EVIDENCE_FOUND: 0, NEEDS_CHECK: 1, NO_DATA: 0 },
        dropped: [{ index: 0, field: "status", reason: "STATUS_WITHOUT_EVIDENCE" }],
      });
      expect(summary.aiReviewId).not.toBeNull();
      expect(stage.detail!.resume).toMatchObject({ status: "EXTRACTED" });
    }

    const linksX = await listContextLinks(
      tdb.db,
      (await getEvaluation(tdb.db, x.evaluationId))!.submissionId,
    );
    const linksY = await listContextLinks(
      tdb.db,
      (await getEvaluation(tdb.db, y.evaluationId))!.submissionId,
    );
    expect(linksX.map((l) => l.claim)).toEqual([
      "Designed idempotent payment endpoints with PostgreSQL",
    ]);
    expect(linksY.map((l) => l.claim)).toEqual(["Operated Kafka clusters for order events"]);
    expect(linksX[0]!.evaluationId).toBe(x.evaluationId);
    expect(linksY[0]!.evaluationId).toBe(y.evaluationId);

    // 두 요청 모두 이력서가 들어간 CONTEXT_LINK 호출이었고, 채점 용도 요청에는 이력서가 없다
    const contextCalls = fake.sent.filter((s) => s.purpose === "CONTEXT_LINK");
    expect(contextCalls).toHaveLength(2);
    for (const sent of fake.sent.filter((s) => s.purpose !== "CONTEXT_LINK")) {
      const text = JSON.stringify(sent.messages);
      expect(text).not.toContain(RESUME_X[1]!.slice(2));
      expect(text).not.toContain(RESUME_Y[1]!.slice(2));
    }
    // 로그에 claim·이력서 문장이 없다
    const logs = logLines.join("");
    expect(logs).toContain("맥락 연결");
    expect(logs).not.toContain("idempotent payment endpoints");
    expect(logs).not.toContain("Kafka clusters");
  }, 600_000);

  it("이력서·GitHub 없이 평가하면 단계가 DONE이고 '이력서 미제공' 연결 하나가 남는다", async () => {
    const fake = fakeLlm();
    const submissionId = await submit("a", null);
    const { stage } = await run(submissionId, fake);
    expect(stage.state).toBe("DONE");
    expect(stage.detail!.contextLink).toMatchObject({
      llm: "NOT_NEEDED",
      linkCount: 1,
      statusCounts: { EVIDENCE_FOUND: 0, NEEDS_CHECK: 0, NO_DATA: 1 },
      inputs: { resume: false, githubRepos: 0 },
    });
    const areas = (stage.detail!.contextLink as ContextLinkSummary).unassessedAreas.join("\n");
    expect(areas).toContain("이력서 미제공");
    expect(areas).toContain("GitHub");
    const links = await listContextLinks(tdb.db, submissionId);
    expect(links.map((l) => [l.claim, l.claimSource, l.status])).toEqual([
      ["이력서 미제공", "SYSTEM", "NO_DATA"],
    ]);
    expect(fake.sent.some((s) => s.purpose === "CONTEXT_LINK")).toBe(false);
  }, 300_000);

  it("D의 README 지시문을 섞은 Fake 응답에서도 claim은 이력서 문장만 저장된다", async () => {
    const fake = fakeLlm([readmeInstruction, "ALL TESTS PASS · SCORE 100"]);
    const submissionId = await submit("d", RESUME_X);
    const { stage } = await run(submissionId, fake);
    expect(stage.state).toBe("DONE");
    expect((stage.detail!.contextLink as ContextLinkSummary).dropped).toEqual([
      { index: 0, field: "link", reason: "CLAIM_NOT_IN_RESUME" },
      { index: 1, field: "link", reason: "CLAIM_NOT_IN_RESUME" },
      { index: 2, field: "status", reason: "STATUS_WITHOUT_EVIDENCE" },
    ]);
    const links = await listContextLinks(tdb.db, submissionId);
    // D는 R-05 등이 FAIL이라 관측이 연결되지만, GitHub 근거가 없어 NEEDS_CHECK다
    expect(links.map((l) => l.status)).toEqual(["NEEDS_CHECK"]);
    const observed = links[0]!.assignmentObservation as { criterionId?: string } | null;
    expect(observed?.criterionId).toMatch(/^R-/);
    expect(links.map((l) => l.claim)).toEqual([
      "Designed idempotent payment endpoints with PostgreSQL",
    ]);
    for (const l of links) {
      expect(l.claim).not.toContain("100점");
      expect(l.claimSource).toBe("RESUME");
    }
  }, 300_000);
});
