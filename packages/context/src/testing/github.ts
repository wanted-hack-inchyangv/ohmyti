/**
 * GitHub REST API 가짜 (T-502 테스트용). 실제 GitHub 응답처럼 인기도 필드(`stargazers_count`·`forks_count`·`watchers_count`,
 * 사용자 `followers`)를 섞어 돌려준다. 수집기가 이 필드를 버리는지 확인하려는 것이다.
 *
 * 받은 요청 경로를 `requests`에 모두 남긴다. `override`로 특정 경로의 응답을 바꿀 수 있다.
 */

export interface FakeProfileRepo {
  name: string;
  description?: string | null | undefined;
  language?: string | null | undefined;
  topics?: string[] | undefined;
  pushedAt?: string | null | undefined;
  fork?: boolean | undefined;
  private?: boolean | undefined;
  /** README 원문. 없으면 404 */
  readme?: string | Uint8Array | null | undefined;
  languages?: Record<string, number> | undefined;
  files?: Array<{ name: string; type: "file" | "dir" | "symlink" }> | undefined;
  /** 없으면 빈 저장소(commits 409, contents 404) */
  commits?: Array<{ sha: string; message: string; date: string }> | undefined;
  pulls?: Array<{ number: number; title: string; mergedAt: string }> | undefined;
}

export interface FakeProfile {
  login: string;
  repos: FakeProfileRepo[];
}

export type FakeOverride = (path: string) => Response | Promise<Response> | undefined;

export interface FakeGitHubProfileApi {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** 받은 요청의 경로 + 쿼리 (`/users/x/repos?...`) */
  requests: string[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function rateLimitedResponse(): Response {
  return json({ message: "API rate limit exceeded" }, 403, {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": "1893456000",
  });
}

export function fakeGitHubProfileApi(
  profiles: FakeProfile[],
  override?: FakeOverride,
): FakeGitHubProfileApi {
  const requests: string[] = [];
  const byLogin = new Map(profiles.map((p) => [p.login.toLowerCase(), p]));

  function findRepo(owner: string, name: string): FakeProfileRepo | undefined {
    return byLogin.get(owner.toLowerCase())?.repos.find((r) => r.name === name);
  }

  function handle(pathAndQuery: string): Response {
    const url = new URL(pathAndQuery, "https://api.github.test");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (segments[0] === "users" && segments[2] === "repos") {
      const profile = byLogin.get(segments[1]!.toLowerCase());
      if (!profile) return json({ message: "Not Found" }, 404);
      return json(
        profile.repos.map((r, i) => ({
          id: i + 1,
          name: r.name,
          full_name: `${profile.login}/${r.name}`,
          html_url: `https://github.com/${profile.login}/${r.name}`,
          owner: { login: profile.login, followers_url: "x" },
          description: r.description ?? null,
          language: r.language ?? null,
          topics: r.topics ?? [],
          pushed_at: r.pushedAt ?? null,
          fork: r.fork ?? false,
          private: r.private ?? false,
          stargazers_count: 1000 + i,
          watchers_count: 1000 + i,
          forks_count: 50 + i,
          forks: 50 + i,
          open_issues_count: 3,
          followers: 99,
        })),
      );
    }

    if (segments[0] === "repos" && segments.length >= 4) {
      const [, owner, name, part] = segments as [string, string, string, string];
      const repo = findRepo(owner, name);
      if (!repo) return json({ message: "Not Found" }, 404);
      switch (part) {
        case "readme":
          if (repo.readme == null) return json({ message: "Not Found" }, 404);
          return new Response(repo.readme, { status: 200 });
        case "languages":
          return json(repo.languages ?? {});
        case "contents":
          if (!repo.commits) return json({ message: "This repository is empty." }, 404);
          return json(
            (repo.files ?? []).map((f) => ({ name: f.name, path: f.name, type: f.type, size: 1 })),
          );
        case "commits": {
          if (!repo.commits) return json({ message: "Git Repository is empty." }, 409);
          const perPage = Number(url.searchParams.get("per_page") ?? 30);
          return json(
            repo.commits.slice(0, perPage).map((c) => ({
              sha: c.sha,
              commit: {
                message: c.message,
                author: { name: owner, email: `${owner}@example.com`, date: c.date },
                committer: { name: owner, email: `${owner}@example.com`, date: c.date },
                comment_count: 0,
              },
              author: { login: owner, followers_url: "x" },
            })),
          );
        }
      }
    }

    if (segments[0] === "search" && segments[1] === "issues") {
      const q = url.searchParams.get("q") ?? "";
      const repoFull = /repo:(\S+)/.exec(q)?.[1] ?? "";
      const [owner, name] = repoFull.split("/");
      const repo = owner && name ? findRepo(owner, name) : undefined;
      if (!repo) return json({ message: "Validation Failed" }, 422);
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const pulls = repo.pulls ?? [];
      return json({
        total_count: pulls.length,
        incomplete_results: false,
        items: pulls.slice(0, perPage).map((p) => ({
          number: p.number,
          title: p.title,
          state: "closed",
          reactions: { total_count: 5 },
          pull_request: { merged_at: p.mergedAt },
        })),
      });
    }

    return json({ message: "Not Found" }, 404);
  }

  return {
    requests,
    async fetch(input) {
      const url = new URL(input);
      const pathAndQuery = `${url.pathname}${url.search}`;
      requests.push(pathAndQuery);
      const replaced = await override?.(pathAndQuery);
      return replaced ?? handle(pathAndQuery);
    },
  };
}

/** 40자 SHA를 만든다 */
export function fakeSha(seed: number): string {
  return seed.toString(16).padStart(40, "0");
}
