/**
 * GitHub 프로필 보충 조회 (TICKET.md T-502). CONTEXT_LINK 단계에서 이력서 추출(T-501) 다음에 한다.
 *
 * - 프로필 전체를 평가하지 않는다. 공개 저장소 목록에서 이력서·JD 키워드와 겹치는 저장소를 최대 `maxRepos`(3)개 고른다.
 *   겹침 점수는 저장소 이름·설명·토픽·주 언어의 토큰 중 키워드에 있는 것의 개수다. 동점은 최근 push 순, 그다음 이름 순이다.
 *   키워드가 하나도 없으면(이력서 없음) 최근 push 순으로 고른다(`RECENT_PUSH`). 키워드가 있는데 겹치는 저장소가 없으면
 *   관련 없는 저장소를 억지로 고르지 않고 `NO_DATA`(`NO_RELATED_REPOS`)다 (G-09).
 * - 저장소별 수집: README 앞 4 KiB, 언어 목록, 최상위 파일 목록, 해당 사용자의 최근 커밋 메시지 20개, 해당 사용자의 병합된 PR 제목 10개.
 * - 요청 수 상한: 목록 1회 + 저장소당 5회 = `1 + 5 × maxRepos` (기본 16). 상한에 닿으면 더 보내지 않는다.
 *   속도 제한 응답을 한 번 받으면 이후 요청은 보내지 않는다.
 * - 스타·팔로워·포크 수 같은 인기도 지표는 응답에서 읽지 않고 저장하지 않는다. 포크 저장소는 후보에서 뺀다.
 * - 조회 실패는 던지지 않고 `NO_DATA`·`PARTIAL` + 사유로 돌려준다. 이력서는 선택 입력이므로 파이프라인을 막으면 안 된다.
 *
 * 수집한 텍스트(README·커밋 메시지·PR 제목)는 데이터다 (G-06). 저장 전에 `maskSensitive`로 이메일·토큰을 가린다.
 * 결과는 `submission_context.github_sources`에만 저장하며 채점 입력에 들어가지 않는다 (G-10).
 */
import {
  GITHUB_REPO_SOURCE_PARTS,
  GitHubSourcesSchema,
  maskSensitive,
  type GitHubRepoSource,
  type GitHubRepoSourcePart,
  type GitHubSources,
  type GitHubSourcesReasonCode,
  type GitHubSourcesStatus,
} from "@ohmyti/core";
import { getSubmissionContext, setGitHubSources, type Database } from "@ohmyti/db";
import { z } from "zod";

export const GITHUB_API_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "ohmyti-worker";

export const GITHUB_PROFILE_LIMITS = {
  /** 보충 조회할 저장소 수 상한 (`MAX_PROFILE_REPOS`) */
  maxRepos: 3,
  /** 후보 목록은 최근 push 순 첫 페이지만 본다 */
  listPageSize: 100,
  readmeBytes: 4096,
  commitCount: 20,
  pullCount: 10,
  topLevelFiles: 100,
  commitMessageChars: 500,
  requestTimeoutMs: 10_000,
} as const;

/** `MAX_PROFILE_REPOS`가 받을 수 있는 최댓값 */
export const MAX_PROFILE_REPOS_CEILING = 10;
/** 저장소 하나에 보내는 요청 수 (README·언어·최상위 파일·커밋·PR 검색) */
export const REQUESTS_PER_REPO = GITHUB_REPO_SOURCE_PARTS.length;

