import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATRIX,
  comparePersona,
  countPdfPages,
  forbiddenRepos,
  parseExistingSubmissions,
  PersonaMatrixSchema,
  STAGES,
  type KitFacts,
  type KitQuestionFacts,
  type PersonaFacts,
  type PersonaMatrix,
  type ReportFacts,
} from "./gate-personas";

const MAX_POINTS = new Map<string, number>([
  ["R-01", 8],
  ["R-02", 6],
  ["R-03", 7],
  ["R-04", 6],
  ["R-05", 14],
  ["R-06", 6],
  ["R-07", 6],
  ["R-08", 6],
  ["R-09", 6],
  ["R-10", 6],
  ["R-11", 4],
  ["G1", 5],
  ["G2", 5],
  ["G3", 5],
  ["R-12", 10],
]);

async function loadMatrix(): Promise<PersonaMatrix> {
  return PersonaMatrixSchema.parse(JSON.parse(await readFile(DEFAULT_MATRIX, "utf8")));
}

/** 기대 키트를 그대로 만족하는 질문 목록 (기대에 없는 슬롯은 선택 질문으로 채운다) */
function kitFactsMatching(matrix: PersonaMatrix, handle: string): KitFacts {
  const expected = matrix.personas[handle]!.kit;
  const questions: KitQuestionFacts[] = [];
  for (const [kind, expectedCount] of Object.entries(expected.kindCounts)) {
    const count = typeof expectedCount === "number" ? expectedCount : expectedCount.max;
    const wanted = expected.questions.filter((q) => q.kind === kind);
    for (let i = 0; i < count; i += 1) {
      const want = wanted[i];
      questions.push({
        id: want?.id ?? `${kind}:filler-${i + 1}`,
        number: questions.length + 1,
        kind,
        competency: "DESIGN",
        priority: want?.priority ?? "OPTIONAL",
        minutes: 6,
        question: "그 동작을 어떻게 확인했는지 설명해 주시겠어요?",
        intent: `${want?.anyOf?.[0] ?? "관측"} 근거를 본인 말로 설명할 수 있는지 본다`,
        probes: ["무엇을 먼저 확인했나요?", "다른 방법은 무엇이 있었나요?"],
        positiveSignals: ["재현 절차를 말한다", "관측과 원인을 나눈다"],
        concernSignals: ["추측으로 답한다", "근거를 말하지 못한다"],
        refs: ["기준 R-05"],
        refKinds: kind === "RESUME_BRIDGE" ? ["CONTEXT_LINK", "CRITERION"] : ["CRITERION"],
        source: "LLM",
        lint: [],
      });
    }
  }
  return {
    slotCount: questions.length,
    templateCount: 0,
    llm: "OK",
    llmReason: null,
    promptVersion: "interview-kit-v1",
    model: "deepseek-chat",
    inputDigest: "b".repeat(64),
    dropped: [],
    plans: [
      { durationMinutes: 45, totalMinutes: 40, questionCount: 4 },
      { durationMinutes: 60, totalMinutes: 58, questionCount: 6 },
    ],
    questions,
  };
}

function reportFactsMatching(facts: PersonaFacts): ReportFacts {
  return {
    scoreDisplay: facts.scoreDisplay,
    verdictCounts: { PASS: 10, FAIL: 2, PARTIAL: 0, INCONCLUSIVE: 1 },
    criteria: { ...facts.criteria },
    mustQuestions: (facts.kit?.questions ?? [])
      .filter((q) => q.priority === "MUST")
      .map((q) => ({ number: q.number, question: q.question, source: q.source })),
    interviewGuideStatus: "AVAILABLE",
    resumeLinksStatus: "AVAILABLE",
    resumeLinkCount: 3,
    designReviewStatus: "AVAILABLE",
    forbidden: [],
  };
}

