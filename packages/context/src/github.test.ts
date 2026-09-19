import { GitHubSourcesSchema, type GitHubSources } from "@ohmyti/core";
import {
  createTestDatabase,
  getSubmissionContext,
  seedEvaluation,
  setResumeText,
  upsertSubmissionContext,
  type TestDatabase,
} from "@ohmyti/db";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectGitHubSources,
  GITHUB_PROFILE_LIMITS,
  loadGitHubProfileConfig,
  matchKeywords,
  profileRequestLimit,
  runGitHubSourcesCollection,
  tokenizeKeywords,
  type GitHubSourcesCollector,
} from "./github";
import {
  fakeGitHubProfileApi,
  fakeSha,
  rateLimitedResponse,
  type FakeProfile,
  type FakeProfileRepo,
} from "./testing/github";

const NOW = new Date("2026-09-19T00:00:00.000Z");
const RESUME = [
  "Backend Engineer",
  "Built an inventory reservation service with PostgreSQL transactions.",
  "Designed idempotent payment endpoints in TypeScript.",
  "재고 동시성 처리를 담당했습니다.",
].join("\n");

/** 인기도 지표 키. 저장 데이터 어디에도 있으면 안 된다 */
const POPULARITY_KEY = /stargazers|followers|forks|watchers/i;

function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) allKeys(item, out);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      allKeys(child, out);
    }
  }
  return out;
}

function repo(name: string, overrides: Partial<FakeProfileRepo> = {}): FakeProfileRepo {
  return {
    name,
    description: null,
    language: "TypeScript",
    topics: [],
    pushedAt: "2026-01-01T00:00:00Z",
    readme: `# ${name}\n`,
    languages: { TypeScript: 1000, JavaScript: 10 },
    files: [
      { name: "README.md", type: "file" },
      { name: "src", type: "dir" },
    ],
    commits: [{ sha: fakeSha(1), message: `init ${name}`, date: "2026-01-01T00:00:00Z" }],
    pulls: [{ number: 1, title: `feat: ${name}`, mergedAt: "2026-01-02T00:00:00Z" }],
    ...overrides,
  };
}

/** 이력서와 겹치는 저장소 5개 + 관련 없는 저장소 + 포크 */
function devProfile(): FakeProfile {
  return {
    login: "dev-kim",
    repos: [
      repo("inventory-service", {
        description: "Inventory reservation with PostgreSQL transactions",
        topics: ["inventory", "postgresql"],
        pushedAt: "2026-03-01T00:00:00Z",
      }),
      repo("payment-idempotency", {
        description: "Idempotent payment endpoints",
        pushedAt: "2026-05-01T00:00:00Z",
      }),
      repo("order-api", {
        description: "Order API with PostgreSQL in TypeScript",
        pushedAt: "2026-06-01T00:00:00Z",
      }),
      repo("typescript-notes", { pushedAt: "2026-07-01T00:00:00Z" }),
      repo("dotfiles", { language: "Shell", pushedAt: "2026-09-01T00:00:00Z" }),
      repo("postgres-backup", {
        description: "backup scripts",
        language: "Shell",
        pushedAt: "2026-08-01T00:00:00Z",
      }),
      repo("inventory-fork", {
        description: "Inventory reservation PostgreSQL transactions payment",
        fork: true,
        pushedAt: "2026-09-10T00:00:00Z",
      }),
    ],
  };
}

describe("키워드 (github)", () => {
  it("kebab·snake를 나누고 불용어·짧은 토큰·숫자만 있는 토큰을 뺀다. camelCase는 나누지 않는다", () => {
    expect(
      [...tokenizeKeywords("PostgreSQL inventory-service the a 2024 C++ node_js")].sort(),
    ).toEqual(["c++", "inventory", "js", "node", "postgresql", "service"].sort());
  });

  it("한글 저장소 토큰은 조사가 붙은 키워드와도 겹친다", () => {
    const keywords = tokenizeKeywords("재고를 관리했습니다");
    expect(matchKeywords(tokenizeKeywords("재고 관리"), keywords)).toEqual(["관리", "재고"]);
    expect(matchKeywords(tokenizeKeywords("주문"), keywords)).toEqual([]);
  });
});

