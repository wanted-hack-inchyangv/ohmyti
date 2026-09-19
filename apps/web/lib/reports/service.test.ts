import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EvaluationReportResponseSchema,
  EvaluationReportSchema,
  FunctionGraphReportResponseSchema,
  RunRecordReportResponseSchema,
  RunRecordReportSchema,
  SubmissionSummaryResponseSchema,
  SubmissionSummarySchema,
  aggregateScore,
} from "@ohmyti/core";
import {
  createTestDatabase,
  criterionResults,
  evaluations,
  finishEvaluation,
  persistEvaluationResults,
  persistMutationExperiment,
  reviewEvents,
  seedEvaluation,
  setSubmissionStatus,
  submissions,
  updateEvaluationStage,
  type EvaluationResultsInput,
  type TestDatabase,
} from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AccessConfig } from "@/lib/auth/config";
import { decideAccess } from "@/lib/auth/guard";
import { isPublicPath } from "@/lib/auth/paths";
import {
  httpStatusOf,
  logRefsOf,
  readEvaluationReport,
  readFunctionGraph,
  readMutationDiff,
  readRunRecord,
  readSubmissionSummary,
  storedScoreOf,
  type ReportDeps,
} from "./service";

// `seedEvaluation` 픽스처(@ohmyti/db)가 쓰는 값
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/web] DATABASE_URL_TEST가 없어 reports 통합 테스트를 건너뜁니다");
}

describe("storedScoreOf", () => {
  it("저장된 네 필드를 그대로 옮기고 표기는 min~max로 만든다", () => {
    expect(
      storedScoreOf({
        scoreEarned: 75,
        scoreMin: 75,
        scoreMax: 100,
        pendingPoints: 25,
        scoreByArea: null,
      }),
    ).toEqual({
      earned: 75,
      min: 75,
      max: 100,
      pendingPoints: 25,
      total: 100,
      display: "75~100/100 · 25점 검토 대기",
      byArea: null,
    });
    expect(
      storedScoreOf({
        scoreEarned: 87,
        scoreMin: 87,
        scoreMax: 87,
        pendingPoints: 0,
        scoreByArea: null,
      })?.display,
    ).toBe("87/100");
  });

  it("영역 소계는 저장된 값을 그대로 옮긴다", () => {
    const byArea = [
      {
        area: "REQUIRED_FEATURES" as const,
        earned: 26,
        min: 26,
        max: 26,
        pendingPoints: 0,
        total: 40,
      },
      { area: "DESIGN" as const, earned: 0, min: 0, max: 10, pendingPoints: 10, total: 10 },
    ];
    expect(
      storedScoreOf({
        scoreEarned: 26,
        scoreMin: 26,
        scoreMax: 36,
        pendingPoints: 10,
        scoreByArea: byArea,
      })?.byArea,
    ).toEqual(byArea);
  });

  it("점수 필드가 하나라도 없으면 null (판정 저장 전)", () => {
    expect(
      storedScoreOf({
        scoreEarned: null,
        scoreMin: null,
        scoreMax: null,
        pendingPoints: null,
        scoreByArea: null,
      }),
    ).toBeNull();
    expect(
      storedScoreOf({
        scoreEarned: 1,
        scoreMin: 1,
        scoreMax: null,
        pendingPoints: 0,
        scoreByArea: null,
      }),
    ).toBeNull();
  });
});

describe("logRefsOf", () => {
  it("stdout·stderr 로그 키만 중복 없이 고른다", () => {
    expect(
      logRefsOf([
        "evaluations/e/runs/r/actual.json",
        "evaluations/e/sandbox/attempt-1/service-1/stdout.txt",
        "evaluations/e/sandbox/attempt-1/service-1/stderr.txt",
        "evaluations/e/sandbox/attempt-1/service-1/stdout.txt",
        "evaluations/e/stages/REQUIREMENT_VERIFY/harness.json",
      ]),
    ).toEqual({
      stdout: ["evaluations/e/sandbox/attempt-1/service-1/stdout.txt"],
      stderr: ["evaluations/e/sandbox/attempt-1/service-1/stderr.txt"],
    });
  });
});