/** 기대값을 그대로 만족하는 관측값 */
function factsMatching(matrix: PersonaMatrix, handle: string): PersonaFacts {
  const p = matrix.personas[handle]!;
  const facts: PersonaFacts = {
    criteria: Object.fromEntries(
      Object.entries(p.criteria).map(([id, verdict]) => [
        id,
        {
          verdict,
          earnedPoints: verdict === "PASS" ? MAX_POINTS.get(id)! : verdict === "FAIL" ? 0 : null,
        },
      ]),
    ),
    mutations: Object.fromEntries(
      Object.entries(p.mutations).map(([id, outcome]) => [id, { outcome, reason: null }]),
    ),
    scoreDisplay: p.scoreDisplay,
    stages: Object.fromEntries(STAGES.map((s) => [s, "DONE"])),
    reviewWrite: {
      llm: "OK",
      reason: null,
      r12Draft: { suggestedPoints: 4, maxPoints: 10, rationale: "계층 분리 근거가 약하다" },
    },
    github: {
      status: "COLLECTED",
      selection: "RESUME_LINK",
      repos: p.portfolio.map((name) => ({
        fullName: `${matrix.organization}/${name}`,
        commits: 3,
        mergedPulls: 0,
        authorFilter: "NONE",
      })),
      excludedRepos: [],
    },
    links: [
      ...p.claims.map((c) => ({
        claim: `주장: ${c.anyOf[0]}`,
        status: c.status,
        followUpQuestion: null,
        criterionId: null,
      })),
      ...p.followUpClaims.map((c) => ({
        claim: `주장: ${c.anyOf[0]}`,
        status: "NEEDS_CHECK",
        followUpQuestion: "어떻게 확인했나요?",
        criterionId: "R-05",
      })),
    ],
    kit: null,
    report: null,
  };
  facts.kit = kitFactsMatching(matrix, handle);
  facts.report = reportFactsMatching(facts);
  return facts;
}

describe("gate:personas 기대값 (T-606)", () => {
  it("페르소나 4종의 기대 판정 점수 합이 점수 표시와 맞는다", async () => {
    const matrix = await loadMatrix();
    expect(Object.keys(matrix.personas).sort()).toEqual(["dohyun", "gaeun", "seojin", "taeyun"]);
    for (const p of Object.values(matrix.personas)) {
      let earned = 0;
      let pending = 0;
      for (const [id, verdict] of Object.entries(p.criteria)) {
        if (verdict === "PASS") earned += MAX_POINTS.get(id)!;
        if (verdict === "INCONCLUSIVE") pending += MAX_POINTS.get(id)!;
      }
      expect(p.scoreDisplay).toBe(`${earned}~${earned + pending}/100 · ${pending}점 검토 대기`);
      expect(Object.keys(p.criteria).sort()).toEqual([...MAX_POINTS.keys()].sort());
    }
  });

  it("선택되면 안 되는 저장소는 본인 제출 저장소(옛 이름 포함)와 다른 페르소나의 저장소다", async () => {
    const matrix = await loadMatrix();
    const forbidden = forbiddenRepos(matrix, "dohyun");
    expect(forbidden).toContain("wanted-hack-inchyangv/dohyun-order-api");
    expect(forbidden).toContain("wanted-hack-inchyangv/gaeun-bookmark-api");
    expect(forbidden).toContain("wanted-hack-inchyangv/order-api-seojin");
    expect(forbidden).not.toContain("wanted-hack-inchyangv/dohyun-board-api");
    expect(forbidden).not.toContain("wanted-hack-inchyangv/dohyun-report-batch");
    // 제출 4 + 옛 이름 3 + 다른 페르소나 포트폴리오 6
    expect(forbidden).toHaveLength(13);
  });
});

