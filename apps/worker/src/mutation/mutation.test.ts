import { ExecutionContractSchema, RubricSchema, type ExecutionContract } from "@ohmyti/core";
import { MUTATION_CATALOG, replaceNodeEdit, type MutationDefinition } from "@ohmyti/analysis";
import {
  approveAssignmentVersion,
  createAssignment,
  createAssignmentVersion,
  createSubmission,
  createTestDatabase,
  executionRecords,
  getEvaluation,
  listExecutionRecords,
  listMutationExperiments,
  mutationExperiments,
  persistMutationExperiment,
  startAssignmentVersionValidation,
  toMutationExperiment,
  type MutationExperimentRow,
  type TestDatabase,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import { LOCAL_RUNNER_DEFAULTS, LocalProcessRunner, type SandboxRunner } from "@ohmyti/runner";
import { FsArtifactStore } from "@ohmyti/storage";
import { eq, sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../logger";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import {
  runEvaluationPipeline,
  type MutationStageConfig,
  type PipelineDeps,
  type PipelineResult,
} from "../pipeline";
import { plannedMutations, preconditionOf, type TestEffectivenessDetail } from "./stage";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SHA = {
  a: "a".repeat(40),
  c: "c".repeat(40),
  noTests: "e".repeat(40),
} as const;

describe("preconditionOf", () => {
  it("PASSED만 실험하고, 테스트 미제출과 환경 미지원·기준 실패를 구분한다", () => {
    expect(preconditionOf({ status: "PASSED" })).toBe("READY");
    expect(preconditionOf({ status: "NO_TESTS" })).toBe("NO_TESTS");
    for (const status of [
      "UNSUPPORTED_FRAMEWORK",
      "BUILD_FAIL",
      "INCONCLUSIVE",
      "TIMEOUT",
    ] as const) {
      expect(preconditionOf({ status })).toBe("ENV_UNSUPPORTED");
    }
    expect(preconditionOf({ status: "FAILED" })).toBe("BASELINE_FAILED");
  });
});

describe("plannedMutations", () => {
  it("rubric 그룹의 mutationIds를 그룹 순서대로 펼친다", async () => {
    const rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    expect(plannedMutations(rubric)).toEqual([
      { mutationId: "M-01", groupId: "G1" },
      { mutationId: "M-02", groupId: "G1" },
      { mutationId: "M-03", groupId: "G2" },
      { mutationId: "M-04", groupId: "G2" },
      { mutationId: "M-05", groupId: "G3" },
    ]);
  });
});

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

/** 샘플 A에서 테스트를 모두 뺀 픽스처 (테스트 미제출) */
async function noTestsFiles(): Promise<FakeRepoFiles> {
  const files = await readTree(path.join(SAMPLES_DIR, "impl-a"));
  for (const name of Object.keys(files)) {
    if (name.startsWith("test/") || name === "vitest.config.ts") delete files[name];
  }
  const pkg = JSON.parse(files["package.json"]!.toString()) as {
    scripts: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  delete pkg.scripts.test;
  delete pkg.devDependencies?.vitest;
  files["package.json"] = JSON.stringify(pkg, null, 2);
  return files;
}

/** 러너·수집기·변형 스냅샷이 남긴 임시 디렉터리 (`ohmyti-sandbox-*`, `ohmyti-repo-*`, `ohmyti-mutant-*`) */
async function leftoverDirs(workRoot: string): Promise<string[]> {
  return (await readdir(workRoot)).filter((name) => name.startsWith("ohmyti-"));
}

/** 명령줄에 작업 루트 경로가 들어간 프로세스 (제출 서비스·vitest·tsx는 모두 그 아래에서 돈다) */
function processesUnder(workRoot: string): string[] {
  const out = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  return out.split("\n").filter((line) => line.includes(workRoot));
}

/**
 * M-02를 등가 변형으로 바꾼 카탈로그: `quantity <= 0` → `quantity < 1`.
 * zod가 정수만 통과시키므로 동작이 같고, 하네스(R-04)가 변형에서도 통과해야 한다.
 */
const EQUIVALENT_CATALOG: MutationDefinition[] = MUTATION_CATALOG.map((definition) =>
  definition.id === "M-02"
    ? {
        ...definition,
        description: "등가 변형 픽스처: `quantity <= 0` → `quantity < 1`",
        transform: (target) => [
          replaceNodeEdit(target, target.getText().replace(/<=\s*0$/, "< 1")),
        ],
      }
    : definition,
);

/** drizzle은 PostgreSQL 오류를 `cause`로 감싼다. 위반한 CHECK 제약 이름을 꺼낸다 */
async function violatedConstraint(promise: Promise<unknown>): Promise<string | null> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (error === null) return null;
  const cause = (error as { cause?: { constraint_name?: string; message?: string } }).cause;
  return cause?.constraint_name ?? cause?.message ?? (error instanceof Error ? error.message : "?");
}

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/worker] DATABASE_URL_TEST가 없어 mutation 실험 통합 테스트를 건너뜁니다");
}

