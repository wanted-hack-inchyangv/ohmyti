/**
 * T-702 인터뷰 키트 단위 테스트 (interview-kit). DB 없이 질문 계획·기본 질문·후처리·LLM 입력을 검사한다.
 * 파이프라인 통합은 `pipeline/interview-kit.test.ts`가 맡는다.
 */
import {
  CONTEXT_DEFAULT_QUESTION,
  InterviewKitSchema,
  lintInterviewQuestion,
  type DesignSignals,
  type SourceLocation,
} from "@ohmyti/core";
import { describe, expect, it } from "vitest";
import {
  checkInterviewKitIsolation,
  findIsolationViolations,
} from "../../../../scripts/check-context-isolation";
import {
  acceptKitItems,
  assembleInterviewKit,
  buildInterviewKitInput,
  InterviewKitLenientOutputSchema,
  LLM_SLOT_KINDS,
  planInterviewSlots,
  templateQuestion,
  type InterviewKitFacts,
  type KitCriterionFact,
} from ".";

const loc = (path: string, startLine: number, endLine = startLine): SourceLocation => ({
  path,
  startLine,
  endLine,
});

function criterion(
  id: string,
  partial: Partial<KitCriterionFact> & Pick<KitCriterionFact, "area" | "maxPoints">,
): KitCriterionFact {
  return {
    id,
    title: `${id} 제목`,
    condition: `${id} 판정 조건`,
    method: "EXECUTION",
    groupId: null,
    verdict: "PASS",
    issueId: null,
    lostPoints: 0,
    observation: `하네스 케이스 ${id} PASS: 검사 3개 모두 통과`,
    runs: [
      {
        runId: `00000000-0000-4000-8000-0000000000${id.replace(/\D/g, "").padStart(2, "0")}`,
        caseId: `case-${id}`,
        handlers: [{ name: "createOrder", location: loc("src/routes/orders.ts", 10, 40) }],
      },
    ],
    ...partial,
  };
}

const SIGNALS: DesignSignals = {
  status: "ok",
  analyzerVersion: "1",
  sourceFiles: 8,
  testFiles: 3,
  maxFileLines: { lines: 120, location: loc("src/app.ts", 1, 120) },
  maxFunctionLines: {
    lines: 48,
    name: "createOrder",
    location: loc("src/routes/orders.ts", 10, 57),
  },
  explicitAny: { count: 0, asAny: 0, locations: [] },
  tsconfig: { path: "tsconfig.json", strict: true },
  duplicateBlocks: { count: 0, groups: [] },
  busyWaits: { count: 0, locations: [] },
  consoleLogs: { count: 0, locations: [] },
  weakAssertions: { count: 2, total: 11, locations: [loc("test/orders.test.ts", 30)] },
};

