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
  genericKeywordPredicate,
  GITHUB_PROFILE_LIMITS,
  linkedRepoNames,
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
import {
  PERSONA_EXPECTED,
  PERSONA_HANDLES,
  PERSONA_ORG_LOGIN,
  PERSONA_ORG_REPOS,
  PERSONA_RESUME_TEXTS,
  personaOrgProfile,
} from "./testing/personas";

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
  it("관련 저장소를 최대 3개만 비범용 겹침 → 전체 겹침 → 최근 push 순으로 고르고 포크는 뺀다", async () => {
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
    // 범용이 아닌 토큰을 앞에 둔다 (T-603)
    expect(first!.matchedKeywords).toEqual([
      "inventory",
      "postgresql",
      "reservation",
      "transactions",
      "service",
      "typescript",
    ]);
    expect(first!.relevanceScore).toBe(first!.matchedKeywords.length);
    // typescript-notes는 범용 키워드(typescript)만 겹친다
    expect(sources.genericOnlyCount).toBe(1);
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

describe("근거 선정 보강: 제출 저장소 제외와 범용 키워드 (github, T-603)", () => {
  const ORG = `${PERSONA_ORG_LOGIN}/`;
  const personaRepos = (handle: string) =>
    PERSONA_ORG_REPOS.map((r) => ORG + r.name).filter((name) =>
      name.startsWith(`${ORG}${handle}-`),
    );
  /** 주소를 지운 이력서. 키워드 겹침 선정만 남는다 */
  const withoutLinks = (text: string) => text.replace(/github\.com\/\S+/g, "");

  it("fixture: 조직 저장소 14개, 이력서 4종", () => {
    expect(PERSONA_ORG_REPOS).toHaveLength(14);
    for (const repo of PERSONA_ORG_REPOS)
      expect(allKeys(repo).filter((k) => POPULARITY_KEY.test(k))).toEqual([]);
    for (const handle of PERSONA_HANDLES) {
      expect(PERSONA_RESUME_TEXTS[handle].length).toBeGreaterThan(500);
    }
  });

  it.each(PERSONA_HANDLES)(
    "%s: 본인의 포트폴리오 2개만 고른다. 제출 저장소와 다른 페르소나의 저장소는 없다",
    async (handle) => {
      const expected = PERSONA_EXPECTED[handle];
      const api = fakeGitHubProfileApi([personaOrgProfile()]);
      const sources = await collectGitHubSources(
        {
          login: PERSONA_ORG_LOGIN,
          resumeText: PERSONA_RESUME_TEXTS[handle],
          excludeRepos: [expected.submittedAs, expected.submissionRepo],
        },
        { fetch: api.fetch, now: () => NOW },
      );
      expect(GitHubSourcesSchema.safeParse(sources).success).toBe(true);
      expect(sources.status).toBe("COLLECTED");
      expect(sources.selection).toBe("RESUME_LINK");
      const selected = sources.repos.map((r) => r.fullName);
      expect([...selected].sort()).toEqual([...expected.portfolio].sort());
      expect(selected).not.toContain(expected.submissionRepo);
      for (const other of PERSONA_HANDLES.filter((h) => h !== handle)) {
        for (const name of personaRepos(other)) expect(selected).not.toContain(name);
      }
      expect(sources.excludedRepos).toEqual([expected.submissionRepo]);
      expect(sources.candidateCount).toBe(13);
      expect(api.requests.length).toBeLessThanOrEqual(profileRequestLimit(3));
      expect(allKeys(sources).filter((k) => POPULARITY_KEY.test(k))).toEqual([]);
      // 선정 사유는 범용이 아닌 토큰이 앞이다
      for (const repo of sources.repos) {
        expect(repo.matchedKeywords[0]).not.toMatch(/^(api|express|typescript|rest)$/);
      }
    },
  );

  it("제출 저장소 비교는 대소문자를 무시하고, 목록에 없는 이름은 기록하지 않는다", async () => {
    const api = fakeGitHubProfileApi([personaOrgProfile()]);
    const sources = await collectGitHubSources(
      {
        login: PERSONA_ORG_LOGIN,
        resumeText: withoutLinks(PERSONA_RESUME_TEXTS.seojin),
        excludeRepos: [
          "Wanted-Hack-Inchyangv/SEOJIN-Order-API",
          `${PERSONA_EXPECTED.seojin.submittedAs}`,
        ],
      },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.selection).toBe("KEYWORD_OVERLAP");
    expect(sources.excludedRepos).toEqual([PERSONA_EXPECTED.seojin.submissionRepo]);
    expect(sources.repos.map((r) => r.fullName)).not.toContain(
      PERSONA_EXPECTED.seojin.submissionRepo,
    );
  });

  it("제출 저장소를 넘기지 않으면 키워드 겹침으로 제출물이 다시 선택된다 (실측 결함 재현)", async () => {
    const api = fakeGitHubProfileApi([personaOrgProfile()]);
    const sources = await collectGitHubSources(
      { login: PERSONA_ORG_LOGIN, resumeText: withoutLinks(PERSONA_RESUME_TEXTS.seojin) },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.excludedRepos).toBeUndefined();
    expect(sources.repos.map((r) => r.fullName)).toContain(PERSONA_EXPECTED.seojin.submissionRepo);
  });

  it.each(["taeyun", "dohyun"] as const)(
    "%s: 주소가 없어도 범용 키워드만 겹친 gaeun-bookmark-api는 고르지 않고 그 수를 기록한다",
    async (handle) => {
      const api = fakeGitHubProfileApi([personaOrgProfile()]);
      const sources = await collectGitHubSources(
        {
          login: PERSONA_ORG_LOGIN,
          resumeText: withoutLinks(PERSONA_RESUME_TEXTS[handle]),
          excludeRepos: [PERSONA_EXPECTED[handle].submissionRepo],
        },
        { fetch: api.fetch, now: () => NOW },
      );
      expect(sources.selection).toBe("KEYWORD_OVERLAP");
      const selected = sources.repos.map((r) => r.fullName);
      expect(selected).not.toContain(`${ORG}gaeun-bookmark-api`);
      expect(selected.slice(0, 2).sort()).toEqual([...PERSONA_EXPECTED[handle].portfolio].sort());
      expect(sources.genericOnlyCount).toBeGreaterThanOrEqual(1);
      for (const repo of sources.repos) {
        expect(repo.matchedKeywords.some((k) => !genericKeywordPredicate([])(k))).toBe(true);
      }
    },
  );

  it("범용 키워드만 겹치면 억지로 고르지 않고 NO_DATA + NO_RELATED_REPOS이며 그 수를 기록한다", async () => {
    const api = fakeGitHubProfileApi([personaOrgProfile()]);
    const sources = await collectGitHubSources(
      { login: PERSONA_ORG_LOGIN, resumeText: "TypeScript Express REST API 백엔드 프로젝트 개발" },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.status).toBe("NO_DATA");
    expect(sources.reason).toMatch(/^NO_RELATED_REPOS: /);
    expect(sources.repos).toEqual([]);
    expect(sources.genericOnlyCount).toBeGreaterThanOrEqual(5);
    expect(api.requests).toHaveLength(1);
  });

  it("범용 판정: 목록, 조사가 붙은 목록 토큰, 후보 4개 이상에서 절반 이상에 나오는 토큰", () => {
    const three = [new Set(["a1", "shared"]), new Set(["shared"]), new Set(["b1"])];
    expect(genericKeywordPredicate(three)("shared")).toBe(false);
    const four = [...three, new Set(["c1"])];
    const isGeneric = genericKeywordPredicate(four);
    expect(isGeneric("shared")).toBe(true);
    expect(isGeneric("a1")).toBe(false);
    for (const token of [
      "api",
      "express",
      "typescript",
      "백엔드",
      "프로젝트",
      "express로",
      "crud와",
    ]) {
      expect(isGeneric(token)).toBe(true);
    }
    expect(isGeneric("재고")).toBe(false);
  });

  it("주소 인용: 같은 로그인의 저장소 이름만, 대소문자 무시, 끝의 .git·마침표를 뗀다", () => {
    const names = linkedRepoNames(
      [
        "github.com/Dev-Kim/Order-Service.git",
        "https://github.com/dev-kim/payments.",
        "github.com/other/elsewhere",
        "GitHub github.com/dev-kim",
      ].join("\n"),
      "dev-kim",
    );
    expect([...names].sort()).toEqual(["order-service", "payments"]);
  });

  it("주소로 가리킨 저장소가 목록에 없으면 키워드 겹침으로 고른다", async () => {
    const api = fakeGitHubProfileApi([devProfile()]);
    const sources = await collectGitHubSources(
      { login: "dev-kim", resumeText: `${RESUME}\ngithub.com/dev-kim/deleted-repo` },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.selection).toBe("KEYWORD_OVERLAP");
    expect(sources.repos.map((r) => r.fullName)).toContain("dev-kim/inventory-service");
  });
});

describe("조직 프로필의 커밋·PR 수집 (github, T-604)", () => {
  /** 사용자 프로필(devProfile)에서 T-604 이전과 같아야 하는 요청 순서 */
  const USER_REQUESTS = ["inventory-service", "payment-idempotency", "order-api"].flatMap(
    (name) => [
      `/repos/dev-kim/${name}/readme`,
      `/repos/dev-kim/${name}/languages`,
      `/repos/dev-kim/${name}/contents`,
      `/repos/dev-kim/${name}/commits?author=dev-kim&per_page=20`,
      `/search/issues?q=${encodeURIComponent(`repo:dev-kim/${name} is:pr is:merged author:dev-kim`)}&sort=updated&order=desc&per_page=10`,
    ],
  );

  it.each(PERSONA_HANDLES)(
    "%s: 조직 프로필이면 작성자 조건 없이 커밋·PR을 수집하고 authorFilter가 NONE이다",
    async (handle) => {
      const expected = PERSONA_EXPECTED[handle];
      const api = fakeGitHubProfileApi([personaOrgProfile()]);
      const sources = await collectGitHubSources(
        {
          login: PERSONA_ORG_LOGIN,
          resumeText: PERSONA_RESUME_TEXTS[handle],
          excludeRepos: [expected.submittedAs, expected.submissionRepo],
        },
        { fetch: api.fetch, now: () => NOW },
      );
      expect(GitHubSourcesSchema.safeParse(sources).success).toBe(true);
      expect(sources.status).toBe("COLLECTED");
      expect(sources.repos.length).toBeGreaterThan(0);
      for (const repo of sources.repos) {
        expect(repo.authorFilter).toBe("NONE");
        expect(repo.commits.length).toBeGreaterThanOrEqual(1);
        expect(repo.missing).toEqual([]);
      }
      // 저장소 목록 응답의 owner.type으로만 판별한다. 추가 요청이 없다
      expect(api.requests.length).toBe(1 + 5 * sources.repos.length);
      expect(api.requests.length).toBeLessThanOrEqual(profileRequestLimit(3));
      expect(sources.requestCount).toBe(api.requests.length);
      const commitRequests = api.requests.filter((r) => r.includes("/commits?"));
      expect(commitRequests).toHaveLength(sources.repos.length);
      for (const r of commitRequests) expect(r).toMatch(/\/commits\?per_page=20$/);
      const searches = api.requests
        .filter((r) => r.startsWith("/search/issues?"))
        .map((r) => new URL(r, "https://api.github.test").searchParams.get("q"));
      expect(searches).toEqual(sources.repos.map((r) => `repo:${r.fullName} is:pr is:merged`));
    },
  );

  it("대조: 같은 조직을 작성자 조건으로 조회하면 커밋이 0개다 (실측 결함 재현)", async () => {
    const profile = personaOrgProfile();
    const api = fakeGitHubProfileApi([{ ...profile, type: "User" }]);
    const sources = await collectGitHubSources(
      { login: PERSONA_ORG_LOGIN, resumeText: PERSONA_RESUME_TEXTS.seojin },
      { fetch: api.fetch, now: () => NOW },
    );
    // owner.type이 User로 오면 기존 동작이다. 조직 저장소의 커밋 작성자는 조직이 아니므로 0개다
    for (const repo of sources.repos) {
      expect(repo.authorFilter).toBe("LOGIN");
      expect(repo.commits).toEqual([]);
    }
  });

  it("조직 저장소의 병합 PR도 작성자 조건 없이 모은다", async () => {
    const api = fakeGitHubProfileApi([
      {
        login: "acme",
        type: "Organization",
        repos: [
          repo("inventory", {
            pulls: [
              {
                number: 3,
                title: "feat: 재고 예약",
                mergedAt: "2026-03-01T00:00:00Z",
                author: "a",
              },
              { number: 4, title: "fix: 예약 만료", mergedAt: "2026-03-02T00:00:00Z", author: "b" },
            ],
          }),
        ],
      },
    ]);
    const sources = await collectGitHubSources(
      { login: "acme", resumeText: "inventory" },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(sources.repos[0]!.mergedPulls.map((p) => p.number)).toEqual([3, 4]);
    expect(sources.repos[0]!.authorFilter).toBe("NONE");
  });

  it("사용자 프로필의 요청 URL과 결과는 이전과 같고 authorFilter가 LOGIN이다", async () => {
    const profile = devProfile();
    // 다른 사람이 작성한 커밋·PR은 사용자 프로필에서 계속 빠진다
    profile.repos[0]!.commits!.push({
      sha: fakeSha(9),
      message: "chore: 다른 사람의 커밋",
      date: "2026-02-01T00:00:00Z",
      author: "someone-else",
    });
    profile.repos[0]!.pulls!.push({
      number: 9,
      title: "다른 사람의 PR",
      mergedAt: "2026-02-02T00:00:00Z",
      author: "someone-else",
    });
    const api = fakeGitHubProfileApi([profile]);
    const sources = await collectGitHubSources(
      { login: "dev-kim", resumeText: RESUME },
      { fetch: api.fetch, now: () => NOW },
    );
    expect(api.requests).toEqual([
      "/users/dev-kim/repos?type=owner&sort=pushed&direction=desc&per_page=100",
      ...USER_REQUESTS,
    ]);
    for (const r of sources.repos) expect(r.authorFilter).toBe("LOGIN");
    const inventory = sources.repos.find((r) => r.fullName === "dev-kim/inventory-service")!;
    expect(inventory.commits.map((c) => c.sha)).toEqual([fakeSha(1)]);
    expect(inventory.mergedPulls.map((p) => p.number)).toEqual([1]);
  });

  it("조직 저장소 커밋 메시지의 Co-Authored-By 트레일러 이메일은 저장되지 않는다", async () => {
    const api = fakeGitHubProfileApi([
      {
        login: "acme",
        type: "Organization",
        repos: [
          repo("inventory", {
            commits: [
              {
                sha: fakeSha(11),
                message:
                  "feat: 재고 예약\n\nCo-Authored-By: Kim Dev <kim.dev@example.com>\nSigned-off-by: Lee <lee+work@corp.co.kr>",
                date: "2026-03-01T00:00:00Z",
                author: "kim-dev",
                email: "kim.dev@example.com",
              },
              {
                sha: fakeSha(12),
                message: "chore: 배포 설정",
                date: "2026-03-02T00:00:00Z",
                author: null,
                email: "bot@noreply.github.com",
              },
            ],
          }),
        ],
      },
    ]);
    const sources = await collectGitHubSources(
      { login: "acme", resumeText: "inventory" },
      { fetch: api.fetch, now: () => NOW },
    );
    const commits = sources.repos[0]!.commits;
    expect(commits).toHaveLength(2);
    expect(commits[0]!.message).toContain("Co-Authored-By: Kim Dev");
    const stored = JSON.stringify(sources);
    expect(stored).not.toMatch(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
    // 응답의 작성자 로그인·이메일 필드는 읽지 않는다
    expect(allKeys(sources)).not.toContain("email");
    expect(stored).not.toContain("kim-dev");
  });

  it("owner.type이 없거나 User면 LOGIN, Organization이면 NONE이다", async () => {
    const list = [
      { owner: undefined, expected: "LOGIN" },
      { owner: { type: "User" }, expected: "LOGIN" },
      { owner: { type: "Organization" }, expected: "NONE" },
    ] as const;
    for (const { owner, expected } of list) {
      const api = fakeGitHubProfileApi([{ login: "x-org", repos: [repo("inventory")] }], (path) =>
        path.startsWith("/users/")
          ? Response.json([
              {
                name: "inventory",
                full_name: "x-org/inventory",
                html_url: "https://github.com/x-org/inventory",
                fork: false,
                private: false,
                ...(owner ? { owner } : {}),
              },
            ])
          : undefined,
      );
      const sources = await collectGitHubSources(
        { login: "x-org", resumeText: "inventory" },
        { fetch: api.fetch, now: () => NOW },
      );
      expect(sources.repos[0]!.authorFilter).toBe(expected);
    }
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