interface Evaluated {
  result: PipelineResult;
  workRoot: string;
  store: FsArtifactStore;
  experiments: MutationExperimentRow[];
  detail: TestEffectivenessDetail;
  leftovers: string[];
  processes: string[];
}

describe.skipIf(!hasTestDb)("TEST_EFFECTIVENESS 단계 (DB 통합)", () => {
  let tdb: TestDatabase;
  let assignmentVersionId: string;
  let contract: ExecutionContract;
  let github: ReturnType<typeof fakeGitHub>;
  const workRoots: string[] = [];
  const harnessVersion = harnessVersionOf(getCaseSet(DEFAULT_CASE_SET));
  let expectedMatrix: { samples: Array<{ id: string; mutations: Record<string, string> }> };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const rubric = RubricSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
    );
    contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    expectedMatrix = JSON.parse(
      await readFile(path.join(SAMPLES_DIR, "expected-matrix.json"), "utf8"),
    ) as typeof expectedMatrix;
    const assignment = await createAssignment(tdb.db, { name: "T-403 테스트 과제" });
    const draft = await createAssignmentVersion(tdb.db, {
      assignmentId: assignment.id,
      title: "v1",
      specRef: "assignments/x/specs/spec.md",
      specDigest: "a".repeat(64),
      rubric,
      executionContract: contract,
      harnessVersion,
    });
    await startAssignmentVersionValidation(tdb.db, draft.id);
    assignmentVersionId = (
      await approveAssignmentVersion(tdb.db, {
        id: draft.id,
        approvedBy: "tester",
        validationResult: { ok: true },
      })
    ).id;
    const [a, c, noTests] = await Promise.all([
      readTree(path.join(SAMPLES_DIR, "impl-a")),
      readTree(path.join(SAMPLES_DIR, "impl-c")),
      noTestsFiles(),
    ]);
    github = fakeGitHub({
      "acme/order-api": {
        defaultBranch: "main",
        refs: { a: SHA.a, c: SHA.c, "no-tests": SHA.noTests },
        tarballs: {
          [SHA.a]: () => makeGitHubStyleTarball(a, SHA.a),
          [SHA.c]: () => makeGitHubStyleTarball(c, SHA.c),
          [SHA.noTests]: () => makeGitHubStyleTarball(noTests, SHA.noTests),
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(workRoots.map((dir) => rm(dir, { recursive: true, force: true })));
    await tdb?.destroy();
  });

  /** 제출 하나를 전체 파이프라인으로 평가한다. 작업 루트는 평가마다 따로 두어 정리 여부를 본다 */
  async function evaluate(
    ref: string,
    mutation: MutationStageConfig = {},
    wrapRunner: (runner: SandboxRunner) => SandboxRunner = (runner) => runner,
  ): Promise<Evaluated> {
    const workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-mutation-"));
    workRoots.push(workRoot);
    const store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
    const runner = wrapRunner(
      new LocalProcessRunner({
        config: { ...LOCAL_RUNNER_DEFAULTS, templateRoot: TEMPLATE_ROOT, workRoot },
        artifactStore: store,
      }),
    );
    const deps: PipelineDeps = {
      db: tdb.db,
      store,
      runner,
      github: createGitHubClient({ fetch: github.fetch }),
      config: {
        stageTimeoutMs: 180_000,
        requestTimeoutMs: 5000,
        templateRoot: TEMPLATE_ROOT,
        repoLimits: { maxFiles: 500, maxBytes: 20 * 1024 * 1024 },
        workRoot,
        mutation,
      },
      logger: createLogger({ destination: { write: () => {} }, level: "silent" }),
    };
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: "https://github.com/acme/order-api",
      repoRef: ref,
    });
    const result = await runEvaluationPipeline(
      { submissionId: submission.id, attempt: 1, maxAttempts: 3 },
      deps,
    );
    const evaluation = (await getEvaluation(tdb.db, result.evaluationId!))!;
    const stage = evaluation.stageLog.find((s) => s.stage === "TEST_EFFECTIVENESS")!;
    return {
      result,
      workRoot,
      store,
      experiments: await listMutationExperiments(tdb.db, evaluation.id),
      detail: stage.detail as TestEffectivenessDetail,
      leftovers: await leftoverDirs(workRoot),
      processes: processesUnder(workRoot),
    };
  }

  const memo = new Map<string, Promise<Evaluated>>();
  const evaluated = (ref: "a" | "c") => {
    if (!memo.has(ref)) memo.set(ref, evaluate(ref));
    return memo.get(ref)!;
  };

  async function readJson(store: FsArtifactStore, key: string): Promise<Record<string, unknown>> {
    const object = await store.get(key);
    expect(object, key).not.toBeNull();
    return JSON.parse(Buffer.from(object!.body).toString("utf8")) as Record<string, unknown>;
  }

  it("A: M-01~M-05 모두 KILLED이고 각 실험에 하네스 FAIL 유효성 검증 기록과 제출 테스트 기록이 있다", async () => {
    const { result, experiments, detail, store } = await evaluated("a");
    expect(result.submissionStatus).toBe("COMPLETED");
    const stage = result.stageLog.find((s) => s.stage === "TEST_EFFECTIVENESS")!;
    expect(stage.state).toBe("DONE");
    expect(detail.precondition).toEqual({
      status: "READY",
      reason: "제출 테스트 기준 실행 통과",
      testsStatus: "PASSED",
    });
    expect(detail.outcomes).toEqual({ KILLED: 5 });
    expect(detail.deadlineReached).toBe(false);
    expect(
      experiments.map((e) => [e.mutationId, e.groupId, e.targetCriterionId, e.outcome]),
    ).toEqual([
      ["M-01", "G1", "R-03", "KILLED"],
      ["M-02", "G1", "R-04", "KILLED"],
      ["M-03", "G2", "R-05", "KILLED"],
      ["M-04", "G2", "R-06", "KILLED"],
      ["M-05", "G3", "R-09", "KILLED"],
    ]);

    const records = new Map(
      (await listExecutionRecords(tdb.db, result.evaluationId!)).map((r) => [r.id, r]),
    );
    for (const experiment of experiments) {
      expect(experiment.validationVerdict).toBe("FAIL");
      expect(experiment.patchDigest).toMatch(/^[0-9a-f]{64}$/);
      // diff 아티팩트
      const diff = await store.get(experiment.patchRef!);
      expect(Buffer.from(diff!.body).toString("utf8")).toMatch(/^--- a\//);
      // 유효성 검증 기록: 대상 케이스가 변형에서 FAIL
      const validation = records.get(experiment.validationRecordId!)!;
      expect(validation.kind).toBe("MUTATION_VALIDATION");
      expect(validation.patchDigest).toBe(experiment.patchDigest);
      expect(validation.harnessVersion).toBe(harnessVersion);
      const validationActual = await readJson(store, validation.actualRef);
      expect(validationActual.verdict).toBe("FAIL");
      const cases = validationActual.cases as Array<{ caseId: string; verdict: string }>;
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.every((c) => c.caseId.startsWith(experiment.targetCriterionId))).toBe(true);
      expect(await store.exists(validation.inputRef.replace(/input\.json$/, "timeline.json"))).toBe(
        true,
      );
      // 제출 테스트 기록: 변형 위에서 실패
      const tests = records.get(experiment.testRecordId!)!;
      expect(tests.kind).toBe("MUTATION_TESTS");
      expect(tests.patchDigest).toBe(experiment.patchDigest);
      const testsActual = await readJson(store, tests.actualRef);
      expect(testsActual.status).toBe("FAILED");
      expect(testsActual.failed).toBeGreaterThan(0);
      // core 스키마로 변환된다
      expect(toMutationExperiment(experiment)).toMatchObject({
        outcome: "KILLED",
        validationVerdict: "FAIL",
      });
    }
  }, 300_000);

  it("C: M-01·M-02 SURVIVED, M-03·M-04 NOT_APPLICABLE(대상 로직 없음), M-05 KILLED이고 expected-matrix와 일치한다", async () => {
    const { experiments, detail } = await evaluated("c");
    const expected = expectedMatrix.samples.find((s) => s.id === "C")!.mutations;
    expect(Object.fromEntries(experiments.map((e) => [e.mutationId, e.outcome]))).toEqual(expected);
    expect(detail.outcomes).toEqual({ SURVIVED: 2, NOT_APPLICABLE: 2, KILLED: 1 });
    const byId = new Map(experiments.map((e) => [e.mutationId, e]));
    for (const id of ["M-03", "M-04"]) {
      const e = byId.get(id)!;
      expect(e.reason).toMatch(/^대상 로직 없음/);
      // 가짜 변형이 없다: diff·기록 없음
      expect(e.patchDigest).toBeNull();
      expect(e.patchRef).toBeNull();
      expect(e.validationRecordId).toBeNull();
      expect(e.testRecordId).toBeNull();
    }
    for (const id of ["M-01", "M-02"]) {
      const e = byId.get(id)!;
      expect(e.validationVerdict).toBe("FAIL");
      expect(e.testRecordId).not.toBeNull();
      expect(e.reason).toMatch(/모두 통과/);
    }
  }, 300_000);

  it("DB 검사: SURVIVED 실험은 예외 없이 유효성 검증 기록의 verdict가 FAIL이고, 어긋난 행은 CHECK 제약이 거부한다", async () => {
    const [{ result: c }] = await Promise.all([evaluated("c"), evaluated("a")]);
    // 저장된 모든 SURVIVED 실험을 DB에서 모아 검증 기록 본문과 대조한다
    const survived = await tdb.db
      .select({ experiment: mutationExperiments, validation: executionRecords })
      .from(mutationExperiments)
      .leftJoin(executionRecords, eq(mutationExperiments.validationRecordId, executionRecords.id))
      .where(eq(mutationExperiments.outcome, "SURVIVED"));
    expect(survived.length).toBeGreaterThanOrEqual(2);
    const { store } = await evaluated("c");
    for (const { experiment, validation } of survived) {
      expect(experiment.validationVerdict).toBe("FAIL");
      expect(validation?.kind).toBe("MUTATION_VALIDATION");
      const actual = await readJson(store, validation!.actualRef);
      expect(actual.verdict).toBe("FAIL");
    }

    // 검증 기록 없이, 또는 검증이 PASS인데 SURVIVED로 저장하려 하면 DB가 거부한다
    const evaluationId = c.evaluationId!;
    const base = {
      evaluationId,
      groupId: "G1",
      targetCriterionId: "R-03",
      outcome: "SURVIVED" as const,
    };
    expect(
      await violatedConstraint(
        persistMutationExperiment(tdb.db, { ...base, id: randomUUID(), mutationId: "X-01" }),
      ),
    ).toBe("mutation_experiments_effective_requires_failing_validation");
    const [someRecord] = await listExecutionRecords(tdb.db, evaluationId);
    expect(
      await violatedConstraint(
        persistMutationExperiment(tdb.db, {
          ...base,
          id: randomUUID(),
          mutationId: "X-02",
          validationVerdict: "PASS",
          validationRecordId: someRecord!.id,
          testRecordId: someRecord!.id,
        }),
      ),
    ).toBe("mutation_experiments_effective_requires_failing_validation");
    expect(
      await violatedConstraint(
        persistMutationExperiment(tdb.db, {
          ...base,
          id: randomUUID(),
          mutationId: "X-03",
          outcome: "EQUIVALENT",
          validationVerdict: "FAIL",
          validationRecordId: someRecord!.id,
        }),
      ),
    ).toBe("mutation_experiments_equivalent_requires_passing_validation");
    const rows = (await tdb.db.execute(
      sql`SELECT count(*)::int AS count FROM mutation_experiments WHERE mutation_id LIKE 'X-%'`,
    )) as unknown as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(0);
  }, 300_000);

  it("하네스가 변형에서도 통과하는 픽스처는 EQUIVALENT로 기록되고 제출 테스트를 돌리지 않으며 SURVIVED로 세지 않는다", async () => {
    const { experiments, detail, store, result } = await evaluate("a", {
      catalog: EQUIVALENT_CATALOG,
    });
    const m02 = experiments.find((e) => e.mutationId === "M-02")!;
    expect(m02.outcome).toBe("EQUIVALENT");
    expect(m02.validationVerdict).toBe("PASS");
    expect(m02.testRecordId).toBeNull();
    expect(m02.reason).toMatch(/모두 통과/);
    const diff = Buffer.from((await store.get(m02.patchRef!))!.body).toString("utf8");
    expect(diff).toContain("+  if (quantity < 1) {");
    const records = await listExecutionRecords(tdb.db, result.evaluationId!);
    const validation = records.find((r) => r.id === m02.validationRecordId)!;
    expect(validation.kind).toBe("MUTATION_VALIDATION");
    expect((await readJson(store, validation.actualRef)).verdict).toBe("PASS");
    expect(records.filter((r) => r.patchDigest === m02.patchDigest)).toHaveLength(1);
    expect(detail.outcomes.SURVIVED).toBeUndefined();
    expect(detail.outcomes).toEqual({ KILLED: 4, EQUIVALENT: 1 });
  }, 300_000);

  it("벽시계 상한을 넘기면 진행 중인 실험과 남은 실험이 TIMEOUT으로 기록되고 단계는 DONE이며 환경이 남지 않는다", async () => {
    // 변형 서비스 기동을 늦춰 첫 변형이 실행 중일 때 상한에 걸리게 한다 (변형 하나의 실행이 1~2초라 그냥 두면 타이밍에 기댄다)
    const slowStart = (runner: SandboxRunner): SandboxRunner => ({
      kind: runner.kind,
      prepare: (...args) => runner.prepare(...args),
      runCommand: (...args) => runner.runCommand(...args),
      destroy: (env) => runner.destroy(env),
      startService: async (env, options) => {
        if (options?.label === "mutation-service") {
          await new Promise((resolve) => setTimeout(resolve, 4000));
        }
        return runner.startService(env, options);
      },
    });
    const started = Date.now();
    const { result, experiments, detail, leftovers, processes } = await evaluate(
      "a",
      { timeoutMs: 1500 },
      slowStart,
    );
    expect(result.submissionStatus).toBe("COMPLETED");
    expect(result.stageLog.find((s) => s.stage === "TEST_EFFECTIVENESS")!.state).toBe("DONE");
    expect(detail.deadlineReached).toBe(true);
    expect(detail.timeoutMs).toBe(1500);
    expect(detail.outcomes).toEqual({ TIMEOUT: 5 });
    const [first, ...rest] = experiments;
    // 첫 변형은 유효성 검증 중에 멈췄다 (환경을 만든 뒤)
    expect(first!.mutationId).toBe("M-01");
    expect(first!.reason).toBe("단계 벽시계 상한(1500ms)을 넘겨 유효성 검증 중에 중단함");
    // 나머지는 시작하지 않았다
    for (const e of rest) {
      expect(e.reason).toBe("단계 벽시계 상한(1500ms)을 넘겨 실행하지 않음");
    }
    for (const e of experiments) {
      expect(e.outcome).toBe("TIMEOUT");
      expect(e.testRecordId).toBeNull();
      expect(e.validationRecordId).toBeNull();
    }
    // 멈춘 변형이 다섯 개를 모두 돌린 것보다 훨씬 빨리 끝났다
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(leftovers).toEqual([]);
    expect(processes).toEqual([]);
  }, 300_000);

  it("상한을 아주 짧게 두면 어떤 변형도 실행하지 않고 모두 TIMEOUT이다", async () => {
    const { experiments, detail, leftovers } = await evaluate("c", { timeoutMs: 1 });
    expect(detail.deadlineReached).toBe(true);
    // 적용 단계에서 걸러진 변형(C의 M-03·M-04, 대상 로직 없음)은 실행 대상이 아니므로 그대로 NOT_APPLICABLE이다
    expect(Object.fromEntries(experiments.map((e) => [e.mutationId, e.outcome]))).toEqual({
      "M-01": "TIMEOUT",
      "M-02": "TIMEOUT",
      "M-03": "NOT_APPLICABLE",
      "M-04": "NOT_APPLICABLE",
      "M-05": "TIMEOUT",
    });
    expect(leftovers).toEqual([]);
  }, 180_000);

  it("단계 종료 후 임시 디렉터리(러너 환경·변형 스냅샷·수집)와 프로세스가 남지 않는다", async () => {
    for (const ref of ["a", "c"] as const) {
      const { leftovers, processes, workRoot } = await evaluated(ref);
      expect(leftovers, ref).toEqual([]);
      expect(processes, ref).toEqual([]);
      // 지금도 없다 (단계가 끝난 뒤 늦게 생기는 것도 없다)
      expect(await leftoverDirs(workRoot)).toEqual([]);
      expect(processesUnder(workRoot)).toEqual([]);
    }
  }, 300_000);

  it("테스트 미제출이면 실험 행 없이 그룹 전체를 '테스트 미제출'로 기록한다", async () => {
    const { result, experiments, detail } = await evaluate("no-tests");
    expect(result.stageLog.find((s) => s.stage === "TEST_EFFECTIVENESS")!.state).toBe("DONE");
    expect(experiments).toEqual([]);
    expect(detail.precondition).toEqual({
      status: "NO_TESTS",
      reason: "테스트 미제출",
      testsStatus: "NO_TESTS",
    });
    expect(detail.groups).toEqual([
      { groupId: "G1", mutationIds: ["M-01", "M-02"], status: "NO_TESTS" },
      { groupId: "G2", mutationIds: ["M-03", "M-04"], status: "NO_TESTS" },
      { groupId: "G3", mutationIds: ["M-05"], status: "NO_TESTS" },
    ]);
  }, 180_000);
});
