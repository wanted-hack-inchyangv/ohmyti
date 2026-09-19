import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ANCHOR_LABELS,
  AREA_DEFAULT_COMPETENCY,
  COMPETENCIES,
  COMPETENCY_ANCHORS,
  CompetencySchema,
  ReportProfileSchema,
  competencyForCriterion,
  impactForCriterion,
} from "./competency";
import { RubricAreaSchema } from "./enums";
import {
  HIRING_REPORT_SCHEMA_VERSION,
  HiringReportSchema,
  JUDGEMENT_KEY_ALLOWED_PATHS,
  collectSchemaKeyPaths,
  findJudgementKeys,
  type HiringReport,
} from "./hiring-report";
import {
  InterviewKitSchema,
  InterviewQuestionSchema,
  type InterviewKit,
  type InterviewQuestion,
} from "./interview";
import { lintInterviewQuestion } from "./interview-lint";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const AT = "2026-09-20T00:00:00.000Z";

const question: InterviewQuestion = {
  id: "FAILURE_DEBRIEF:R-06",
  kind: "FAILURE_DEBRIEF",
  competency: "DEBUGGING",
  priority: "MUST",
  minutes: 8,
  question:
    "R-06 재생 기록을 함께 보겠습니다. 기대한 응답과 실제 응답이 달라진 원인을 코드에서 짚어 주시겠어요?",
  intent: "재생 기록의 기대값과 실제값에서 원인 코드 위치까지 좁힐 수 있는지 확인한다.",
  probes: [
    "두 번째 요청에서 어떤 값이 달라졌나요?",
    "그 차이를 만든 조건은 코드의 어느 분기에서 결정되나요?",
    "본문 비교 대신 해시를 저장한다면 어떤 비용이 생기나요?",
  ],
  positiveSignals: ["기대값과 실제값의 차이를 먼저 말한다.", "원인 분기를 파일과 함수로 짚는다."],
  concernSignals: ["재생 기록을 보지 않고 추측한다.", "테스트 환경 탓으로 돌린다."],
  refs: [
    { kind: "CRITERION", criterionId: "R-06" },
    { kind: "EXECUTION_RECORD", runId: "run-1", criterionId: "R-06" },
    { kind: "SOURCE", location: { path: "src/orders.ts", startLine: 10, endLine: 30 } },
  ],
  source: "TEMPLATE",
};

const kit: InterviewKit = {
  schemaVersion: 1,
  evaluationId: "eval-1",
  questions: [question],
  plans: [
    {
      durationMinutes: 45,
      segments: [
        { name: "도입", minutes: 5, questionIds: [] },
        { name: "실패 디브리핑", minutes: 8, questionIds: [question.id] },
        { name: "지원자 질문", minutes: 5, questionIds: [] },
      ],
    },
  ],
  generation: {
    slotCount: 1,
    templateCount: 1,
    llm: "NOT_RUN",
    llmReason: "LLM 미실행(예산 초과)",
    promptVersion: "interview-kit-v1",
    model: null,
    aiReviewId: null,
    inputDigest: null,
    dropped: [],
  },
};

