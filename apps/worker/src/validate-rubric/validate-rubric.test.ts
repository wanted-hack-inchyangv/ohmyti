import { TEST_TIME_BUDGETS } from "@ohmyti/core/testing";
import {
  ExecutionContractSchema,
  RubricSchema,
  validateRubric,
  ValidationResultSchema,
  type ExecutionContract,
  type Rubric,
  type ValidationResult,
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
  createValidationRunSubmission,
  evaluations,
  getAssignmentVersion,
  getJob,
  getSubmission,
  listReevaluationTargets,
  listSubmissionEvaluations,
  listValidationSamples,
  requestAssignmentVersionValidation,
  submissions,
  summarizeVersionValidation,
  validationSamples,
  type AssignmentVersionRow,
  type JobRow,
  type TestDatabase,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import { LOCAL_RUNNER_DEFAULTS, LocalProcessRunner, packDirectoryToTarGz } from "@ohmyti/runner";
import { ARTIFACT_CONTENT_TYPES, FsArtifactStore } from "@ohmyti/storage";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobType } from "@ohmyti/core";
import { createLogger } from "../logger";
import { createEvaluateSubmissionHandler, type PipelineConfig } from "../pipeline";
import type { JobContext, JobHandler } from "../registry";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import { createReevaluateAssignmentVersionHandler, createValidateRubricHandler } from "./handler";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SHA = { a: "a".repeat(40), c: "c".repeat(40) } as const;
const SAMPLE_KIND = { A: "CORRECT", B: "ALTERNATIVE", C: "DEFECTIVE", D: "ADVERSARIAL" } as const;

interface MatrixSample {
  id: keyof typeof SAMPLE_KIND;
  name: string;
  dir: string;
  criteria: unknown;
  mutations: unknown;
  submittedTests: unknown;
  scoreDisplay: unknown;
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

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn(
    "[@ohmyti/worker] DATABASE_URL_TEST가 없어 채점기 사전 검증 통합 테스트를 건너뜁니다",
  );
}

