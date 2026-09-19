import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  COMPETENCIES,
  HiringReportSchema,
  aggregateScore,
  findForbiddenReportExpressions,
  findJudgementKeys,
  type ContextLink,
  type DesignSignals,
  type EvaluationReport,
  type EvaluationStageRecord,
  type Evidence,
  type ReportProfile,
} from "@ohmyti/core";
import {
  createTestDatabase,
  persistEvaluationResults,
  seedEvaluation,
  setAssignmentVersionReportProfile,
  type TestDatabase,
} from "@ohmyti/db";
import { FsArtifactStore } from "@ohmyti/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFECTIVE_SAMPLE_VERDICTS,
  FIXTURE_CONTEXT_LINK_ID,
  FIXTURE_EVALUATION_ID,
  FIXTURE_RUN_ID,
  FIXTURE_SHA,
  FIXTURE_SUBMISSION_ID,
  interviewKitFixture,
  reportFixture,
} from "@/lib/workbench/fixtures";
import {
  buildHiringReport,
  lostPointsOf,
  readHiringReport,
  type HiringReportInput,
} from "./hiring-report";
import { hiringReportToMarkdown } from "./hiring-report-markdown";
import { readEvaluationReport, type ReportDeps } from "./service";

const RUN_R06 = "6a6a6a6a-6666-4666-8666-666666666666";
const RUN_R07 = "7a7a7a7a-7777-4777-8777-777777777777";
const EVIDENCE_R06 = "6b6b6b6b-6666-4666-8666-666666666666";
const EVIDENCE_R07 = "7b7b7b7b-7777-4777-8777-777777777777";

function evidence(id: string, runId: string, testId: string): Evidence {
  return {
    id,
    evaluationId: FIXTURE_EVALUATION_ID,
    submissionSha: FIXTURE_SHA,
    runId,
    testId,
    artifactRefs: [`evaluations/${FIXTURE_EVALUATION_ID}/runs/${runId}/actual.json`],
  };
}

/** 부록 A의 C(결함) 샘플과 같은 판정: R-05·R-06·R-07 FAIL, G1~G3·R-12 미확정 */
function defectiveReport(overrides: Partial<Parameters<typeof reportFixture>[0]> = {}) {
  return reportFixture({
    verdicts: DEFECTIVE_SAMPLE_VERDICTS,
    aggregate: true,
    extraEvidences: [
      { criterionId: "R-06", evidence: evidence(EVIDENCE_R06, RUN_R06, "R-06-case") },
      { criterionId: "R-07", evidence: evidence(EVIDENCE_R07, RUN_R07, "R-07-case") },
    ],
    ...overrides,
  });
}

/** 모든 기준이 PASS인 A(정답) 샘플 */
function correctReport(): EvaluationReport {
  const verdicts = Object.fromEntries(
    Object.keys(DEFECTIVE_SAMPLE_VERDICTS).map((id) => [id, "PASS" as const]),
  );
  return reportFixture({ verdicts, aggregate: true });
}

const PROFILE: ReportProfile = {
  profileVersion: 1,
  criteria: [
    {
      criterionId: "R-05",
      competency: "DATA_INTEGRITY",
      impact: "같은 주문 요청이 두 번 처리되어 중복 결제로 이어질 수 있습니다.",
    },
    {
      criterionId: "R-03",
      impact: "재고보다 많은 수량을 받아들이면 배송할 수 없는 주문이 생깁니다.",
    },
  ],
};

const CONTEXT_LINKS: ContextLink[] = [
  {
    id: FIXTURE_CONTEXT_LINK_ID,
    submissionId: FIXTURE_SUBMISSION_ID,
    evaluationId: FIXTURE_EVALUATION_ID,
    claim: "결제 API에 멱등 처리를 도입했습니다",
    claimSource: "RESUME",
    status: "EVIDENCE_FOUND",
    githubEvidence: [
      {
        repo: "example/payments",
        url: "https://github.com/example/payments/pull/12",
        summary: "재전송 키로 중복 결제를 막은 변경",
      },
    ],
    assignmentObservation: {
      criterionId: "R-05",
      summary: "이번 과제에서는 재전송이 두 번 처리되었습니다",
    },
    followUpQuestion: "그때의 재전송 판단 기준은 무엇이었나요?",
    createdAt: "2026-09-18T09:04:00.000Z",
  },
];

