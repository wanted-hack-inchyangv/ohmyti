/**
 * 4단계 게이트 (TICKET.md T-408): `pnpm gate:phase4`.
 *
 * 로컬 스택(임시 PostgreSQL DB + LocalProcessRunner + fs 아티팩트 스토어)에서 워커의 실제 job 경로로 4단계 전체를 돌린다.
 *
 * 1. 과제 v1(DRAFT)과 검증 샘플 A/B/C/D(스냅샷 + 기대 결과표)를 만든다. 샘플 서명(`human_reviewed_by`)은 비워 둔다.
 * 2. `VALIDATE_RUBRIC` job을 큐에 넣고 워커 핸들러로 처리한다: 검증 샘플마다 하네스 + 제출 테스트 + mutation을 실행하고
 *    기대 결과표와 대조한다. 검증 실행은 REVIEW_WRITE를 건너뛰므로 LLM은 mutation 위치 제안에만 쓰인다.
 * 3. 승인 흐름: 서명 없으면 차단 → (임시 DB 픽스처로) 서명 → 승인자 공백 차단 → 승인. 이어서 R-11에 express 의존성
 *    정적 검사를 넣은 v2를 검증해 B 불일치로 승인이 막히는지 본다 (v2 검증은 LLM 없이 돈다).
 * 4. 승인된 v1에 A/B/C/D를 실제 제출로 넣고 `EVALUATE_SUBMISSION` job을 워커 핸들러로 처리한다: 저장소 수집(가짜 GitHub
 *    tarball) → 전체 파이프라인 → LLM 근거 리뷰(REVIEW_WRITE). LLM은 `DEEP_SEEK_API_KEY`가 있으면 실제 DeepSeek, 없으면 Fake다.
 * 5. 게이트 대조(`checks.ts`): 기대 결과표 일치, B 전체 PASS·G1~G3 만점, D 점수 = C 점수, LLM 단계 전후 판정 불변, 승인 흐름.
 * 6. `docs/gates/phase4-gate.json`과 `docs/gates/phase4.md`의 게이트 절(표식 사이)을 다시 쓴다.
 *
 *   pnpm gate:phase4 [--fake] [--no-write] [--json <path>] [--md <path>]
 *
 * 필요: `DATABASE_URL_TEST`(임시 DB를 만들 서버). 종료 코드: 0 = 모든 대조 통과, 1 = 실패·오류.
 * 판정은 파이프라인이 한다. 이 스크립트는 결과를 읽고 대조만 한다 (G-01, G-07).
 */
