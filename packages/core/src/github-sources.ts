/**
 * GitHub 프로필 보충 조회 결과 (TICKET.md T-502). `submission_context.github_sources`에 저장한다.
 *
 * - 프로필 전체를 평가하지 않는다. 이력서·JD 키워드와 겹치는 공개 저장소를 최대 `MAX_PROFILE_REPOS`(3)개만 고른다 (PRD 3장).
 * - 스타·팔로워·포크 수 같은 인기도 지표는 스키마에 없다. 객체는 모두 `strict`라 모르는 키가 있으면 검증에 실패한다.
 * - 조회하지 못하면 `NO_DATA` + 사유(`<CODE>: <설명>`)를 남긴다. 채점 입력에는 들어가지 않는다 (G-10).
 */
import { z } from "zod";
import { ShaSchema, TimestampSchema } from "./common";

export const GITHUB_SOURCES_STATUS = ["COLLECTED", "PARTIAL", "NO_DATA"] as const;
export const GitHubSourcesStatusSchema = z.enum(GITHUB_SOURCES_STATUS);
export type GitHubSourcesStatus = z.infer<typeof GitHubSourcesStatusSchema>;

/** `NO_DATA`·`PARTIAL`의 사유 코드 */
export const GITHUB_SOURCES_REASON_CODES = [
  "NO_PROFILE",
  "PROFILE_NOT_FOUND",
  "RATE_LIMITED",
  "GITHUB_UNAVAILABLE",
  "NO_PUBLIC_REPOS",
  "NO_RELATED_REPOS",
  "REQUEST_LIMIT_REACHED",
] as const;
export const GitHubSourcesReasonCodeSchema = z.enum(GITHUB_SOURCES_REASON_CODES);
export type GitHubSourcesReasonCode = z.infer<typeof GitHubSourcesReasonCodeSchema>;

/** 저장소 하나에서 수집하는 항목 */
export const GITHUB_REPO_SOURCE_PARTS = [
  "readme",
  "languages",
  "topLevelFiles",
  "commits",
  "mergedPulls",
] as const;
export const GitHubRepoSourcePartSchema = z.enum(GITHUB_REPO_SOURCE_PARTS);
export type GitHubRepoSourcePart = z.infer<typeof GitHubRepoSourcePartSchema>;

export const GitHubRepoSourceSchema = z.strictObject({
  /** `owner/repo` */
  fullName: z.string().min(3).max(200),
  url: z.url(),
  description: z.string().max(1000).nullable(),
  /** GitHub이 판정한 주 언어 */
  language: z.string().max(100).nullable(),
  topics: z.array(z.string().max(100)).max(30),
  pushedAt: TimestampSchema.nullable(),
  /**
   * 선정 근거: 이력서·JD 키워드와 겹친 저장소 토큰. 범용이 아닌 토큰을 앞에 두고 각 묶음 안은 정렬한다(T-603).
   * 점수는 그 개수다
   */
  matchedKeywords: z.array(z.string().max(100)).max(50),
  relevanceScore: z.int().min(0),
  /** README 앞 4 KiB (UTF-8, 마스킹 후). 없으면 null */
  readme: z.string().max(4096).nullable(),
  readmeTruncated: z.boolean(),
  /** 언어별 바이트 수 (큰 순) */
  languages: z.array(z.strictObject({ name: z.string().max(100), bytes: z.int().min(0) })).max(50),
  /** 최상위 파일·디렉터리 이름 */
  topLevelFiles: z
    .array(z.strictObject({ name: z.string().max(255), type: z.enum(["file", "dir", "other"]) }))
    .max(100),
  /** 기본 브랜치에서 해당 사용자가 작성한 최근 커밋 (최대 20개) */
  commits: z
    .array(
      z.strictObject({
        sha: ShaSchema,
        message: z.string().max(500),
        committedAt: TimestampSchema.nullable(),
      }),
    )
    .max(20),
  /** 해당 사용자의 병합된 PR 제목 (최대 10개) */
  mergedPulls: z
    .array(
      z.strictObject({
        number: z.int().min(1),
        title: z.string().max(300),
        mergedAt: TimestampSchema.nullable(),
      }),
    )
    .max(10),
  /** 수집하지 못한 항목과 사유. 비어 있으면 모두 수집했다 */
  missing: z
    .array(z.strictObject({ part: GitHubRepoSourcePartSchema, reason: z.string().max(500) }))
    .max(GITHUB_REPO_SOURCE_PARTS.length),
});
export type GitHubRepoSource = z.infer<typeof GitHubRepoSourceSchema>;

export const GitHubSourcesSchema = z.strictObject({
  status: GitHubSourcesStatusSchema,
  /** `<CODE>: <설명>`. COLLECTED면 null */
  reason: z.string().max(1000).nullable(),
  login: z.string().max(100).nullable(),
  collectedAt: TimestampSchema,
  /**
   * 선정 방식: 이력서·JD가 주소로 직접 가리킨 저장소(`RESUME_LINK`, T-603), 키워드 겹침,
   * 또는 키워드가 없어 최근 push 순
   */
  selection: z.enum(["RESUME_LINK", "KEYWORD_OVERLAP", "RECENT_PUSH"]).nullable(),
  /** 후보로 본 공개 저장소 수(포크·제출 저장소 제외)와 목록 첫 페이지 상한에 걸렸는지 */
  candidateCount: z.int().min(0),
  candidateListTruncated: z.boolean(),
  /**
   * 근거 후보에서 뺀 제출 저장소(`owner/name`, 목록에 있던 이름). 채점 대상이 이력서 근거로 다시 쓰이지 않게 한다 (T-603).
   * T-603 이전 기록에는 없다
   */
  excludedRepos: z.array(z.string().min(3).max(200)).max(10).optional(),
  /** 키워드 겹침 선정에서 범용 키워드만 겹쳐 빠진 후보 수 (T-603). 다른 선정 방식이거나 T-603 이전 기록이면 없다 */
  genericOnlyCount: z.int().min(0).optional(),
  repos: z.array(GitHubRepoSourceSchema).max(10),
  /** 실제로 보낸 GitHub API 요청 수와 상한 */
  requestCount: z.int().min(0),
  requestLimit: z.int().min(1),
});
export type GitHubSources = z.infer<typeof GitHubSourcesSchema>;