/** 문서화된 요청 수 상한: 목록 1회 + 저장소당 5회 */
export function profileRequestLimit(maxRepos: number): number {
  return 1 + REQUESTS_PER_REPO * maxRepos;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubProfileOptions {
  /** 선택. 공개 API 속도 제한 완화 (`GITHUB_TOKEN`) */
  token?: string | undefined;
  maxRepos?: number | undefined;
  baseUrl?: string | undefined;
  fetch?: FetchLike | undefined;
  requestTimeoutMs?: number | undefined;
  /** 저장하는 텍스트에서 가릴 비밀값 */
  secrets?: readonly string[] | undefined;
  now?: (() => Date) | undefined;
}

export interface GitHubProfileInput {
  login: string | null;
  /** 이력서 텍스트 (EXTRACTED·MANUAL). 키워드 추출에만 쓰고 저장·전송하지 않는다 */
  resumeText?: string | null | undefined;
  /** 직무 설명. MVP 입력에는 아직 없다 */
  jdText?: string | null | undefined;
}

type Env = Record<string, string | undefined>;

/** `MAX_PROFILE_REPOS`(기본 3, 1~10)·`GITHUB_TOKEN` (TICKET.md 1.6) */
export function loadGitHubProfileConfig(env: Env = process.env): {
  maxRepos: number;
  token: string | undefined;
} {
  const raw = env.MAX_PROFILE_REPOS;
  let maxRepos: number = GITHUB_PROFILE_LIMITS.maxRepos;
  if (raw !== undefined && raw.trim() !== "") {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PROFILE_REPOS_CEILING) {
      throw new Error(
        `MAX_PROFILE_REPOS 값 ${JSON.stringify(raw)}은 1 이상 ${MAX_PROFILE_REPOS_CEILING} 이하의 정수여야 합니다`,
      );
    }
    maxRepos = value;
  }
  return { maxRepos, token: env.GITHUB_TOKEN?.trim() || undefined };
}

// ── 키워드 ──────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "a an and are as at be by for from has have in is it its my of on or our the this that " +
    "to was we with you your using use used based about into via etc http https www com " +
    "github io md readme repo repository project projects sample example demo test tests"
  ).split(" "),
);

const HANGUL = /\p{Script=Hangul}/u;

/**
 * 텍스트를 비교용 토큰 집합으로 바꾼다. 공백·구두점·`-`·`_`로 나누고 소문자로 만든다.
 * camelCase는 나누지 않는다(`PostgreSQL`·`TypeScript`가 쪼개지면 엉뚱한 토큰이 겹친다).
 * 2글자 미만, 숫자만 있는 토큰, 흔한 영어 불용어는 뺀다. `c++`·`c#` 같은 기호는 유지한다.
 */
