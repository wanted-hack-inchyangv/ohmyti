import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATRIX,
  comparePersona,
  forbiddenRepos,
  parseExistingSubmissions,
  PersonaMatrixSchema,
  STAGES,
  type PersonaFacts,
  type PersonaMatrix,
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

/** 기대값을 그대로 만족하는 관측값 */
function factsMatching(matrix: PersonaMatrix, handle: string): PersonaFacts {
  const p = matrix.personas[handle]!;
  return {
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
  };
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
