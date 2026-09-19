/**
 * 테스트용: GitHub tarball 모양의 아카이브와 GitHub API를 흉내 내는 fetch.
 * 실제 GitHub는 `github.integration.test.ts`(GITHUB_INTEGRATION=1)만 부른다.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { FetchLike } from "./github";

export interface FakeRepoFiles {
  [relativePath: string]: string | Buffer;
}

export interface FakeTarballOptions {
  /** 최상위 디렉터리 이름. 기본 `owner-repo-<sha 앞 7자>` */
  topDir?: string;
  /** 심볼릭 링크 `경로 → 대상` */
  symlinks?: Record<string, string>;
  /** `.git/HEAD` 등 .git 항목을 넣는다 */
  withGitDir?: boolean;
  /** 항목 mtime. 서로 다른 값으로 두 번 만들어도 스냅샷 digest가 같아야 한다 */
  mtime?: Date;
}

/** 파일 맵을 GitHub tarball 형식(최상위 디렉터리 한 단계)으로 만든다 */
export async function makeGitHubStyleTarball(
  files: FakeRepoFiles,
  sha: string,
  options: FakeTarballOptions = {},
): Promise<Uint8Array> {
  const topDir = options.topDir ?? `owner-repo-${sha.slice(0, 7)}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmyti-fake-tarball-"));
  try {
    const base = path.join(root, topDir);
    await mkdir(base, { recursive: true });
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(base, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    if (options.withGitDir) {
      await mkdir(path.join(base, ".git", "refs"), { recursive: true });
      await writeFile(path.join(base, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(path.join(base, ".git", "refs", "x"), sha);
    }
    for (const [linkPath, target] of Object.entries(options.symlinks ?? {})) {
      const file = path.join(base, linkPath);
      await mkdir(path.dirname(file), { recursive: true });
      await symlink(target, file);
    }
    const chunks: Buffer[] = [];
    const stream = tar.c(
      {
        cwd: root,
        gzip: true,
        ...(options.mtime ? { mtime: options.mtime } : {}),
      },
      [topDir],
    );
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export interface FakeGitHubRepo {
  defaultBranch: string;
  isPrivate?: boolean;
  /** ref(브랜치·태그·SHA) → SHA. 테스트가 값을 바꿔 브랜치 이동을 흉내 낸다 */
  refs: Record<string, string>;
  /** SHA → tarball 바이트 (또는 만들기 함수) */
  tarballs: Record<string, Uint8Array | (() => Promise<Uint8Array>)>;
  /** 저장소 응답의 `full_name`. 이름이 바뀐 저장소(옛 이름 키로 등록)를 흉내 낸다. 없으면 요청한 `owner/name` */
  fullName?: string;
}

export interface FakeGitHubState {
  repos: Record<string, FakeGitHubRepo>;
  /** 다음 응답(경로에 `pathIncludes`가 있으면 그 경로만)을 강제로 이 상태 코드로 만든다 (한 번 쓰면 초기화). 속도 제한 테스트용 */
  nextFailure?:
    { status: number; headers?: Record<string, string>; pathIncludes?: string } | undefined;
  calls: string[];
}

export function fakeGitHub(repos: Record<string, FakeGitHubRepo>): {
  state: FakeGitHubState;
  fetch: FetchLike;
} {
  const state: FakeGitHubState = { repos, calls: [] };
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(input);
    state.calls.push(`${url.pathname}`);
    if (
      state.nextFailure &&
      (!state.nextFailure.pathIncludes || url.pathname.includes(state.nextFailure.pathIncludes))
    ) {
      const failure = state.nextFailure;
      state.nextFailure = undefined;
      return new Response(JSON.stringify({ message: "forced" }), {
        status: failure.status,
        headers: failure.headers ?? {},
      });
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return json({ message: "Not Found" }, 404);
    const [, owner, name, rest] = match;
    const repo = state.repos[`${owner}/${name}`];
    if (!repo || repo.isPrivate) return json({ message: "Not Found" }, 404);
    if (!rest) {
      return json({
        full_name: repo.fullName ?? `${owner}/${name}`,
        default_branch: repo.defaultBranch,
        private: false,
      });
    }
    if (rest.startsWith("commits/")) {
      const ref = decodeURIComponent(rest.slice("commits/".length));
      const sha = repo.refs[ref] ?? (Object.values(repo.refs).includes(ref) ? ref : undefined);
      if (!sha) {
        // GitHub: 없는 브랜치는 404, 형식은 맞지만 없는 SHA는 422
        return json(
          { message: /^[0-9a-f]{40}$/.test(ref) ? "No commit found for SHA" : "Not Found" },
          /^[0-9a-f]{40}$/.test(ref) ? 422 : 404,
        );
      }
      return json({ sha });
    }
    if (rest.startsWith("tarball/")) {
      const sha = rest.slice("tarball/".length);
      const source = repo.tarballs[sha];
      if (!source) return json({ message: "Not Found" }, 404);
      const bytes = typeof source === "function" ? await source() : source;
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: { "content-type": "application/x-gzip" },
      });
    }
    return json({ message: "Not Found" }, 404);
  };

  return { state, fetch: fetchImpl };
}

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

export const SMALL_REPO_FILES: FakeRepoFiles = {
  "README.md": "# order api\n\nnpm start, PORT\n",
  "package.json": JSON.stringify({ name: "order-api", scripts: { start: "tsx src/server.ts" } }),
  "src/server.ts": "export const x = 1;\n",
  "src/routes/orders.ts": "export const orders = [];\n",
};