const DESIGN_SIGNALS: DesignSignals = {
  status: "ok",
  analyzerVersion: "1",
  sourceFiles: 12,
  testFiles: 3,
  maxFileLines: { lines: 180, location: { path: "src/app.ts", startLine: 1, endLine: 180 } },
  maxFunctionLines: {
    lines: 60,
    name: "createOrder",
    location: { path: "src/app.ts", startLine: 20, endLine: 80 },
  },
  explicitAny: { count: 2, asAny: 1, locations: [] },
  tsconfig: { path: "tsconfig.json", strict: true },
  duplicateBlocks: { count: 0, groups: [] },
  busyWaits: { count: 0, locations: [] },
  consoleLogs: { count: 1, locations: [] },
  weakAssertions: { count: 1, total: 20, locations: [] },
};

const REVIEW_WRITE_STAGE: EvaluationStageRecord = {
  stage: "REVIEW_WRITE",
  state: "DONE",
  detail: {
    llm: "OK",
    llmError: null,
    promptVersion: "review-write-1",
    model: "deepseek-chat",
    aiReviewId: "88888888-8888-4888-8888-888888888888",
    aiReviewVersion: 1,
    targets: ["R-05"],
    interpretations: [],
    designSuggestions: [
      {
        criterionId: "R-12",
        suggestedPoints: 6,
        maxPoints: 10,
        rationale: "HTTP 처리와 주문 규칙이 같은 파일에 섞여 있습니다.",
        evidenceIds: [],
      },
    ],
    suggestions: [],
    dropped: [],
  },
};

const CONTEXT_LINK_STAGE: EvaluationStageRecord = {
  stage: "CONTEXT_LINK",
  state: "DONE",
  detail: {
    contextLink: {
      llm: "OK",
      llmError: null,
      promptVersion: "context-link-3",
      model: "deepseek-chat",
      aiReviewId: "99999999-9999-4999-8999-999999999999",
      aiReviewVersion: 1,
      inputs: { resume: true, jd: false, githubRepos: 1, observations: 2 },
      linkCount: 1,
      statusCounts: { EVIDENCE_FOUND: 1, NEEDS_CHECK: 0, NO_DATA: 0 },
      unassessedAreas: ["대용량 트래픽 운영 경험은 제출 자료로 확인할 수 없음"],
      dropped: [],
    },
  },
};

const INTERVIEW_KIT_STAGE: EvaluationStageRecord = {
  stage: "INTERVIEW_KIT",
  state: "DONE",
  detail: {
    slotCount: 3,
    templateCount: 1,
    llm: "OK",
    llmReason: null,
    promptVersion: "interview-kit-1",
    model: "deepseek-chat",
    aiReviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    inputDigest: "b".repeat(64),
    dropped: [],
    artifactKey: `evaluations/${FIXTURE_EVALUATION_ID}/interview-kit.json`,
    priorities: { MUST: 1, SHOULD: 2, OPTIONAL: 0 },
  },
};

function fullInput(overrides: Partial<HiringReportInput> = {}): HiringReportInput {
  return {
    report: defectiveReport({
      stages: [REVIEW_WRITE_STAGE, CONTEXT_LINK_STAGE, INTERVIEW_KIT_STAGE],
    }),
    kit: interviewKitFixture(),
    contextLinks: CONTEXT_LINKS,
    designSignals: DESIGN_SIGNALS,
    profile: PROFILE,
    ...overrides,
  };
}