function buildReport(): HiringReport {
  return {
    schemaVersion: HIRING_REPORT_SCHEMA_VERSION,
    evaluationId: "eval-1",
    assignment: { name: "order-api", version: 1, title: "주문 API" },
    isSample: true,
    summary: {
      score: {
        earned: 69,
        min: 69,
        max: 69,
        pendingPoints: 0,
        total: 100,
        display: "69/100",
        byArea: null,
      },
      verdictCounts: { PASS: 10, FAIL: 4, PARTIAL: 0, INCONCLUSIVE: 1 },
      pendingReview: [],
    },
    keyObservations: {
      strengths: [],
      defects: [
        {
          criterionId: "R-06",
          title: "멱등 키 충돌",
          verdict: "FAIL",
          issueId: null,
          observation: "다른 본문으로 같은 키를 보내면 409 대신 201이 왔다.",
          impact:
            "같은 주문 요청이 다른 내용으로 다시 오면 새 주문이 만들어져 중복 결제로 이어질 수 있다.",
          aiDraft: null,
          refs: [{ kind: "EXECUTION_RECORD", runId: "run-1", criterionId: "R-06" }],
        },
      ],
    },
    competencies: [
      {
        competency: "DEBUGGING",
        name: COMPETENCIES.DEBUGGING.name,
        interviewOnly: true,
        criteria: [],
        verdictCounts: { PASS: 0, FAIL: 0, PARTIAL: 0, INCONCLUSIVE: 0 },
        kitQuestions: [{ questionId: question.id, number: 1, question: question.question }],
      },
    ],
    requirements: {
      criteria: [],
      testEffectiveness: [
        {
          groupId: "G1",
          name: "경계·검증",
          criterionId: "G1",
          verdict: "FAIL",
          outcomes: {
            KILLED: 1,
            SURVIVED: 2,
            EQUIVALENT: 0,
            BUILD_FAIL: 0,
            ENV_ERROR: 0,
            TIMEOUT: 0,
            NOT_APPLICABLE: 0,
          },
        },
      ],
      designReview: { status: "NO_DATA", draft: true, items: [], signals: null },
    },
    resumeLinks: { status: "NO_RESUME", links: [] },
    interviewGuide: {
      status: "AVAILABLE",
      llm: "NOT_RUN",
      llmReason: "LLM 미실행(예산 초과)",
      mustQuestions: [
        {
          questionId: question.id,
          number: 1,
          kind: question.kind,
          competency: question.competency,
          minutes: question.minutes,
          question: question.question,
          source: question.source,
        },
      ],
    },
    scope: {
      unassessedAreas: ["이력서 미제공"],
      inconclusive: [
        {
          criterionId: "R-10",
          title: "실행 계약 충족",
          failureKind: "ENVIRONMENT",
          environmental: true,
          reason: "서비스 기동 시간 초과",
        },
      ],
      pendingReview: [],
      llmUsage: [
        { stage: "REVIEW_WRITE", state: "DONE", model: null, promptVersion: null, reason: null },
      ],
      supportScope: ["TypeScript 저장소만 지원합니다."],
    },
    scorecard: {
      humanOnly: true,
      competencies: CompetencySchema.options.map((competency) => ({
        competency,
        name: COMPETENCIES[competency].name,
        definition: COMPETENCIES[competency].definition,
        interviewOnly: COMPETENCIES[competency].interviewOnly,
        anchors: [...COMPETENCY_ANCHORS[competency]],
      })),
      saved: [],
    },
    audit: {
      evaluationId: "eval-1",
      submissionId: "sub-1",
      rubricVersion: "v1-12345678",
      harnessVersion: "1",
      environmentDigest: DIGEST,
      submissionSha: SHA,
      repoUrl: "https://github.com/example/order-api",
      isSample: true,
      finishedAt: AT,
      llmStages: [],
      humanEdits: { count: 0, lastAt: null },
    },
  };
}

