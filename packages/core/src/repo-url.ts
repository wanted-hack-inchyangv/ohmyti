/**
 * GitHub 저장소 URL 파싱 (TICKET.md T-202). 워커(T-202)와 제출 폼(T-206)이 같은 규칙을 쓴다.
 * 허용 형식: `https://github.com/<owner>/<repo>[.git][/tree/<ref>]`. `<ref>`는 브랜치·태그·SHA이며 `/`를 포함할 수 있다.
 * MVP는 공개 GitHub 저장소만 지원하므로(PRD 3장) 다른 호스트는 거부한다.
 * Node 전용 API를 쓰지 않는다. 클라이언트 컴포넌트에서도 불러온다.
 */

export interface ParsedRepoUrl {
  owner: string;
  repo: string;
  /** URL의 `/tree/<ref>` 부분. 없으면 기본 브랜치 */
  ref?: string;
}

export class InvalidRepoUrlError extends Error {
  override readonly name = "InvalidRepoUrlError";
  constructor(
    readonly url: string,
    readonly detail: string,
  ) {
    super(`지원하지 않는 저장소 URL(${detail}): ${url}`);
  }
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

export function parseGitHubRepoUrl(input: string): ParsedRepoUrl {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidRepoUrlError(raw, "URL 형식이 아님");
  }
  if (url.protocol !== "https:") throw new InvalidRepoUrlError(raw, "https만 허용");
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
    throw new InvalidRepoUrlError(raw, "github.com 저장소만 지원");
  }
  if (url.username || url.password) throw new InvalidRepoUrlError(raw, "자격증명이 든 URL");

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const [owner, repoSegment, ...rest] = segments;
  if (!owner || !repoSegment) throw new InvalidRepoUrlError(raw, "owner/repo가 없음");
  const repo = repoSegment.endsWith(".git") ? repoSegment.slice(0, -".git".length) : repoSegment;
  if (!OWNER.test(owner)) throw new InvalidRepoUrlError(raw, "owner 이름이 올바르지 않음");
  if (!REPO.test(repo) || repo === "." || repo === "..") {
    throw new InvalidRepoUrlError(raw, "저장소 이름이 올바르지 않음");
  }

  if (rest.length === 0) return { owner, repo };
  if (rest[0] !== "tree" || rest.length < 2) {
    throw new InvalidRepoUrlError(raw, "`/tree/<ref>` 외의 하위 경로는 지원하지 않음");
  }
  let ref: string;
  try {
    ref = rest
      .slice(1)
      .map((s) => decodeURIComponent(s))
      .join("/");
  } catch {
    throw new InvalidRepoUrlError(raw, "ref 인코딩이 올바르지 않음");
  }
  if (!isValidRef(ref)) throw new InvalidRepoUrlError(raw, "ref가 올바르지 않음");
  return { owner, repo, ref };
}

export const SHA40 = /^[0-9a-f]{40}$/;

/**
 * git ref 이름 규칙의 부분집합. 제어 문자·공백·`..`·`~^:?*[\`·선행 `-`를 거부한다.
 * ref는 GitHub API 경로에 그대로 들어가므로 여기서 걸러야 한다.
 */
export function isValidRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.includes("..") || ref.includes("//") || ref.endsWith(".lock")) return false;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
    if (" ~^:?*[\\".includes(ch)) return false;
  }
  return true;
}

/** 사용자가 40자 SHA를 직접 준 경우 소문자로 정규화한 값, 아니면 null */
export function normalizeSha(ref: string): string | null {
  const lowered = ref.trim().toLowerCase();
  return SHA40.test(lowered) ? lowered : null;
}

/** 사용자가 제출 기준으로 적는 커밋 식별자: 7~40자 hex (짧은 SHA는 워커가 GitHub API로 해석한다) */
export const COMMIT_SHA_INPUT = /^[0-9a-fA-F]{7,40}$/;

export function isCommitShaInput(value: string): boolean {
  return COMMIT_SHA_INPUT.test(value.trim());
}

/**
 * GitHub 프로필 URL(`https://github.com/<login>`)에서 로그인 이름을 뽑는다. 조직·사용자 페이지 모두 같은 형식이다.
 * 저장소 URL(`/owner/repo`)이나 다른 호스트는 거부한다.
 */
export function parseGitHubProfileUrl(input: string): { login: string } {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidRepoUrlError(raw, "URL 형식이 아님");
  }
  if (url.protocol !== "https:") throw new InvalidRepoUrlError(raw, "https만 허용");
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
    throw new InvalidRepoUrlError(raw, "github.com 프로필만 지원");
  }
  if (url.username || url.password) throw new InvalidRepoUrlError(raw, "자격증명이 든 URL");
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length !== 1) {
    throw new InvalidRepoUrlError(raw, "프로필 URL은 `https://github.com/<login>` 형식이어야 함");
  }
  const login = segments[0]!;
  if (!OWNER.test(login)) throw new InvalidRepoUrlError(raw, "로그인 이름이 올바르지 않음");
  return { login };
}