describe("buildHiringReport · 핵심 관측", () => {
  it("샘플 C의 확인된 결함 3개가 잃은 배점 순이고 각각 실행 기록 근거를 참조한다", () => {
    const report = buildHiringReport(fullInput());
    const defects = report.keyObservations.defects;
    expect(defects.map((d) => d.criterionId)).toEqual(["R-05", "R-06", "R-07"]);
    const lost = defects.map((d) =>
      report.requirements.criteria.find((c) => c.criterionId === d.criterionId)!,
    );
    expect(lost.map((c) => c.maxPoints - (c.earnedPoints ?? 0))).toEqual([14, 6, 6]);
    for (const defect of defects) {
      const runs = defect.refs.filter((ref) => ref.kind === "EXECUTION_RECORD");
      expect(runs.length, defect.criterionId).toBeGreaterThan(0);
      expect(defect.refs[0]).toEqual({ kind: "CRITERION", criterionId: defect.criterionId });
    }
    const runsOf = (criterionId: string) =>
      defects
        .find((d) => d.criterionId === criterionId)!
        .refs.flatMap((ref) => (ref.kind === "EXECUTION_RECORD" ? [ref.runId] : []));
    expect(runsOf("R-05")).toEqual([FIXTURE_RUN_ID]);
    expect(runsOf("R-06")).toContain(RUN_R06);
    expect(runsOf("R-07")).toContain(RUN_R07);
  });

  it("샘플 A 리포트는 확인된 결함이 0개이고 강점은 배점 순 3개다", () => {
    const report = buildHiringReport(fullInput({ report: correctReport() }));
    expect(report.keyObservations.defects).toEqual([]);
    expect(report.keyObservations.strengths.map((s) => s.criterionId)).toEqual([
      "R-03",
      "R-04",
      "R-07",
    ]);
  });

  it("같은 issueId로 묶인 기준은 결함에 한 번만 보인다 (G-12)", () => {
    const base = defectiveReport();
    const report: EvaluationReport = {
      ...base,
      criterionResults: base.criterionResults.map((result) =>
        result.verdict === "FAIL" ? { ...result, issueId: "case:same-defect" } : result,
      ),
    };
    const built = buildHiringReport(fullInput({ report }));
    expect(built.keyObservations.defects.map((d) => d.criterionId)).toEqual(["R-05"]);
  });

  it("프로필이 있으면 영향 문장을 옮기고 없으면 null이다 (G-09)", () => {
    const withProfile = buildHiringReport(fullInput());
    expect(withProfile.keyObservations.defects[0]!.impact).toBe(PROFILE.criteria[0]!.impact);
    const without = buildHiringReport(fullInput({ profile: null }));
    expect(without.keyObservations.defects[0]!.impact).toBeNull();
  });

  it("REVIEW_WRITE 서술은 AI 초안으로 붙는다", () => {
    const report = buildHiringReport(fullInput());
    const items = report.requirements.designReview.items;
    expect(report.requirements.designReview.draft).toBe(true);
    expect(items.map((i) => i.criterionId)).toEqual(["R-12"]);
    expect(items[0]!.rationale).toContain("HTTP 처리");
  });
});

