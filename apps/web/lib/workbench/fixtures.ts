/**
 * 워크벤치 테스트용 리포트 픽스처. `EvaluationReportSchema`를 통과하는 완전한 리포트를 만든다.
 * 기본 점수는 `score` 필드에 적힌 값 그대로이며 기준 결과와 합이 맞는지는 이 픽스처가 보장하지 않는다
 * (화면은 저장된 값을 옮길 뿐 재계산하지 않는다는 점을 검사하기 위해 일부러 분리한다).
 * `aggregate: true`면 워커가 하듯 `aggregateScore`로 점수·영역 소계를 만들어 넣는다 (T-302 소계 검증용).
 */
import {
  aggregateScore,
  EvaluationReportSchema,
  formatStoredScoreDisplay,
  STAGE_NOT_IMPLEMENTED_REASON,
  type CriterionResult,
  type EvaluationReport,
  type EvaluationStageRecord,
  type Evidence,
  type ReviewEvent,
  type Rubric,
  type StoredScore,
} from "@ohmyti/core";
import { sampleRubric } from "@ohmyti/core/fixtures";

export const FIXTURE_SHA = "0123456789abcdef0123456789abcdef01234567";
export const FIXTURE_DIGEST = "a".repeat(64);
export const FIXTURE_EVALUATION_ID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_SUBMISSION_ID = "22222222-2222-4222-8222-222222222222";
export const FIXTURE_VERSION_ID = "33333333-3333-4333-8333-333333333333";
export const FIXTURE_ASSIGNMENT_ID = "44444444-4444-4444-8444-444444444444";
// 앞 8자에 글자를 섞는다: 숫자만 8자면 짧은 ID 표시가 마스킹 유틸의 전화번호 패턴에 걸린다 (replay.test.tsx의 마스킹 검사)
export const FIXTURE_RUN_ID = "5e5e5e5e-5555-4555-8555-555555555555";
export const FIXTURE_EVIDENCE_ID = "66666666-6666-4666-8666-666666666666";

/** `sampleRubric()`의 `title`은 ID와 같아 화면에서 ID가 두 번 보이므로 부록 A의 제목을 넣는다 */
const CRITERION_TITLE: Record<string, string> = {
  "R-01": "정상 주문",
  "R-02": "상품·주문 조회",
  "R-05": "멱등 재전송",
  "R-06": "멱등 키 본문 불일치",
  "R-09": "취소와 재고 복구",
  "R-03": "재고 부족",
  "R-04": "입력 검증",
  "R-07": "같은 키 동시 요청",
  "R-08": "다른 키 동시 요청",
  G1: "경계·검증 그룹 탐지",
  G2: "멱등성 그룹 탐지",
  G3: "취소 그룹 탐지",
  "R-12": "계층 분리·변경 용이성",
  "R-10": "실행 계약",
  "R-11": "README",
};

export function fixtureRubric(): Rubric {
  const rubric = sampleRubric();
  return {
    ...rubric,
    criteria: rubric.criteria.map((c) => ({ ...c, title: CRITERION_TITLE[c.id] ?? c.title })),
  };
}

/** 부록 A의 C(결함) 샘플과 같은 2단계 시점 판정: R-05·R-06·R-07 FAIL, G1~G3·R-12 INCONCLUSIVE, 나머지 PASS */
export const DEFECTIVE_SAMPLE_VERDICTS: Record<string, CriterionResult["verdict"]> = {
  "R-01": "PASS",
  "R-02": "PASS",
  "R-05": "FAIL",
  "R-06": "FAIL",
  "R-09": "PASS",
  "R-03": "PASS",
  "R-04": "PASS",
  "R-07": "FAIL",
  "R-08": "PASS",
  G1: "INCONCLUSIVE",
  G2: "INCONCLUSIVE",
  G3: "INCONCLUSIVE",
  "R-12": "INCONCLUSIVE",
  "R-10": "PASS",
  "R-11": "PASS",
};

