import {
  aggregateScore,
  ExecutionContractSchema,
  RubricSchema,
  type MutationOutcome,
  type Rubric,
} from "@ohmyti/core";
import {
  approveAssignmentVersion,
  createAssignment,
  createAssignmentVersion,
  createSubmission,
  createTestDatabase,
  criterionResults,
  getEvaluation,
  listCriterionResults,
  listEvidences,
  listExecutionRecords,
  listMutationExperiments,
  startAssignmentVersionValidation,
  toCriterionResult,
  type CriterionResultRow,
  type TestDatabase,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import { LOCAL_RUNNER_DEFAULTS, LocalProcessRunner } from "@ohmyti/runner";
import { FsArtifactStore } from "@ohmyti/storage";
import { and, eq } from "drizzle-orm";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../logger";
import { createGitHubClient } from "../repo";
import { fakeGitHub, makeGitHubStyleTarball, type FakeRepoFiles } from "../repo/test-support";
import { runEvaluationPipeline, type PipelineDeps } from "../pipeline";
import {
  decideEffectiveness,
  NO_SUBMITTED_TESTS_OBSERVATION,
  persistEffectivenessResults,
  type EffectivenessExperiment,
  type EffectivenessScoringSummary,
} from ".";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");

/** 비율 표기("변형 생존율 n%", "3/5 생존" 등)가 없어야 한다 (티켓 인수 기준) */
const RATIO_PATTERN = /%|생존율|비율|\d+\s*\/\s*\d+\s*(?:생존|탐지|살아)/;

async function loadRubric(): Promise<Rubric> {
  return RubricSchema.parse(
    JSON.parse(await readFile(path.join(SAMPLES_DIR, "rubric.v1.json"), "utf8")),
  );
}

function experiment(
  mutationId: string,
  outcome: MutationOutcome,
  groupId: string,
  targetCriterionId: string,
): EffectivenessExperiment {
  const effective = outcome === "KILLED" || outcome === "SURVIVED";
  return {
    mutationId,
    groupId,
    targetCriterionId,
    outcome,
    reason: outcome === "NOT_APPLICABLE" ? "대상 로직 없음" : null,
    target: null,
    patchRef:
      outcome === "NOT_APPLICABLE" ? null : `evaluations/x/mutations/${mutationId}/diff.patch`,
    validationRecordId: effective || outcome === "EQUIVALENT" ? `${mutationId}-validation` : null,
    testRecordId: effective ? `${mutationId}-tests` : null,
  };
}

const TARGETS: Record<string, [string, string]> = {
  "M-01": ["G1", "R-03"],
  "M-02": ["G1", "R-04"],
  "M-03": ["G2", "R-05"],
  "M-04": ["G2", "R-06"],
  "M-05": ["G3", "R-09"],
};

function experimentsOf(outcomes: Record<string, MutationOutcome>): EffectivenessExperiment[] {
  return Object.entries(outcomes).map(([id, outcome]) =>
    experiment(id, outcome, TARGETS[id]![0], TARGETS[id]![1]),
  );
}

const DONE_READY = {
  state: "DONE" as const,
  detail: { precondition: { status: "READY", reason: "", testsStatus: "PASSED" } },
};

describe("decideEffectiveness", () => {
  let rubric: Rubric;
  beforeAll(async () => {
    rubric = await loadRubric();
  });

  const byId = (decisions: ReturnType<typeof decideEffectiveness>) =>
    new Map(decisions.map((d) => [d.criterionId, d]));

  it("A: 모두 KILLED면 세 그룹 모두 PASS 만점이다", () => {
    const decisions = byId(
      decideEffectiveness({
        rubric,
        stage: DONE_READY,
        experiments: experimentsOf({
          "M-01": "KILLED",
          "M-02": "KILLED",
          "M-03": "KILLED",
          "M-04": "KILLED",
          "M-05": "KILLED",
        }),
      }),
    );
    expect([...decisions.keys()]).toEqual(["G1", "G2", "G3"]);
    for (const d of decisions.values()) {
      expect(d).toMatchObject({
        verdict: "PASS",
        earnedPoints: 5,
        reviewState: "NOT_REQUIRED",
        issueId: null,
      });
    }
    expect(decisions.get("G1")!.experiments.map((e) => e.mutationId)).toEqual(["M-01", "M-02"]);
  });

  it("C: G1 FAIL(R-03·R-04), G2 INCONCLUSIVE 검토 대기, G3 PASS", () => {
    const decisions = byId(
      decideEffectiveness({
        rubric,
        stage: DONE_READY,
        experiments: experimentsOf({
          "M-01": "SURVIVED",
          "M-02": "SURVIVED",
          "M-03": "NOT_APPLICABLE",
          "M-04": "NOT_APPLICABLE",
          "M-05": "KILLED",
        }),
      }),
    );
    const g1 = decisions.get("G1")!;
    expect(g1).toMatchObject({
      verdict: "FAIL",
      earnedPoints: 0,
      issueId: "untested:G1",
      unverifiedCriterionIds: ["R-03", "R-04"],
    });
    expect(g1.observation).toMatch(/^검증되지 않은 요구사항: R-03, R-04 · M-01 SURVIVED\(R-03\)/);
    expect(decisions.get("G2")).toMatchObject({
      verdict: "INCONCLUSIVE",
      earnedPoints: null,
      reviewState: "PENDING",
    });
    expect(decisions.get("G2")!.observation).toContain("M-03 NOT_APPLICABLE(R-05): 대상 로직 없음");
    expect(decisions.get("G3")).toMatchObject({ verdict: "PASS", earnedPoints: 5 });
  });

  it("SURVIVED가 하나라도 있으면 KILLED가 섞여도 FAIL이고, 살아남은 변형의 요구사항만 나열한다", () => {
    const g1 = decideEffectiveness({
      rubric,
      stage: DONE_READY,
      experiments: experimentsOf({ "M-01": "KILLED", "M-02": "SURVIVED" }),
    })[0]!;
    expect(g1).toMatchObject({ verdict: "FAIL", unverifiedCriterionIds: ["R-04"] });
    expect(g1.observation.startsWith("검증되지 않은 요구사항: R-04 ·")).toBe(true);
  });

  it("KILLED가 있고 SURVIVED가 없으면 나머지가 TIMEOUT·EQUIVALENT여도 PASS다", () => {
    const [g1, g2] = decideEffectiveness({
      rubric,
      stage: DONE_READY,
      experiments: experimentsOf({
        "M-01": "KILLED",
        "M-02": "TIMEOUT",
        "M-03": "EQUIVALENT",
        "M-04": "KILLED",
      }),
    });
    expect(g1).toMatchObject({ verdict: "PASS", earnedPoints: 5 });
    expect(g2).toMatchObject({ verdict: "PASS", earnedPoints: 5 });
  });

  it("유효 실험이 없으면(NOT_APPLICABLE·EQUIVALENT·BUILD_FAIL·ENV_ERROR·TIMEOUT·실험 없음) INCONCLUSIVE다", () => {
    const decisions = byId(
      decideEffectiveness({
        rubric,
        stage: DONE_READY,
        experiments: experimentsOf({
          "M-01": "EQUIVALENT",
          "M-02": "BUILD_FAIL",
          "M-03": "ENV_ERROR",
          "M-04": "TIMEOUT",
        }),
      }),
    );
    for (const id of ["G1", "G2", "G3"]) {
      expect(decisions.get(id)).toMatchObject({
        verdict: "INCONCLUSIVE",
        earnedPoints: null,
        reviewState: "PENDING",
        issueId: null,
      });
    }
    expect(decisions.get("G3")!.observation).toContain("실험 기록 없음: M-05");
  });

  it("테스트 미제출은 세 그룹 모두 FAIL 0점이고 observation이 '제출 테스트 없음'이다", () => {
    const decisions = decideEffectiveness({
      rubric,
      stage: {
        state: "DONE",
        detail: { precondition: { status: "NO_TESTS", reason: "", testsStatus: "NO_TESTS" } },
      },
      experiments: [],
    });
    expect(decisions.map((d) => [d.criterionId, d.verdict, d.earnedPoints, d.observation])).toEqual(
      [
        ["G1", "FAIL", 0, NO_SUBMITTED_TESTS_OBSERVATION],
        ["G2", "FAIL", 0, NO_SUBMITTED_TESTS_OBSERVATION],
        ["G3", "FAIL", 0, NO_SUBMITTED_TESTS_OBSERVATION],
      ],
    );
    expect(NO_SUBMITTED_TESTS_OBSERVATION).toBe("제출 테스트 없음");
    // 그룹마다 다른 issueId: 서로 다른 요구사항 그룹이며 aggregateScore가 중복 감점으로 거부하지 않는다 (G-12)
    expect(new Set(decisions.map((d) => d.issueId)).size).toBe(3);
  });

  it("환경 미지원·기준 실행 실패·단계 건너뜀은 세 그룹 모두 INCONCLUSIVE 검토 대기다", () => {
    const stages = [
      {
        state: "DONE" as const,
        detail: {
          precondition: {
            status: "ENV_UNSUPPORTED",
            reason: "",
            testsStatus: "UNSUPPORTED_FRAMEWORK",
          },
        },
      },
      {
        state: "DONE" as const,
        detail: { precondition: { status: "BASELINE_FAILED", reason: "", testsStatus: "FAILED" } },
      },
      { state: "SKIPPED" as const, reason: "disabled_by_config" },
    ];
    const prefixes = [
      "환경 미지원: 제출 테스트 기준 실행 UNSUPPORTED_FRAMEWORK",
      "제출 테스트 기준 실행 실패",
      "테스트 실효성 미실행: disabled_by_config",
    ];
    for (const [index, stage] of stages.entries()) {
      const decisions = decideEffectiveness({ rubric, stage, experiments: [] });
      expect(decisions).toHaveLength(3);
      for (const d of decisions) {
        expect(d).toMatchObject({
          verdict: "INCONCLUSIVE",
          earnedPoints: null,
          reviewState: "PENDING",
        });
        expect(d.observation.startsWith(prefixes[index]!)).toBe(true);
      }
    }
  });

  it("observation에 비율 표기가 없다", () => {
    const all = [
      ...decideEffectiveness({
        rubric,
        stage: DONE_READY,
        experiments: experimentsOf({
          "M-01": "SURVIVED",
          "M-02": "KILLED",
          "M-03": "NOT_APPLICABLE",
          "M-04": "EQUIVALENT",
          "M-05": "KILLED",
        }),
      }),
    ];
    for (const d of all) expect(d.observation).not.toMatch(RATIO_PATTERN);
  });
});

// ─── DB 통합: 전체 파이프라인 ────────────────────────────────────────────────

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

function editPackage(
  files: FakeRepoFiles,
  edit: (pkg: {
    scripts: Record<string, string>;
    devDependencies?: Record<string, string>;
  }) => void,
): void {
  const pkg = JSON.parse(files["package.json"]!.toString()) as Parameters<typeof edit>[0];
  edit(pkg);
  files["package.json"] = JSON.stringify(pkg, null, 2);
}

/** 샘플 A에서 테스트를 모두 뺀 픽스처 (테스트 미제출) */
async function noTestsFiles(): Promise<FakeRepoFiles> {
  const files = await readTree(path.join(SAMPLES_DIR, "impl-a"));
  for (const name of Object.keys(files)) {
    if (name.startsWith("test/") || name === "vitest.config.ts") delete files[name];
  }
  editPackage(files, (pkg) => {
    delete pkg.scripts.test;
    delete pkg.devDependencies?.vitest;
  });
  return files;
}

/**
 * 샘플 A의 테스트 명령을 jest로 바꾼 픽스처 (지원하지 않는 프레임워크 → 환경 미지원).
 * jest를 의존성에 넣으면 템플릿 허용 목록 검사(T-203)에서 제출 전체가 UNSUPPORTED가 되므로 명령만 바꾼다
 */
async function jestFiles(): Promise<FakeRepoFiles> {
  const files = await readTree(path.join(SAMPLES_DIR, "impl-a"));
  delete files["vitest.config.ts"];
  files["jest.config.js"] = "export default { testEnvironment: 'node' };\n";
  editPackage(files, (pkg) => {
    pkg.scripts.test = "jest";
    delete pkg.devDependencies?.vitest;
  });
  return files;
}

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/worker] DATABASE_URL_TEST가 없어 테스트 실효성 통합 테스트를 건너뜁니다");
}