describe("buildHiringReport · 저장값 대조", () => {
  it("점수 표기·영역 소계·판정이 평가 조회 API와 같다", () => {
    const input = fullInput();
    const built = buildHiringReport(input);
    expect(built.summary.score).toEqual(input.report.score);
    expect(built.summary.score!.byArea).toEqual(input.report.score!.byArea);
    // 저장된 값은 집계 엔진으로 검산했을 때와도 같다 (리포트는 집계하지 않는다)
    const summary = aggregateScore(input.report.criterionResults, input.report.rubric);
    expect(built.summary.score!.display).toBe(summary.display);
    for (const criterion of built.requirements.criteria) {
      const stored = input.report.criterionResults.find(
        (r) => r.criterionId === criterion.criterionId,
      )!;
      expect(criterion.verdict).toBe(stored.verdict);
      expect(criterion.earnedPoints).toBe(stored.earnedPoints);
      expect(criterion.maxPoints).toBe(stored.maxPoints);
      expect(criterion.reviewState).toBe(stored.reviewState);
    }
    const counts = built.summary.verdictCounts;
    expect(counts.PASS + counts.FAIL + counts.PARTIAL + counts.INCONCLUSIVE).toBe(
      input.report.criterionResults.length,
    );
    expect(counts.FAIL).toBe(3);
    expect(counts.INCONCLUSIVE).toBe(4);
  });

  it("역량별 관측은 점수를 만들지 않고 판정 분포와 근거만 옮긴다", () => {
    const report = buildHiringReport(fullInput());
    const dataIntegrity = report.competencies.find((c) => c.competency === "DATA_INTEGRITY")!;
    // 프로필 보정으로 R-05가 동시성·정합성 역량에 들어간다
    expect(dataIntegrity.criteria.map((c) => c.criterionId)).toContain("R-05");
    expect(dataIntegrity.verdictCounts.FAIL).toBe(1);
    const debugging = report.competencies.find((c) => c.competency === "DEBUGGING")!;
    expect(debugging.interviewOnly).toBe(true);
    expect(debugging.criteria).toEqual([]);
    expect(debugging.kitQuestionIds).toEqual(["FAILURE_DEBRIEF:R-05"]);
    expect(report.competencies.map((c) => c.name)).toEqual(
      report.competencies.map((c) => COMPETENCIES[c.competency].name),
    );
  });

  it("감사 정보는 저장된 버전·다이제스트와 사람 수정 이력 건수를 옮긴다", () => {
    const input = fullInput();
    const built = buildHiringReport(input);
    expect(built.audit).toMatchObject({
      evaluationId: input.report.evaluation.id,
      rubricVersion: input.report.evaluation.rubricVersion,
      harnessVersion: input.report.evaluation.harnessVersion,
      environmentDigest: input.report.evaluation.environmentDigest,
      submissionSha: input.report.evaluation.submissionSha,
      humanEdits: { count: 0, lastAt: null },
    });
    expect(built.audit.llmStages.map((s) => s.stage)).toEqual([
      "REVIEW_WRITE",
      "CONTEXT_LINK",
      "INTERVIEW_KIT",
    ]);
    expect(built.audit.llmStages[0]!.model).toBe("deepseek-chat");
  });
});

describe("buildHiringReport · 범위와 한계", () => {
  it("미확정·검토 대기가 있으면 점수 범위와 한계 절이 채워진다", () => {
    const report = buildHiringReport(fullInput());
    expect(report.summary.score!.pendingPoints).toBeGreaterThan(0);
    expect(report.summary.score!.display).toMatch(/검토 대기/);
    expect(report.scope.inconclusive.map((i) => i.criterionId)).toEqual(["G1", "G2", "G3", "R-12"]);
    expect(report.scope.pendingReview.map((p) => p.criterionId)).toEqual([
      "G1",
      "G2",
      "G3",
      "R-12",
    ]);
    expect(report.scope.unassessedAreas).toEqual([
      "대용량 트래픽 운영 경험은 제출 자료로 확인할 수 없음",
    ]);
    expect(report.scope.supportScope.length).toBeGreaterThan(0);
    expect(report.scope.llmUsage.map((u) => u.stage)).toEqual([
      "REVIEW_WRITE",
      "CONTEXT_LINK",
      "INTERVIEW_KIT",
    ]);
  });

  it("환경 장애로 미확정이 된 기준은 제출 코드의 결함과 구분한다 (G-11)", () => {
    const base = defectiveReport();
    const report: EvaluationReport = {
      ...base,
      criterionResults: base.criterionResults.map((result) =>
        result.criterionId === "R-12"
          ? { ...result, evidenceIds: ["66666666-6666-4666-8666-666666666666"] }
          : result,
      ),
      executionRecords: base.executionRecords.map((record) => ({
        ...record,
        failureKind: "ENVIRONMENT" as const,
      })),
    };
    const built = buildHiringReport(fullInput({ report }));
    const item = built.scope.inconclusive.find((i) => i.criterionId === "R-12")!;
    expect(item.failureKind).toBe("ENVIRONMENT");
    expect(item.environmental).toBe(true);
  });
});