/** 기본 점수 `54~69/100 · 15점 검토 대기`(C 샘플)에 맞춘 영역 소계 */
export const DEFAULT_BY_AREA: NonNullable<StoredScore["byArea"]> = [
  { area: "REQUIRED_FEATURES", earned: 20, min: 20, max: 20, pendingPoints: 0, total: 40 },
  { area: "EDGE_AND_FAILURE", earned: 19, min: 19, max: 19, pendingPoints: 0, total: 25 },
  { area: "TEST_EFFECTIVENESS", earned: 5, min: 5, max: 10, pendingPoints: 5, total: 15 },
  { area: "DESIGN", earned: 0, min: 0, max: 10, pendingPoints: 10, total: 10 },
  { area: "REPRODUCIBILITY_AND_DOCS", earned: 10, min: 10, max: 10, pendingPoints: 0, total: 10 },
];

export const DEFAULT_STAGES: EvaluationStageRecord[] = [
  {
    stage: "REPO_CHECK",
    state: "DONE",
    startedAt: "2026-09-18T09:00:00.000Z",
    finishedAt: "2026-09-18T09:00:02.000Z",
  },
  {
    stage: "TEST_EFFECTIVENESS",
    state: "SKIPPED",
    reason: STAGE_NOT_IMPLEMENTED_REASON,
    detail: { ticket: "T-403" },
  },
];

export interface ReportFixtureOptions {
  score?: EvaluationReport["score"];
  isSample?: boolean;
  /** 기준 ID → verdict. 없는 기준은 결과 없이 둔다 */
  verdicts?: Record<string, CriterionResult["verdict"]>;
  /** true면 `score`를 `aggregateScore(criterionResults, rubric)`에서 만든다 (워커의 저장 경로와 같다) */
  aggregate?: boolean;
  stages?: EvaluationStageRecord[];
  /** R-05 근거의 `testId` (하네스 케이스 ID). 기본 `R-05-case` */
  evidenceTestId?: string;
  /** 기준에 근거를 더한다 (근거는 `evidences`에, id는 그 기준의 `evidenceIds` 끝에). 코드 근거 뷰어(T-305) 테스트용 */
  extraEvidences?: Array<{ criterionId: string; evidence: Evidence }>;
  /** 검토 이력 (T-306). 리포트에 들어가는 순서 그대로 */
  reviewEvents?: ReviewEvent[];
  /** 기준 ID → `interpretation` (추정). T-407 전에는 비어 있다 */
  interpretations?: Record<string, string>;
  /** mutation 실험 (T-403·T-404). 기본은 없음 */
  mutationExperiments?: EvaluationReport["mutationExperiments"];
}

/** 워커(`scoreFieldsOf`)와 API(`storedScoreOf`)가 하는 변환을 합친 것: 집계 결과 → 저장된 점수 */
export function storedScoreFromAggregate(
  results: CriterionResult[],
  rubric: Rubric,
): NonNullable<EvaluationReport["score"]> {
  const summary = aggregateScore(results, rubric);
  const score = {
    earned: summary.earned,
    min: summary.min,
    max: summary.max,
    pendingPoints: summary.pendingPoints,
  };
  return {
    ...score,
    total: summary.total,
    display: formatStoredScoreDisplay(score, summary.total),
    byArea: summary.byArea,
  };
}