describe("httpStatusOf", () => {
  it("입력 오류는 400, 없는 자원은 404", () => {
    expect(httpStatusOf("INVALID_INPUT")).toBe(400);
    expect(httpStatusOf("EVALUATION_NOT_FOUND")).toBe(404);
    expect(httpStatusOf("RUN_NOT_FOUND")).toBe(404);
    expect(httpStatusOf("SUBMISSION_NOT_FOUND")).toBe(404);
    expect(httpStatusOf("ARTIFACT_NOT_FOUND")).toBe(404);
    expect(httpStatusOf("MUTATION_NOT_FOUND")).toBe(404);
  });
});

describe("API 코드에 점수 계산 로직이 없다", () => {
  const files = [
    path.join(import.meta.dirname, "service.ts"),
    path.join(import.meta.dirname, "http.ts"),
    path.join(import.meta.dirname, "../../app/api/evaluations/[id]/route.ts"),
    path.join(import.meta.dirname, "../../app/api/evaluations/[id]/runs/[runId]/route.ts"),
    path.join(import.meta.dirname, "../../app/api/submissions/[id]/route.ts"),
  ];

  it("aggregateScore·formatScoreDisplay를 부르지 않고 배점을 더하지 않는다", async () => {
    for (const file of files) {
      const source = await readFile(file, "utf8");
      // 주석 줄은 제외하고 코드만 본다
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/aggregateScore/);
      expect(code, file).not.toMatch(/\bformatScoreDisplay\b/);
      expect(code, file).not.toMatch(/\.reduce\(/);
      expect(code, file).not.toMatch(/maxPoints\s*[-+]|earnedPoints\s*[-+]/);
    }
  });
});

describe("접근 보호 (T-008 proxy)", () => {
  const SECRET = "0123456789abcdef0123456789abcdef";
  const ENABLED: AccessConfig = { enabled: true, password: "pw", secret: SECRET };
  const paths = [
    `/api/evaluations/${randomUUID()}`,
    `/api/evaluations/${randomUUID()}/runs/${randomUUID()}`,
    `/api/evaluations/${randomUUID()}/graph`,
    `/api/submissions/${randomUUID()}`,
  ];

  it("세 조회 경로는 공개 경로가 아니며 쿠키 없는 요청은 401(unauthorized)이다", async () => {
    for (const pathname of paths) {
      expect(isPublicPath(pathname)).toBe(false);
      const decision = await decideAccess(
        {
          pathname,
          search: "",
          method: "GET",
          accept: "application/json",
          sessionToken: undefined,
        },
        ENABLED,
      );
      expect(decision, pathname).toEqual({ kind: "unauthorized" });
      // 브라우저 탐색(Accept: text/html)이어도 /api/*는 로그인 화면으로 보내지 않고 401이다
      const html = await decideAccess(
        { pathname, search: "", method: "GET", accept: "text/html", sessionToken: undefined },
        ENABLED,
      );
      expect(html, pathname).toEqual({ kind: "unauthorized" });
    }
  });
});

// ── 통합 ─────────────────────────────────────────────────────────────────────

interface Seeded {
  evaluationId: string;
  submissionId: string;
  rubricVersion: string;
  input: EvaluationResultsInput;
  bodies: Map<string, unknown>;
}