export function tokenizeKeywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)) {
    const token = raw.replace(/^[+#]+/, "");
    if (token.length < 2 || /^\d+$/.test(token) || STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

/** 저장소 토큰 중 키워드와 겹치는 것. 한글 토큰은 조사가 붙은 키워드(`재고를`)도 앞부분이 같으면 겹친 것으로 본다 */
export function matchKeywords(
  repoTokens: ReadonlySet<string>,
  keywords: ReadonlySet<string>,
): string[] {
  const matched: string[] = [];
  for (const token of repoTokens) {
    if (keywords.has(token)) {
      matched.push(token);
      continue;
    }
    if (HANGUL.test(token)) {
      for (const keyword of keywords) {
        if (keyword.startsWith(token)) {
          matched.push(token);
          break;
        }
      }
    }
  }
  return matched.sort();
}

// ── GitHub 응답 ────────────────────────────────────────────────────────────────

/** 목록 응답에서 읽는 필드만 둔다. 스타·포크 수·watchers 등은 읽지 않는다 */
const RepoListItem = z.object({
  name: z.string().min(1),
  full_name: z.string().min(3),
  html_url: z.url(),
  description: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  pushed_at: z.string().nullable().optional(),
  fork: z.boolean(),
  private: z.boolean(),
});
type RepoListItem = z.infer<typeof RepoListItem>;

const LanguagesResponse = z.record(z.string(), z.number());
const ContentsResponse = z.array(z.object({ name: z.string(), type: z.string() }));
const CommitsResponse = z.array(
  z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    commit: z.object({
      message: z.string(),
      committer: z.object({ date: z.string().nullable().optional() }).nullable().optional(),
      author: z.object({ date: z.string().nullable().optional() }).nullable().optional(),
    }),
  }),
);
const SearchResponse = z.object({
  items: z.array(
    z.object({
      number: z.int().min(1),
      title: z.string(),
      pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
    }),
  ),
});

type FailureCode =
  | "NOT_FOUND"
  | "EMPTY"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "REQUEST_LIMIT";

class GitHubFailure {
  constructor(
    readonly code: FailureCode,
    readonly message: string,
  ) {}
  toString(): string {
    return `${this.code}: ${this.message}`;
  }
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** 요청 수를 세고 상한을 지키는 GitHub 호출기. 속도 제한을 한 번 받으면 이후 요청을 보내지 않는다 */
class GitHubRequester {
  count = 0;
  private rateLimited: GitHubFailure | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
    private readonly token: string | undefined,
    private readonly timeoutMs: number,
    readonly limit: number,
  ) {}

  async get(
    path: string,
    accept = "application/vnd.github+json",
  ): Promise<Response | GitHubFailure> {
    if (this.rateLimited) return this.rateLimited;
    if (this.count >= this.limit) {
      return new GitHubFailure("REQUEST_LIMIT", `요청 수 상한 ${this.limit}회에 닿았습니다`);
    }
    this.count += 1;
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      return new GitHubFailure("UNAVAILABLE", `GitHub 요청 실패 (${name})`);
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    const failure = classify(response);
    if (failure.code === "RATE_LIMITED") this.rateLimited = failure;
    return failure;
  }

  /** JSON 본문 또는 `GitHubFailure` */
  async json(path: string): Promise<unknown> {
    const response = await this.get(path);
    if (response instanceof GitHubFailure) return response;
    try {
      return await response.json();
    } catch {
      return new GitHubFailure("INVALID_RESPONSE", "GitHub 응답이 JSON이 아닙니다");
    }
  }
}

function classify(response: Response): GitHubFailure {
  const { status } = response;
  if (status === 404) return new GitHubFailure("NOT_FOUND", "찾을 수 없습니다 (404)");
  if (status === 409) return new GitHubFailure("EMPTY", "빈 저장소입니다 (409)");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  if (status === 429 || (status === 403 && (remaining === "0" || retryAfter !== null))) {
    return new GitHubFailure("RATE_LIMITED", `GitHub API 속도 제한에 걸렸습니다 (${status})`);
  }
  if (status === 401 || status === 403 || status === 451) {
    return new GitHubFailure("FORBIDDEN", `접근이 거부되었습니다 (${status})`);
  }
  if (status >= 500) return new GitHubFailure("UNAVAILABLE", `GitHub 서버 오류 (${status})`);
  return new GitHubFailure("INVALID_RESPONSE", `예상하지 못한 응답 (${status})`);
}

/** README 원문을 앞 `maxBytes`바이트까지만 읽는다. 나머지는 받지 않는다 */
async function readHead(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
      if (size === maxBytes) {
        const next = await reader.read();
        truncated = !next.done && next.value.byteLength > 0;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // 잘린 자리의 깨진 UTF-8 조각은 버린다
  let text = new TextDecoder("utf-8").decode(bytes);
  if (truncated) text = text.replace(/�+$/, "");
  return { text, truncated };
}

// ── 수집 ────────────────────────────────────────────────────────────────────────

interface Candidate {
  item: RepoListItem;
  matched: string[];
  pushedAt: string | null;
}

function repoTokens(item: RepoListItem): Set<string> {
  return tokenizeKeywords(
    [item.name, item.description ?? "", ...(item.topics ?? []), item.language ?? ""].join(" "),
  );
}

/** 겹침 점수 내림차순 → 최근 push → 이름 순 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (b.matched.length !== a.matched.length) return b.matched.length - a.matched.length;
  const pa = a.pushedAt ?? "";
  const pb = b.pushedAt ?? "";
  if (pa !== pb) return pa < pb ? 1 : -1;
  return a.item.full_name.localeCompare(b.item.full_name);
}

const REASON_TEXT: Record<GitHubSourcesReasonCode, string> = {
  NO_PROFILE: "GitHub 프로필이 입력되지 않았습니다",
  PROFILE_NOT_FOUND: "GitHub 프로필을 찾을 수 없습니다",
  RATE_LIMITED: "GitHub API 속도 제한으로 조회하지 못했습니다",
  GITHUB_UNAVAILABLE: "GitHub API에 접근하지 못했습니다",
  NO_PUBLIC_REPOS: "포크가 아닌 공개 저장소가 없습니다",
  NO_RELATED_REPOS: "이력서·JD 키워드와 겹치는 공개 저장소가 없습니다",
  REQUEST_LIMIT_REACHED: "요청 수 상한에 닿아 일부만 수집했습니다",
};

function reasonOf(code: GitHubSourcesReasonCode, detail?: string): string {
  return `${code}: ${REASON_TEXT[code]}${detail ? ` (${detail})` : ""}`;
}

function listFailureCode(failure: GitHubFailure): GitHubSourcesReasonCode {
  switch (failure.code) {
    case "NOT_FOUND":
      return "PROFILE_NOT_FOUND";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "REQUEST_LIMIT":
      return "REQUEST_LIMIT_REACHED";
    default:
      return "GITHUB_UNAVAILABLE";
  }
}

/**
 * 프로필의 공개 저장소에서 관련 저장소를 골라 근거 자료를 수집한다. 던지지 않는다.
 * 반환값은 `GitHubSourcesSchema`를 통과한다.
 */
export async function collectGitHubSources(
  input: GitHubProfileInput,
  options: GitHubProfileOptions = {},
): Promise<GitHubSources> {
  const maxRepos = options.maxRepos ?? GITHUB_PROFILE_LIMITS.maxRepos;
  const secrets = options.secrets ?? [];
  const mask = (text: string) => maskSensitive(text, secrets);
  const now = options.now ?? (() => new Date());
  const requester = new GitHubRequester(
    (options.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, ""),
    options.fetch ?? ((url, init) => fetch(url, init)),
    options.token,
    options.requestTimeoutMs ?? GITHUB_PROFILE_LIMITS.requestTimeoutMs,
    profileRequestLimit(maxRepos),
  );
  const login = input.login?.trim() || null;

  const result = (
    status: GitHubSourcesStatus,
    reason: string | null,
    extra: Partial<
      Pick<GitHubSources, "selection" | "candidateCount" | "candidateListTruncated" | "repos">
    > = {},
  ): GitHubSources =>
    GitHubSourcesSchema.parse({
      status,
      reason,
      login,
      collectedAt: now().toISOString(),
      selection: null,
      candidateCount: 0,
      candidateListTruncated: false,
      repos: [],
      ...extra,
      requestCount: requester.count,
      requestLimit: requester.limit,
    });

  if (!login) return result("NO_DATA", reasonOf("NO_PROFILE"));
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
    return result("NO_DATA", reasonOf("PROFILE_NOT_FOUND", "로그인 형식이 올바르지 않습니다"));
  }

  const list = await requester.json(
    `/users/${encodeURIComponent(login)}/repos?type=owner&sort=pushed&direction=desc&per_page=${GITHUB_PROFILE_LIMITS.listPageSize}`,
  );
  if (list instanceof GitHubFailure) {
    return result("NO_DATA", reasonOf(listFailureCode(list), list.toString()));
  }
  const parsed = z.array(RepoListItem).safeParse(list);
  if (!parsed.success) {
    return result(
      "NO_DATA",
      reasonOf("GITHUB_UNAVAILABLE", "저장소 목록 응답 형식이 예상과 다릅니다"),
    );
  }
  const candidateListTruncated = parsed.data.length >= GITHUB_PROFILE_LIMITS.listPageSize;
  const publicRepos = parsed.data.filter((item) => !item.fork && !item.private);
  const listed = { candidateCount: publicRepos.length, candidateListTruncated };
  if (publicRepos.length === 0) return result("NO_DATA", reasonOf("NO_PUBLIC_REPOS"), listed);

  const keywords = tokenizeKeywords([input.resumeText ?? "", input.jdText ?? ""].join("\n"));
  const selection = keywords.size > 0 ? "KEYWORD_OVERLAP" : "RECENT_PUSH";
  const candidates: Candidate[] = publicRepos.map((item) => ({
    item,
    matched: keywords.size > 0 ? matchKeywords(repoTokens(item), keywords) : [],
    pushedAt: isoOrNull(item.pushed_at),
  }));
  const selected = candidates
    .filter((c) => selection === "RECENT_PUSH" || c.matched.length > 0)
    .sort(compareCandidates)
    .slice(0, maxRepos);
  if (selected.length === 0) {
    return result("NO_DATA", reasonOf("NO_RELATED_REPOS"), { ...listed, selection });
  }

  const repos: GitHubRepoSource[] = [];
  for (const candidate of selected) {
    repos.push(await collectRepo(requester, login, candidate, mask));
  }

  const failures = repos.flatMap((r) => r.missing);
  if (failures.length === 0) {
    return result("COLLECTED", null, { ...listed, selection, repos });
  }
  const code: GitHubSourcesReasonCode = failures.some((f) => f.reason.startsWith("RATE_LIMITED"))
    ? "RATE_LIMITED"
    : failures.some((f) => f.reason.startsWith("REQUEST_LIMIT"))
      ? "REQUEST_LIMIT_REACHED"
      : "GITHUB_UNAVAILABLE";
  return result("PARTIAL", reasonOf(code, `${failures.length}개 항목을 수집하지 못했습니다`), {
    ...listed,
    selection,
    repos,
  });
}

async function collectRepo(
  requester: GitHubRequester,
  login: string,
  candidate: Candidate,
  mask: (text: string) => string,
): Promise<GitHubRepoSource> {
  const { item } = candidate;
  const [owner, name] = item.full_name.split("/") as [string, string];
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const missing: Array<{ part: GitHubRepoSourcePart; reason: string }> = [];
  const miss = (part: GitHubRepoSourcePart, failure: GitHubFailure) =>
    missing.push({ part, reason: truncate(failure.toString(), 500) });
  const invalid = (part: GitHubRepoSourcePart) =>
    miss(part, new GitHubFailure("INVALID_RESPONSE", "응답 형식이 예상과 다릅니다"));

  // README 앞 4 KiB. 없으면(404) null이며 실패가 아니다
  let readme: string | null = null;
  let readmeTruncated = false;
  const readmeResponse = await requester.get(`${base}/readme`, "application/vnd.github.raw+json");
  if (readmeResponse instanceof GitHubFailure) {
    if (readmeResponse.code !== "NOT_FOUND") miss("readme", readmeResponse);
  } else {
    const head = await readHead(readmeResponse, GITHUB_PROFILE_LIMITS.readmeBytes);
    // 마스킹으로 길어질 수 있으므로 다시 자른다
    readme = truncate(mask(head.text), GITHUB_PROFILE_LIMITS.readmeBytes);
    readmeTruncated = head.truncated;
  }

  let languages: GitHubRepoSource["languages"] = [];
  const languagesBody = await requester.json(`${base}/languages`);
  if (languagesBody instanceof GitHubFailure) miss("languages", languagesBody);
  else {
    const parsed = LanguagesResponse.safeParse(languagesBody);
    if (!parsed.success) invalid("languages");
    else {
      languages = Object.entries(parsed.data)
        .map(([language, bytes]) => ({
          name: truncate(language, 100),
          bytes: Math.max(0, Math.trunc(bytes)),
        }))
        .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
        .slice(0, 50);
    }
  }

  // 빈 저장소는 contents가 404다
  let topLevelFiles: GitHubRepoSource["topLevelFiles"] = [];
  const contentsBody = await requester.json(`${base}/contents`);
  if (contentsBody instanceof GitHubFailure) {
    if (contentsBody.code !== "NOT_FOUND") miss("topLevelFiles", contentsBody);
  } else {
    const parsed = ContentsResponse.safeParse(contentsBody);
    if (!parsed.success) invalid("topLevelFiles");
    else {
      topLevelFiles = parsed.data.slice(0, GITHUB_PROFILE_LIMITS.topLevelFiles).map((entry) => ({
        name: truncate(entry.name, 255),
        type: entry.type === "file" ? "file" : entry.type === "dir" ? "dir" : "other",
      }));
    }
  }

  // 기본 브랜치에서 해당 사용자가 작성한 커밋. 빈 저장소는 409다
  let commits: GitHubRepoSource["commits"] = [];
  const commitsBody = await requester.json(
    `${base}/commits?author=${encodeURIComponent(login)}&per_page=${GITHUB_PROFILE_LIMITS.commitCount}`,
  );
  if (commitsBody instanceof GitHubFailure) {
    if (commitsBody.code !== "EMPTY") miss("commits", commitsBody);
  } else {
    const parsed = CommitsResponse.safeParse(commitsBody);
    if (!parsed.success) invalid("commits");
    else {
      commits = parsed.data.slice(0, GITHUB_PROFILE_LIMITS.commitCount).map((c) => ({
        sha: c.sha,
        message: truncate(mask(c.commit.message.trim()), GITHUB_PROFILE_LIMITS.commitMessageChars),
        committedAt: isoOrNull(c.commit.committer?.date ?? c.commit.author?.date),
      }));
    }
  }

  let mergedPulls: GitHubRepoSource["mergedPulls"] = [];
  const query = `repo:${item.full_name} is:pr is:merged author:${login}`;
  const searchBody = await requester.json(
    `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${GITHUB_PROFILE_LIMITS.pullCount}`,
  );
  if (searchBody instanceof GitHubFailure) miss("mergedPulls", searchBody);
  else {
    const parsed = SearchResponse.safeParse(searchBody);
    if (!parsed.success) invalid("mergedPulls");
    else {
      mergedPulls = parsed.data.items.slice(0, GITHUB_PROFILE_LIMITS.pullCount).map((pr) => ({
        number: pr.number,
        title: truncate(mask(pr.title.trim()), 300),
        mergedAt: isoOrNull(pr.pull_request?.merged_at),
      }));
    }
  }

  return {
    fullName: item.full_name,
    url: item.html_url,
    description: item.description ? truncate(mask(item.description), 1000) : null,
    language: item.language ? truncate(item.language, 100) : null,
    topics: (item.topics ?? []).slice(0, 30).map((t) => truncate(t, 100)),
    pushedAt: candidate.pushedAt,
    matchedKeywords: candidate.matched.slice(0, 50).map((t) => truncate(t, 100)),
    relevanceScore: candidate.matched.length,
    readme,
    readmeTruncated,
    languages,
    topLevelFiles,
    commits,
    mergedPulls,
    missing,
  };
}

// ── 제출 단위 실행 ──────────────────────────────────────────────────────────────

/** 로그·단계 기록에 남기는 요약. README·커밋 본문은 없다 */
export interface GitHubSourcesSummary {
  status: GitHubSourcesStatus;
  /** 이번 호출에서 한 일 */
  action: "COLLECTED" | "KEPT" | "NO_DATA" | "PARTIAL";
  reason: string | null;
  repos: string[];
  requestCount: number;
}

export type GitHubSourcesCollector = (input: GitHubProfileInput) => Promise<GitHubSources>;

/** 프로덕션 수집기. 토큰·저장소 수 상한·비밀값을 묶는다 */
export function createGitHubSourcesCollector(
  options: GitHubProfileOptions,
): GitHubSourcesCollector {
  return (input) => collectGitHubSources(input, options);
}

/** 다시 조회할 가치가 있는 일시적 실패 (job 재시도에서 다시 조회한다) */
const TRANSIENT_CODES: readonly GitHubSourcesReasonCode[] = ["RATE_LIMITED", "GITHUB_UNAVAILABLE"];

function isTransient(sources: GitHubSources): boolean {
  return (
    sources.status === "NO_DATA" &&
    TRANSIENT_CODES.some((code) => sources.reason?.startsWith(`${code}:`))
  );
}

function summaryOf(
  sources: GitHubSources,
  action: GitHubSourcesSummary["action"],
): GitHubSourcesSummary {
  return {
    status: sources.status,
    action,
    reason: sources.reason,
    repos: sources.repos.map((r) => r.fullName),
    requestCount: sources.requestCount,
  };
}

export interface GitHubSourcesDeps {
  db: Database;
  collect: GitHubSourcesCollector;
  now?: (() => Date) | undefined;
}

/**
 * 제출의 GitHub 로그인과 이력서 텍스트로 보충 조회를 하고 `submission_context.github_sources`에 기록한다.
 * 이미 기록이 있으면(일시적 실패로 끝난 NO_DATA 제외) 다시 조회하지 않는다(재시도 멱등).
 * 수집기가 예상 밖으로 던져도 NO_DATA로 기록하고 던지지 않는다 (DB 오류는 예외).
 */
export async function runGitHubSourcesCollection(
  deps: GitHubSourcesDeps,
  submissionId: string,
): Promise<GitHubSourcesSummary> {
  const context = await getSubmissionContext(deps.db, submissionId);
  const existing = context?.githubSources
    ? GitHubSourcesSchema.safeParse(context.githubSources)
    : null;
  if (existing?.success && !isTransient(existing.data)) return summaryOf(existing.data, "KEPT");

  const login = context?.githubLogin ?? null;
  const resumeText =
    context?.resumeTextStatus === "EXTRACTED" || context?.resumeTextStatus === "MANUAL"
      ? context.resumeText
      : null;
  let sources: GitHubSources;
  try {
    sources = await deps.collect({ login, resumeText });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    sources = GitHubSourcesSchema.parse({
      status: "NO_DATA",
      reason: reasonOf("GITHUB_UNAVAILABLE", `수집 중 오류 (${name})`),
      login,
      collectedAt: (deps.now ?? (() => new Date()))().toISOString(),
      selection: null,
      candidateCount: 0,
      candidateListTruncated: false,
      repos: [],
      requestCount: 0,
      requestLimit: 1,
    });
  }
  await setGitHubSources(deps.db, submissionId, sources);
  return summaryOf(
    sources,
    sources.status === "COLLECTED"
      ? "COLLECTED"
      : sources.status === "PARTIAL"
        ? "PARTIAL"
        : "NO_DATA",
  );
}