describe("collectGitHubSources (github)", () => {
  it("관련 저장소를 최대 3개만 겹침 점수 → 최근 push 순으로 고르고 포크는 뺀다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const sources = await collectGitHubSources(
      { login: "dev-kim", resumeText: RESUME },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(GitHubSourcesSchema.safeParse(sources).success).toBe(true);
    expect(sources.status).toBe("COLLECTED");
    expect(sources.reason).toBeNull();
    expect(sources.selection).toBe("KEYWORD_OVERLAP");
    expect(sources.candidateCount).toBe(6);
    expect(sources.repos.length).toBeLessThanOrEqual(3);
    expect(sources.repos.map((r) => r.fullName)).toEqual([
      "dev-kim/inventory-service",
      "dev-kim/payment-idempotency",
      "dev-kim/order-api",
    ]);
    const [first] = sources.repos;
    expect(first!.matchedKeywords).toEqual(
      ["inventory", "postgresql", "reservation", "service", "transactions", "typescript"].sort(),
    );
    expect(first!.relevanceScore).toBe(first!.matchedKeywords.length);
    expect(sources.repos.map((r) => r.fullName)).not.toContain("dev-kim/inventory-fork");
    expect(sources.repos.map((r) => r.fullName)).not.toContain("dev-kim/dotfiles");
  });

  it("저장소별로 README·언어·최상위 파일·커밋·병합 PR을 수집한다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const sources = await collectGitHubSources(
      { login: "dev-kim", resumeText: RESUME },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.repos[0]).toMatchObject({
      url: "https://github.com/dev-kim/inventory-service",
      readme: "# inventory-service\n",
      readmeTruncated: false,
      languages: [
        { name: "TypeScript", bytes: 1000 },
        { name: "JavaScript", bytes: 10 },
      ],
      topLevelFiles: [
        { name: "README.md", type: "file" },
        { name: "src", type: "dir" },
      ],
      commits: [
        {
          sha: fakeSha(1),
          message: "init inventory-service",
          committedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      mergedPulls: [
        { number: 1, title: "feat: inventory-service", mergedAt: "2026-01-02T00:00:00.000Z" },
      ],
      missing: [],
    });
    // 커밋·PR은 해당 사용자의 것만 요청한다
    expect(api.requests).toContain(
      "/repos/dev-kim/inventory-service/commits?author=dev-kim&per_page=20",
    );
    expect(
      api.requests.some(
        (r) =>
          r.startsWith("/search/issues?q=") &&
          decodeURIComponent(r).includes(
            "repo:dev-kim/inventory-service is:pr is:merged author:dev-kim",
          ),
      ),
    ).toBe(true);
  });

  it("저장 데이터에 stargazers·followers·forks 키가 없다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const sources = await collectGitHubSources(
      { login: "dev-kim", resumeText: RESUME },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.repos.length).toBeGreaterThan(0);
    const keys = allKeys(JSON.parse(JSON.stringify(sources)));
    expect(keys.filter((k) => POPULARITY_KEY.test(k))).toEqual([]);
    // 스키마도 모르는 키를 거절한다
    expect(
      GitHubSourcesSchema.safeParse({
        ...sources,
        repos: [{ ...sources.repos[0], stargazersCount: 1 }],
      }).success,
    ).toBe(false);
    expect(GitHubSourcesSchema.safeParse({ ...sources, followers: 1 }).success).toBe(false);
  });

  it("API 요청 수가 문서화된 상한(1 + 5 × 저장소 수) 이하다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const sources = await collectGitHubSources(
      { login: "dev-kim", resumeText: RESUME },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(profileRequestLimit(3)).toBe(16);
    expect(sources.requestLimit).toBe(16);
    expect(api.requests.length).toBe(sources.requestCount);
    expect(api.requests.length).toBeLessThanOrEqual(
      profileRequestLimit(GITHUB_PROFILE_LIMITS.maxRepos),
    );
    expect(api.requests.length).toBe(16);
  });

  it("속성: 저장소 수·상한·실패 위치가 어떻든 요청 수는 상한을 넘지 않고 저장소는 maxRepos 이하다", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 15 }),
        fc.integer({ min: 1, max: 10 }),
        fc.option(fc.integer({ min: 0, max: 60 }), { nil: undefined }),
        fc.boolean(),
        async (repoCount, maxRepos, failAt, rateLimit) => {
          const profile: FakeProfile = {
            login: "prop",
            repos: Array.from({ length: repoCount }, (_, i) =>
              repo(`inventory-${i}`, {
                pushedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
              }),
            ),
          };
          let n = 0;
          const api = fakeGitHubProfileApi([profile], () => {
            n += 1;
            if (failAt !== undefined && n === failAt + 1) {
              return rateLimit ? rateLimitedResponse() : new Response("boom", { status: 502 });
            }
            return undefined;
          });
          const sources = await collectGitHubSources(
            { login: "prop", resumeText: "inventory" },
            { fetch: api.fetch, maxRepos, now: () => NOW },
          );
          expect(GitHubSourcesSchema.safeParse(sources).success).toBe(true);
          expect(api.requests.length).toBeLessThanOrEqual(profileRequestLimit(maxRepos));
          expect(sources.requestCount).toBe(api.requests.length);
          expect(sources.repos.length).toBeLessThanOrEqual(maxRepos);
        },
      ),
      { numRuns: 60, seed: 502 },
    );
  });

  it("maxRepos를 줄이면 그 수만큼만 고르고 요청도 줄어든다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const sources = await collectGitHubSources(
      { login: "dev-kim", resumeText: RESUME },
      { fetch: api.fetch, maxRepos: 1, now: () => NOW },
    );
    expect(sources.repos.map((r) => r.fullName)).toEqual(["dev-kim/inventory-service"]);
    expect(api.requests.length).toBe(6);
  });

  it("없는 프로필은 NO_DATA + PROFILE_NOT_FOUND이고 요청은 1회다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const sources = await collectGitHubSources(
      { login: "ghost-user", resumeText: RESUME },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources).toMatchObject({
      status: "NO_DATA",
      login: "ghost-user",
      repos: [],
      requestCount: 1,
    });
    expect(sources.reason).toMatch(/^PROFILE_NOT_FOUND: /);
  });

  it("목록 조회가 속도 제한이면 NO_DATA + RATE_LIMITED이고 더 요청하지 않는다", async () => {
    const api = fakeGitHubProfileApi([devProfile()], () => rateLimitedResponse());
    const sources = await collectGitHubSources(
      { login: "dev-kim", resumeText: RESUME },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.status).toBe("NO_DATA");
    expect(sources.reason).toMatch(/^RATE_LIMITED: /);
    expect(api.requests.length).toBe(1);
  });

  it("429도 속도 제한으로 본다", async () => {
    const api = fakeGitHubProfileApi([devProfile()], () => new Response("", { status: 429 }));
    const sources = await collectGitHubSources(
      { login: "dev-kim" },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.reason).toMatch(/^RATE_LIMITED: /);
  });

  it("네트워크 오류·5xx는 NO_DATA + GITHUB_UNAVAILABLE이다", async () => {
    const down = await collectGitHubSources(
      { login: "dev-kim" },
      {
        fetch: () => Promise.reject(new TypeError("fetch failed")),
        now: () => NOW,
      },
    );
    expect(down.status).toBe("NO_DATA");
    expect(down.reason).toMatch(
      /^GITHUB_UNAVAILABLE: .*UNAVAILABLE: GitHub 요청 실패 \(TypeError\)/,
    );

    const api = fakeGitHubProfileApi([devProfile()], () => new Response("", { status: 503 }));
    const unavailable = await collectGitHubSources(
      { login: "dev-kim" },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(unavailable.reason).toMatch(/^GITHUB_UNAVAILABLE: /);
  });

  it("저장소 수집 중 속도 제한을 받으면 PARTIAL이고 그 뒤로는 요청하지 않는다", async () => {
    const api = fakeGitHubProfileApi([devProfile()], (path) =>
      path.startsWith("/search/issues") ? rateLimitedResponse() : undefined,
    );
    const sources = await collectGitHubSources(
      { login: "dev-kim", resumeText: RESUME },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.status).toBe("PARTIAL");
    expect(sources.reason).toMatch(/^RATE_LIMITED: /);
    // 목록 1 + 첫 저장소 5 (마지막이 검색). 이후 저장소는 요청 없이 모두 missing
    expect(api.requests.length).toBe(6);
    expect(sources.repos).toHaveLength(3);
    expect(sources.repos[0]!.readme).toBe("# inventory-service\n");
    expect(sources.repos[0]!.missing).toEqual([
      { part: "mergedPulls", reason: expect.stringMatching(/^RATE_LIMITED: /) as string },
    ]);
    expect(sources.repos[2]!.missing.map((m) => m.part)).toEqual([
      "readme",
      "languages",
      "topLevelFiles",
      "commits",
      "mergedPulls",
    ]);
  });

  it("프로필 입력이 없으면 요청 없이 NO_DATA + NO_PROFILE이다", async () => {
    const api = fakeGitHubProfileApi([]);
    const sources = await collectGitHubSources(
      { login: null },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources).toMatchObject({ status: "NO_DATA", login: null, requestCount: 0 });
    expect(sources.reason).toMatch(/^NO_PROFILE: /);
    expect(api.requests).toEqual([]);
  });

  it("로그인 형식이 틀리면 요청하지 않는다", async () => {
    const api = fakeGitHubProfileApi([]);
    const sources = await collectGitHubSources(
      { login: "../etc" },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.reason).toMatch(/^PROFILE_NOT_FOUND: /);
    expect(api.requests).toEqual([]);
  });

  it("이력서·JD 키워드가 없으면 최근 push 순으로 고른다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const sources = await collectGitHubSources(
      { login: "dev-kim" },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.selection).toBe("RECENT_PUSH");
    expect(sources.repos.map((r) => r.fullName)).toEqual([
      "dev-kim/dotfiles",
      "dev-kim/postgres-backup",
      "dev-kim/typescript-notes",
    ]);
    expect(sources.repos.every((r) => r.relevanceScore === 0)).toBe(true);
  });

  it("JD 텍스트도 키워드로 쓴다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const sources = await collectGitHubSources(
      { login: "dev-kim", jdText: "backup automation in Shell" },
      { fetch: api.fetch, maxRepos: 1, now: () => NOW },
    );
    expect(sources.repos.map((r) => r.fullName)).toEqual(["dev-kim/postgres-backup"]);
  });

  it("키워드와 겹치는 저장소가 없으면 억지로 고르지 않고 NO_DATA + NO_RELATED_REPOS다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const sources = await collectGitHubSources(
      { login: "dev-kim", resumeText: "Android Kotlin Jetpack Compose" },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources).toMatchObject({
      status: "NO_DATA",
      repos: [],
      candidateCount: 6,
      requestCount: 1,
    });
    expect(sources.reason).toMatch(/^NO_RELATED_REPOS: /);
  });

  it("포크·비공개만 있으면 NO_DATA + NO_PUBLIC_REPOS다", async () => {
    const api = fakeGitHubProfileApi([
      { login: "forker", repos: [repo("a", { fork: true }), repo("b", { private: true })] },
    ]);
    const sources = await collectGitHubSources(
      { login: "forker" },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.reason).toMatch(/^NO_PUBLIC_REPOS: /);
  });

  it("README는 앞 4 KiB만 읽고 잘린 UTF-8 조각을 버리며 이메일을 가린다", async () => {
    const body = `contact: dev@example.com\n${"가".repeat(3000)}`;
    const api = fakeGitHubProfileApi([
      { login: "writer", repos: [repo("inventory", { readme: new TextEncoder().encode(body) })] },
    ]);
    const sources = await collectGitHubSources(
      { login: "writer", resumeText: "inventory" },
      { fetch: api.fetch, now: () => NOW },
    );
    const readme = sources.repos[0]!.readme!;
    expect(sources.repos[0]!.readmeTruncated).toBe(true);
    expect(readme).not.toContain("dev@example.com");
    expect(readme).not.toContain("�");
    expect(new TextEncoder().encode(readme).byteLength).toBeLessThanOrEqual(4096);
    expect(readme.endsWith("가")).toBe(true);
  });

  it("README가 없거나 빈 저장소면 빈 값이고 수집 실패로 보지 않는다", async () => {
    const api = fakeGitHubProfileApi([
      {
        login: "empty",
        repos: [
          repo("inventory", { readme: null, commits: undefined, files: undefined, pulls: [] }),
        ],
      },
    ]);
    const sources = await collectGitHubSources(
      { login: "empty", resumeText: "inventory" },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.status).toBe("COLLECTED");
    expect(sources.repos[0]).toMatchObject({
      readme: null,
      commits: [],
      topLevelFiles: [],
      mergedPulls: [],
      missing: [],
    });
  });

  it("커밋 메시지는 500자로 자르고 토큰을 가린다", async () => {
    const api = fakeGitHubProfileApi([
      {
        login: "committer",
        repos: [
          repo("inventory", {
            commits: [
              {
                sha: fakeSha(7),
                message: `fix: rotate ghp_${"a".repeat(36)}\n\n${"x".repeat(1000)}`,
                date: "2026-02-01T00:00:00Z",
              },
            ],
          }),
        ],
      },
    ]);
    const sources = await collectGitHubSources(
      { login: "committer", resumeText: "inventory" },
      { fetch: api.fetch, now: () => NOW },
    );
    const message = sources.repos[0]!.commits[0]!.message;
    expect(message.length).toBeLessThanOrEqual(500);
    expect(message).not.toContain(`ghp_${"a".repeat(36)}`);
  });
});