describe("buildHiringReport · 자료가 없는 이전 평가", () => {
  const legacy = () =>
    buildHiringReport({
      report: defectiveReport(),
      kit: null,
      contextLinks: null,
      designSignals: null,
      profile: null,
    });

  it("키트·맥락 연결·설계 신호가 없으면 해당 절만 자료 없음으로 조립된다", () => {
    const report = legacy();
    expect(report.interviewGuide).toEqual({
      status: "NO_DATA",
      llm: null,
      llmReason: null,
      mustQuestions: [],
    });
    expect(report.resumeLinks).toEqual({ status: "NO_DATA", links: [] });
    expect(report.requirements.designReview.status).toBe("NO_DATA");
    expect(report.requirements.designReview.signals).toBeNull();
    // 나머지 절은 그대로 채워진다
    expect(report.summary.score).not.toBeNull();
    expect(report.keyObservations.defects).toHaveLength(3);
    expect(report.scorecard.competencies).toHaveLength(9);
    expect(HiringReportSchema.safeParse(report).success).toBe(true);
  });

  it("이력서가 없어 연결이 하나도 없으면 이력서 절은 NO_RESUME이다", () => {
    const report = buildHiringReport(fullInput({ contextLinks: [] }));
    expect(report.resumeLinks.status).toBe("NO_RESUME");
  });

  it("LLM을 부르지 못한 키트도 리포트의 면접 안내에 사실 그대로 표시된다", () => {
    const kit = interviewKitFixture({
      generation: { llm: "NOT_CONFIGURED", llmReason: "LLM 키가 설정되지 않음" },
    });
    const report = buildHiringReport(fullInput({ kit }));
    expect(report.interviewGuide.status).toBe("AVAILABLE");
    expect(report.interviewGuide.llm).toBe("NOT_CONFIGURED");
    expect(report.interviewGuide.llmReason).toBe("LLM 키가 설정되지 않음");
    expect(report.interviewGuide.mustQuestions.map((q) => q.questionId)).toEqual([
      "FAILURE_DEBRIEF:R-05",
    ]);
  });
});

describe("금지 표현·판단 키", () => {
  const inputs = [fullInput(), fullInput({ report: correctReport() })];

  it("JSON·Markdown 출력 전체에 금지 표현이 없다", () => {
    for (const input of inputs) {
      const report = buildHiringReport(input);
      expect(findForbiddenReportExpressions(JSON.stringify(report))).toEqual([]);
      expect(findForbiddenReportExpressions(hiringReportToMarkdown(report))).toEqual([]);
    }
  });

  it("리포트 스키마에 판단을 담는 키가 없다", () => {
    expect(findJudgementKeys(HiringReportSchema)).toEqual([]);
  });

  it("금지 표현이 있는 LLM 초안은 버린다", () => {
    const stage: EvaluationStageRecord = {
      ...REVIEW_WRITE_STAGE,
      detail: {
        ...REVIEW_WRITE_STAGE.detail,
        designSuggestions: [
          {
            criterionId: "R-12",
            suggestedPoints: 6,
            maxPoints: 10,
            rationale: "구조가 좋아 시니어 수준으로 보입니다.",
            evidenceIds: [],
          },
        ],
      },
    };
    const report = buildHiringReport(
      fullInput({
        report: defectiveReport({ stages: [stage, CONTEXT_LINK_STAGE, INTERVIEW_KIT_STAGE] }),
      }),
    );
    expect(report.requirements.designReview.items).toEqual([]);
    expect(findForbiddenReportExpressions(JSON.stringify(report))).toEqual([]);
  });
});