import {
  RubricSchema,
  ReviewWriteSummarySchema,
  type Rubric,
  type ValidationResult,
} from "@ohmyti/core";
import {
  ExecutionContractSchema,
  ValidationResultSchema,
  type ValidationSampleActual,
} from "@ohmyti/core";
import {
  AssignmentError,
  approveValidatedAssignmentVersion,
  checkAssignmentVersionApproval,
  claimJob,
  completeJob,
  createAssignment,
  createAssignmentVersion,
  createDraftFromVersion,
  createSubmission,
  createTestDatabase,
  enqueueSubmissionEvaluation,
  getAssignmentVersion,
  getEvaluation,
  listAiReviews,
  listCriterionResults,
  requestAssignmentVersionValidation,
  stageRecordOf,
  validationSamples,
  type AssignmentVersionRow,
  type CriterionResultRow,
  type Database,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import type { LlmClient } from "@ohmyti/llm";
import { LOCAL_RUNNER_DEFAULTS, LocalProcessRunner, packDirectoryToTarGz } from "@ohmyti/runner";
import { ARTIFACT_CONTENT_TYPES, FsArtifactStore } from "@ohmyti/storage";
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { loadEnv } from "../env";
import { createWorkerLlmClient } from "../llm";
import { createLogger } from "../logger";
import {
  createEvaluateSubmissionHandler,
  createLlmForEvaluation,
  type PipelineConfig,
  type PipelineHooks,
} from "../pipeline";
import type { JobContext, JobHandler } from "../registry";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import { collectSampleActual, createValidateRubricHandler } from "../validate-rubric";
import {
  checkAdversarial,
  checkAlternative,
  checkApprovalFlow,
  checkLlm,
  checkMatrix,
  GATE_SAMPLE_IDS,
  GATE_SAMPLE_KIND,
  GateMatrixSchema,
  type ApprovalFlowObservation,
  type GateCheck,
  type GateLlmSample,
  type GateSampleId,
} from "./checks";
import { renderGateMarkdown, replaceGateSection, type GateRecord } from "./report";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const DEFAULT_JSON = path.join(REPO_ROOT, "docs/gates/phase4-gate.json");
const DEFAULT_MD = path.join(REPO_ROOT, "docs/gates/phase4.md");
const WORKER_ID = "gate-phase4";
/** 임시 DB에서만 쓰는 샘플 서명. 실제 서명(expected-matrix `reviewedBy`)은 T-101 사람 확인이다 */
const FIXTURE_REVIEWER = "gate:phase4 (임시 DB 픽스처 서명)";
const APPROVER = "gate:phase4";

/** Fake 모드 응답: mutation 위치 후보 없음(AST 휴리스틱만), 근거 리뷰는 빈 결과 */
const FAKE_RESPONSES = {
  MUTATION_TARGETS: { output: { candidates: [] } },
  EVIDENCE_REVIEW: { output: { failures: [], designReviews: [], suggestions: [] } },
};

type ScoreFields = Array<
  Pick<CriterionResultRow, "criterionId" | "earnedPoints" | "verdict" | "observation">
>;
const scoreFields = (rows: CriterionResultRow[]): ScoreFields =>
  rows.map((r) => ({
    criterionId: r.criterionId,
    earnedPoints: r.earnedPoints,
    verdict: r.verdict,
    observation: r.observation,
  }));

function blockerCodes(error: unknown): string[] {
  if (!(error instanceof AssignmentError)) throw error;
  const details = error.details as { blockers?: Array<{ code: string }> } | undefined;
  return details?.blockers?.map((b) => b.code) ?? [error.code];
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      fake: { type: "boolean", default: false },
      "no-write": { type: "boolean", default: false },
      json: { type: "string" },
      md: { type: "string" },
    },
  });
  loadEnv();
  const jsonOut = values.json
    ? path.resolve(process.env.INIT_CWD ?? process.cwd(), values.json)
    : DEFAULT_JSON;
  const mdOut = values.md
    ? path.resolve(process.env.INIT_CWD ?? process.cwd(), values.md)
    : DEFAULT_MD;
  const logger = createLogger({
    level: "warn",
    destination: { write: (line: string) => process.stderr.write(line) },
  });

  const workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-gate-phase4-"));
  const realLlm =
    !values.fake &&
    Boolean(process.env.DEEP_SEEK_API_KEY?.trim()) &&
    (process.env.LLM_PROVIDER ?? "deepseek") !== "fake";
  const llmEnv: Record<string, string | undefined> = { ...process.env };
  if (!realLlm) {
    const fakeFile = path.join(workRoot, "llm-fake-responses.json");
    await writeFile(fakeFile, JSON.stringify(FAKE_RESPONSES));
    llmEnv.LLM_PROVIDER = "fake";
    llmEnv.LLM_FAKE_RESPONSES_FILE = fakeFile;
  }
  // 설정 오류는 여기서 드러낸다 (createLlmForEvaluation은 경고만 남기고 LLM 없이 돈다)
  const base: LlmClient = createWorkerLlmClient(llmEnv);
  const llm = createLlmForEvaluation(llmEnv, logger);
  console.error(
    `[gate:phase4] LLM ${realLlm ? "실제" : "Fake"} (${base.provider}/${base.model})${realLlm ? "" : values.fake ? " · --fake" : " · DEEP_SEEK_API_KEY 없음"}`,
  );

  const tdb = await createTestDatabase();
  const startedAt = new Date();
  try {
    const db = tdb.db;
    const store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
    const runner = new LocalProcessRunner({
      config: { ...LOCAL_RUNNER_DEFAULTS, templateRoot: TEMPLATE_ROOT, workRoot },
      artifactStore: store,
    });
    // 검증 샘플은 저장소가 아니라 스냅샷을 채점한다. GitHub 호출이 생기면 오류다
    const github = createGitHubClient({
      fetch: () => Promise.reject(new Error("gate:phase4는 GitHub를 호출하지 않습니다")),
    });
    const config: PipelineConfig = {
      stageTimeoutMs: 300_000,
      requestTimeoutMs: 5000,
      templateRoot: TEMPLATE_ROOT,
      repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
      workRoot,
    };
    const before = new Map<string, ScoreFields>();
    const reviewHooks: PipelineHooks = {
      beforeStage: async (stage, evaluationId) => {
        if (stage === "REVIEW_WRITE" && evaluationId) {
          before.set(evaluationId, scoreFields(await listCriterionResults(db, evaluationId)));
        }
      },
    };
    // 검증 실행은 mutation 위치 제안에만 LLM을 쓴다 (REVIEW_WRITE는 검증 실행에서 건너뛴다, T-407)
    const validateWithLlm = createValidateRubricHandler({ runner, github, config, llm });
    const validateWithoutLlm = createValidateRubricHandler({ runner, github, config });
    const ctx: JobContext = {
      logger,
      db,
      store,
      heartbeat: () => Promise.resolve(),
      signal: new AbortController().signal,
      workerId: WORKER_ID,
    };

    const rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    const contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    const matrix = GateMatrixSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "expected-matrix.json"), "utf8")),
    );
    const harnessVersion = harnessVersionOf(getCaseSet(DEFAULT_CASE_SET));

    // 1. 과제 v1 + 검증 샘플 (서명 없음)
    const assignment = await createAssignment(db, { name: "T-408 4단계 게이트" });
    const v1Draft = await createAssignmentVersion(db, {
      assignmentId: assignment.id,
      title: "주문·재고 API v1",
      specRef: `assignments/${assignment.id}/specs/spec.md`,
      specDigest: createHash("sha256")
        .update(await readFile(path.join(SAMPLES_DIR, "SPEC.md")))
        .digest("hex"),
      rubric,
      executionContract: contract,
      harnessVersion,
    });
    for (const sample of matrix.samples) {
      const tarGz = await packDirectoryToTarGz(path.join(SAMPLES_DIR, sample.dir));
      const snapshotRef = `assignments/${assignment.id}/versions/1/samples/${sample.id}/snapshot.tar.gz`;
      await store.put(snapshotRef, tarGz, { contentType: ARTIFACT_CONTENT_TYPES.snapshot });
      await db.insert(validationSamples).values({
        assignmentVersionId: v1Draft.id,
        name: sample.name,
        kind: GATE_SAMPLE_KIND[sample.id],
        snapshotRef,
        submissionSha: createHash("sha1").update(tarGz).digest("hex"),
        expected: {
          criteria: sample.criteria,
          mutations: sample.mutations,
          submittedTests: sample.submittedTests,
          scoreDisplay: sample.scoreDisplay,
        },
      });
    }

    // 2. VALIDATE_RUBRIC job (실제 큐 → 워커 핸들러)
    const validate = async (versionId: string, handler: JobHandler) => {
      await requestAssignmentVersionValidation(db, versionId);
      const job = await claimJob(db, { workerId: WORKER_ID, types: ["VALIDATE_RUBRIC"] });
      if (!job) throw new Error("VALIDATE_RUBRIC job을 꺼내지 못했습니다");
      await handler(job, ctx);
      if (!(await completeJob(db, job.id, WORKER_ID))) throw new Error("job을 닫지 못했습니다");
      const version = (await getAssignmentVersion(db, versionId))!;
      return { version, result: ValidationResultSchema.parse(version.validationResult) };
    };
    console.error("[gate:phase4] v1 채점기 검증: 검증 샘플 A/B/C/D 실행 중");
    const v1Run = await validate(v1Draft.id, validateWithLlm);

    const scoreSubmissions = async (versionId: string) => {
      const files = await Promise.all(
        GATE_SAMPLE_IDS.map((id) =>
          readTree(path.join(SAMPLES_DIR, matrix.samples.find((s) => s.id === id)!.dir)),
        ),
      );
      const sha = (id: GateSampleId) => id.toLowerCase().repeat(40);
      const repoGithub = createGitHubClient({
        fetch: fakeGitHub({
          "acme/order-api": {
            defaultBranch: "main",
            refs: Object.fromEntries(GATE_SAMPLE_IDS.map((id) => [id.toLowerCase(), sha(id)])),
            tarballs: Object.fromEntries(
              GATE_SAMPLE_IDS.map((id, i) => [
                sha(id),
                () => makeGitHubStyleTarball(files[i]!, sha(id)),
              ]),
            ),
          },
        }).fetch,
      });
      const evaluateHandler = createEvaluateSubmissionHandler({
        runner,
        github: repoGithub,
        config,
        llm,
        hooks: reviewHooks,
      });
      const submissionIds = {} as Record<GateSampleId, string>;
      for (const id of GATE_SAMPLE_IDS) {
        console.error(`[gate:phase4] 제출 ${id} 채점 중`);
        const submission = await createSubmission(db, {
          assignmentVersionId: versionId,
          repoUrl: "https://github.com/acme/order-api",
          repoRef: id.toLowerCase(),
        });
        await enqueueSubmissionEvaluation(db, submission.id);
        const job = await claimJob(db, { workerId: WORKER_ID, types: ["EVALUATE_SUBMISSION"] });
        if (!job) throw new Error("EVALUATE_SUBMISSION job을 꺼내지 못했습니다");
        await evaluateHandler(job, ctx);
        if (!(await completeJob(db, job.id, WORKER_ID))) throw new Error("job을 닫지 못했습니다");
        submissionIds[id] = submission.id;
      }
      const version = (await getAssignmentVersion(db, versionId))!;
      const actuals = await collectActuals(db, submissionIds, version);
      const llmSamples = await collectLlm(db, actuals, before);
      return { actuals, llmSamples, version };
    };

    // 3. 승인 흐름 (v1 승인 → v2 express 필수 검증·차단)
    console.error("[gate:phase4] 승인 흐름과 v2(express 필수) 검증 실행 중");
    const flow = await approvalFlow(db, v1Run, rubric, (id) => validate(id, validateWithoutLlm));
    const checks: GateCheck[] = [];
    const samples: GateRecord["samples"] = [];
    if (flow.approvedStatus === "APPROVED" && flow.v1StatusAfterV2 === "APPROVED") {
      // 4. 승인된 v1에 샘플 A/B/C/D를 실제 제출로 넣는다 (저장소 수집 → 전체 파이프라인 → LLM 근거 리뷰)
      const { actuals, llmSamples, version } = await scoreSubmissions(v1Draft.id);

      // 5. 게이트 대조
      checks.push(
        checkMatrix(matrix, actuals),
        checkAlternative(version.rubric, actuals.B),
        checkAdversarial(actuals.C, actuals.D),
        checkLlm(llmSamples, realLlm),
      );
      for (const id of GATE_SAMPLE_IDS) {
        const expected = matrix.samples.find((s) => s.id === id)!;
        samples.push({
          id,
          name: expected.name,
          validationStatus:
            v1Run.result.perSample.find((p) => p.name === expected.name)?.status ?? null,
          scoreDisplay: actuals[id].scoreDisplay,
          expectedScoreDisplay: expected.scoreDisplay.beforeHumanReview,
          criteria: actuals[id].criteria,
          mutations: actuals[id].mutations,
          submittedTests: actuals[id].submittedTests,
          llm: llmSamples.find((s) => s.sampleId === id)!,
        });
      }
    } else {
      checks.push({
        id: "SUBMISSIONS",
        title: "승인된 v1에 A/B/C/D 실제 제출 채점",
        pass: false,
        detail: "v1이 승인되지 않아 실제 제출을 채점하지 않았다",
        problems: ["v1 미승인 (아래 승인 흐름의 불일치 참고)"],
      });
    }
    checks.push(checkApprovalFlow(flow));

    const finishedAt = new Date();
    const pass = checks.every((c) => c.pass);
    const record: GateRecord = {
      kind: "phase4_gate",
      pass,
      startedAt: startedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      environment: {
        node: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        runner: "local",
        database: "DATABASE_URL_TEST 서버의 임시 PostgreSQL DB",
      },
      llm: {
        mode: realLlm ? "real" : "fake",
        provider: base.provider,
        requestedModel: base.model,
      },
      rubricVersion: v1Run.version.rubricVersion,
      harnessVersion,
      matrixReviewedBy: matrix.reviewedBy,
      checks,
      samples,
      approvalFlow: flow,
    };

    for (const c of checks) {
      console.error(`${c.pass ? "PASS" : "FAIL"} ${c.id}: ${c.detail}`);
      for (const p of c.problems) console.error(`  - ${p}`);
    }
    if (!values["no-write"]) {
      await mkdir(path.dirname(jsonOut), { recursive: true });
      await writeFile(jsonOut, `${JSON.stringify(record, null, 2)}\n`);
      const existing = existsSync(mdOut) ? await readFile(mdOut, "utf8") : "";
      await writeFile(mdOut, replaceGateSection(existing, renderGateMarkdown(record)));
      await formatWithPrettier([jsonOut, mdOut]);
      console.error(
        `[gate:phase4] 기록: ${path.relative(REPO_ROOT, jsonOut)}, ${path.relative(REPO_ROOT, mdOut)}`,
      );
    }
    console.error(`[gate:phase4] ${pass ? "통과" : "실패"} (${record.durationMs}ms)`);
    return pass ? 0 : 1;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
    await tdb.destroy();
  }
}