/** 샘플 순서의 rubric을 흉내 낸 입력. `fail`에 넣은 기준은 FAIL이고 잃은 배점은 배점 전부다 */
function facts(
  options: { fail?: string[]; survived?: string[]; links?: number } = {},
): InterviewKitFacts {
  const fail = new Set(options.fail ?? []);
  const base: Array<[string, KitCriterionFact["area"], number, Partial<KitCriterionFact>?]> = [
    ["R-01", "REQUIRED_FEATURES", 8],
    ["R-02", "REQUIRED_FEATURES", 6],
    ["R-05", "REQUIRED_FEATURES", 14],
    ["R-06", "REQUIRED_FEATURES", 6],
    ["R-09", "REQUIRED_FEATURES", 6],
    ["R-03", "EDGE_AND_FAILURE", 7],
    ["R-04", "EDGE_AND_FAILURE", 6],
    ["R-07", "EDGE_AND_FAILURE", 6, { title: "같은 키 동시 요청" }],
    ["R-08", "EDGE_AND_FAILURE", 6, { title: "다른 키 동시 요청과 재고 하한" }],
    ["G1", "TEST_EFFECTIVENESS", 5, { method: "MUTATION", groupId: "G1", runs: [] }],
    ["R-12", "DESIGN", 10, { method: "HUMAN_REVIEW", verdict: "INCONCLUSIVE", runs: [] }],
  ];
  const criteria = base.map(([id, area, maxPoints, extra]) => {
    const failed = fail.has(id);
    return criterion(id, {
      area,
      maxPoints,
      ...extra,
      ...(failed
        ? {
            verdict: "FAIL" as const,
            lostPoints: maxPoints,
            issueId: `case:case-${id}`,
            observation: `하네스 케이스 case-${id} FAIL(ASSERTION): 검사 3개 중 1개 실패 · status: 기대 422, 실제 201`,
          }
        : {}),
    });
  });
  const survived = new Set(options.survived ?? []);
  return {
    spec: { title: "주문 API", summary: "# 주문 API\n멱등 키로 주문을 만든다." },
    resetPath: "/admin/reset",
    criteria,
    independentGroups: [["R-05", "R-06", "R-07"]],
    groups: [{ id: "G1", name: "경계·검증", criterionIds: ["R-03", "R-04"] }],
    mutations: ["M-02", "M-01"].map((mutationId) => ({
      mutationId,
      experimentId: `00000000-0000-4000-8000-00000000010${mutationId.slice(-1)}`,
      groupId: "G1",
      outcome: survived.has(mutationId) ? ("SURVIVED" as const) : ("KILLED" as const),
      description: `${mutationId} 설명`,
      target: loc("src/routes/orders.ts", 20),
    })),
    designSignals: SIGNALS,
    designDrafts: [],
    contextLinks: Array.from({ length: options.links ?? 0 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000020${i}`,
      question: "결제 API에서 같은 키에 다른 본문이 오면 어떤 응답을 돌려주도록 정했나요?",
      criterionId: i === 1 ? "R-06" : null,
      structured: null,
    })),
  };
}

const C_FACTS = facts({ fail: ["R-05", "R-06", "R-07", "G1"], survived: ["M-01", "M-02"] });
const A_FACTS = facts();

describe("planInterviewSlots (결정적 질문 계획)", () => {
  it("결함 구현(C): FAIL 기준마다 실패 디브리핑 슬롯이 생기고 잃은 배점 상위 2개가 필수다", () => {
    const plan = planInterviewSlots(C_FACTS);
    const debrief = plan.slots.filter((s) => s.kind === "FAILURE_DEBRIEF");
    // 세 기준은 rubric independentReason으로 따로 감점되므로 각자 슬롯이다. MUTATION 기준(G1)은 테스트 설계로 간다
    expect(debrief.map((s) => s.id)).toEqual([
      "FAILURE_DEBRIEF:R-05",
      "FAILURE_DEBRIEF:R-06",
      "FAILURE_DEBRIEF:R-07",
    ]);
    expect(debrief.map((s) => s.priority)).toEqual(["MUST", "MUST", "SHOULD"]);
    expect(debrief[0]!.refs).toContainEqual({ kind: "CRITERION", criterionId: "R-05" });
    expect(debrief[0]!.refs.some((r) => r.kind === "EXECUTION_RECORD")).toBe(true);
    expect(debrief[0]!.competency).toBe("DEBUGGING");

    const must = plan.slots.filter((s) => s.priority === "MUST").map((s) => s.id);
    expect(must).toEqual([
      "FAILURE_DEBRIEF:R-05",
      "FAILURE_DEBRIEF:R-06",
      "TEST_DESIGN:G1",
      "STRENGTH_DEPTH:R-03",
    ]);
    const testDesign = plan.slots.find((s) => s.id === "TEST_DESIGN:G1")!;
    expect(testDesign.refs.filter((r) => r.kind === "MUTATION").map((r) => r.mutationId)).toEqual([
      "M-01",
      "M-02",
    ]);
    expect(testDesign.refs).toContainEqual({ kind: "CRITERION", criterionId: "G1" });
    // 키트 순서: 필수 → 권장 → 선택
    const order = { MUST: 0, SHOULD: 1, OPTIONAL: 2 } as const;
    const ranks = plan.slots.map((s) => order[s.priority]);
    expect([...ranks].sort()).toEqual(ranks);
  });

  it("정답 구현(A): 실패 디브리핑이 없고 강점 확인 2개와 요구사항 확장 1개가 필수다", () => {
    const plan = planInterviewSlots(A_FACTS);
    expect(plan.slots.filter((s) => s.kind === "FAILURE_DEBRIEF")).toHaveLength(0);
    const must = plan.slots.filter((s) => s.priority === "MUST");
    expect(must.map((s) => s.kind)).toEqual(["STRENGTH_DEPTH", "STRENGTH_DEPTH", "EXTENSION"]);
    // 배점이 큰 순(R-03 7점), 같으면 rubric 순서
    expect(must.map((s) => s.id)).toEqual([
      "STRENGTH_DEPTH:R-03",
      "STRENGTH_DEPTH:R-04",
      "EXTENSION:multi-instance",
    ]);
    const strength = must[0]!;
    expect(strength.refs).toEqual([
      { kind: "CRITERION", criterionId: "R-03" },
      {
        kind: "EXECUTION_RECORD",
        runId: A_FACTS.criteria.find((c) => c.id === "R-03")!.runs[0]!.runId,
        criterionId: "R-03",
      },
      { kind: "SOURCE", location: loc("src/routes/orders.ts", 10, 40) },
    ]);
    const extension = plan.slots.filter((s) => s.kind === "EXTENSION");
    expect(extension.map((s) => s.id)).toEqual([
      "EXTENSION:multi-instance",
      "EXTENSION:persistent-store",
    ]);
    expect(extension[1]!.brief.scenario?.note).toBe(
      "실행 계약에 상태 초기화 경로(/admin/reset)가 있다",
    );
    // 약한 단언이 있으면 테스트 설계 슬롯이 생기고, 가장 긴 함수는 설계 트레이드오프 슬롯이 된다
    expect(plan.slots.map((s) => s.id)).toContain("TEST_DESIGN:weak-assertions");
    expect(plan.slots.map((s) => s.id)).toContain("DESIGN_TRADEOFF:max-function");
  });

  it("같은 issueId는 별도 감점 근거가 없으면 하나로 묶고, INCONCLUSIVE 기준은 질문으로 만들지 않는다", () => {
    const base = facts({ fail: ["R-05", "R-06", "R-03"] });
    base.independentGroups = [];
    base.criteria = base.criteria.map((c) => {
      if (c.id === "R-05" || c.id === "R-06") return { ...c, issueId: "idempotency-store-missing" };
      if (c.id === "R-08")
        return { ...c, verdict: "INCONCLUSIVE" as const, observation: "TIMEOUT" };
      return c;
    });
    const debrief = planInterviewSlots(base).slots.filter((s) => s.kind === "FAILURE_DEBRIEF");
    expect(debrief.map((s) => s.id)).toEqual(["FAILURE_DEBRIEF:R-05", "FAILURE_DEBRIEF:R-03"]);
    expect(debrief[0]!.brief.criteria.map((c) => c.id)).toEqual(["R-05", "R-06"]);
    expect(debrief[0]!.refs.filter((r) => r.kind === "CRITERION")).toHaveLength(2);
  });

  it("이력서 연결은 관측 기준이 있는 연결을 먼저 최대 3개 가져오고 LLM 입력에는 넣지 않는다", () => {
    const plan = planInterviewSlots(facts({ links: 4 }));
    const bridges = plan.slots.filter((s) => s.kind === "RESUME_BRIDGE");
    expect(bridges).toHaveLength(3);
    expect(bridges[0]!.refs).toEqual([
      { kind: "CONTEXT_LINK", contextLinkId: "00000000-0000-4000-8000-000000000201" },
      { kind: "CRITERION", criterionId: "R-06" },
    ]);
    const input = buildInterviewKitInput({ spec: A_FACTS.spec, slots: plan.slots });
    expect(input).not.toContain("RESUME_BRIDGE");
    expect(input).not.toContain("결제 API에서 같은 키에");
  });

  it("같은 입력이면 계획(슬롯·우선순위·시간·진행안)이 바이트 단위로 같고, 변이·연결 입력 순서에 기대지 않는다", () => {
    const first = JSON.stringify(planInterviewSlots(C_FACTS));
    expect(JSON.stringify(planInterviewSlots(C_FACTS))).toBe(first);
    const shuffled = { ...C_FACTS, mutations: [...C_FACTS.mutations].reverse() };
    expect(JSON.stringify(planInterviewSlots(shuffled))).toBe(first);
  });

  it("진행안은 도입·지원자 질문 5분을 고정하고 필수 → 권장 순으로 45분·60분을 넘지 않게 채운다", () => {
    for (const input of [C_FACTS, A_FACTS, facts({ links: 3 })]) {
      const plan = planInterviewSlots(input);
      expect(plan.plans.map((p) => p.durationMinutes)).toEqual([45, 60]);
      for (const p of plan.plans) {
        const total = p.segments.reduce((sum, s) => sum + s.minutes, 0);
        expect(total).toBeLessThanOrEqual(p.durationMinutes);
        expect(p.segments[0]).toEqual({ name: "도입", minutes: 5, questionIds: [] });
        expect(p.segments.at(-1)).toEqual({ name: "지원자 질문", minutes: 5, questionIds: [] });
        const ids = p.segments.flatMap((s) => s.questionIds);
        const chosen = plan.slots.filter((s) => ids.includes(s.id));
        expect(chosen.every((s) => s.priority !== "OPTIONAL")).toBe(true);
        // 필수 질문은 모두 들어간다
        for (const s of plan.slots.filter((s) => s.priority === "MUST"))
          expect(ids).toContain(s.id);
      }
    }
    // C의 45분: 필수 28분(실패 8+8, 테스트 설계 6, 강점 6) 뒤에 남은 7분에는 권장 중 6분짜리 테스트 설계만 들어간다
    const c = planInterviewSlots(C_FACTS);
    expect(c.plans[0]!.segments.map((s) => [s.name, s.minutes])).toEqual([
      ["도입", 5],
      ["실패 디브리핑", 16],
      ["테스트 설계", 12],
      ["강점 확인", 6],
      ["지원자 질문", 5],
    ]);
  });
});

describe("기본 질문 (source: TEMPLATE)", () => {
  it("모든 유형의 기본 질문이 질문 검사를 통과한다", () => {
    const variants = [
      planInterviewSlots(C_FACTS),
      planInterviewSlots(facts({ links: 3 })),
      planInterviewSlots({
        ...A_FACTS,
        designSignals: null,
        designDrafts: [{ criterionId: "R-12" }],
      }),
    ];
    const kinds = new Set<string>();
    for (const plan of variants) {
      for (const slot of plan.slots) {
        kinds.add(slot.kind);
        const text = templateQuestion(slot);
        expect(lintInterviewQuestion({ ...text, refs: slot.refs }), slot.id).toEqual([]);
      }
    }
    expect([...kinds].sort()).toEqual([
      "DESIGN_TRADEOFF",
      "EXTENSION",
      "FAILURE_DEBRIEF",
      "RESUME_BRIDGE",
      "STRENGTH_DEPTH",
      "TEST_DESIGN",
    ]);
  });

  it("실패 디브리핑 기본 질문은 티켓 예시 문장이다", () => {
    const slot = planInterviewSlots(facts({ fail: ["R-06"] })).slots[0]!;
    expect(templateQuestion(slot).question).toBe(
      "R-06 재생 기록을 함께 보겠습니다. 기대한 응답과 실제 응답이 달라진 원인을 코드에서 짚어 주시겠어요?",
    );
  });
});

describe("후처리 (acceptKitItems · assembleInterviewKit)", () => {
  const plan = planInterviewSlots(C_FACTS);
  const llmSlots = plan.slots.filter((s) => LLM_SLOT_KINDS.includes(s.kind));
  const good = (slotId: string) => ({
    slotId,
    question: `${slotId.split(":")[1]} 동작을 함께 보겠습니다. 이 동작을 확인하는 코드는 어디에 있나요?`,
    intent: "지원자가 코드 위치를 스스로 찾는지 확인한다.",
    probes: ["가장 먼저 볼 파일은 무엇인가요?", "그 파일을 고르는 기준은 무엇인가요?"],
    positiveSignals: ["코드 위치를 스스로 찾아 설명한다.", "요청 흐름을 순서대로 말한다."],
    concernSignals: ["코드를 보지 않고 추측한다.", "요청 흐름을 설명하지 않는다."],
  });

  it("복합 질문·추궁 어조·인상 표현·없는 슬롯·중복·스키마 위반만 버리고 기본 질문으로 채우며 사유를 남긴다", () => {
    const [first, second, third, fourth, ...rest] = llmSlots;
    const raw = {
      questions: [
        {
          ...good(first!.id),
          question:
            "어떤 저장소에서 어떤 격리 수준으로 구현했고, 충돌 재시도 조건은 어떻게 달랐나요?",
        },
        {
          ...good(second!.id),
          question: "이번 과제에서는 왜 그 조건이 테스트에 들어가지 않았는지 설명해 주시겠어요?",
        },
        {
          ...good(third!.id),
          positiveSignals: ["똑똑하게 답한다.", "요청 흐름을 순서대로 말한다."],
        },
        good("FAILURE_DEBRIEF:R-99"),
        good(fourth!.id),
        good(fourth!.id),
        { slotId: rest[0]!.id, question: "질문만 있다" },
        ...rest.slice(1).map((s) => good(s.id)),
      ],
    };
    const parsed = InterviewKitLenientOutputSchema.parse(raw);
    const { accepted, dropped } = acceptKitItems(parsed.questions, plan);
    expect(dropped).toEqual([
      { index: 0, slotId: first!.id, reason: "LINT_VIOLATION", rules: ["COMPOUND_QUESTION"] },
      { index: 1, slotId: second!.id, reason: "LINT_VIOLATION", rules: ["ACCUSATORY_TONE"] },
      { index: 2, slotId: third!.id, reason: "LINT_VIOLATION", rules: ["IMPRESSION"] },
      { index: 3, slotId: "FAILURE_DEBRIEF:R-99", reason: "UNKNOWN_SLOT", rules: [] },
      { index: 5, slotId: fourth!.id, reason: "DUPLICATE_SLOT", rules: [] },
      { index: 6, slotId: rest[0]!.id, reason: "SCHEMA_INVALID", rules: [] },
    ]);
    expect([...accepted.keys()]).toEqual([fourth!.id, ...rest.slice(1).map((s) => s.id)]);

    const kit = assembleInterviewKit({
      evaluationId: "00000000-0000-4000-8000-000000000001",
      plan,
      accepted,
      dropped,
      generation: {
        llm: "OK",
        llmReason: null,
        promptVersion: "interview-kit@v1+test",
        model: "fake",
        aiReviewId: null,
        inputDigest: "a".repeat(64),
      },
    });
    expect(InterviewKitSchema.parse(kit)).toEqual(kit);
    const sourceOf = (id: string) => kit.questions.find((q) => q.id === id)!.source;
    for (const slot of [first!, second!, third!, rest[0]!])
      expect(sourceOf(slot.id)).toBe("TEMPLATE");
    expect(sourceOf(fourth!.id)).toBe("LLM");
    expect(kit.generation.templateCount).toBe(4);
    expect(kit.generation.slotCount).toBe(plan.slots.length);
    expect(kit.generation.dropped).toHaveLength(6);
    // 근거 참조·우선순위·시간은 계획의 값이다
    for (const q of kit.questions) {
      const slot = plan.slots.find((s) => s.id === q.id)!;
      expect([q.refs, q.priority, q.minutes, q.competency]).toEqual([
        slot.refs,
        slot.priority,
        slot.minutes,
        slot.competency,
      ]);
      expect(lintInterviewQuestion(q)).toEqual([]);
    }
  });

  it("검사에 걸리는 이력서 연결 질문은 기본 질문으로 바꾸고 사유를 남긴다", () => {
    const withLinks = facts({ links: 2 });
    withLinks.contextLinks[0]!.question =
      "어떤 저장소(DB/Redis)에서 구현했나요? 이번 과제와는 어떤 점이 다른가요?";
    const bridgePlan = planInterviewSlots(withLinks);
    const kit = assembleInterviewKit({
      evaluationId: "00000000-0000-4000-8000-000000000001",
      plan: bridgePlan,
      accepted: new Map(),
      dropped: [],
      generation: {
        llm: "NOT_CONFIGURED",
        llmReason: "LLM 미실행(설정 없음)",
        promptVersion: "interview-kit@v1+test",
        model: null,
        aiReviewId: null,
        inputDigest: null,
      },
    });
    const bridges = kit.questions.filter((q) => q.kind === "RESUME_BRIDGE");
    expect(bridges.map((q) => q.source)).toEqual(["LLM", "TEMPLATE"]);
    expect(bridges[0]!.question).toBe(
      "결제 API에서 같은 키에 다른 본문이 오면 어떤 응답을 돌려주도록 정했나요?",
    );
    expect(kit.generation.dropped).toEqual([
      {
        index: null,
        slotId: bridges[1]!.id,
        reason: "LINT_VIOLATION",
        rules: ["COMPOUND_QUESTION", "MULTIPLE_QUESTION_MARKS"],
      },
    ]);
  });

  it("맥락 연결 v3의 질문 구조가 있으면 의도·꼬리 질문·신호·역량을 그대로 쓰고, 기본 질문으로 바뀐 연결은 TEMPLATE이다 (T-703)", () => {
    const withLinks = facts({ links: 2 });
    const structured = {
      question: "결제 API에서 같은 키에 다른 본문이 오면 어떤 응답을 돌려주도록 정했나요?",
      intent: "멱등성 설계가 본문 불일치 조건까지 다뤘는지 확인한다.",
      probes: ["멱등성 키는 어디에 저장했나요?", "동시에 같은 키가 오면 어떻게 되나요?"],
      positiveSignals: ["키 저장 위치와 만료를 설명한다", "본문 비교 기준을 구체적으로 든다"],
      concernSignals: ["일반론으로만 설명한다", "본문 불일치 처리를 설명하지 않는다"],
      competency: "DATA_INTEGRITY" as const,
      source: "LLM" as const,
    };
    withLinks.contextLinks[0]!.structured = structured;
    withLinks.contextLinks[1]!.question = CONTEXT_DEFAULT_QUESTION.question;
    withLinks.contextLinks[1]!.structured = CONTEXT_DEFAULT_QUESTION;
    const bridgePlan = planInterviewSlots(withLinks);
    const bridgeSlots = bridgePlan.slots.filter((s) => s.kind === "RESUME_BRIDGE");
    // 관측 기준(R-06)이 있는 두 번째 연결이 먼저다. 역량은 연결 기준이 아니라 질문 구조의 값이다
    expect(bridgeSlots.map((s) => s.competency)).toEqual(["TRADEOFFS", "DATA_INTEGRITY"]);
    const kit = assembleInterviewKit({
      evaluationId: "00000000-0000-4000-8000-000000000001",
      plan: bridgePlan,
      accepted: new Map(),
      dropped: [],
      generation: {
        llm: "NOT_CONFIGURED",
        llmReason: "LLM 미실행(설정 없음)",
        promptVersion: "interview-kit@v1+test",
        model: null,
        aiReviewId: null,
        inputDigest: null,
      },
    });
    const bridges = kit.questions.filter((q) => q.kind === "RESUME_BRIDGE");
    expect(bridges.map((q) => [q.source, q.competency, q.question])).toEqual([
      ["TEMPLATE", "TRADEOFFS", CONTEXT_DEFAULT_QUESTION.question],
      ["LLM", "DATA_INTEGRITY", structured.question],
    ]);
    expect(bridges[1]).toMatchObject({
      intent: structured.intent,
      probes: structured.probes,
      positiveSignals: structured.positiveSignals,
      concernSignals: structured.concernSignals,
    });
    expect(kit.generation.dropped).toEqual([]);
  });
});

describe("LLM 입력 (buildInterviewKitInput)", () => {
  it("제출물 문자열은 비신뢰 블록에 넣고 실행 기록 ID·점수·이력서는 넣지 않는다", () => {
    const plan = planInterviewSlots(C_FACTS);
    const input = buildInterviewKitInput({ spec: C_FACTS.spec, slots: plan.slots });
    expect(input).toContain("### FAILURE_DEBRIEF:R-05 · 실패 디브리핑 · 확인하는 역량: 원인 분석");
    expect(input).toMatch(
      /<<<UNTRUSTED_DATA label="observation:FAILURE_DEBRIEF:R-05"[^\n]*>>>\n- 하네스 케이스/,
    );
    expect(input).toMatch(
      /<<<UNTRUSTED_DATA label="code:FAILURE_DEBRIEF:R-05"[^\n]*>>>\n- createOrder/,
    );
    expect(input).toContain("- M-01: M-01 설명");
    for (const c of C_FACTS.criteria) {
      for (const run of c.runs) expect(input).not.toContain(run.runId);
    }
    expect(input).not.toMatch(/배점|점수|lostPoints|maxPoints/);
  });

  it("격리 검사: 입력 생성 파일은 점수·이력서·맥락 연결을, 단계 파일은 이력서·GitHub를 읽지 않는다", async () => {
    expect(await checkInterviewKitIsolation()).toEqual([]);
    const source = [
      "const t = context.resumeText;",
      "const g = row.githubSources;",
      "const links = await listContextLinks(db, id);",
      "const p = row.earnedPoints;",
    ].join("\n");
    const stageRules = findIsolationViolations(source, "x.ts", { score: false, resume: true });
    expect(stageRules.map((v) => `${v.line}:${v.rule}`)).toEqual([
      "1:RESUME_IDENTIFIER",
      "2:RESUME_IDENTIFIER",
    ]);
    const inputRules = findIsolationViolations(source, "x.ts", {
      resume: true,
      contextLinks: true,
    });
    expect(inputRules.map((v) => `${v.line}:${v.rule}`)).toEqual([
      "1:RESUME_IDENTIFIER",
      "2:RESUME_IDENTIFIER",
      "3:RESUME_IDENTIFIER",
      "4:SCORE_IDENTIFIER",
    ]);
  });
});
