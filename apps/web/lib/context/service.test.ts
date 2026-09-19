import { randomUUID } from "node:crypto";
import {
  CONTEXT_DEFAULT_QUESTION,
  EvaluationContextReportResponseSchema,
  type GitHubSources,
} from "@ohmyti/core";
import {
  createTestDatabase,
  replaceContextLinks,
  seedEvaluation,
  setGitHubSources,
  setResumeText,
  type TestDatabase,
} from "@ohmyti/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEvaluationContextReport } from "./service";

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/web] DATABASE_URL_TEST가 없어 맥락 조회 통합 테스트를 건너뜁니다");
}

const SOURCES: GitHubSources = {
  status: "COLLECTED",
  reason: null,
  login: "acme",
  collectedAt: "2026-09-20T00:00:00.000Z",
  selection: "RESUME_LINK",
  candidateCount: 2,
  candidateListTruncated: false,
  excludedRepos: ["acme/order-api"],
  repos: [
    {
      fullName: "acme/board-api",
      url: "https://github.com/acme/board-api",
      description: "게시판 REST API",
      language: "TypeScript",
      topics: [],
      pushedAt: null,
      matchedKeywords: ["board"],
      relevanceScore: 1,
      readme: null,
      readmeTruncated: false,
      languages: [],
      topLevelFiles: [],
      authorFilter: "NONE",
      commits: [
        {
          sha: "0123456789abcdef0123456789abcdef01234567",
          message: "init",
          committedAt: null,
        },
      ],
      mergedPulls: [],
      missing: [],
    },
  ],
  requestCount: 6,
  requestLimit: 16,
};

describe.skipIf(!hasTestDb)("readEvaluationContextReport (T-606 조회 API)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
  });

  it("이 평가의 맥락 연결과 GitHub 근거를 응답 스키마로 돌려주고 이력서 본문은 넣지 않는다", async () => {
    const seeded = await seedEvaluation(tdb.db, `web-t606-${Date.now()}`);
    await setResumeText(tdb.db, seeded.submissionId, {
      text: "이력서 본문 비밀 문장",
      status: "EXTRACTED",
      reason: null,
    });
    await setGitHubSources(tdb.db, seeded.submissionId, SOURCES);
    await replaceContextLinks(tdb.db, {
      submissionId: seeded.submissionId,
      evaluationId: seeded.evaluationId,
      links: [
        {
          claimSource: "RESUME",
          claim: "클린 아키텍처와 TDD를 적용했다",
          status: "NEEDS_CHECK",
          followUpQuestion: "경계 조건을 어떤 기준으로 테스트했나요?",
        },
        // 맥락 연결 v3(T-703): 질문 구조 열이 있는 연결
        {
          claimSource: "RESUME",
          claim: "주문 API의 멱등성 키를 설계했다",
          status: "NEEDS_CHECK",
          followUpQuestion: CONTEXT_DEFAULT_QUESTION.question,
          question: CONTEXT_DEFAULT_QUESTION,
        },
      ],
    });

    const result = await readEvaluationContextReport({ db: tdb.db }, seeded.evaluationId);
    expect(EvaluationContextReportResponseSchema.safeParse(result).success).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.evaluationId).toBe(seeded.evaluationId);
    expect(result.data.submissionId).toBe(seeded.submissionId);
    expect(result.data.links.map((l) => [l.claim, l.followUpQuestion])).toEqual([
      ["클린 아키텍처와 TDD를 적용했다", "경계 조건을 어떤 기준으로 테스트했나요?"],
      ["주문 API의 멱등성 키를 설계했다", CONTEXT_DEFAULT_QUESTION.question],
    ]);
    // v2 연결(질문 구조 열 null)은 질문 구조 없이 그대로 읽고, v3 연결은 질문 구조를 함께 돌려준다
    expect(result.data.links[0]).not.toHaveProperty("question");
    expect(result.data.links[1]!.question).toEqual(CONTEXT_DEFAULT_QUESTION);
    expect(result.data.github.sources?.repos.map((r) => r.fullName)).toEqual(["acme/board-api"]);
    expect(result.data.resume).toEqual({ uploaded: false, textStatus: "EXTRACTED", reason: null });
    expect(JSON.stringify(result)).not.toContain("이력서 본문 비밀 문장");
  });

  it("없는 평가는 EVALUATION_NOT_FOUND, 형식이 틀린 ID는 INVALID_INPUT이다", async () => {
    const missing = await readEvaluationContextReport({ db: tdb.db }, randomUUID());
    expect(missing).toMatchObject({ ok: false, code: "EVALUATION_NOT_FOUND" });
    const invalid = await readEvaluationContextReport({ db: tdb.db }, "not-a-uuid");
    expect(invalid).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });
});
