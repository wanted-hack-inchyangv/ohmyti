/**
 * CONTEXT_LINK 실제 LLM 1회 실행 CLI (T-503 사람 확인 준비). 샘플 하나(기본 C)를 임시 DB·로컬 러너로 전체 파이프라인에 넣고,
 * 워커와 같은 evaluation LLM 클라이언트(예산·`ai_reviews` 기록)로 맥락 연결을 실행한 뒤 결과를 JSON으로 남긴다.
 * 변형 실험(TEST_EFFECTIVENESS)은 끈다. 이력서는 텍스트 PDF로 만들어 넣고(기본은 `sampleResumeLines`), GitHub 로그인을 주면
 * 실제 GitHub API로 보충 조회한다(`GITHUB_TOKEN` 권장).
 *
 *   pnpm --filter @ohmyti/worker exec tsx src/context-link/cli.ts [a|b|c|d] [--resume <텍스트 파일>] [--github <login>] [--out <result.json>]
 *
 * 필요: `DATABASE_URL_TEST`(임시 DB를 만들 서버), LLM 설정(`DEEP_SEEK_API_KEY` …, 저장소 루트 `.env.local`·`.env`).
 * 결과 JSON에는 사람이 품질을 검토할 수 있도록 claim·후속 질문 원문이 들어간다. 이력서에 실제 개인정보를 넣지 않는다.
 */
import { ContextLinkSummarySchema, ExecutionContractSchema, RubricSchema } from "@ohmyti/core";
import {
  CONTEXT_LINK_PROMPT,
  createGitHubSourcesCollector,
  loadGitHubProfileConfig,
} from "@ohmyti/context";
import { buildTextPdf, sampleResumeLines } from "@ohmyti/context/testing";
import {
  approveAssignmentVersion,
  createAssignment,
  createAssignmentVersion,
  createSubmission,
  createTestDatabase,
  getEvaluation,
  listAiReviews,
  listContextLinks,
  listCriterionResults,
  startAssignmentVersionValidation,
  toContextLink,
  upsertSubmissionContext,
  type CriterionResultRow,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import {
  createDbAiReviewSink,
  createEvaluationLlmClient,
  llmBudgetLimitsFromEnv,
} from "@ohmyti/llm";
import { LOCAL_RUNNER_DEFAULTS, LocalProcessRunner } from "@ohmyti/runner";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../env";
import { createWorkerLlmClient } from "../llm";
import { createLogger } from "../logger";
import { runEvaluationPipeline } from "../pipeline";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";

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

const verdictFields = (rows: CriterionResultRow[]) =>
  rows.map((r) => ({
    criterionId: r.criterionId,
    earnedPoints: r.earnedPoints,
    verdict: r.verdict,
    observation: r.observation,
  }));

function takeOption(args: string[], name: string): string | undefined | null {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value ?? null;
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const outPath = takeOption(args, "--out");
  const resumePath = takeOption(args, "--resume");
  const githubLogin = takeOption(args, "--github");
  const sample = (args[0] ?? "c") as (typeof SAMPLES)[number];
  if (
    !SAMPLES.includes(sample) ||
    outPath === null ||
    resumePath === null ||
    githubLogin === null
  ) {
    console.error(
      "사용법: tsx src/context-link/cli.ts [a|b|c|d] [--resume <텍스트 파일>] [--github <login>] [--out <result.json>]",
    );
    return 1;
  }
  loadEnv();
  const base = createWorkerLlmClient(process.env);
  const limits = llmBudgetLimitsFromEnv(process.env);
  const resumeLines = resumePath
    ? (await readFile(path.resolve(process.cwd(), resumePath), "utf8")).split("\n")
    : sampleResumeLines();
  const profile = loadGitHubProfileConfig(process.env);
  const tdb = await createTestDatabase();
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-context-cli-"));
  try {
    const rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    const contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    const assignment = await createAssignment(tdb.db, { name: "T-503 실제 LLM 실행" });
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
      approvedBy: "context-link-cli",
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
    const resumeRef = artifactKeys.resume(submission.id);
    await store.put(resumeRef, buildTextPdf([resumeLines]), {
      contentType: ARTIFACT_CONTENT_TYPES.resume,
    });
    await upsertSubmissionContext(tdb.db, submission.id, {
      resumeRef,
      ...(githubLogin ? { githubLogin } : {}),
    });

    let before: ReturnType<typeof verdictFields> = [];
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
        githubSources: createGitHubSourcesCollector({
          token: profile.token,
          maxRepos: profile.maxRepos,
        }),
        hooks: {
          beforeStage: async (stage, evaluationId) => {
            if (stage === "CONTEXT_LINK" && evaluationId) {
              before = verdictFields(await listCriterionResults(tdb.db, evaluationId));
            }
          },
        },
      },
    );
    const finishedAt = new Date();
    const evaluationId = result.evaluationId!;
    const evaluation = (await getEvaluation(tdb.db, evaluationId))!;
    const stage = evaluation.stageLog.find((s) => s.stage === "CONTEXT_LINK")!;
    const rows = await listCriterionResults(tdb.db, evaluationId);
    const unchanged = JSON.stringify(verdictFields(rows)) === JSON.stringify(before);
    const reviews = await listAiReviews(tdb.db, { evaluationId, kind: "CONTEXT_LINK" });
    const summary = ContextLinkSummarySchema.safeParse(stage.detail?.contextLink);
    const links = (await listContextLinks(tdb.db, submission.id)).map(toContextLink);
    const record = {
      kind: "context_link_run",
      sample,
      provider: base.provider,
      requestedModel: base.model,
      promptVersion: CONTEXT_LINK_PROMPT.promptVersion,
      githubLogin: githubLogin ?? null,
      startedAt: startedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      submissionStatus: result.submissionStatus,
      criteriaUnchanged: unchanged,
      stage: { state: stage.state, reason: stage.reason ?? null },
      github: stage.detail?.github ?? null,
      calls: reviews.map((r) => ({
        version: r.version,
        model: r.model,
        inputDigest: r.inputDigest,
        usage: r.usage,
        costUsd: Number(r.costUsd),
      })),
      summary: summary.success ? summary.data : (stage.detail?.contextLink ?? null),
      rawOutput: reviews.at(-1)?.output ?? null,
      links: links.map((l) => ({
        claim: l.claim,
        status: l.status,
        githubEvidence: l.githubEvidence ?? null,
        assignmentObservation: l.assignmentObservation ?? null,
        followUpQuestion: l.followUpQuestion ?? null,
      })),
    };
    const json = `${JSON.stringify(record, null, 2)}\n`;
    if (outPath) await writeFile(path.resolve(process.cwd(), outPath), json);
    else process.stdout.write(json);
    console.error(
      `CONTEXT_LINK ${stage.state}${stage.reason ? ` (${stage.reason})` : ""} · 연결 ${links.length}건 · 판정 불변 ${unchanged}`,
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