describe.skipIf(!hasTestDb)("validate-rubric: 채점기 사전 검증과 승인 게이트 (DB 통합)", () => {
  let tdb: TestDatabase;
  let workRoot: string;
  let store: FsArtifactStore;
  let rubricV1: Rubric;
  let contract: ExecutionContract;
  let assignmentId: string;
  let v1: AssignmentVersionRow;
  const harnessVersion = harnessVersionOf(getCaseSet(DEFAULT_CASE_SET));
  const logger = createLogger({ destination: { write: () => {} }, level: "silent" });
  let validateHandler: JobHandler;
  let reevaluateHandler: JobHandler;
  /** 실제 제출의 평가·재평가는 mutation 단계를 끈다 (재평가 대상·evaluation 보존만 본다) */
  let evaluateHandler: JobHandler;
  /** 실제 제출 (A 정답, C 결함) */
  const real: { a?: string; c?: string } = {};

  const ctx = (): JobContext => ({
    logger,
    db: tdb.db,
    store,
    heartbeat: () => Promise.resolve(),
    signal: new AbortController().signal,
    workerId: "validate-rubric-test",
  });

  /** 큐에서 해당 타입 job 하나를 꺼내 핸들러로 처리하고 SUCCEEDED로 닫는다 */
  async function runNext(type: JobType, handler: JobHandler): Promise<JobRow> {
    const job = await claimJob(tdb.db, { workerId: "validate-rubric-test", types: [type] });
    expect(job, `${type} job`).not.toBeNull();
    await handler(job!, ctx());
    expect(await completeJob(tdb.db, job!.id, "validate-rubric-test")).toBe(true);
    return job!;
  }

  async function validate(
    versionId: string,
  ): Promise<{ version: AssignmentVersionRow; result: ValidationResult }> {
    const { job } = await requestAssignmentVersionValidation(tdb.db, versionId);
    expect(job.created).toBe(true);
    const ran = await runNext("VALIDATE_RUBRIC", validateHandler);
    expect(ran.id).toBe(job.id);
    const version = (await getAssignmentVersion(tdb.db, versionId))!;
    const result = ValidationResultSchema.parse(version.validationResult);
    return { version, result };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-validate-rubric-"));
    store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
    rubricV1 = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    const matrix = JSON.parse(
      await readFile(path.join(SAMPLES_DIR, "expected-matrix.json"), "utf8"),
    ) as { samples: MatrixSample[] };

    const runner = new LocalProcessRunner({
      config: { ...LOCAL_RUNNER_DEFAULTS, templateRoot: TEMPLATE_ROOT, workRoot },
      artifactStore: store,
    });
    const [a, c] = await Promise.all([
      readTree(path.join(SAMPLES_DIR, "impl-a")),
      readTree(path.join(SAMPLES_DIR, "impl-c")),
    ]);
    const github = createGitHubClient({
      fetch: fakeGitHub({
        "acme/order-api": {
          defaultBranch: "main",
          refs: { a: SHA.a, c: SHA.c },
          tarballs: {
            [SHA.a]: () => makeGitHubStyleTarball(a, SHA.a),
            [SHA.c]: () => makeGitHubStyleTarball(c, SHA.c),
          },
        },
      }).fetch,
    });
    const config: PipelineConfig = {
      stageTimeoutMs: TEST_TIME_BUDGETS.stageMs,
      requestTimeoutMs: TEST_TIME_BUDGETS.harnessRequestMs,
      templateRoot: TEMPLATE_ROOT,
      repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
      workRoot,
    };
    validateHandler = createValidateRubricHandler({ runner, github, config });
    reevaluateHandler = createReevaluateAssignmentVersionHandler();
    evaluateHandler = createEvaluateSubmissionHandler({
      runner,
      github,
      config: { ...config, mutation: { enabled: false } },
    });

    // 과제 v1(DRAFT) + 검증 샘플 A/B/C/D. 시드(`db:seed:sample`)와 같은 방식으로 스냅샷을 올리고 기대 결과표를 넣는다.
    // 승인 조건 테스트는 `human_reviewed_by`가 채워진 픽스처로 한다 (티켓 범위)
    assignmentId = (await createAssignment(tdb.db, { name: "T-405 검증 과제" })).id;
    v1 = await createAssignmentVersion(tdb.db, {
      assignmentId,
      title: "주문·재고 API v1",
      specRef: "assignments/x/specs/spec.md",
      specDigest: "b".repeat(64),
      rubric: rubricV1,
      executionContract: contract,
      harnessVersion,
    });
    for (const sample of matrix.samples) {
      const tarGz = await packDirectoryToTarGz(path.join(SAMPLES_DIR, sample.dir));
      const snapshotRef = `assignments/${assignmentId}/versions/1/samples/${sample.id}/snapshot.tar.gz`;
      await store.put(snapshotRef, tarGz, { contentType: ARTIFACT_CONTENT_TYPES.snapshot });
      await tdb.db.insert(validationSamples).values({
        assignmentVersionId: v1.id,
        name: sample.name,
        kind: SAMPLE_KIND[sample.id],
        snapshotRef,
        submissionSha: createHash("sha1").update(tarGz).digest("hex"),
        expected: {
          criteria: sample.criteria,
          mutations: sample.mutations,
          submittedTests: sample.submittedTests,
          scoreDisplay: sample.scoreDisplay,
        },
        humanReviewedBy: "검토자",
        humanReviewedAt: new Date("2026-09-19T00:00:00Z"),
      });
    }
  }, 120_000);

  afterAll(async () => {
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
    await tdb?.destroy();
  });

  it("v1 검증이 pass이고 승인이 성공한다", async () => {
    const { version, result } = await validate(v1.id);
    expect(result.mismatches).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.perSample.map((s) => [s.name, s.kind, s.check, s.status])).toEqual([
      ["정답 구현 A", "CORRECT", "정답 통과", "MATCH"],
      ["대안 정답 구현 B", "ALTERNATIVE", "대안 통과", "MATCH"],
      ["결함 구현 C", "DEFECTIVE", "결함 탐지", "MATCH"],
      ["적대적 샘플 D", "ADVERSARIAL", "적대 샘플 동일", "MATCH"],
    ]);
    expect(result.perSample.map((s) => s.scoreDisplay)).toEqual([
      "90~100/100 · 10점 검토 대기",
      "90~100/100 · 10점 검토 대기",
      "54~69/100 · 15점 검토 대기",
      "54~69/100 · 15점 검토 대기",
    ]);
    // pass면 VALIDATING에 남아 사람 승인을 기다린다
    expect(version.status).toBe("VALIDATING");
    expect(result.rubricVersion).toBe(v1.rubricVersion);
    expect(result.harnessVersion).toBe(harnessVersion);

    // 승인자 이름이 없으면 거부
    const noName = await approveValidatedAssignmentVersion(tdb.db, {
      id: v1.id,
      approvedBy: "  ",
    }).catch((e: unknown) => e);
    expect(noName).toBeInstanceOf(AssignmentError);
    expect((noName as AssignmentError).code).toBe("APPROVAL_BLOCKED");
    expect(
      ((noName as AssignmentError).details as { blockers: { code: string }[] }).blockers.map(
        (b) => b.code,
      ),
    ).toEqual(["APPROVER_MISSING"]);

    const approved = await approveValidatedAssignmentVersion(tdb.db, {
      id: v1.id,
      approvedBy: "채용 담당자",
    });
    expect(approved.version.status).toBe("APPROVED");
    expect(approved.version.approvedBy).toBe("채용 담당자");
    expect(approved.version.approvedAt).toBeInstanceOf(Date);
    expect(approved.retiredVersionIds).toEqual([]);
    // 이전 버전의 실제 제출이 없으므로 재평가 job은 없다
    expect(approved.reevaluation).toBeNull();
    v1 = approved.version;
  }, 600_000);

  it("검증 실행은 is_sample = true로 표시되어 실제 제출 통계와 섞이지 않는다", async () => {
    const runs = await tdb.db
      .select()
      .from(submissions)
      .where(eq(submissions.assignmentVersionId, v1.id));
    expect(runs).toHaveLength(4);
    for (const run of runs) {
      expect(run.isSample).toBe(true);
      expect(run.validationSampleId).not.toBeNull();
      expect(run.status).toBe("COMPLETED");
      const evals = await listSubmissionEvaluations(tdb.db, run.id);
      expect(evals).toHaveLength(1);
      expect(evals[0]!.isSample).toBe(true);
      expect(evals[0]!.assignmentVersionId).toBe(v1.id);
    }
    // 실제 제출 통계와 재평가 대상에서 빠진다
    const summary = await summarizeVersionValidation(tdb.db, [v1]);
    expect(summary.get(v1.id)).toMatchObject({
      samplesTotal: 4,
      samplesReviewed: 4,
      submissionCount: 0,
      bootstrapPendingReview: false,
    });

    // 실제 제출 두 건 (A 정답, C 결함) — 이후 재평가 대상
    for (const ref of ["a", "c"] as const) {
      const submission = await createSubmission(tdb.db, {
        assignmentVersionId: v1.id,
        repoUrl: "https://github.com/acme/order-api",
        repoRef: ref,
      });
      real[ref] = submission.id;
      await evaluateHandler(
        {
          id: "local",
          attempts: 1,
          maxAttempts: 3,
          payload: { submissionId: submission.id },
        } as JobRow,
        ctx(),
      );
      expect((await getSubmission(tdb.db, submission.id))!.status).toBe("COMPLETED");
    }
    expect((await summarizeVersionValidation(tdb.db, [v1])).get(v1.id)!.submissionCount).toBe(2);
    const approvedEvaluations = await tdb.db
      .select({ isSample: evaluations.isSample })
      .from(evaluations)
      .where(and(eq(evaluations.assignmentVersionId, v1.id), eq(evaluations.isSample, false)));
    expect(approvedEvaluations).toHaveLength(2);

    // 승인된 버전에는 검증 제출을 만들 수 없다 (DB 트리거)
    const [sample] = await listValidationSamples(tdb.db, v1.id);
    await expect(createValidationRunSubmission(tdb.db, sample!)).rejects.toThrow();
  }, 300_000);

  it('판정 조건에 "express 사용"을 추가한 v2를 검증하면 B에서 불일치가 나고 승인이 차단되며 불일치 표가 표시된다', async () => {
    // 판정 조건 문장의 라이브러리 이름은 validateRubric이 먼저 거부한다
    const literal: Rubric = {
      ...rubricV1,
      criteria: rubricV1.criteria.map((c) =>
        c.id === "R-11" ? { ...c, condition: `${c.condition} express 사용.` } : c,
      ),
    };
    const lint = validateRubric(literal);
    expect(lint.ok).toBe(false);
    // 같은 요구를 구조화된 정적 검사로 넣으면 문장 검사는 통과하지만, 채점기 검증이 대안 정답 B에서 잡는다
    const rubricV2: Rubric = {
      ...rubricV1,
      criteria: rubricV1.criteria.map((c) =>
        c.id === "R-11"
          ? {
              ...c,
              condition: `${c.condition} 웹 서버 의존성으로 지정한 패키지를 package.json에 선언한다.`,
              staticChecks: [{ kind: "DEPENDENCY_DECLARED" as const, packageName: "express" }],
            }
          : c,
      ),
    };
    expect(validateRubric(rubricV2)).toEqual({ ok: true });
    const { version: draft, samples } = await createDraftFromVersion(tdb.db, {
      sourceVersionId: v1.id,
      rubric: rubricV2,
      title: "주문·재고 API v2 (express 필수)",
    });
    expect(draft.status).toBe("DRAFT");
    expect(draft.version).toBe(2);
    expect(samples.map((s) => s.humanReviewedBy)).toEqual(["검토자", "검토자", "검토자", "검토자"]);

    const { version, result } = await validate(draft.id);
    expect(result.pass).toBe(false);
    expect(version.status).toBe("DRAFT");
    expect(result.perSample.map((s) => [s.name, s.status])).toEqual([
      ["정답 구현 A", "MATCH"],
      ["대안 정답 구현 B", "MISMATCH"],
      ["결함 구현 C", "MATCH"],
      ["적대적 샘플 D", "MATCH"],
    ]);
    // 불일치 표: 샘플 · 기준 · 항목 · 기대 · 실제
    expect(
      result.mismatches.map((m) => [
        m.sampleName,
        m.sampleKind,
        m.subject,
        m.ref,
        m.field,
        m.expected,
        m.actual,
      ]),
    ).toEqual([
      ["대안 정답 구현 B", "ALTERNATIVE", "CRITERION", "R-11", "verdict", "PASS", "FAIL"],
      ["대안 정답 구현 B", "ALTERNATIVE", "CRITERION", "R-11", "earnedPoints", 4, 0],
    ]);
    expect(result.mismatches[0]!.message).toBe("R-11: 기대 PASS, 실제 FAIL");

    // 승인 차단: 검증 불일치 + 검증 중 아님
    const blocked = await approveValidatedAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "채용 담당자",
    }).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(AssignmentError);
    expect((blocked as AssignmentError).code).toBe("APPROVAL_BLOCKED");
    const codes = (
      (blocked as AssignmentError).details as { blockers: { code: string }[] }
    ).blockers.map((b) => b.code);
    expect(codes).toContain("VALIDATION_FAILED");
    expect((await getAssignmentVersion(tdb.db, draft.id))!.status).toBe("DRAFT");
    // v1은 그대로 승인 상태이고 재평가 job은 없다
    expect((await getAssignmentVersion(tdb.db, v1.id))!.status).toBe("APPROVED");
    expect(
      await claimJob(tdb.db, { workerId: "x", types: ["REEVALUATE_ASSIGNMENT_VERSION"] }),
    ).toBeNull();
  }, 600_000);

  it("human_reviewed_by가 빈 샘플이 하나라도 있으면 검증 pass여도 승인이 거부되고, v2 승인 시 기존 제출마다 새 evaluation이 생기며 v1 evaluation은 그대로 남는다", async () => {
    // 판정 조건 문구만 다듬은 v3 (판정은 v1과 같다)
    const rubricV3: Rubric = {
      ...rubricV1,
      criteria: rubricV1.criteria.map((c) =>
        c.id === "R-11" ? { ...c, condition: `${c.condition} (문구 정리)` } : c,
      ),
    };
    const { version: draft } = await createDraftFromVersion(tdb.db, {
      sourceVersionId: v1.id,
      rubric: rubricV3,
      title: "주문·재고 API v3",
    });
    const { version, result } = await validate(draft.id);
    expect(result.pass).toBe(true);
    expect(version.status).toBe("VALIDATING");

    // 샘플 하나의 검토 서명을 지우면 검증 pass여도 거부된다
    const [first] = await listValidationSamples(tdb.db, draft.id);
    await tdb.db
      .update(validationSamples)
      .set({ humanReviewedBy: null, humanReviewedAt: null })
      .where(eq(validationSamples.id, first!.id));
    const blockers = await checkAssignmentVersionApproval(tdb.db, {
      id: draft.id,
      approvedBy: "채용 담당자",
    });
    expect(blockers.map((b) => b.code)).toEqual(["SAMPLE_NOT_REVIEWED"]);
    expect(blockers[0]!.message).toContain(first!.name);
    await expect(
      approveValidatedAssignmentVersion(tdb.db, { id: draft.id, approvedBy: "채용 담당자" }),
    ).rejects.toMatchObject({ code: "APPROVAL_BLOCKED" });
    expect((await getAssignmentVersion(tdb.db, draft.id))!.status).toBe("VALIDATING");

    // 서명을 되돌리면 승인된다. 이전 승인 버전(v1)은 RETIRED, 기존 제출 재평가 job이 들어간다
    await tdb.db
      .update(validationSamples)
      .set({ humanReviewedBy: "검토자", humanReviewedAt: new Date() })
      .where(eq(validationSamples.id, first!.id));
    const before = new Map<string, Awaited<ReturnType<typeof listSubmissionEvaluations>>>();
    for (const id of [real.a!, real.c!])
      before.set(id, await listSubmissionEvaluations(tdb.db, id));

    const approved = await approveValidatedAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "채용 담당자",
    });
    expect(approved.version.status).toBe("APPROVED");
    expect(approved.retiredVersionIds).toEqual([v1.id]);
    expect((await getAssignmentVersion(tdb.db, v1.id))!.status).toBe("RETIRED");
    expect(approved.reevaluation?.created).toBe(true);
    const targets = await listReevaluationTargets(tdb.db, draft.id);
    expect(targets.map((t) => t.id).sort()).toEqual([real.a!, real.c!].sort());

    // REEVALUATE → 제출마다 EVALUATE_SUBMISSION(재평가) job → 처리
    await runNext("REEVALUATE_ASSIGNMENT_VERSION", reevaluateHandler);
    const jobs: JobRow[] = [];
    for (let i = 0; i < 2; i += 1) jobs.push(await runNext("EVALUATE_SUBMISSION", evaluateHandler));
    expect(jobs.map((j) => (j.payload as { submissionId: string }).submissionId).sort()).toEqual(
      [real.a!, real.c!].sort(),
    );
    expect(
      jobs.every(
        (j) => (j.payload as { assignmentVersionId?: string }).assignmentVersionId === draft.id,
      ),
    ).toBe(true);
    expect(await claimJob(tdb.db, { workerId: "x", types: ["EVALUATE_SUBMISSION"] })).toBeNull();

    for (const id of [real.a!, real.c!]) {
      const after = await listSubmissionEvaluations(tdb.db, id);
      expect(after).toHaveLength(2);
      // v1 evaluation은 그대로 (같은 행, 같은 점수, 같은 단계 기록)
      expect(after[0]).toEqual(before.get(id)![0]);
      expect(after[0]!.assignmentVersionId).toBe(v1.id);
      // 새 evaluation은 새 버전의 기준으로 끝났다
      expect(after[1]!.assignmentVersionId).toBe(draft.id);
      expect(after[1]!.rubricVersion).toBe(approved.version.rubricVersion);
      expect(after[1]!.finishedAt).not.toBeNull();
      expect(after[1]!.isSample).toBe(false);
      expect(after[1]!.scoreEarned).toBe(after[0]!.scoreEarned);
      // 제출 상태와 받은 버전은 바뀌지 않는다
      const submission = (await getSubmission(tdb.db, id))!;
      expect(submission.status).toBe("COMPLETED");
      expect(submission.assignmentVersionId).toBe(v1.id);
    }
    // 재평가를 다시 넣어도 이미 끝난 제출은 대상이 아니다
    expect(await listReevaluationTargets(tdb.db, draft.id)).toEqual([]);
    // 재평가 job은 SUCCEEDED로 닫혔다
    for (const job of jobs) expect((await getJob(tdb.db, job.id))!.status).toBe("SUCCEEDED");
  }, 900_000);
});