async function collectActuals(
  db: Database,
  submissionIds: Record<GateSampleId, string>,
  version: AssignmentVersionRow,
): Promise<Record<GateSampleId, ValidationSampleActual>> {
  const total = version.rubric.criteria.reduce((sum, c) => sum + c.maxPoints, 0);
  const out = {} as Record<GateSampleId, ValidationSampleActual>;
  for (const id of GATE_SAMPLE_IDS) {
    out[id] = await collectSampleActual(db, submissionIds[id], null, total);
  }
  return out;
}

async function collectLlm(
  db: Database,
  actuals: Record<GateSampleId, ValidationSampleActual>,
  before: Map<string, ScoreFields>,
): Promise<GateLlmSample[]> {
  const out: GateLlmSample[] = [];
  for (const id of GATE_SAMPLE_IDS) {
    const evaluationId = actuals[id].evaluationId;
    const evaluation = evaluationId ? await getEvaluation(db, evaluationId) : null;
    const stage = evaluation ? stageRecordOf(evaluation.stageLog, "REVIEW_WRITE") : null;
    const summary = ReviewWriteSummarySchema.safeParse(stage?.detail);
    const reviews = evaluationId ? await listAiReviews(db, { evaluationId }) : [];
    const snapshot = evaluationId ? before.get(evaluationId) : undefined;
    const after = evaluationId ? scoreFields(await listCriterionResults(db, evaluationId)) : [];
    out.push({
      sampleId: id,
      evaluationId,
      reviewWriteState: stage?.state ?? null,
      reviewWriteReason: stage?.reason ?? null,
      reviewWriteLlm: summary.success ? summary.data.llm : null,
      reviewWriteError: summary.success ? summary.data.llmError : null,
      interpretations: summary.success
        ? summary.data.interpretations.map((i) => ({
            criterionId: i.criterionId,
            confidence: i.confidence,
            evidenceCount: i.evidenceIds.length,
            minimalRepro: i.minimalRepro.summary,
          }))
        : [],
      designSuggestions: summary.success
        ? summary.data.designSuggestions.map((d) => ({
            criterionId: d.criterionId,
            suggestedPoints: d.suggestedPoints,
            maxPoints: d.maxPoints,
          }))
        : [],
      suggestions: summary.success ? summary.data.suggestions.map((x) => x.title) : [],
      dropped: summary.success ? summary.data.dropped.length : 0,
      criteriaUnchanged: snapshot ? JSON.stringify(snapshot) === JSON.stringify(after) : null,
      calls: reviews.map((r) => ({
        kind: r.kind,
        model: r.model,
        promptVersion: r.promptVersion,
        costUsd: Number(r.costUsd),
      })),
    });
  }
  return out;
}

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