describe("역량 모델", () => {
  it("역량 9종과 면접 전용 3종", () => {
    expect(CompetencySchema.options).toHaveLength(9);
    expect(
      CompetencySchema.options.filter((competency) => COMPETENCIES[competency].interviewOnly),
    ).toEqual(["DEBUGGING", "TRADEOFFS", "OPERABILITY"]);
    for (const competency of CompetencySchema.options) {
      expect(COMPETENCIES[competency].name.length).toBeGreaterThan(0);
      expect(COMPETENCIES[competency].definition).toMatch(/다\.$/);
    }
  });

  it("모든 역량에 1~4단계 앵커가 있고 행동 문장이 겹치지 않는다", () => {
    const behaviors = new Set<string>();
    for (const competency of CompetencySchema.options) {
      const anchors = COMPETENCY_ANCHORS[competency];
      expect(anchors.map((anchor) => anchor.value)).toEqual([1, 2, 3, 4]);
      expect(anchors.map((anchor) => anchor.label)).toEqual([
        ANCHOR_LABELS[1],
        ANCHOR_LABELS[2],
        ANCHOR_LABELS[3],
        ANCHOR_LABELS[4],
      ]);
      for (const anchor of anchors) {
        expect(anchor.behavior).toMatch(/다\.$/);
        behaviors.add(anchor.behavior);
      }
    }
    expect(behaviors.size).toBe(9 * 4);
    expect(ANCHOR_LABELS).toEqual({ 1: "미흡", 2: "보완 필요", 3: "충족", 4: "탁월" });
    expect(COMPETENCY_ANCHORS.DEBUGGING[2]!.behavior).toBe(
      "재생 기록의 기대값·실제값에서 원인 코드 위치까지 스스로 좁힌다.",
    );
  });

  it("영역 기본 매핑은 결정적이며 면접 전용 역량으로 매핑하지 않는다", () => {
    expect(AREA_DEFAULT_COMPETENCY).toEqual({
      REQUIRED_FEATURES: "REQUIREMENTS",
      EDGE_AND_FAILURE: "ROBUSTNESS",
      TEST_EFFECTIVENESS: "TESTING",
      DESIGN: "DESIGN",
      REPRODUCIBILITY_AND_DOCS: "COMMUNICATION",
    });
    for (const area of RubricAreaSchema.options) {
      expect(COMPETENCIES[AREA_DEFAULT_COMPETENCY[area]].interviewOnly).toBe(false);
    }
  });

  it("리포트 프로필이 역량과 영향 문장을 보정한다", () => {
    const profile = ReportProfileSchema.parse({
      profileVersion: 1,
      criteria: [
        { criterionId: "R-07", competency: "DATA_INTEGRITY" },
        { criterionId: "R-06", impact: "중복 결제로 이어질 수 있다." },
      ],
    });
    expect(competencyForCriterion({ id: "R-07", area: "EDGE_AND_FAILURE" }, profile)).toBe(
      "DATA_INTEGRITY",
    );
    expect(competencyForCriterion({ id: "R-06", area: "REQUIRED_FEATURES" }, profile)).toBe(
      "REQUIREMENTS",
    );
    expect(competencyForCriterion({ id: "R-03", area: "EDGE_AND_FAILURE" }, null)).toBe(
      "ROBUSTNESS",
    );
    expect(impactForCriterion("R-06", profile)).toBe("중복 결제로 이어질 수 있다.");
    expect(impactForCriterion("R-03", profile)).toBeNull();
    expect(impactForCriterion("R-06", null)).toBeNull();
  });

  it("리포트 프로필의 기준 중복과 모르는 키를 거절한다", () => {
    expect(
      ReportProfileSchema.safeParse({
        profileVersion: 1,
        criteria: [{ criterionId: "R-01" }, { criterionId: "R-01" }],
      }).success,
    ).toBe(false);
    expect(
      ReportProfileSchema.safeParse({
        profileVersion: 1,
        criteria: [{ criterionId: "R-01", points: 3 }],
      }).success,
    ).toBe(false);
  });
});

describe("InterviewQuestionSchema·InterviewKitSchema", () => {
  it("예시 질문이 스키마와 질문 검사를 통과한다", () => {
    expect(InterviewQuestionSchema.parse(question)).toEqual(question);
    expect(lintInterviewQuestion(question)).toEqual([]);
    expect(InterviewKitSchema.parse(kit)).toEqual(kit);
  });

  it("근거 참조가 없거나 꼬리 질문·신호 개수가 범위를 벗어나면 거절한다", () => {
    expect(InterviewQuestionSchema.safeParse({ ...question, refs: [] }).success).toBe(false);
    expect(InterviewQuestionSchema.safeParse({ ...question, probes: ["하나"] }).success).toBe(
      false,
    );
    expect(
      InterviewQuestionSchema.safeParse({ ...question, positiveSignals: ["1", "2", "3", "4", "5"] })
        .success,
    ).toBe(false);
  });

  it("점수·판정 키를 붙이면 strictObject가 거절한다", () => {
    for (const key of ["score", "grade", "recommendation", "rank", "verdict", "points"]) {
      expect(InterviewQuestionSchema.safeParse({ ...question, [key]: 1 }).success).toBe(false);
      expect(InterviewKitSchema.safeParse({ ...kit, [key]: 1 }).success).toBe(false);
    }
  });

  it("진행안 구간 합이 길이를 넘거나 없는 질문을 가리키면 거절한다", () => {
    const over = structuredClone(kit);
    over.plans[0]!.segments.push({ name: "확장", minutes: 30, questionIds: [] });
    expect(InterviewKitSchema.safeParse(over).success).toBe(false);

    const unknown = structuredClone(kit);
    unknown.plans[0]!.segments[1]!.questionIds.push("EXTENSION:1");
    expect(InterviewKitSchema.safeParse(unknown).success).toBe(false);

    const duplicate = structuredClone(kit);
    duplicate.questions.push(question);
    expect(InterviewKitSchema.safeParse(duplicate).success).toBe(false);
  });
});