/** 평가 하나에 기동 기록 + 하네스 케이스 기록 + 제출 테스트 기록을 아티팩트와 함께 저장한다 */
async function seedResults(deps: ReportDeps, label: string): Promise<Seeded> {
  const seeded = await seedEvaluation(deps.db, `web-t207-${label}-${Date.now()}`);
  const { evaluationId, submissionId, rubricVersion } = seeded;
  await updateEvaluationStage(deps.db, evaluationId, "REPO_CHECK", { state: "RUNNING" });
  await updateEvaluationStage(deps.db, evaluationId, "REPO_CHECK", {
    state: "DONE",
    detail: { submissionSha: SHA, fileCount: 3 },
  });
  await updateEvaluationStage(deps.db, evaluationId, "REQUIREMENT_VERIFY", { state: "RUNNING" });
  await updateEvaluationStage(deps.db, evaluationId, "REQUIREMENT_VERIFY", { state: "DONE" });

  const bodies = new Map<string, unknown>();
  const serviceLogs = [
    `evaluations/${evaluationId}/sandbox/attempt-1/service-1/stdout.txt`,
    `evaluations/${evaluationId}/sandbox/attempt-1/service-1/stderr.txt`,
  ];
  const makeRecord = (
    kind: "HARNESS" | "SUBMITTED_TESTS",
    parts: { input: unknown; expected: unknown; actual: unknown; timeline?: unknown },
    fields: { failureKind: "NONE" | "ASSERTION"; exitCode: number | null; testId?: string },
  ) => {
    const runId = randomUUID();
    const key = (part: "input" | "expected" | "actual" | "timeline") =>
      artifactKeys.runRecord(evaluationId, runId, part);
    bodies.set(key("input"), parts.input);
    bodies.set(key("expected"), parts.expected);
    bodies.set(key("actual"), parts.actual);
    const refs = [key("input"), key("expected"), key("actual")];
    if (parts.timeline !== undefined) {
      bodies.set(key("timeline"), parts.timeline);
      refs.push(key("timeline"));
    }
    return {
      record: {
        id: runId,
        evaluationId,
        kind,
        submissionSha: SHA,
        rubricVersion,
        harnessVersion: "harness-0",
        environmentDigest: DIGEST,
        inputRef: key("input"),
        expectedRef: key("expected"),
        actualRef: key("actual"),
        exitCode: fields.exitCode,
        failureKind: fields.failureKind,
        startedAt: "2026-09-18T09:00:00.000Z",
        finishedAt: "2026-09-18T09:00:01.500Z",
        durationMs: 1500,
      },
      evidence: {
        id: randomUUID(),
        evaluationId,
        submissionSha: SHA,
        runId,
        testId: fields.testId,
        artifactRefs: [...refs, ...serviceLogs],
      },
    };
  };

  const startup = makeRecord(
    "HARNESS",
    {
      input: { kind: "SERVICE_STARTUP", startCommand: "npm start" },
      expected: { outcome: "HEALTHY" },
      actual: { outcome: "HEALTHY", elapsedMs: 812 },
    },
    { failureKind: "NONE", exitCode: null },
  );
  const harnessCase = makeRecord(
    "HARNESS",
    {
      input: { kind: "HARNESS_CASE", caseId: "R-01-normal-order" },
      expected: { caseId: "R-01-normal-order", expected: { status: 201 } },
      actual: {
        caseId: "R-01-normal-order",
        verdict: "FAIL",
        failureKind: "ASSERTION",
        actual: { status: 500, "p1After.stock": 0 },
        checks: [{ name: "status", expected: 201, actual: 500, passed: false }],
      },
      timeline: [{ at: 0, step: "POST /orders", status: 500 }],
    },
    { failureKind: "ASSERTION", exitCode: null, testId: "R-01-normal-order" },
  );
  const tests = makeRecord(
    "SUBMITTED_TESTS",
    {
      input: { kind: "SUBMITTED_TESTS", framework: "vitest" },
      expected: { status: "PASSED" },
      actual: { status: "PASSED", total: 12, passed: 12 },
    },
    { failureKind: "NONE", exitCode: 0 },
  );

  for (const [key, body] of bodies) {
    await deps.store.put(key, JSON.stringify(body), {
      contentType: ARTIFACT_CONTENT_TYPES.runRecord,
    });
  }

  const input: EvaluationResultsInput = {
    evaluationId,
    executionRecords: [startup.record, harnessCase.record, tests.record],
    evidences: [startup.evidence, harnessCase.evidence, tests.evidence],
    criterionResults: [
      {
        evaluationId,
        criterionId: "R-01",
        rubricVersion,
        maxPoints: 100,
        earnedPoints: 0,
        verdict: "FAIL",
        method: "EXECUTION",
        evidenceIds: [harnessCase.evidence.id, startup.evidence.id],
        issueId: "case:R-01-normal-order",
        observation: "케이스 R-01-normal-order 검사 1개 중 1개 실패 · status: 기대 201, 실제 500",
        reviewState: "NOT_REQUIRED",
      },
    ],
    score: {
      earned: 0,
      min: 0,
      max: 0,
      pendingPoints: 0,
      byArea: [
        { area: "REQUIRED_FEATURES", earned: 0, min: 0, max: 0, pendingPoints: 0, total: 100 },
      ],
    },
  };
  await persistEvaluationResults(deps.db, input);
  await finishEvaluation(deps.db, evaluationId, new Date("2026-09-18T09:00:05.000Z"));
  await setSubmissionStatus(deps.db, submissionId, "COMPLETED");
  return { evaluationId, submissionId, rubricVersion, input, bodies };
}