describe("comparePersona", () => {
  it("기대값과 같은 관측이면 불일치·경고가 없다", async () => {
    const matrix = await loadMatrix();
    for (const handle of Object.keys(matrix.personas)) {
      const result = comparePersona(matrix, handle, MAX_POINTS, factsMatching(matrix, handle));
      expect(result.mismatches, handle).toEqual([]);
      expect(result.warnings, handle).toEqual([]);
    }
  });

  it("실측 결함 세 가지(REVIEW_WRITE 미확정, 변이 미적용, 근거 교차 선택)를 불일치로 잡는다", async () => {
    const matrix = await loadMatrix();
    const gaeun = factsMatching(matrix, "gaeun");
    gaeun.reviewWrite = { llm: "INCONCLUSIVE", reason: "LLM 결과 미확정", r12Draft: null };
    gaeun.github.repos.push({
      fullName: "wanted-hack-inchyangv/seojin-order-api",
      commits: 0,
      mergedPulls: 0,
      authorFilter: null,
    });
    expect(comparePersona(matrix, "gaeun", MAX_POINTS, gaeun).mismatches).toEqual([
      "REVIEW_WRITE LLM 결과: 기대 OK, 실제 INCONCLUSIVE (LLM 결과 미확정)",
      "R-12 설계 초안 없음",
      "GitHub 근거에 선택되면 안 되는 저장소: wanted-hack-inchyangv/seojin-order-api",
    ]);

    const dohyun = factsMatching(matrix, "dohyun");
    dohyun.mutations["M-05"] = { outcome: "NOT_APPLICABLE", reason: "대상 로직 없음" };
    dohyun.criteria.G3 = { verdict: "INCONCLUSIVE", earnedPoints: null };
    dohyun.scoreDisplay = "75~90/100 · 15점 검토 대기";
    // 리포트는 같은 저장값을 옮기므로 워크벤치 값과 함께 바뀐다 (리포트 대조는 아래 T-708 테스트에서 본다)
    dohyun.report = {
      ...dohyun.report!,
      scoreDisplay: dohyun.scoreDisplay,
      criteria: dohyun.criteria,
    };
    expect(comparePersona(matrix, "dohyun", MAX_POINTS, dohyun).mismatches).toEqual([
      "G3: 기대 FAIL 0점, 실제 INCONCLUSIVE null점",
      "M-05: 기대 SURVIVED, 실제 NOT_APPLICABLE (대상 로직 없음)",
      "점수 표시: 기대 75~85/100 · 10점 검토 대기, 실제 75~90/100 · 15점 검토 대기",
    ]);
  });

  it("커밋 0개, 포트폴리오 누락, 후속 질문 없음은 불일치이고 주장 상태 라벨 차이는 경고다", async () => {
    const matrix = await loadMatrix();
    const taeyun = factsMatching(matrix, "taeyun");
    taeyun.github.repos = taeyun.github.repos.slice(0, 1).map((r) => ({ ...r, commits: 0 }));
    taeyun.links = taeyun.links.map((l) => ({
      ...l,
      followUpQuestion: null,
      status: l.claim.includes("CLI") ? "EVIDENCE_FOUND" : l.status,
    }));
    const result = comparePersona(matrix, "taeyun", MAX_POINTS, taeyun);
    expect(result.mismatches).toEqual([
      "GitHub 근거에 taeyun-til-cli이 없음",
      "GitHub 근거에 수집된 커밋 없음",
      '주장 "결제 웹훅 멱등 처리"에 후속 질문 없음',
    ]);
    expect(result.warnings).toEqual(["주장(CLI): 기대 NEEDS_CHECK, 실제 EVIDENCE_FOUND"]);
  });

  it("단계가 DONE이 아니거나 판정이 없으면 불일치다", async () => {
    const matrix = await loadMatrix();
    const seojin = factsMatching(matrix, "seojin");
    seojin.stages.CONTEXT_LINK = "FAILED";
    delete seojin.criteria["R-11"];
    expect(comparePersona(matrix, "seojin", MAX_POINTS, seojin).mismatches).toEqual([
      "R-11: 판정 없음 (기대 PASS)",
      "CONTEXT_LINK: 기대 DONE, 실제 FAILED",
    ]);
  });
});

