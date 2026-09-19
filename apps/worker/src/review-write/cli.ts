/**
 * REVIEW_WRITE 실제 LLM 1회 실행 CLI (T-407 사람 확인 준비). 샘플 하나(기본 C)를 임시 DB·로컬 러너로 전체 파이프라인에 넣고
 * 워커와 같은 evaluation LLM 클라이언트(예산·`ai_reviews` 기록)로 REVIEW_WRITE를 실행한 뒤 결과를 JSON으로 남긴다.
 * 변형 실험(TEST_EFFECTIVENESS)은 끈다. 이 실행은 REVIEW_WRITE 전후만 본다.
 *
 *   pnpm --filter @ohmyti/worker exec tsx src/review-write/cli.ts [c|d|a|b] [--out <result.json>]
 *
 * 필요: `DATABASE_URL_TEST`(임시 DB를 만들 서버), LLM 설정(`DEEP_SEEK_API_KEY` …, 저장소 루트 `.env.local`·`.env`).
 */
import { ExecutionContractSchema, RubricSchema, ReviewWriteSummarySchema } from "@ohmyti/core";
import {
  approveAssignmentVersion,
  createAssignment,
  createAssignmentVersion,
  createSubmission,
  createTestDatabase,
  getEvaluation,
  listAiReviews,
  listCriterionResults,
  listEvidences,
  startAssignmentVersionValidation,
  type CriterionResultRow,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import {
  createDbAiReviewSink,
  createEvaluationLlmClient,
  llmBudgetLimitsFromEnv,
} from "@ohmyti/llm";
import { LOCAL_RUNNER_DEFAULTS, LocalProcessRunner } from "@ohmyti/runner";
import { FsArtifactStore } from "@ohmyti/storage";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../env";
import { createWorkerLlmClient } from "../llm";
import { createLogger } from "../logger";
import { runEvaluationPipeline } from "../pipeline";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import { EVIDENCE_REVIEW_PROMPT } from "./prompt";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SAMPLES = ["a", "b", "c", "d"] as const;

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

const scoreFields = (rows: CriterionResultRow[]) =>
  rows.map((r) => ({
    criterionId: r.criterionId,
    earnedPoints: r.earnedPoints,
    verdict: r.verdict,
    observation: r.observation,
  }));

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (outIndex >= 0) args.splice(outIndex, 2);
  const sample = (args[0] ?? "c") as (typeof SAMPLES)[number];
  if (!SAMPLES.includes(sample) || (outIndex >= 0 && !outPath)) {
    console.error("사용법: tsx src/review-write/cli.ts [a|b|c|d] [--out <result.json>]");
    return 1;
  }
  loadEnv();
  const base = createWorkerLlmClient(process.env);
  const limits = llmBudgetLimitsFromEnv(process.env);
  const tdb = await createTestDatabase();
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-review-cli-"));
  try {
    const rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    const contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    const assignment = await createAssignment(tdb.db, { name: "T-407 실제 LLM 실행" });
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
    const approved = await approveAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "review-write-cli",
      validationResult: { ok: true },
    });
    const sha = sample.repeat(40);
    const files = await readTree(path.join(SAMPLES_DIR, `impl-${sample}`));
    const github = fakeGitHub({
      "acme/order-api": {
        defaultBranch: "main",
        refs: { [sample]: sha },
        tarballs: { [sha]: () => makeGitHubStyleTarball(files, sha) },
      },
    });
    const store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId: approved.id,
      repoUrl: "https://github.com/acme/order-api",
      repoRef: sample,
    });
    let before: ReturnType<typeof scoreFields> = [];
    const startedAt = new Date();
    const result = await runEvaluationPipeline(
      { submissionId: submission.id, attempt: 1, maxAttempts: 1 },
      {
        db: tdb.db,
        store,
        runner: new LocalProcessRunner({
          config: { ...LOCAL_RUNNER_DEFAULTS, templateRoot: TEMPLATE_ROOT, workRoot },
          artifactStore: store,
        }),
        github: createGitHubClient({ fetch: github.fetch }),
        config: {
          stageTimeoutMs: 300_000,
          requestTimeoutMs: 5000,
          templateRoot: TEMPLATE_ROOT,
          repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
          workRoot,
          mutation: { enabled: false },
        },
        logger: createLogger({
          level: "warn",
          destination: { write: (line: string) => process.stderr.write(line) },
        }),
        llmForEvaluation: (evaluationId) =>
          createEvaluationLlmClient({
            base,
            sink: createDbAiReviewSink(tdb.db),
            scope: { evaluationId },
            limits,
          }),
        hooks: {
          beforeStage: async (stage, evaluationId) => {
            if (stage === "REVIEW_WRITE" && evaluationId) {
              before = scoreFields(await listCriterionResults(tdb.db, evaluationId));
            }
          },
        },
      },
    );
    const finishedAt = new Date();
    const evaluationId = result.evaluationId!;
    const evaluation = (await getEvaluation(tdb.db, evaluationId))!;
    const stage = evaluation.stageLog.find((s) => s.stage === "REVIEW_WRITE")!;
    const rows = await listCriterionResults(tdb.db, evaluationId);
    const evidences = await listEvidences(tdb.db, evaluationId);
    const reviews = await listAiReviews(tdb.db, { evaluationId, kind: "EVIDENCE_REVIEW" });
    const summary = ReviewWriteSummarySchema.safeParse(stage.detail);
    const unchanged = JSON.stringify(scoreFields(rows)) === JSON.stringify(before);
    const record = {
      kind: "review_write_run",
      sample,
      provider: base.provider,
      requestedModel: base.model,
      promptVersion: EVIDENCE_REVIEW_PROMPT.promptVersion,
      startedAt: startedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      submissionStatus: result.submissionStatus,
      criteriaUnchanged: unchanged,
      stage: { state: stage.state, reason: stage.reason ?? null },
      calls: reviews.map((r) => ({
        version: r.version,
        model: r.model,
        inputDigest: r.inputDigest,
        usage: r.usage,
        costUsd: Number(r.costUsd),
      })),
      summary: summary.success ? summary.data : stage.detail,
      interpretations: rows
        .filter((r) => r.interpretation !== null)
        .map((r) => ({
          criterionId: r.criterionId,
          verdict: r.verdict,
          interpretation: r.interpretation,
        })),
      llmEvidences: evidences
        .filter((e) => e.kind === "LLM_INTERPRETATION")
        .map((e) => ({ source: e.source, detail: e.detail, snippet: e.snippet })),
      criteria: scoreFields(rows).map(({ observation: _o, ...rest }) => rest),
    };
    const json = `${JSON.stringify(record, null, 2)}\n`;
    if (outPath) await writeFile(path.resolve(process.cwd(), outPath), json);
    else process.stdout.write(json);
    console.error(
      `REVIEW_WRITE ${stage.state}${stage.reason ? ` (${stage.reason})` : ""} · 추정 ${record.interpretations.length}건 · LLM 근거 ${record.llmEvidences.length}건 · 판정 불변 ${unchanged}`,
    );
    return stage.state === "DONE" && unchanged ? 0 : 2;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
    await tdb.destroy();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