describe("hiringReportToMarkdown", () => {
  it("PRD 14.3의 9개 절을 순서대로 담고 스코어카드는 빈 칸이다", () => {
    const markdown = hiringReportToMarkdown(buildHiringReport(fullInput()));
    const headings = markdown.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## 1. 한눈 요약",
      "## 2. 핵심 관측",
      "## 3. 역량별 관측",
      "## 4. 요구사항별 결과",
      "## 5. 이력서 주장과 근거",
      "## 6. 면접 안내 (필수 질문)",
      "## 7. 평가 범위와 한계",
      "## 8. 면접관 스코어카드 (사람이 기입합니다)",
      "## 9. 감사 정보",
    ]);
    expect(markdown).toContain("- 기입: [ ] 1 [ ] 2 [ ] 3 [ ] 4");
    expect(markdown).not.toMatch(/기입: \[[^ ]\]/);
  });

  it("점수 표기와 근거 식별자를 그대로 옮긴다", () => {
    const input = fullInput();
    const markdown = hiringReportToMarkdown(buildHiringReport(input));
    expect(markdown).toContain(input.report.score!.display);
    expect(markdown).toContain(`실행 기록 ${FIXTURE_RUN_ID}`);
    expect(markdown).toContain(input.report.evaluation.environmentDigest);
  });

  it("자료가 없는 절은 이유를 그대로 적는다 (G-14)", () => {
    const markdown = hiringReportToMarkdown(
      buildHiringReport({
        report: defectiveReport(),
        kit: null,
        contextLinks: null,
        designSignals: null,
        profile: null,
      }),
    );
    expect(markdown).toContain("맥락 연결 자료가 없습니다.");
    expect(markdown).toContain("인터뷰 키트가 없습니다.");
  });
});

// ── 통합 ─────────────────────────────────────────────────────────────────────

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/web] DATABASE_URL_TEST가 없어 채용 리포트 통합 테스트를 건너뜁니다");
}