describe("comparePersona · 인터뷰 키트와 채용 리포트 (T-708)", () => {
  it("키트가 없거나 질문 수·우선순위가 다르면 불일치다", async () => {
    const matrix = await loadMatrix();
    const taeyun = factsMatching(matrix, "taeyun");
    taeyun.kit = null;
    expect(comparePersona(matrix, "taeyun", MAX_POINTS, taeyun).mismatches).toContain(
      "인터뷰 키트를 읽지 못함",
    );

    const dohyun = factsMatching(matrix, "dohyun");
    const first = dohyun.kit!.questions[0]!;
    first.priority = first.priority === "MUST" ? "SHOULD" : "MUST";
    dohyun.kit!.questions = dohyun.kit!.questions.filter((q) => q.kind !== "EXTENSION");
    dohyun.kit!.slotCount = dohyun.kit!.questions.length;
    const result = comparePersona(matrix, "dohyun", MAX_POINTS, dohyun);
    expect(result.mismatches.some((m) => m.includes("EXTENSION 질문 수"))).toBe(true);
    expect(result.mismatches.some((m) => m.includes("우선순위"))).toBe(true);
  });

  it("질문 검사 위반·근거 없음·과제 비교 이력서 질문을 불일치로 잡고 기본 질문 대체는 경고다", async () => {
    const matrix = await loadMatrix();
    const gaeun = factsMatching(matrix, "gaeun");
    const kit = gaeun.kit!;
    kit.templateCount = 2;
    kit.questions[0]!.lint = ["question: MULTI_QUESTION"];
    kit.questions[0]!.refs = [];
    const bridge = kit.questions.find((q) => q.kind === "RESUME_BRIDGE")!;
    bridge.refKinds = ["CONTEXT_LINK"];
    bridge.question = "이번 과제와 비교하면 무엇이 달랐나요?";
    const result = comparePersona(matrix, "gaeun", MAX_POINTS, gaeun);
    expect(result.mismatches).toContain(`${kit.questions[0]!.id}: 근거 참조 없음`);
    expect(result.mismatches).toContain(
      `${kit.questions[0]!.id}: 질문 검사 위반 question: MULTI_QUESTION`,
    );
    expect(result.mismatches).toContain(
      `${bridge.id}: 관측 기준이 없는 이력서 연결 질문이 과제와 비교함`,
    );
    expect(result.warnings).toContain(`기본 질문(TEMPLATE) 대체 2/${kit.slotCount}`);
  });

  it("리포트의 판정·점수가 워크벤치와 다르거나 금지 표현이 있으면 불일치다", async () => {
    const matrix = await loadMatrix();
    const seojin = factsMatching(matrix, "seojin");
    seojin.report!.scoreDisplay = "100/100";
    seojin.report!.criteria["R-05"] = { verdict: "FAIL", earnedPoints: 0 };
    seojin.report!.forbidden = ["추천"];
    const mismatches = comparePersona(matrix, "seojin", MAX_POINTS, seojin).mismatches;
    expect(mismatches).toContain(
      `리포트 점수 표시: 워크벤치 ${seojin.scoreDisplay}, 리포트 100/100`,
    );
    expect(mismatches).toContain("리포트 R-05: 워크벤치 PASS 14점, 리포트 FAIL 0점");
    expect(mismatches).toContain("금지 표현 추천");
  });
});

describe("countPdfPages", () => {
  it("페이지 트리의 Count를 읽고 없으면 Page 객체를 센다", () => {
    expect(countPdfPages("<< /Type /Pages /Kids [1 0 R 2 0 R] /Count 3 >>")).toBe(3);
    expect(countPdfPages("<< /Type /Page >> << /Type /Page >>")).toBe(2);
  });
});

describe("parseExistingSubmissions", () => {
  it("페르소나=제출 ID 목록을 읽고 형식이 틀리면 null을 반환한다", () => {
    const id = "c419a77b-c6ee-4bb8-8c3a-8c7ccf6151d8";
    expect(parseExistingSubmissions("")).toEqual({});
    expect(parseExistingSubmissions(`dohyun=${id}, seojin=${id}`)).toEqual({
      dohyun: id,
      seojin: id,
    });
    expect(parseExistingSubmissions("dohyun")).toBeNull();
    expect(parseExistingSubmissions("dohyun=not-a-uuid")).toBeNull();
  });
});