describe("loadGitHubProfileConfig (github)", () => {
  it("기본 3, 1~10 정수만 받는다", () => {
    expect(loadGitHubProfileConfig({})).toEqual({ maxRepos: 3, token: undefined });
    expect(loadGitHubProfileConfig({ MAX_PROFILE_REPOS: "2", GITHUB_TOKEN: " t " })).toEqual({
      maxRepos: 2,
      token: "t",
    });
    for (const bad of ["0", "11", "2.5", "abc"]) {
      expect(() => loadGitHubProfileConfig({ MAX_PROFILE_REPOS: bad })).toThrow(
        /MAX_PROFILE_REPOS/,
      );
    }
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

describe.skipIf(!hasTestDb)("runGitHubSourcesCollection (github, DB 통합)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  });

  afterAll(async () => {
    await tdb?.destroy();
  });

  function collectorFor(api: ReturnType<typeof fakeGitHubProfileApi>): GitHubSourcesCollector {
    return (input) => collectGitHubSources(input, { fetch: api.fetch, now: () => NOW });
  }

  async function submission(
    login: string | null,
    resumeText: string | null = null,
  ): Promise<string> {
    const { submissionId } = await seedEvaluation(tdb.db);
    await upsertSubmissionContext(tdb.db, submissionId, { githubLogin: login });
    if (resumeText) {
      await setResumeText(tdb.db, submissionId, {
        status: "EXTRACTED",
        text: resumeText,
        reason: null,
      });
    }
    return submissionId;
  }

  it("이력서 키워드로 고른 저장소를 github_sources에 저장하고 인기도 키가 없다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const submissionId = await submission("dev-kim", RESUME);
    const summary = await runGitHubSourcesCollection(
      { db: tdb.db, collect: collectorFor(api) },
      submissionId,
    );
    expect(summary).toEqual({
      status: "COLLECTED",
      action: "COLLECTED",
      reason: null,
      repos: ["dev-kim/inventory-service", "dev-kim/payment-idempotency", "dev-kim/order-api"],
      requestCount: 16,
    });
    const stored = (await getSubmissionContext(tdb.db, submissionId))!
      .githubSources as GitHubSources;
    expect(GitHubSourcesSchema.parse(stored).repos).toHaveLength(3);
    expect(allKeys(stored).filter((k) => POPULARITY_KEY.test(k))).toEqual([]);
    // 요약에는 README·이력서 본문이 없다
    expect(JSON.stringify(summary)).not.toContain("inventory-service\n");
    expect(JSON.stringify(summary)).not.toContain("Backend Engineer");
  });

  it("접근 불가 프로필은 NO_DATA와 사유로 기록되고 던지지 않는다", async () => {
    const api = fakeGitHubProfileApi([]);
    const submissionId = await submission("ghost-user");
    const summary = await runGitHubSourcesCollection(
      { db: tdb.db, collect: collectorFor(api) },
      submissionId,
    );
    expect(summary).toMatchObject({ status: "NO_DATA", action: "NO_DATA", repos: [] });
    const stored = (await getSubmissionContext(tdb.db, submissionId))!
      .githubSources as GitHubSources;
    expect(stored.status).toBe("NO_DATA");
    expect(stored.reason).toMatch(/^PROFILE_NOT_FOUND: /);
  });

  it("프로필 입력이 없어도 NO_DATA + NO_PROFILE로 기록한다", async () => {
    const api = fakeGitHubProfileApi([]);
    const submissionId = await submission(null);
    const summary = await runGitHubSourcesCollection(
      { db: tdb.db, collect: collectorFor(api) },
      submissionId,
    );
    expect(summary.reason).toMatch(/^NO_PROFILE: /);
    expect(api.requests).toEqual([]);
  });

  it("이미 기록이 있으면 다시 조회하지 않는다 (재시도 멱등)", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const submissionId = await submission("dev-kim", RESUME);
    await runGitHubSourcesCollection({ db: tdb.db, collect: collectorFor(api) }, submissionId);
    const before = api.requests.length;
    const again = await runGitHubSourcesCollection(
      { db: tdb.db, collect: collectorFor(api) },
      submissionId,
    );
    expect(again.action).toBe("KEPT");
    expect(api.requests.length).toBe(before);
  });

  it("속도 제한으로 끝난 NO_DATA는 다음 시도에서 다시 조회한다", async () => {
    let limited = true;
    const api = fakeGitHubProfileApi([devProfile()], () =>
      limited ? rateLimitedResponse() : undefined,
    );
    const submissionId = await submission("dev-kim", RESUME);
    const first = await runGitHubSourcesCollection(
      { db: tdb.db, collect: collectorFor(api) },
      submissionId,
    );
    expect(first.reason).toMatch(/^RATE_LIMITED: /);
    limited = false;
    const second = await runGitHubSourcesCollection(
      { db: tdb.db, collect: collectorFor(api) },
      submissionId,
    );
    expect(second.action).toBe("COLLECTED");
  });

  it("수집기가 예상 밖으로 던져도 NO_DATA로 기록하고 던지지 않는다", async () => {
    const submissionId = await submission("dev-kim");
    const summary = await runGitHubSourcesCollection(
      {
        db: tdb.db,
        collect: () => Promise.reject(new RangeError("bug")),
        now: () => NOW,
      },
      submissionId,
    );
    expect(summary.status).toBe("NO_DATA");
    expect(summary.reason).toMatch(/^GITHUB_UNAVAILABLE: .*RangeError/);
  });
});
