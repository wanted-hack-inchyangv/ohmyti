/**
 * T-702 INTERVIEW_KIT 단계의 파이프라인 통합 테스트 (interview-kit).
 *
 * - 결함 구현 C를 fake LLM으로 평가하면 FAIL 기준마다 실패 디브리핑 슬롯이 생기고 상위 2개가 필수다. 정답 구현 A는 실패 디브리핑이
 *   없고 강점 확인·요구사항 확장이 필수다. 이력서 없이 제출해도 키트가 저장된다.
 * - 같은 스냅샷을 이력서 X와 Y로 평가하면 INTERVIEW_KIT의 LLM 입력 다이제스트와 질문 계획이 같다.
 * - fake LLM이 복합 질문·추궁 어조·없는 슬롯 ID를 돌려주면 그 항목만 버려지고 기본 질문으로 채워지며 사유가 단계 기록에 남는다.
 * - 예산 초과면 모든 슬롯이 기본 질문이고 단계는 DONE + 사유다.
 * - 키트 단계 전후로 판정·점수가 같다 (키트는 판정 digest 대상이 아니다).
 */
import { TEST_TIME_BUDGETS } from "@ohmyti/core/testing";
import {
  ExecutionContractSchema,
  InterviewKitSchema,
  RubricSchema,
  type InterviewKit,
} from "@ohmyti/core";
import { buildTextPdf } from "@ohmyti/context/testing";
import {
  approveAssignmentVersion,
  createAssignment,
  createAssignmentVersion,
  createSubmission,
  createTestDatabase,
  getEvaluation,
  listAiReviews,
  listCriterionResults,
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
import { createLogger } from "../logger";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import { describeStageLog } from "../testing/premise";
import { runEvaluationPipeline, type PipelineDeps } from ".";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SHA_A = "a".repeat(40);
const SHA_C = "c".repeat(40);

const RESUME_X = [
  "Alex Kim - Backend Engineer",
  "- Designed idempotent payment endpoints with PostgreSQL",
];
const RESUME_Y = ["Bora Lee - Platform Engineer", "- Operated Kafka clusters for order events"];

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

/** 요청의 이력서 두 번째 줄을 claim으로 쓰는 맥락 연결 응답 (후속 질문은 검사를 통과하는 문장) */
function contextReply({ messages }: { messages: Array<{ role: string; content: string }> }) {
  const user = messages.find((m) => m.role === "user")!.content;
  const resume = [RESUME_X, RESUME_Y].find((lines) => user.includes(lines[1]!.slice(2)))!;
  return {
    output: {
      links: [
        {
          claim: resume[1]!.replace(/^- /, ""),
          claimSource: "RESUME",
          evidence: null,
          observedInAssignment: null,
          status: "NEEDS_CHECK",
          followUpQuestion: "이력서의 경험과 이번 과제 구현의 실행 조건 차이는 무엇인가요?",
        },
      ],
      unassessedAreas: [],
    },
  };
}

function goodItem(slotId: string) {
  return {
    slotId,
    question: "이 동작을 함께 보겠습니다. 이 동작을 확인하는 코드는 어디에 있나요?",
    intent: "지원자가 코드 위치를 스스로 찾는지 확인한다.",
    probes: ["가장 먼저 볼 파일은 무엇인가요?", "그 파일을 고르는 기준은 무엇인가요?"],
    positiveSignals: ["코드 위치를 스스로 찾아 설명한다.", "요청 흐름을 순서대로 말한다."],
    concernSignals: ["코드를 보지 않고 추측한다.", "요청 흐름을 설명하지 않는다."],
  };
}

/** 슬롯 목록에서 첫 슬롯은 복합 질문, 둘째는 추궁 어조로 쓰고, 없는 슬롯 하나를 섞는다. 나머지는 검사를 통과한다 */
function kitReply({ messages }: { messages: Array<{ role: string; content: string }> }) {
  const user = messages.find((m) => m.role === "user")!.content;
  const slotIds = [...user.matchAll(/^### (\S+) · /gm)].map((m) => m[1]!);
  const [first, second, ...rest] = slotIds;
  return {
    output: {
      questions: [
        {
          ...goodItem(first!),
          question: "어떤 저장소로 구현했고, 충돌 재시도 조건은 어떻게 달랐나요?",
        },
        {
          ...goodItem(second!),
          question: "이번 과제에서는 왜 그 조건이 테스트에 들어가지 않았는지 설명해 주시겠어요?",
        },
        goodItem("FAILURE_DEBRIEF:R-99"),
        ...rest.map(goodItem),
      ],
    },
  };
}

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

describe.skipIf(!hasTestDb)("INTERVIEW_KIT 인터뷰 키트 (interview-kit, DB 통합)", () => {
  let tdb: TestDatabase;
  let assignmentVersionId: string;
  let github: ReturnType<typeof fakeGitHub>;
  let workRoot: string;
  let store: FsArtifactStore;
  const logger = createLogger({ destination: { write: () => {} }, level: "silent" });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-interview-kit-"));
    store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
    const rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    const contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    const specText = await readFile(path.join(SAMPLES_DIR, "SPEC.md"), "utf8");
    const specRef = "assignments/t702/specs/spec.md";
    await store.put(specRef, specText, { contentType: "text/markdown" });
    const assignment = await createAssignment(tdb.db, { name: "T-702 테스트 과제" });
    const draft = await createAssignmentVersion(tdb.db, {
      assignmentId: assignment.id,
      title: "주문 API v1",
      specRef,
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
    const c = await readTree(path.join(SAMPLES_DIR, "impl-c"));
    github = fakeGitHub({
      "acme/order-api": {
        defaultBranch: "main",
        refs: { a: SHA_A, c: SHA_C },
        tarballs: {
          [SHA_A]: () => makeGitHubStyleTarball(a, SHA_A),
          [SHA_C]: () => makeGitHubStyleTarball(c, SHA_C),
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  function fakeLlm() {
    return new FakeLlmClient({
      responses: {
        EVIDENCE_REVIEW: { output: { failures: [], designReviews: [], suggestions: [] } },
        CONTEXT_LINK: contextReply,
        INTERVIEW_KIT: kitReply,
      },
    });
  }

  /** 판정·점수·근거 수 (키트 단계 전후 비교용, 판정 digest와 같은 대상) */
  async function judgment(evaluationId: string) {
    const rows = await listCriterionResults(tdb.db, evaluationId);
    const evaluation = (await getEvaluation(tdb.db, evaluationId))!;
    return {
      score: [
        evaluation.scoreEarned,
        evaluation.scoreMin,
        evaluation.scoreMax,
        evaluation.scoreByArea,
      ],
      rows: rows
        .map((r) => [
          r.criterionId,
          r.verdict,
          r.earnedPoints,
          r.issueId,
          r.reviewState,
          r.evidenceIds,
        ])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    };
  }

  async function evaluate(
    ref: "a" | "c",
    resume: string[] | null,
    fake: FakeLlmClient,
    maxCalls = 20,
  ) {
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
    let beforeKit: Awaited<ReturnType<typeof judgment>> | null = null;
    const deps: PipelineDeps = {
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
        mutation: { enabled: false },
      },
      logger,
      hooks: {
        beforeStage: async (stage, evaluationId) => {
          if (stage === "INTERVIEW_KIT" && evaluationId) beforeKit = await judgment(evaluationId);
        },
      },
      llmForEvaluation: (evaluationId) =>
        createEvaluationLlmClient({
          base: fake,
          sink: createDbAiReviewSink(tdb.db),
          scope: { evaluationId },
          limits: { maxCalls, maxCostUsd: 1 },
        }),
    };
    const result = await runEvaluationPipeline(
      { submissionId: submission.id, attempt: 1, maxAttempts: 3 },
      deps,
    );
    expect(result.submissionStatus, describeStageLog(result.stageLog)).toBe("COMPLETED");
    const evaluationId = result.evaluationId!;
    const evaluation = (await getEvaluation(tdb.db, evaluationId))!;
    const stage = evaluation.stageLog.find((s) => s.stage === "INTERVIEW_KIT")!;
    const object = await store.get(artifactKeys.interviewKit(evaluationId));
    expect(object, "키트 아티팩트가 저장되어야 한다").not.toBeNull();
    const kit = InterviewKitSchema.parse(JSON.parse(Buffer.from(object!.body).toString("utf8")));
    expect(beforeKit, "INTERVIEW_KIT 직전 판정을 기록해야 한다").not.toBeNull();
    // 키트 유무로 판정·점수가 달라지지 않는다
    expect(await judgment(evaluationId)).toEqual(beforeKit);
    return { evaluationId, stage, kit, rows: await listCriterionResults(tdb.db, evaluationId) };
  }

  const shape = (kit: InterviewKit) => ({
    questions: kit.questions.map((q) => [q.id, q.kind, q.priority, q.minutes, q.competency]),
    plans: kit.plans,
  });

  let cX: Awaited<ReturnType<typeof evaluate>>;
  let cY: Awaited<ReturnType<typeof evaluate>>;
  let fakeX: FakeLlmClient;

  it("C: FAIL 기준마다 실패 디브리핑 슬롯이 생기고 상위 2개가 필수다. 버린 LLM 항목은 기본 질문으로 채우고 사유를 남긴다", async () => {
    fakeX = fakeLlm();
    cX = await evaluate("c", RESUME_X, fakeX);
    const { stage, kit, rows } = cX;
    expect(stage.state).toBe("DONE");
    expect(stage.reason ?? null).toBeNull();

    const failed = rows
      .filter((r) => r.verdict === "FAIL" && r.method === "EXECUTION")
      .map((r) => r.criterionId)
      .sort();
    expect(failed).toEqual(["R-05", "R-06", "R-07"]);
    const debrief = kit.questions.filter((q) => q.kind === "FAILURE_DEBRIEF");
    const covered = debrief
      .flatMap((q) => q.refs)
      .flatMap((r) => (r.kind === "CRITERION" ? [r.criterionId] : []))
      .sort();
    expect(covered).toEqual(failed);
    expect(debrief.map((q) => q.id)).toEqual([
      "FAILURE_DEBRIEF:R-05",
      "FAILURE_DEBRIEF:R-06",
      "FAILURE_DEBRIEF:R-07",
    ]);
    expect(debrief.map((q) => q.priority)).toEqual(["MUST", "MUST", "SHOULD"]);
    // 실패 디브리핑은 재생 기록(실행 기록)을 근거로 가리킨다
    for (const q of debrief) expect(q.refs.some((r) => r.kind === "EXECUTION_RECORD")).toBe(true);

    // 첫 슬롯(복합 질문)·둘째 슬롯(추궁 어조)·없는 슬롯만 버렸다
    const detail = stage.detail as { dropped: InterviewKit["generation"]["dropped"] };
    expect(detail.dropped).toEqual([
      {
        index: 0,
        slotId: kit.questions[0]!.id,
        reason: "LINT_VIOLATION",
        rules: ["COMPOUND_QUESTION"],
      },
      {
        index: 1,
        slotId: kit.questions[1]!.id,
        reason: "LINT_VIOLATION",
        rules: ["ACCUSATORY_TONE"],
      },
      { index: 2, slotId: "FAILURE_DEBRIEF:R-99", reason: "UNKNOWN_SLOT", rules: [] },
    ]);
    expect(kit.questions[0]!.source).toBe("TEMPLATE");
    expect(kit.questions[0]!.question).toBe(
      "R-05 재생 기록을 함께 보겠습니다. 기대한 응답과 실제 응답이 달라진 원인을 코드에서 짚어 주시겠어요?",
    );
    expect(kit.questions[1]!.source).toBe("TEMPLATE");
    const llmWritten = kit.questions.filter(
      (q) => q.kind !== "RESUME_BRIDGE" && q.source === "LLM",
    );
    expect(llmWritten.length).toBe(
      kit.questions.filter((q) => q.kind !== "RESUME_BRIDGE").length - 2,
    );
    expect(stage.detail).toMatchObject({
      llm: "OK",
      templateCount: 2,
      slotCount: kit.questions.length,
      artifactKey: artifactKeys.interviewKit(cX.evaluationId),
    });
    expect(kit.generation.aiReviewId).not.toBeNull();

    // 이력서 연결 슬롯은 맥락 연결의 질문을 그대로 쓰고, 이 단계의 LLM 입력에는 이력서가 없다
    const bridge = kit.questions.filter((q) => q.kind === "RESUME_BRIDGE");
    expect(bridge.map((q) => q.question)).toEqual([
      "이력서의 경험과 이번 과제 구현의 실행 조건 차이는 무엇인가요?",
    ]);
    const kitCalls = fakeX.sent.filter((c) => c.purpose === "INTERVIEW_KIT");
    expect(kitCalls).toHaveLength(1);
    const user = kitCalls[0]!.messages.find((m) => m.role === "user")!.content;
    expect(user).not.toContain("idempotent payment endpoints");
    expect(user).not.toContain("Alex Kim");
    expect(user).not.toContain("이력서의 경험과");
    expect(user).toContain("제목: 주문 API v1");
  }, 240_000);

  it("같은 스냅샷을 이력서 Y로 평가해도 INTERVIEW_KIT의 LLM 입력 다이제스트와 질문 계획이 같다", async () => {
    const fakeY = fakeLlm();
    cY = await evaluate("c", RESUME_Y, fakeY);
    expect(cX.kit.generation.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(cY.kit.generation.inputDigest).toBe(cX.kit.generation.inputDigest);
    const [reviewsX, reviewsY] = await Promise.all(
      [cX, cY].map((r) =>
        listAiReviews(tdb.db, { evaluationId: r.evaluationId, kind: "INTERVIEW_KIT" }),
      ),
    );
    expect(reviewsX!.map((r) => r.inputDigest)).toEqual([cX.kit.generation.inputDigest]);
    expect(reviewsY!.map((r) => r.inputDigest)).toEqual([cX.kit.generation.inputDigest]);
    // 맥락 연결 입력은 이력서가 달라 다르다
    const [ctxX, ctxY] = await Promise.all(
      [cX, cY].map((r) =>
        listAiReviews(tdb.db, { evaluationId: r.evaluationId, kind: "CONTEXT_LINK" }),
      ),
    );
    expect(ctxX![0]!.inputDigest).not.toBe(ctxY![0]!.inputDigest);
    expect(shape(cY.kit)).toEqual(shape(cX.kit));
  }, 240_000);

  it("A: 이력서 없이 제출해도 키트가 저장되고, 실패 디브리핑 없이 강점 확인 2개와 요구사항 확장 1개가 필수다", async () => {
    const { stage, kit } = await evaluate("a", null, fakeLlm());
    expect(stage.state).toBe("DONE");
    expect(kit.questions.filter((q) => q.kind === "FAILURE_DEBRIEF")).toHaveLength(0);
    expect(kit.questions.filter((q) => q.kind === "RESUME_BRIDGE")).toHaveLength(0);
    const must = kit.questions.filter((q) => q.priority === "MUST");
    expect(must.map((q) => q.kind)).toEqual(["STRENGTH_DEPTH", "STRENGTH_DEPTH", "EXTENSION"]);
    expect(kit.plans.map((p) => p.durationMinutes)).toEqual([45, 60]);
  }, 240_000);

  it("예산 초과: 모든 슬롯이 기본 질문이고 단계는 DONE + 사유다", async () => {
    const fake = fakeLlm();
    const { stage, kit } = await evaluate("c", RESUME_X, fake, 0);
    expect(stage.state).toBe("DONE");
    expect(stage.reason).toBe("LLM 미실행(예산 초과)");
    expect(kit.questions.length).toBeGreaterThan(0);
    // 이력서 연결 질문은 맥락 연결 단계가 만들지 못해 없다
    expect(kit.questions.every((q) => q.source === "TEMPLATE")).toBe(true);
    expect(kit.generation).toMatchObject({
      llm: "NOT_RUN",
      llmReason: "LLM 미실행(예산 초과)",
      inputDigest: null,
      templateCount: kit.questions.length,
      dropped: [],
    });
    expect(fake.sent.filter((c) => c.purpose === "INTERVIEW_KIT")).toHaveLength(0);
    // 계획은 LLM과 무관하게 같다
    const planOf = (k: InterviewKit) =>
      shape(k)
        .questions.filter((q) => q[1] !== "RESUME_BRIDGE")
        .map((q) => q.join("|"));
    expect(planOf(kit)).toEqual(planOf(cX.kit));
  }, 240_000);
});