describe("HiringReportSchema", () => {
  it("예시 리포트가 스키마를 통과한다", () => {
    const report = buildReport();
    expect(HiringReportSchema.parse(report)).toEqual(report);
  });

  it("PRD 14.3의 9개 절이 있다", () => {
    expect(Object.keys(HiringReportSchema.shape)).toEqual([
      "schemaVersion",
      "evaluationId",
      "assignment",
      "isSample",
      "summary",
      "keyObservations",
      "competencies",
      "requirements",
      "resumeLinks",
      "interviewGuide",
      "scope",
      "scorecard",
      "audit",
    ]);
  });

  it("스코어카드는 사람이 기입하는 빈 양식이다 (값 필드를 붙이면 거절)", () => {
    const report = buildReport();
    const withValue = structuredClone(report) as unknown as {
      scorecard: { competencies: Array<Record<string, unknown>> };
    };
    withValue.scorecard.competencies[0]!.value = 3;
    expect(HiringReportSchema.safeParse(withValue).success).toBe(false);
  });

  it("리포트용 총점·등급·추천 키를 붙이면 strictObject가 거절한다", () => {
    for (const key of ["totalScore", "grade", "level", "recommendation", "rank", "hireDecision"]) {
      expect(HiringReportSchema.safeParse({ ...buildReport(), [key]: "x" }).success).toBe(false);
      expect(
        HiringReportSchema.safeParse({
          ...buildReport(),
          summary: { ...buildReport().summary, [key]: "x" },
        }).success,
      ).toBe(false);
    }
  });
});

describe("키 이름 검사 (G-01, G-13, PRD 14.4)", () => {
  it("검사기가 중첩·배열·유니온·레코드 안의 키를 모두 본다", () => {
    const paths = collectSchemaKeyPaths(InterviewKitSchema);
    expect(paths).toContain("questions.[].refs.[].runId");
    expect(paths).toContain("questions.[].refs.[].location.path");
    expect(paths).toContain("plans.[].segments.[].questionIds");
    expect(collectSchemaKeyPaths(HiringReportSchema)).toContain(
      "summary.score.byArea.[].pendingPoints",
    );

    const probe = z.strictObject({
      list: z.array(z.strictObject({ grade: z.string() })),
      map: z.record(z.string(), z.strictObject({ hireRecommendation: z.boolean() })),
      union: z.union([z.strictObject({ seniorityLevel: z.string() }), z.string()]),
      nested: z.strictObject({ ranking: z.int().nullable().optional() }),
    });
    expect(findJudgementKeys(probe)).toEqual([
      "list.[].grade",
      "map.{}.hireRecommendation",
      "union.seniorityLevel",
      "nested.ranking",
    ]);
  });

  it("인터뷰 키트 스키마에 점수·판정·등급·추천·순위 키가 없다", () => {
    expect(findJudgementKeys(InterviewKitSchema, [])).toEqual([]);
    const lastKeys = collectSchemaKeyPaths(InterviewKitSchema).map((p) => p.split(".").at(-1)!);
    for (const key of ["points", "earned", "verdict", "earnedPoints", "maxPoints"]) {
      expect(lastKeys).not.toContain(key);
    }
  });

  it("채용 리포트 스키마에는 저장된 점수(summary.score)와 사람 기입 양식(scorecard) 외에 판단 키가 없다", () => {
    expect(JUDGEMENT_KEY_ALLOWED_PATHS).toEqual(["summary.score", "scorecard"]);
    expect(findJudgementKeys(HiringReportSchema)).toEqual([]);
    expect(findJudgementKeys(HiringReportSchema, [])).toEqual(["summary.score", "scorecard"]);
  });
});
