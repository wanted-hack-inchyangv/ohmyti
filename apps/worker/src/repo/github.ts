/**
 * GitHub REST API 클라이언트 (TICKET.md T-202). 세 호출만 쓴다:
 *
 * - `GET /repos/{owner}/{repo}`: 존재·공개 여부와 기본 브랜치
 * - `GET /repos/{owner}/{repo}/commits/{ref}`: 브랜치·태그·SHA → 커밋 SHA (HEAD 고정)
 * - `GET /repos/{owner}/{repo}/tarball/{sha}`: 소스 tarball (302 → codeload). git 바이너리가 필요 없다 (1.2)
 *
 * 오류 분류 (G-11):
 * - 404·422(없는 커밋), 401(비공개): `RepoNotAccessibleError` → 제출 UNSUPPORTED(REPO_NOT_ACCESSIBLE)
 * - 403·429(속도 제한), 5xx, 네트워크 오류: `RepoEnvironmentError` → job 재시도
 *
 * `fetch`는 주입할 수 있어 테스트는 실제 GitHub를 부르지 않는다.
 */
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

export const GITHUB_API_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "ohmyti-worker";

/** 저장소·ref에 접근할 수 없다. 재시도해도 같으므로 제출을 UNSUPPORTED로 끝낸다 */
export class RepoNotAccessibleError extends Error {
  override readonly name = "RepoNotAccessibleError";
  constructor(
    readonly detail: string,
    readonly status: number | null = null,
  ) {
    super(detail);
  }
}

/** GitHub 쪽 일시 장애·속도 제한·네트워크 오류. job을 ENVIRONMENT 실패로 재시도한다 */
export class RepoEnvironmentError extends Error {
  override readonly name = "RepoEnvironmentError";
  constructor(
    readonly detail: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`ENVIRONMENT: ${detail}`);
  }
}

/** 다운로드가 상한을 넘었다. 스냅샷 한도 초과(LIMIT_EXCEEDED)로 처리한다 */
export class TarballTooLargeError extends Error {
  override readonly name = "TarballTooLargeError";
  constructor(readonly maxBytes: number) {
    super(`tarball이 다운로드 상한 ${maxBytes}바이트를 넘었습니다`);
  }
}

export interface RepositoryInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface CommitInfo {
  sha: string;
}

export interface DownloadResult {
  bytes: number;
}

export interface GitHubClient {
  getRepository(owner: string, repo: string): Promise<RepositoryInfo>;
  /** 브랜치·태그·SHA를 커밋 SHA로 해석한다. 없으면 `RepoNotAccessibleError` */
  resolveCommit(owner: string, repo: string, ref: string): Promise<CommitInfo>;
  /** tarball을 파일로 내려받는다. `maxBytes`를 넘으면 `TarballTooLargeError` */
  downloadTarball(
    owner: string,
    repo: string,
    sha: string,
    destFile: string,
    maxBytes: number,
  ): Promise<DownloadResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  /** 선택. 공개 API 속도 제한 완화 (`GITHUB_TOKEN`) */
  token?: string | undefined;
  baseUrl?: string | undefined;
  fetch?: FetchLike | undefined;
  /** 요청당 제한 시간. 기본 30초 (tarball은 별도 `downloadTimeoutMs`) */
  requestTimeoutMs?: number | undefined;
  /** tarball 다운로드 전체 제한 시간. 기본 120초 */
  downloadTimeoutMs?: number | undefined;
}

const RepositoryResponse = z.object({
  default_branch: z.string().min(1),
  private: z.boolean(),
});
const CommitResponse = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });

export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const baseUrl = (options.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 120_000;

  function headers(accept: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
    };
    if (options.token) h.Authorization = `Bearer ${options.token}`;
    return h;
  }

  async function request(path: string, accept: string, timeoutMs: number): Promise<Response> {
    const url = `${baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: headers(accept),
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RepoEnvironmentError(
        `GitHub 요청 실패 (${path}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    throw classifyErrorStatus(response, path);
  }

  return {
    async getRepository(owner, repo) {
      const response = await request(
        `/repos/${enc(owner)}/${enc(repo)}`,
        "application/vnd.github+json",
        requestTimeoutMs,
      );
      const parsed = RepositoryResponse.safeParse(await readJson(response, "저장소 정보"));
      if (!parsed.success) {
        throw new RepoEnvironmentError("GitHub 저장소 응답 형식이 예상과 다릅니다");
      }
      return {
        owner,
        repo,
        defaultBranch: parsed.data.default_branch,
        isPrivate: parsed.data.private,
      };
    },

    async resolveCommit(owner, repo, ref) {
      const response = await request(
        `/repos/${enc(owner)}/${enc(repo)}/commits/${encodeRef(ref)}`,
        "application/vnd.github+json",
        requestTimeoutMs,
      );
      const parsed = CommitResponse.safeParse(await readJson(response, "커밋 정보"));
      if (!parsed.success) {
        throw new RepoEnvironmentError("GitHub 커밋 응답 형식이 예상과 다릅니다");
      }
      return { sha: parsed.data.sha };
    },

    async downloadTarball(owner, repo, sha, destFile, maxBytes) {
      const response = await request(
        `/repos/${enc(owner)}/${enc(repo)}/tarball/${enc(sha)}`,
        "application/vnd.github+json",
        downloadTimeoutMs,
      );
      if (!response.body) throw new RepoEnvironmentError("tarball 응답에 본문이 없습니다");
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) {
            callback(new TarballTooLargeError(maxBytes));
            return;
          }
          callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destFile));
      } catch (error) {
        if (error instanceof TarballTooLargeError) throw error;
        throw new RepoEnvironmentError(
          `tarball 다운로드 실패: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { bytes };
    },
  };
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** ref는 `/`를 포함할 수 있다 (`feature/x`). 세그먼트별로 인코딩해 경로 구분자는 남긴다 */
function encodeRef(ref: string): string {
  return ref.split("/").map(enc).join("/");
}

async function readJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new RepoEnvironmentError(
      `GitHub ${label} 응답을 JSON으로 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 상태 코드로 접근 불가와 환경 장애를 가른다. */
export function classifyErrorStatus(response: Response, path: string): Error {
  const status = response.status;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;

  if (status === 429 || (status === 403 && (remaining === "0" || retryAfterMs !== null))) {
    return new RepoEnvironmentError(
      `GitHub API 속도 제한 (${status}, ${path})`,
      status,
      retryAfterMs,
    );
  }
  if (status === 403) {
    // 속도 제한 표시가 없는 403도 GitHub는 비공개·차단 저장소에 준다. 재시도해도 같지 않다는 보장은 없어 환경 장애로 둔다
    return new RepoEnvironmentError(`GitHub 접근 거부 (403, ${path})`, status);
  }
  if (status === 404 || status === 401 || status === 410) {
    return new RepoNotAccessibleError(
      `저장소 또는 ref를 찾을 수 없거나 비공개입니다 (${status}, ${path})`,
      status,
    );
  }
  if (status === 422) {
    return new RepoNotAccessibleError(`커밋을 찾을 수 없습니다 (422, ${path})`, status);
  }
  return new RepoEnvironmentError(`GitHub 응답 오류 (${status}, ${path})`, status);
}