async function approvalFlow(
  db: Database,
  v1Run: { version: AssignmentVersionRow; result: ValidationResult },
  rubric: Rubric,
  validate: (
    versionId: string,
  ) => Promise<{ version: AssignmentVersionRow; result: ValidationResult }>,
): Promise<ApprovalFlowObservation> {
  const v1Id = v1Run.version.id;
  // 서명 없는 샘플이 있으면 검증 pass여도 막힌다
  const unsignedBlockers = (
    await checkAssignmentVersionApproval(db, { id: v1Id, approvedBy: APPROVER })
  ).map((b) => b.code);
  await db
    .update(validationSamples)
    .set({ humanReviewedBy: FIXTURE_REVIEWER, humanReviewedAt: new Date() })
    .where(eq(validationSamples.assignmentVersionId, v1Id));
  const blankApproverBlockers = await approveValidatedAssignmentVersion(db, {
    id: v1Id,
    approvedBy: "  ",
  }).then(() => [] as string[], blockerCodes);
  const approved = await approveValidatedAssignmentVersion(db, { id: v1Id, approvedBy: APPROVER })
    .then((r) => r.version.status as string)
    .catch((error: unknown) => `BLOCKED(${blockerCodes(error).join(",")})`);

  // v2: 같은 요구를 판정 조건 문장이 아니라 구조화된 정적 검사로 넣는다 (문장의 라이브러리 이름은 validateRubric이 거부)
  const rubricV2: Rubric = {
    ...rubric,
    criteria: rubric.criteria.map((c) =>
      c.id === "R-11"
        ? {
            ...c,
            condition: `${c.condition} 웹 서버 의존성으로 지정한 패키지를 package.json에 선언한다.`,
            staticChecks: [{ kind: "DEPENDENCY_DECLARED" as const, packageName: "express" }],
          }
        : c,
    ),
  };
  let v2: ApprovalFlowObservation["v2Pass"] = null;
  let v2Status: string | null = null;
  let v2Mismatches: ApprovalFlowObservation["v2Mismatches"] = [];
  let v2Blockers: string[] = [];
  if (approved === "APPROVED") {
    const { version: draft } = await createDraftFromVersion(db, {
      sourceVersionId: v1Id,
      rubric: rubricV2,
      title: "주문·재고 API v2 (express 필수)",
    });
    const run = await validate(draft.id);
    v2 = run.result.pass;
    v2Status = run.version.status;
    const idByKind = new Map(
      Object.entries(GATE_SAMPLE_KIND).map(([id, kind]) => [kind as string, id]),
    );
    v2Mismatches = run.result.mismatches.map((m) => ({
      sample: (m.sampleKind && idByKind.get(m.sampleKind)) ?? m.sampleName ?? "-",
      ref: m.ref,
      field: m.field,
      expected: m.expected,
      actual: m.actual,
    }));
    v2Blockers = await approveValidatedAssignmentVersion(db, {
      id: draft.id,
      approvedBy: APPROVER,
    }).then(() => [] as string[], blockerCodes);
  }
  return {
    v1Pass: v1Run.result.pass,
    v1Mismatches: v1Run.result.mismatches.map((m) => `${m.sampleName ?? "-"} ${m.message}`),
    v1StatusAfterValidation: v1Run.version.status,
    unsignedBlockers,
    blankApproverBlockers,
    approvedStatus: approved,
    v2Pass: v2,
    v2Status,
    v2Mismatches,
    v2Blockers,
    v1StatusAfterV2: (await getAssignmentVersion(db, v1Id))?.status ?? null,
  };
}

/** 기록 파일을 저장소의 prettier 설정으로 정리한다 (`pnpm format:check`가 통과하도록) */
async function formatWithPrettier(files: string[]): Promise<void> {
  const bin = path.join(REPO_ROOT, "node_modules/.bin/prettier");
  if (!existsSync(bin)) {
    console.error("[gate:phase4] prettier가 없어 기록 파일 정리를 건너뜁니다");
    return;
  }
  await promisify(execFile)(bin, ["--write", "--log-level", "warn", ...files], { cwd: REPO_ROOT });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