describe.skipIf(!hasTestDb)("reports 서비스 (통합)", () => {
  let tdb: TestDatabase;
  let storeRoot: string;
  let deps: ReportDeps;
  let seeded: Seeded;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storeRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-web-reports-"));
    deps = { db: tdb.db, store: new FsArtifactStore({ root: storeRoot }) };
    seeded = await seedResults(deps, "main");
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  it("리포트가 스키마를 통과하고 점수는 DB 행의 값과 같다", async () => {
    const result = await readEvaluationReport(deps, seeded.evaluationId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = EvaluationReportSchema.parse(result.data);

    const [row] = await tdb.db
      .select()
      .from(evaluations)
      .where(eq(evaluations.id, seeded.evaluationId));
    expect(report.score).toEqual({
      earned: row!.scoreEarned,
      min: row!.scoreMin,
      max: row!.scoreMax,
      pendingPoints: row!.pendingPoints,
      total: 100,
      display: "0/100",
      byArea: row!.scoreByArea,
    });
    expect(report.score!.byArea).toEqual(seeded.input.score.byArea);
    // 저장된 값은 집계 엔진으로 검산했을 때와도 같다 (API는 집계하지 않고 저장 값을 옮긴다)
    const summary = aggregateScore(report.criterionResults, report.rubric);
    expect(summary.earned).toBe(report.score!.earned);
    expect(summary.pendingPoints).toBe(report.score!.pendingPoints);
    expect(summary.display).toBe(report.score!.display);
    expect(summary.byArea).toEqual(report.score!.byArea);

    expect(report.evaluation.id).toBe(seeded.evaluationId);
    expect(report.evaluation.submissionId).toBe(seeded.submissionId);
    expect(report.evaluation.finishedAt).toBe("2026-09-18T09:00:05.000Z");
    expect(report.submission.status).toBe("COMPLETED");
    expect(report.assignment.name).toBe("테스트 과제");
    expect(report.rubric.version).toBe(seeded.rubricVersion);
    expect(report.rubric.criteria.map((c) => c.id)).toEqual(["R-01"]);
    expect(report.criterionResults).toHaveLength(1);
    expect(report.criterionResults[0]).toMatchObject({
      criterionId: "R-01",
      verdict: "FAIL",
      earnedPoints: 0,
      issueId: "case:R-01-normal-order",
    });
    expect(report.criterionResults[0]!.interpretation).toBeUndefined();
    expect(report.evidences.map((e) => e.id).sort()).toEqual(
      seeded.input.evidences.map((e) => e.id).sort(),
    );
    expect(report.executionRecords.map((r) => r.id).sort()).toEqual(
      seeded.input.executionRecords.map((r) => r.id).sort(),
    );
    expect(report.stages.map((s) => [s.stage, s.state])).toEqual([
      ["REPO_CHECK", "DONE"],
      ["REQUIREMENT_VERIFY", "DONE"],
    ]);
    expect(report.reviewEvents).toEqual([]);
  });

  it("리포트의 실행 기록과 run 엔드포인트의 본문은 같은 runId·같은 ref에서 나온다", async () => {
    const report = await readEvaluationReport(deps, seeded.evaluationId);
    if (!report.ok) throw new Error(report.message);
    expect(report.data.executionRecords.length).toBe(3);
    for (const record of report.data.executionRecords) {
      const run = await readRunRecord(deps, seeded.evaluationId, record.id);
      expect(run.ok, record.id).toBe(true);
      if (!run.ok) continue;
      const parsed = RunRecordReportSchema.parse(run.data);
      expect(parsed.runId).toBe(record.id);
      expect(parsed.record).toEqual(record);
      expect(parsed.record.actualRef).toBe(record.actualRef);
      expect(parsed.actual).toEqual(seeded.bodies.get(record.actualRef));
      expect(parsed.input).toEqual(seeded.bodies.get(record.inputRef));
      expect(parsed.expected).toEqual(seeded.bodies.get(record.expectedRef));
      const timelineKey = artifactKeys.runRecord(seeded.evaluationId, record.id, "timeline");
      expect(parsed.timeline).toEqual(seeded.bodies.get(timelineKey) ?? null);
      expect(parsed.evidences).toHaveLength(1);
      expect(parsed.evidences[0]!.runId).toBe(record.id);
      expect(parsed.logs).toEqual({
        stdout: [`evaluations/${seeded.evaluationId}/sandbox/attempt-1/service-1/stdout.txt`],
        stderr: [`evaluations/${seeded.evaluationId}/sandbox/attempt-1/service-1/stderr.txt`],
      });
    }
    // 근거가 가리키는 runId는 모두 리포트의 실행 기록에 있다
    const runIds = new Set(report.data.executionRecords.map((r) => r.id));
    for (const evidence of report.data.evidences) {
      expect(evidence.runId && runIds.has(evidence.runId)).toBe(true);
    }
    // FAIL 판정이 참조하는 근거는 하네스 케이스 기록(actual에 실패 검사)이다
    const failing = report.data.criterionResults.find((c) => c.verdict === "FAIL")!;
    const evidence = report.data.evidences.find((e) => e.id === failing.evidenceIds[0])!;
    const run = await readRunRecord(deps, seeded.evaluationId, evidence.runId!);
    expect(run.ok && (run.data.actual as { verdict: string }).verdict).toBe("FAIL");
  });

  it("없는 기록·다른 평가의 기록·잘못된 ID·본문 아티팩트 없음을 구분해 거절한다", async () => {
    const missing = await readRunRecord(deps, seeded.evaluationId, randomUUID());
    expect(missing).toMatchObject({ ok: false, code: "RUN_NOT_FOUND" });

    const other = await seedEvaluation(tdb.db, `web-t207-other-${Date.now()}`);
    const runId = seeded.input.executionRecords[0]!.id;
    const crossed = await readRunRecord(deps, other.evaluationId, runId);
    expect(crossed).toMatchObject({ ok: false, code: "RUN_NOT_FOUND" });

    expect(await readRunRecord(deps, "not-a-uuid", runId)).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await readRunRecord(deps, seeded.evaluationId, "nope")).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await readEvaluationReport(deps, "x")).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await readEvaluationReport(deps, randomUUID())).toMatchObject({
      ok: false,
      code: "EVALUATION_NOT_FOUND",
    });

    // 본문 아티팩트가 없는 기록 (스토어 유실): 404·ARTIFACT_NOT_FOUND, 빈 값으로 꾸미지 않는다
    const lost = seeded.input.executionRecords[2]!;
    await deps.store.delete(lost.actualRef);
    try {
      const result = await readRunRecord(deps, seeded.evaluationId, lost.id);
      expect(result).toMatchObject({ ok: false, code: "ARTIFACT_NOT_FOUND" });
      expect(!result.ok && result.message).toContain("actual");
    } finally {
      await deps.store.put(lost.actualRef, JSON.stringify(seeded.bodies.get(lost.actualRef)), {
        contentType: ARTIFACT_CONTENT_TYPES.runRecord,
      });
    }
  });

  it("관련 함수 그래프(T-304)는 저장된 아티팩트를 스키마로 확인해 그대로 돌려주고, 없으면 ARTIFACT_NOT_FOUND", async () => {
    const key = artifactKeys.functionGraph(seeded.evaluationId);
    expect(await readFunctionGraph(deps, seeded.evaluationId)).toMatchObject({
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
    });
    expect(await readFunctionGraph(deps, randomUUID())).toMatchObject({
      ok: false,
      code: "EVALUATION_NOT_FOUND",
    });
    expect(await readFunctionGraph(deps, "x")).toMatchObject({ ok: false, code: "INVALID_INPUT" });

    const analysis = {
      status: "unavailable",
      analyzerVersion: "1",
      reason: "문법 오류: src/x.ts:1 '{' expected.",
    };
    await deps.store.put(key, JSON.stringify(analysis), { contentType: "application/json" });
    try {
      const result = await readFunctionGraph(deps, seeded.evaluationId);
      expect(result).toEqual({
        ok: true,
        data: { evaluationId: seeded.evaluationId, artifactKey: key, analysis },
      });
      // 형태가 맞지 않는 아티팩트는 꾸미지 않고 거절한다
      await deps.store.put(key, JSON.stringify({ status: "weird" }), {
        contentType: "application/json",
      });
      expect(await readFunctionGraph(deps, seeded.evaluationId)).toMatchObject({
        ok: false,
        code: "ARTIFACT_NOT_FOUND",
      });
    } finally {
      await deps.store.delete(key);
    }
  });

  it("변형 실험(T-404)은 리포트에 실리고, diff는 저장된 본문 그대로 돌려준다. 없는 실험·diff 없는 실험·유실은 구분한다", async () => {
    const { evaluationId } = seeded;
    const patchRef = artifactKeys.mutationDiff(evaluationId, "M-02");
    const diff =
      "--- a/src/validation.ts\n+++ b/src/validation.ts\n@@ -1,1 +1,1 @@\n-if (q <= 0)\n+if (q < 0)\n";
    await deps.store.put(patchRef, diff, { contentType: ARTIFACT_CONTENT_TYPES.mutationDiff });
    await persistMutationExperiment(tdb.db, {
      id: randomUUID(),
      evaluationId,
      mutationId: "M-01",
      groupId: "G1",
      targetCriterionId: "R-03",
      outcome: "NOT_APPLICABLE",
      reason: "대상 로직 없음",
    });
    await persistMutationExperiment(tdb.db, {
      id: randomUUID(),
      evaluationId,
      mutationId: "M-02",
      groupId: "G1",
      targetCriterionId: "R-04",
      target: { path: "src/validation.ts", startLine: 1, endLine: 1 },
      patchDigest: DIGEST,
      patchRef,
      outcome: "BUILD_FAIL",
      reason: "새 컴파일 오류",
    });
    const report = await readEvaluationReport(deps, evaluationId);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.data.mutationExperiments.map((e) => [e.mutationId, e.outcome])).toEqual([
        ["M-01", "NOT_APPLICABLE"],
        ["M-02", "BUILD_FAIL"],
      ]);
    }
    expect(await readMutationDiff(deps, evaluationId, "M-02")).toEqual({
      ok: true,
      data: { evaluationId, mutationId: "M-02", patchRef, patchDigest: DIGEST, diff },
    });
    expect(await readMutationDiff(deps, evaluationId, "M-01")).toMatchObject({
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
    });
    expect(await readMutationDiff(deps, evaluationId, "M-09")).toMatchObject({
      ok: false,
      code: "MUTATION_NOT_FOUND",
    });
    expect(await readMutationDiff(deps, evaluationId, "../x")).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    await deps.store.delete(patchRef);
    expect(await readMutationDiff(deps, evaluationId, "M-02")).toMatchObject({
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
    });
  });

  it("제출 요약은 상태·종료 여부·최신 평가 ID와 저장 점수를 낸다", async () => {
    const result = await readSubmissionSummary(deps, seeded.submissionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = SubmissionSummarySchema.parse(result.data);
    expect(summary).toMatchObject({
      id: seeded.submissionId,
      status: "COMPLETED",
      submissionSha: SHA,
      terminal: true,
      latestEvaluation: {
        id: seeded.evaluationId,
        finishedAt: "2026-09-18T09:00:05.000Z",
        score: { earned: 0, pendingPoints: 0, display: "0/100" },
      },
    });

    // 평가가 없는 제출: latestEvaluation null, 점수 없음
    const fresh = await seedEvaluation(tdb.db, `web-t207-fresh-${Date.now()}`);
    await tdb.db.delete(evaluations).where(eq(evaluations.id, fresh.evaluationId));
    const none = await readSubmissionSummary(deps, fresh.submissionId);
    expect(none.ok && none.data.latestEvaluation).toBeNull();
    expect(none.ok && none.data.terminal).toBe(false);

    expect(await readSubmissionSummary(deps, randomUUID())).toMatchObject({
      ok: false,
      code: "SUBMISSION_NOT_FOUND",
    });
    expect(await readSubmissionSummary(deps, "bad")).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
  });

  it("검토 이력(review_events)을 시각 순으로 싣는다", async () => {
    const [cr] = await tdb.db
      .select({ id: criterionResults.id })
      .from(criterionResults)
      .where(eq(criterionResults.evaluationId, seeded.evaluationId));
    await tdb.db.insert(reviewEvents).values({
      evaluationId: seeded.evaluationId,
      criterionResultId: cr!.id,
      criterionId: "R-01",
      kind: "CONFIRM",
      reviewer: "reviewer@example.com",
      previous: { earnedPoints: 0, verdict: "FAIL", reviewState: "NOT_REQUIRED" },
      next: { earnedPoints: 0, verdict: "FAIL", reviewState: "CONFIRMED" },
      reason: "재현 확인",
    });
    const report = await readEvaluationReport(deps, seeded.evaluationId);
    if (!report.ok) throw new Error(report.message);
    expect(report.data.reviewEvents).toHaveLength(1);
    expect(report.data.reviewEvents[0]).toMatchObject({
      criterionId: "R-01",
      kind: "CONFIRM",
      reviewer: "reviewer@example.com",
      previous: { reviewState: "NOT_REQUIRED" },
      next: { reviewState: "CONFIRMED" },
      reason: "재현 확인",
    });
    // 점수는 여전히 저장 값 그대로다
    expect(report.data.score?.display).toBe("0/100");
  });

  it("삭제된 제출의 평가는 EVALUATION_NOT_FOUND", async () => {
    const gone = await seedResults(deps, "deleted");
    await tdb.db
      .update(submissions)
      .set({ status: "DELETED", deletedAt: new Date() })
      .where(eq(submissions.id, gone.submissionId));
    expect(await readEvaluationReport(deps, gone.evaluationId)).toMatchObject({
      ok: false,
      code: "EVALUATION_NOT_FOUND",
    });
    expect(await readSubmissionSummary(deps, gone.submissionId)).toMatchObject({
      ok: false,
      code: "SUBMISSION_NOT_FOUND",
    });
  });

  it("라우트 핸들러 응답이 봉투 스키마를 통과하고 상태 코드·no-store를 낸다", async () => {
    // 핸들러는 환경변수로 DB·스토어를 만든다. 이 파일의 워커에서 처음 만들어지도록 여기서 설정한다.
    process.env.DATABASE_URL = tdb.url;
    process.env.ARTIFACT_STORE = "fs";
    process.env.ARTIFACT_FS_ROOT = storeRoot;
    const [evaluationRoute, runRoute, submissionRoute, graphRoute] = await Promise.all([
      import("../../app/api/evaluations/[id]/route"),
      import("../../app/api/evaluations/[id]/runs/[runId]/route"),
      import("../../app/api/submissions/[id]/route"),
      import("../../app/api/evaluations/[id]/graph/route"),
    ]);
    const request = new Request("http://localhost/api");

    const evalRes = await evaluationRoute.GET(request, {
      params: Promise.resolve({ id: seeded.evaluationId }),
    });
    expect(evalRes.status).toBe(200);
    expect(evalRes.headers.get("cache-control")).toBe("no-store");
    const evalBody = EvaluationReportResponseSchema.parse(await evalRes.json());
    expect(evalBody.ok).toBe(true);
    if (!evalBody.ok) return;

    const runId = evalBody.data.executionRecords[1]!.id;
    const runRes = await runRoute.GET(request, {
      params: Promise.resolve({ id: seeded.evaluationId, runId }),
    });
    expect(runRes.status).toBe(200);
    const runBody = RunRecordReportResponseSchema.parse(await runRes.json());
    expect(runBody.ok && runBody.data.runId).toBe(runId);
    expect(runBody.ok && runBody.data.record.actualRef).toBe(
      evalBody.data.executionRecords[1]!.actualRef,
    );

    const subRes = await submissionRoute.GET(request, {
      params: Promise.resolve({ id: seeded.submissionId }),
    });
    expect(subRes.status).toBe(200);
    const subBody = SubmissionSummaryResponseSchema.parse(await subRes.json());
    expect(subBody.ok && subBody.data.latestEvaluation?.id).toBe(seeded.evaluationId);

    const notFound = await evaluationRoute.GET(request, {
      params: Promise.resolve({ id: randomUUID() }),
    });
    expect(notFound.status).toBe(404);
    expect(EvaluationReportResponseSchema.parse(await notFound.json())).toMatchObject({
      ok: false,
      code: "EVALUATION_NOT_FOUND",
    });
    const bad = await runRoute.GET(request, {
      params: Promise.resolve({ id: seeded.evaluationId, runId: "zzz" }),
    });
    expect(bad.status).toBe(400);

    // 그래프 엔드포인트 (T-304): 아티팩트가 없으면 404, 있으면 봉투 스키마 통과
    const graphMissing = await graphRoute.GET(request, {
      params: Promise.resolve({ id: seeded.evaluationId }),
    });
    expect(graphMissing.status).toBe(404);
    expect(FunctionGraphReportResponseSchema.parse(await graphMissing.json())).toMatchObject({
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
    });
    const graphKey = artifactKeys.functionGraph(seeded.evaluationId);
    await deps.store.put(
      graphKey,
      JSON.stringify({
        status: "unavailable",
        analyzerVersion: "1",
        reason: "라우트 등록을 찾지 못함",
      }),
      { contentType: "application/json" },
    );
    try {
      const graphRes = await graphRoute.GET(request, {
        params: Promise.resolve({ id: seeded.evaluationId }),
      });
      expect(graphRes.status).toBe(200);
      expect(graphRes.headers.get("cache-control")).toBe("no-store");
      const graphBody = FunctionGraphReportResponseSchema.parse(await graphRes.json());
      expect(graphBody.ok && graphBody.data.analysis.status).toBe("unavailable");
    } finally {
      await deps.store.delete(graphKey);
    }

    // 핸들러가 만든 DB 핸들을 닫아 임시 DB를 지울 수 있게 한다
    const handle = (globalThis as { __ohmytiDb?: { close: () => Promise<void> } }).__ohmytiDb;
    await handle?.close();
  });
});