export function reportFixture(options: ReportFixtureOptions = {}): EvaluationReport {
  const rubric = fixtureRubric();
  const verdicts = options.verdicts ?? {
    "R-01": "PASS",
    "R-05": "FAIL",
    G1: "INCONCLUSIVE",
    "R-12": "INCONCLUSIVE",
  };
  const byId = new Map(rubric.criteria.map((c) => [c.id, c]));
  const criterionResults: CriterionResult[] = Object.entries(verdicts).map(([id, verdict]) => {
    const criterion = byId.get(id);
    if (!criterion) throw new Error(`픽스처 rubric에 없는 기준: ${id}`);
    const inconclusive = verdict === "INCONCLUSIVE";
    return {
      criterionId: id,
      rubricVersion: rubric.version,
      maxPoints: criterion.maxPoints,
      earnedPoints: inconclusive ? null : verdict === "PASS" ? criterion.maxPoints : 0,
      verdict,
      method: criterion.method,
      // 감점(FAIL·PARTIAL)은 Evidence를 참조해야 한다 (G-02)
      evidenceIds: verdict === "FAIL" || verdict === "PARTIAL" ? [FIXTURE_EVIDENCE_ID] : [],
      ...(verdict === "FAIL" ? { issueId: `case:${id}-case` } : {}),
      observation: `${id} 관측`,
      ...(options.interpretations?.[id] !== undefined
        ? { interpretation: options.interpretations[id] }
        : {}),
      reviewState: inconclusive ? "PENDING" : "NOT_REQUIRED",
      evaluationId: FIXTURE_EVALUATION_ID,
    };
  });
  for (const extra of options.extraEvidences ?? []) {
    const result = criterionResults.find((r) => r.criterionId === extra.criterionId);
    if (!result) throw new Error(`픽스처 결과에 없는 기준: ${extra.criterionId}`);
    result.evidenceIds = [...result.evidenceIds, extra.evidence.id];
  }
  const report: EvaluationReport = {
    evaluation: {
      id: FIXTURE_EVALUATION_ID,
      submissionId: FIXTURE_SUBMISSION_ID,
      assignmentVersionId: FIXTURE_VERSION_ID,
      rubricVersion: rubric.version,
      harnessVersion: "0.0.0+abcdef0123456789",
      environmentDigest: FIXTURE_DIGEST,
      submissionSha: FIXTURE_SHA,
      isSample: options.isSample ?? false,
      createdAt: "2026-09-18T09:00:00.000Z",
      finishedAt: "2026-09-18T09:05:00.000Z",
    },
    submission: {
      id: FIXTURE_SUBMISSION_ID,
      status: "COMPLETED",
      repoUrl: "https://github.com/example/order-api",
      repoRef: null,
      isSample: options.isSample ?? false,
    },
    assignment: {
      id: FIXTURE_ASSIGNMENT_ID,
      name: "order-api",
      version: 1,
      title: "주문·재고 API",
    },
    rubric,
    executionContract: {
      startCommand: "npm start",
      portEnv: "PORT",
      healthPath: "/health",
      healthTimeoutMs: 10_000,
      resetPath: "/admin/reset",
      templateName: "order-api-ts",
      nodeVersion: "22",
    },
    score: options.aggregate
      ? storedScoreFromAggregate(criterionResults, rubric)
      : options.score === undefined
        ? {
            earned: 54,
            min: 54,
            max: 69,
            pendingPoints: 15,
            total: 100,
            display: "54~69/100 · 15점 검토 대기",
            byArea: DEFAULT_BY_AREA,
          }
        : options.score,
    criterionResults,
    evidences: [
      {
        id: FIXTURE_EVIDENCE_ID,
        evaluationId: FIXTURE_EVALUATION_ID,
        submissionSha: FIXTURE_SHA,
        runId: FIXTURE_RUN_ID,
        testId: options.evidenceTestId ?? "R-05-case",
        artifactRefs: [`evaluations/${FIXTURE_EVALUATION_ID}/runs/${FIXTURE_RUN_ID}/actual.json`],
      },
      ...(options.extraEvidences ?? []).map((extra) => extra.evidence),
    ],
    executionRecords: [
      {
        id: FIXTURE_RUN_ID,
        evaluationId: FIXTURE_EVALUATION_ID,
        kind: "HARNESS",
        submissionSha: FIXTURE_SHA,
        rubricVersion: rubric.version,
        harnessVersion: "0.0.0+abcdef0123456789",
        environmentDigest: FIXTURE_DIGEST,
        inputRef: `evaluations/${FIXTURE_EVALUATION_ID}/runs/${FIXTURE_RUN_ID}/input.json`,
        expectedRef: `evaluations/${FIXTURE_EVALUATION_ID}/runs/${FIXTURE_RUN_ID}/expected.json`,
        actualRef: `evaluations/${FIXTURE_EVALUATION_ID}/runs/${FIXTURE_RUN_ID}/actual.json`,
        exitCode: null,
        failureKind: "ASSERTION",
      },
    ],
    stages: options.stages ?? DEFAULT_STAGES,
    reviewEvents: options.reviewEvents ?? [],
    mutationExperiments: options.mutationExperiments ?? [],
  };
  return EvaluationReportSchema.parse(report);
}