const SHA = {
  a: "a".repeat(40),
  c: "c".repeat(40),
  d: "d".repeat(40),
  noTests: "e".repeat(40),
  jest: "f".repeat(40),
} as const;
type Ref = "a" | "c" | "d" | "no-tests" | "jest";

interface Evaluated {
  evaluationId: string;
  submissionStatus: string;
  rows: Map<string, CriterionResultRow>;
  scoring: EffectivenessScoringSummary;
  scoreDisplay: string;
}

describe.skipIf(!hasTestDb)("테스트 실효성 점수 산정 (DB 통합)", () => {
  let tdb: TestDatabase;
  let rubric: Rubric;
  let assignmentVersionId: string;
  let github: ReturnType<typeof fakeGitHub>;
  const workRoots: string[] = [];
  let expectedMatrix: {
    samples: Array<{ id: string; scoreDisplay: { beforeHumanReview: string } }>;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    rubric = await loadRubric();
    const contract = ExecutionContractSchema.parse(
      JSON.parse(await readFile(path.join(SAMPLES_DIR, "execution-contract.json"), "utf8")),
    );
    expectedMatrix = JSON.parse(
      await readFile(path.join(SAMPLES_DIR, "expected-matrix.json"), "utf8"),
    ) as typeof expectedMatrix;
    const assignment = await createAssignment(tdb.db, { name: "T-404 테스트 과제" });
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
      approvedBy: "tester",
      validationResult: { ok: true },
    });
    assignmentVersionId = approved.id;
    // 판정 행의 rubricVersion은 저장된 버전(`v1-<해시>`)이다. 집계는 저장된 rubric으로 한다
    rubric = approved.rubric;
    const [a, c, d, noTests, jest] = await Promise.all([
      readTree(path.join(SAMPLES_DIR, "impl-a")),
      readTree(path.join(SAMPLES_DIR, "impl-c")),
      readTree(path.join(SAMPLES_DIR, "impl-d")),
      noTestsFiles(),
      jestFiles(),
    ]);
    github = fakeGitHub({
      "acme/order-api": {
        defaultBranch: "main",
        refs: { a: SHA.a, c: SHA.c, d: SHA.d, "no-tests": SHA.noTests, jest: SHA.jest },
        tarballs: {
          [SHA.a]: () => makeGitHubStyleTarball(a, SHA.a),
          [SHA.c]: () => makeGitHubStyleTarball(c, SHA.c),
          [SHA.d]: () => makeGitHubStyleTarball(d, SHA.d),
          [SHA.noTests]: () => makeGitHubStyleTarball(noTests, SHA.noTests),
          [SHA.jest]: () => makeGitHubStyleTarball(jest, SHA.jest),
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(workRoots.map((dir) => rm(dir, { recursive: true, force: true })));
    await tdb?.destroy();
  });

  async function evaluate(ref: Ref): Promise<Evaluated> {
    const workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-effectiveness-"));
    workRoots.push(workRoot);
    const store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
    const deps: PipelineDeps = {
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
    expect(stage.state, JSON.stringify(evaluation.stageLog)).toBe("DONE");
    const rows = await listCriterionResults(tdb.db, evaluation.id);
    const score = aggregateScore(rows.map(toCriterionResult), rubric);
    // 저장된 점수 필드가 판정 행의 집계와 같다
    expect({
      earned: evaluation.scoreEarned,
      min: evaluation.scoreMin,
      max: evaluation.scoreMax,
      pendingPoints: evaluation.pendingPoints,
    }).toEqual({
      earned: score.earned,
      min: score.min,
      max: score.max,
      pendingPoints: score.pendingPoints,
    });
    expect(evaluation.scoreByArea).toEqual(score.byArea);
    return {
      evaluationId: evaluation.id,
      submissionStatus: result.submissionStatus,
      rows: new Map(rows.map((r) => [r.criterionId, r])),
      scoring: (stage.detail as { scoring: EffectivenessScoringSummary }).scoring,
      scoreDisplay: score.display,
    };
  }

  const memo = new Map<Ref, Promise<Evaluated>>();
  const evaluated = (ref: Ref) => {
    if (!memo.has(ref)) memo.set(ref, evaluate(ref));
    return memo.get(ref)!;
  };
  const expectedDisplay = (id: string) =>
    expectedMatrix.samples.find((s) => s.id === id)!.scoreDisplay.beforeHumanReview;

  it("A: 테스트 실효성 15/15이고 점수가 기대 결과표(beforeHumanReview)와 같다", async () => {
    const { rows, scoring, scoreDisplay, submissionStatus } = await evaluated("a");
    expect(submissionStatus).toBe("COMPLETED");
    for (const id of ["G1", "G2", "G3"]) {
      expect(rows.get(id)).toMatchObject({
        verdict: "PASS",
        earnedPoints: 5,
        reviewState: "NOT_REQUIRED",
        issueId: null,
      });
      expect(rows.get(id)!.observation).toMatch(/^유효한 변형을 제출 테스트가 모두 탐지함 · /);
    }
    const effectiveness = aggregateScore(
      [...rows.values()].map(toCriterionResult),
      rubric,
    ).byArea.find((a) => a.area === "TEST_EFFECTIVENESS")!;
    expect(effectiveness).toMatchObject({ earned: 15, min: 15, max: 15, pendingPoints: 0 });
    expect(scoring.groups.map((g) => [g.criterionId, g.verdict, g.earnedPoints])).toEqual([
      ["G1", "PASS", 5],
      ["G2", "PASS", 5],
      ["G3", "PASS", 5],
    ]);
    expect(scoreDisplay).toBe(expectedDisplay("A"));
  }, 240_000);

  it.each([
    ["c", "C"],
    ["d", "D"],
  ] as const)(
    "%s: G1 0점(observation에 R-03·R-04), G2 null 검토 대기, G3 5점",
    async (ref, sampleId) => {
      const { rows, scoreDisplay } = await evaluated(ref);
      const g1 = rows.get("G1")!;
      expect(g1).toMatchObject({
        verdict: "FAIL",
        earnedPoints: 0,
        reviewState: "NOT_REQUIRED",
        issueId: "untested:G1",
      });
      expect(g1.observation).toMatch(/^검증되지 않은 요구사항: R-03, R-04 · /);
      expect(rows.get("G2")).toMatchObject({
        verdict: "INCONCLUSIVE",
        earnedPoints: null,
        reviewState: "PENDING",
      });
      expect(rows.get("G2")!.observation).toContain("대상 로직 없음");
      expect(rows.get("G3")).toMatchObject({ verdict: "PASS", earnedPoints: 5 });
      expect(scoreDisplay).toBe(expectedDisplay(sampleId));
      for (const row of rows.values()) expect(row.observation).not.toMatch(RATIO_PATTERN);
    },
    240_000,
  );

  it("근거: G1의 근거는 M-01 검증 기록 → M-01 테스트 기록 → M-01 diff → M-02 … 순서이며 원본 제출 테스트 근거가 뒤에 남는다", async () => {
    const { evaluationId, rows } = await evaluated("c");
    const [experiments, records, evidences] = await Promise.all([
      listMutationExperiments(tdb.db, evaluationId),
      listExecutionRecords(tdb.db, evaluationId),
      listEvidences(tdb.db, evaluationId),
    ]);
    const evidenceById = new Map(evidences.map((e) => [e.id, e]));
    const recordById = new Map(records.map((r) => [r.id, r]));
    const g1 = rows.get("G1")!.evidenceIds.map((id) => evidenceById.get(id)!);
    const m01 = experiments.find((e) => e.mutationId === "M-01")!;
    const m02 = experiments.find((e) => e.mutationId === "M-02")!;
    expect(g1.slice(0, 6).map((e) => e.runId ?? e.artifactRefs[0])).toEqual([
      m01.validationRecordId,
      m01.testRecordId,
      m01.patchRef,
      m02.validationRecordId,
      m02.testRecordId,
      m02.patchRef,
    ]);
    expect(recordById.get(g1[0]!.runId!)!.kind).toBe("MUTATION_VALIDATION");
    expect(recordById.get(g1[1]!.runId!)!.kind).toBe("MUTATION_TESTS");
    // 기록 근거는 본문과 diff를 함께 참조하고, 하네스 케이스 ID를 두지 않는다(재실행 대상이 아니다)
    expect(g1[0]!.artifactRefs).toContain(m01.patchRef);
    expect(g1[0]!.artifactRefs).toContain(recordById.get(g1[0]!.runId!)!.actualRef);
    expect(g1[0]!.testId).toBeNull();
    // diff 근거는 변형 위치를 가진다
    expect(g1[2]!.source).toEqual(m01.target);
    expect(g1[2]!.runId).toBeNull();
    // 원본 제출 테스트 근거(T-205)
    const baseline = recordById.get(g1.at(-1)!.runId!)!;
    expect(baseline.kind).toBe("SUBMITTED_TESTS");
    // G2(NOT_APPLICABLE뿐)는 변형 근거 없이 원본 제출 테스트 근거만 가진다
    const g2 = rows.get("G2")!.evidenceIds.map((id) => evidenceById.get(id)!);
    expect(g2.map((e) => recordById.get(e.runId!)!.kind)).toEqual(["SUBMITTED_TESTS"]);
  }, 240_000);

  it("테스트 미제출 픽스처는 세 그룹 모두 0점이고 observation이 '제출 테스트 없음'이다 (INCONCLUSIVE가 아니다)", async () => {
    const { rows, scoring } = await evaluated("no-tests");
    for (const id of ["G1", "G2", "G3"]) {
      const row = rows.get(id)!;
      expect(row).toMatchObject({
        verdict: "FAIL",
        earnedPoints: 0,
        reviewState: "NOT_REQUIRED",
        observation: "제출 테스트 없음",
      });
      expect(row.evidenceIds.length).toBeGreaterThan(0);
    }
    expect(scoring.groups.every((g) => g.basis === "NO_TESTS")).toBe(true);
  }, 240_000);

  it("jest 픽스처는 세 그룹 모두 INCONCLUSIVE다 (환경 미지원)", async () => {
    const { rows, scoring } = await evaluated("jest");
    for (const id of ["G1", "G2", "G3"]) {
      expect(rows.get(id)).toMatchObject({
        verdict: "INCONCLUSIVE",
        earnedPoints: null,
        reviewState: "PENDING",
      });
      expect(rows.get(id)!.observation).toMatch(
        /^환경 미지원: 제출 테스트 기준 실행 UNSUPPORTED_FRAMEWORK/,
      );
    }
    expect(scoring.groups.every((g) => g.basis === "ENV_UNSUPPORTED")).toBe(true);
  }, 240_000);

  it("다시 저장해도 근거가 늘지 않고 판정이 같다. 사람이 확정한 판정은 바꾸지 않는다", async () => {
    const { evaluationId, rows } = await evaluated("c");
    const evaluation = (await getEvaluation(tdb.db, evaluationId))!;
    const stage = evaluation.stageLog.find((s) => s.stage === "TEST_EFFECTIVENESS")!;
    const before = await listEvidences(tdb.db, evaluationId);
    const again = await persistEffectivenessResults(
      { evaluation: { id: evaluationId, submissionSha: SHA.c }, rubric, stage },
      { db: tdb.db },
    );
    expect(again.status).toBe("saved");
    if (again.status === "saved") expect(again.summary.evidencesAdded).toBe(0);
    expect(await listEvidences(tdb.db, evaluationId)).toHaveLength(before.length);
    const afterRows = new Map(
      (await listCriterionResults(tdb.db, evaluationId)).map((r) => [r.criterionId, r]),
    );
    for (const id of ["G1", "G2", "G3"]) {
      expect(afterRows.get(id)!.evidenceIds).toEqual(rows.get(id)!.evidenceIds);
      expect(afterRows.get(id)!.observation).toBe(rows.get(id)!.observation);
    }
    // 사람이 G2를 확정했다고 두고 다시 저장하면 G2는 건너뛴다
    await tdb.db
      .update(criterionResults)
      .set({ verdict: "PASS", earnedPoints: 5, reviewState: "CONFIRMED" })
      .where(
        and(
          eq(criterionResults.evaluationId, evaluationId),
          eq(criterionResults.criterionId, "G2"),
        ),
      );
    const third = await persistEffectivenessResults(
      { evaluation: { id: evaluationId, submissionSha: SHA.c }, rubric, stage },
      { db: tdb.db },
    );
    expect(third.status).toBe("saved");
    if (third.status === "saved") {
      expect(third.summary.groups.find((g) => g.criterionId === "G2")!.skipped).toBe(
        "사람이 확정한 판정이라 바꾸지 않음",
      );
    }
    const g2 = (await listCriterionResults(tdb.db, evaluationId)).find(
      (r) => r.criterionId === "G2",
    )!;
    expect(g2).toMatchObject({ verdict: "PASS", earnedPoints: 5, reviewState: "CONFIRMED" });
  }, 240_000);
});
