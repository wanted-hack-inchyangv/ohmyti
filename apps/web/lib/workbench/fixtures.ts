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
  INTERVIEW_KIT_SCHEMA_VERSION,
  InterviewKitSchema,
  STAGE_NOT_IMPLEMENTED_REASON,
  type CriterionResult,
  type EvaluationReport,
  type EvaluationStageRecord,
  type Evidence,
  type InterviewKit,
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

/** 인터뷰 키트 픽스처의 맥락 연결 ID (`RESUME_BRIDGE` 질문의 근거) */
export const FIXTURE_CONTEXT_LINK_ID = "77777777-7777-4777-8777-777777777777";

export interface InterviewKitFixtureOptions {
  /** 생성 요약을 덮어쓴다 (LLM 미실행·기본 질문 수 검사용) */
  generation?: Partial<InterviewKit["generation"]>;
  /** 질문을 통째로 바꾼다 */
  questions?: InterviewKit["questions"];
  /** 진행안을 통째로 바꾼다 */
  plans?: InterviewKit["plans"];
}

/**
 * 인터뷰 키트 픽스처 (T-704). 워커의 INTERVIEW_KIT 단계(T-702)가 저장하는 형태 그대로이며
 * 결함 샘플 C처럼 R-05 실패 디브리핑 · 테스트 설계 · 이력서 연결 세 질문을 담는다.
 */
export function interviewKitFixture(options: InterviewKitFixtureOptions = {}): InterviewKit {
  const questions: InterviewKit["questions"] = options.questions ?? [
    {
      id: "FAILURE_DEBRIEF:R-05",
      kind: "FAILURE_DEBRIEF",
      competency: "DEBUGGING",
      priority: "MUST",
      minutes: 8,
      question:
        "R-05 재생 기록을 함께 보겠습니다. 같은 멱등 키로 재전송했을 때 재고가 두 번 줄어든 지점을 짚어 주시겠어요?",
      intent: "관측된 실패에서 근거를 따라 원인 코드까지 범위를 좁히는지 확인합니다.",
      probes: [
        "재전송 요청이 처음 요청과 같은 키인지는 어디에서 판단하나요?",
        "저장과 차감의 순서를 어떤 기준으로 정하셨나요?",
      ],
      positiveSignals: [
        "재생 기록의 요청 순서를 짚어 가며 원인 구간을 좁힌다.",
        "재현 조건을 스스로 다시 만들어 설명한다.",
      ],
      concernSignals: [
        "기록을 보지 않고 일반론으로만 답한다.",
        "원인을 환경 탓으로 돌리고 코드 경로를 말하지 못한다.",
      ],
      refs: [
        { kind: "CRITERION", criterionId: "R-05" },
        { kind: "EXECUTION_RECORD", runId: FIXTURE_RUN_ID, criterionId: "R-05" },
        { kind: "SOURCE", location: { path: "src/http/routes.ts", startLine: 25, endLine: 28 } },
      ],
      source: "LLM",
    },
    {
      id: "TEST_DESIGN:G1",
      kind: "TEST_DESIGN",
      competency: "TESTING",
      priority: "SHOULD",
      minutes: 6,
      question: "경계 입력을 다루는 테스트를 지금 하나 더 쓴다면 어떤 것을 먼저 쓰시겠어요?",
      intent: "결함을 실제로 잡는 테스트를 설계하는 기준이 있는지 확인합니다.",
      probes: [
        "그 테스트가 실패하려면 구현이 어떻게 달라져야 하나요?",
        "지금 테스트에서 빠졌다고 보는 구간은 어디인가요?",
      ],
      positiveSignals: [
        "잡으려는 결함을 먼저 말하고 테스트를 설계한다.",
        "기존 테스트의 빈틈을 스스로 짚는다.",
      ],
      concernSignals: [
        "커버리지 수치로만 충분하다고 답한다.",
        "테스트가 무엇을 막는지 설명하지 못한다.",
      ],
      refs: [{ kind: "CRITERION", criterionId: "G1" }],
      source: "TEMPLATE",
    },
    {
      id: "RESUME_BRIDGE:1",
      kind: "RESUME_BRIDGE",
      competency: "DATA_INTEGRITY",
      priority: "SHOULD",
      minutes: 5,
      question: "이력서에 적으신 멱등 결제 엔드포인트에서는 재전송을 어떤 기준으로 구분하셨나요?",
      intent: "이력서 경험의 조건과 이번 과제의 조건 차이를 확인합니다.",
      probes: ["그때의 트래픽 조건은 어땠나요?", "같은 응답인지는 어떻게 확인하셨나요?"],
      positiveSignals: [
        "두 구현의 조건 차이를 스스로 구분한다.",
        "확인 방법을 구체적으로 설명한다.",
      ],
      concernSignals: ["경험과 과제를 같은 조건으로 뭉뚱그린다.", "확인 방법을 말하지 못한다."],
      refs: [{ kind: "CONTEXT_LINK", contextLinkId: FIXTURE_CONTEXT_LINK_ID }],
      source: "LLM",
    },
  ];
  const plans: InterviewKit["plans"] = options.plans ?? [
    {
      durationMinutes: 45,
      segments: [
        { name: "도입", minutes: 5, questionIds: [] },
        { name: "실패 디브리핑", minutes: 8, questionIds: ["FAILURE_DEBRIEF:R-05"] },
        { name: "테스트 설계", minutes: 6, questionIds: ["TEST_DESIGN:G1"] },
        { name: "지원자 질문", minutes: 5, questionIds: [] },
      ],
    },
    {
      durationMinutes: 60,
      segments: [
        { name: "도입", minutes: 5, questionIds: [] },
        { name: "실패 디브리핑", minutes: 8, questionIds: ["FAILURE_DEBRIEF:R-05"] },
        { name: "테스트 설계", minutes: 6, questionIds: ["TEST_DESIGN:G1"] },
        { name: "이력서 연결", minutes: 5, questionIds: ["RESUME_BRIDGE:1"] },
        { name: "지원자 질문", minutes: 5, questionIds: [] },
      ],
    },
  ];
  return InterviewKitSchema.parse({
    schemaVersion: INTERVIEW_KIT_SCHEMA_VERSION,
    evaluationId: FIXTURE_EVALUATION_ID,
    questions,
    plans,
    generation: {
      slotCount: questions.length,
      templateCount: questions.filter((q) => q.source === "TEMPLATE").length,
      llm: "OK",
      llmReason: null,
      promptVersion: "interview-kit-1",
      model: "deepseek-chat",
      aiReviewId: "88888888-8888-4888-8888-888888888888",
      inputDigest: FIXTURE_DIGEST,
      dropped: [],
      ...options.generation,
    },
  });
}