describe.skipIf(!hasTestDb)("readHiringReport (통합)", () => {
  let tdb: TestDatabase;
  let storeRoot: string;
  let deps: ReportDeps;
  let evaluationId: string;
  let assignmentVersionId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storeRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-web-hiring-"));
    deps = { db: tdb.db, store: new FsArtifactStore({ root: storeRoot }) };
    const seeded = await seedEvaluation(tdb.db, `web-t705-${Date.now()}`);
    evaluationId = seeded.evaluationId;
    assignmentVersionId = seeded.assignmentVersionId;
    const runId = randomUUID();
    const evidenceId = randomUUID();
    await persistEvaluationResults(tdb.db, {
      evaluationId,
      executionRecords: [
        {
          id: runId,
          evaluationId,
          kind: "HARNESS",
          submissionSha: FIXTURE_SHA,
          rubricVersion: seeded.rubricVersion,
          harnessVersion: "harness-0",
          environmentDigest: "a".repeat(64),
          inputRef: `evaluations/${evaluationId}/runs/${runId}/input.json`,
          expectedRef: `evaluations/${evaluationId}/runs/${runId}/expected.json`,
          actualRef: `evaluations/${evaluationId}/runs/${runId}/actual.json`,
          exitCode: null,
          failureKind: "ASSERTION",
        },
      ],
      evidences: [
        {
          id: evidenceId,
          evaluationId,
          submissionSha: FIXTURE_SHA,
          runId,
          testId: "R-01-normal-order",
          artifactRefs: [`evaluations/${evaluationId}/runs/${runId}/actual.json`],
        },
      ],
      criterionResults: [
        {
          evaluationId,
          criterionId: "R-01",
          rubricVersion: seeded.rubricVersion,
          maxPoints: 100,
          earnedPoints: 0,
          verdict: "FAIL",
          method: "EXECUTION",
          evidenceIds: [evidenceId],
          issueId: "case:R-01-normal-order",
          observation: "케이스 R-01-normal-order 검사 1개 중 1개 실패",
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
    });
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  it("평가 조회 API와 같은 저장값으로 조립하고 없는 자료는 자료 없음으로 둔다", async () => {
    const stored = await readEvaluationReport({ db: tdb.db }, evaluationId);
    const hiring = await readHiringReport(deps, evaluationId);
    expect(stored.ok && hiring.ok).toBe(true);
    if (!stored.ok || !hiring.ok) return;
    expect(hiring.data.summary.score).toEqual(stored.data.score);
    expect(hiring.data.requirements.criteria.map((c) => c.verdict)).toEqual(
      stored.data.criterionResults.map((r) => r.verdict),
    );
    expect(hiring.data.keyObservations.defects.map((d) => d.criterionId)).toEqual(["R-01"]);
    expect(hiring.data.audit.rubricVersion).toBe(stored.data.evaluation.rubricVersion);
    // 키트·설계 신호·프로필이 없는 평가다
    expect(hiring.data.interviewGuide.status).toBe("NO_DATA");
    expect(hiring.data.keyObservations.defects[0]!.impact).toBeNull();
    expect(findForbiddenReportExpressions(JSON.stringify(hiring.data))).toEqual([]);
  });

  it("과제 버전의 리포트 프로필을 읽어 영향 문장과 역량 보정을 붙인다", async () => {
    await setAssignmentVersionReportProfile(tdb.db, assignmentVersionId, {
      profileVersion: 1,
      criteria: [
        {
          criterionId: "R-01",
          competency: "DATA_INTEGRITY",
          impact: "중복 결제로 이어질 수 있습니다.",
        },
      ],
    });
    const hiring = await readHiringReport(deps, evaluationId);
    expect(hiring.ok).toBe(true);
    if (!hiring.ok) return;
    expect(hiring.data.keyObservations.defects[0]!.impact).toBe("중복 결제로 이어질 수 있습니다.");
    const dataIntegrity = hiring.data.competencies.find((c) => c.competency === "DATA_INTEGRITY")!;
    expect(dataIntegrity.criteria.map((c) => c.criterionId)).toEqual(["R-01"]);
  });

  it("없는 평가는 EVALUATION_NOT_FOUND다", async () => {
    const result = await readHiringReport(deps, randomUUID());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("EVALUATION_NOT_FOUND");
  });
});

describe("조립 코드에 점수 계산이 없다", () => {
  it("aggregateScore를 부르지 않고 배점을 더하지 않는다", async () => {
    const files = [
      path.join(import.meta.dirname, "hiring-report.ts"),
      path.join(import.meta.dirname, "hiring-report-markdown.ts"),
      path.join(import.meta.dirname, "../../app/api/evaluations/[id]/hiring-report/route.ts"),
    ];
    for (const file of files) {
      const code = (await readFile(file, "utf8"))
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/aggregateScore/);
      expect(code, file).not.toMatch(/\bformatScoreDisplay\b/);
      expect(code, file).not.toMatch(/\bformatStoredScoreDisplay\b/);
      expect(code, file).not.toMatch(/earnedPoints\s*\+|maxPoints\s*\+/);
    }
  });

  it("잃은 배점은 순서를 정하는 데만 쓰는 저장값의 차이다", () => {
    expect(
      lostPointsOf({
        criterionId: "R-05",
        rubricVersion: "v1-00000000",
        maxPoints: 14,
        earnedPoints: 0,
        verdict: "FAIL",
        method: "EXECUTION",
        evidenceIds: [],
        observation: "",
        reviewState: "NOT_REQUIRED",
      }),
    ).toBe(14);
    expect(
      lostPointsOf({
        criterionId: "R-01",
        rubricVersion: "v1-00000000",
        maxPoints: 8,
        earnedPoints: 8,
        verdict: "PASS",
        method: "EXECUTION",
        evidenceIds: [],
        observation: "",
        reviewState: "NOT_REQUIRED",
      }),
    ).toBe(0);
  });
});
