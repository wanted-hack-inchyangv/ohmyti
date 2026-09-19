/**
 * 저장소 수집과 SHA 고정 (TICKET.md T-202). `EVALUATE_SUBMISSION`의 REPO_CHECK 단계다.
 *
 * 흐름: URL 파싱 → (이미 고정된 SHA가 있으면 그것을, 없으면 요청 ref 또는 기본 브랜치의 HEAD를) 커밋 SHA로 해석
 * → tarball 다운로드 → 정규화 스냅샷 생성 → 스토어에 `snapshot.tar.gz`·`snapshot-manifest.json` 저장
 * → `submissions.submission_sha`·`snapshot_ref` 고정.
 *
 * 결과 분류:
 * - `PINNED`: 정상. 이후 단계(T-203 ENV_PREP)로 이어진다.
 * - `UNSUPPORTED`: `REPO_NOT_ACCESSIBLE`(비공개·404·없는 ref·잘못된 URL) 또는 `LIMIT_EXCEEDED`(파일 수·바이트).
 *   제출 상태를 UNSUPPORTED로 바꾸며 job은 정상 종료한다 (G-09: 사유와 함께 거절).
 * - 예외 `RepoEnvironmentError`: 속도 제한·5xx·네트워크. job이 ENVIRONMENT 실패로 재시도한다 (G-11).
 *
 * 멱등성: 같은 제출에 다시 호출되면(재시도) 이미 고정된 SHA를 다시 쓴다. 브랜치가 그 사이 움직여도
 * `submission_sha`는 바뀌지 않는다. 스냅샷·manifest가 이미 스토어에 있으면 네트워크를 쓰지 않는다.
 */
import { maskSensitive } from "@ohmyti/core";
import {
  getSubmission,
  markSubmissionUnsupported,
  pinSubmissionSnapshot,
  type Database,
  type SubmissionRow,
} from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logger";
import {
  RepoEnvironmentError,
  RepoNotAccessibleError,
  TarballTooLargeError,
  type GitHubClient,
} from "./github";
import {
  buildSnapshotFromTarball,
  SnapshotArchiveError,
  SnapshotLimitExceededError,
  SnapshotManifestSchema,
  type SnapshotLimits,
  type SnapshotManifest,
} from "./snapshot";
import { InvalidRepoUrlError, normalizeSha, parseGitHubRepoUrl } from "./url";

export const REPO_UNSUPPORTED_REASONS = ["REPO_NOT_ACCESSIBLE", "LIMIT_EXCEEDED"] as const;
export type RepoUnsupportedReason = (typeof REPO_UNSUPPORTED_REASONS)[number];

export type RepoCheckResult =
  | {
      outcome: "PINNED";
      submissionSha: string;
      snapshotRef: string;
      manifestRef: string;
      manifest: SnapshotManifest;
      /** 스토어에 있던 스냅샷을 재사용해 네트워크를 쓰지 않았다 */
      reused: boolean;
    }
  | { outcome: "UNSUPPORTED"; reason: RepoUnsupportedReason; detail: string };

export interface RepoCollectConfig extends SnapshotLimits {
  githubToken?: string | undefined;
}

export const REPO_COLLECT_DEFAULTS = {
  maxFiles: 500,
  maxBytes: 20 * 1024 * 1024,
} as const;

/** 압축 tarball 다운로드 상한. 압축본이 이보다 크면 압축 전 소스는 확실히 `maxBytes`를 넘는다 */
export function downloadLimitBytes(limits: SnapshotLimits): number {
  return limits.maxBytes + 4 * 1024 * 1024;
}

type Env = Record<string, string | undefined>;

/** `MAX_SOURCE_FILES`·`MAX_SOURCE_BYTES`·`GITHUB_TOKEN` (TICKET.md 1.6) */
export function loadRepoCollectConfig(env: Env = process.env): RepoCollectConfig {
  return {
    maxFiles: intFrom(env, "MAX_SOURCE_FILES", REPO_COLLECT_DEFAULTS.maxFiles),
    maxBytes: intFrom(env, "MAX_SOURCE_BYTES", REPO_COLLECT_DEFAULTS.maxBytes),
    githubToken: env.GITHUB_TOKEN?.trim() || undefined,
  };
}

function intFrom(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} 값 ${JSON.stringify(raw)}은 1 이상의 정수여야 합니다`);
  }
  return value;
}

export interface CollectRepositoryInput {
  submissionId: string;
  repoUrl: string;
  /** 사용자가 별도로 지정한 브랜치·태그·SHA. URL의 `/tree/<ref>`보다 우선한다 */
  repoRef?: string | null | undefined;
  /** 이전 시도에서 고정한 SHA. 있으면 ref를 다시 해석하지 않는다 */
  pinnedSha?: string | null | undefined;
}

export interface CollectRepositoryDeps {
  github: GitHubClient;
  store: ArtifactStore;
  limits: SnapshotLimits;
  logger?: Logger | undefined;
  /** 임시 디렉터리 위치. 기본 `os.tmpdir()` */
  workRoot?: string | undefined;
  now?: (() => Date) | undefined;
  /** 사유 문자열 마스킹에 쓸 비밀값 */
  secrets?: readonly string[] | undefined;
}

/**
 * 저장소를 수집해 스토어에 스냅샷을 넣는다. DB는 건드리지 않는다 (`runRepoCheckStage`가 기록한다).
 */
export async function collectRepository(
  input: CollectRepositoryInput,
  deps: CollectRepositoryDeps,
): Promise<RepoCheckResult> {
  const { github, store, limits } = deps;
  const snapshotRef = artifactKeys.snapshot(input.submissionId);
  const manifestRef = artifactKeys.snapshotManifest(input.submissionId);
  const secrets = deps.secrets ?? [];
  const unsupported = (reason: RepoUnsupportedReason, detail: string): RepoCheckResult => ({
    outcome: "UNSUPPORTED",
    reason,
    detail: maskSensitive(detail, secrets),
  });

  let parsed;
  try {
    parsed = parseGitHubRepoUrl(input.repoUrl);
  } catch (error) {
    if (error instanceof InvalidRepoUrlError)
      return unsupported("REPO_NOT_ACCESSIBLE", error.message);
    throw error;
  }

  // 재시도: 이미 고정된 SHA와 스냅샷이 있으면 그대로 쓴다
  if (input.pinnedSha) {
    const existing = await store.get(manifestRef);
    if (existing && (await store.exists(snapshotRef))) {
      const manifest = SnapshotManifestSchema.safeParse(
        JSON.parse(Buffer.from(existing.body).toString("utf8")),
      );
      if (manifest.success && manifest.data.submissionSha === input.pinnedSha) {
        deps.logger?.info({ submissionSha: input.pinnedSha }, "저장된 스냅샷을 재사용합니다");
        return {
          outcome: "PINNED",
          submissionSha: input.pinnedSha,
          snapshotRef,
          manifestRef,
          manifest: manifest.data,
          reused: true,
        };
      }
    }
  }

  const requestedRef = input.repoRef?.trim() || parsed.ref;
  let submissionSha: string;
  let refLabel: string;
  try {
    if (input.pinnedSha) {
      submissionSha = input.pinnedSha;
      refLabel = requestedRef ?? input.pinnedSha;
    } else {
      const resolved = await resolveSha(github, parsed.owner, parsed.repo, requestedRef);
      submissionSha = resolved.sha;
      refLabel = resolved.refLabel;
    }
  } catch (error) {
    if (error instanceof RepoNotAccessibleError) {
      return unsupported("REPO_NOT_ACCESSIBLE", error.detail);
    }
    throw error;
  }

  const workRoot = deps.workRoot ?? os.tmpdir();
  await mkdir(workRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(workRoot, "ohmyti-repo-"));
  try {
    const archiveFile = path.join(workDir, "source.tar.gz");
    try {
      const download = await github.downloadTarball(
        parsed.owner,
        parsed.repo,
        submissionSha,
        archiveFile,
        downloadLimitBytes(limits),
      );
      deps.logger?.info(
        { submissionSha, bytes: download.bytes, owner: parsed.owner, repo: parsed.repo },
        "tarball을 내려받았습니다",
      );
    } catch (error) {
      if (error instanceof TarballTooLargeError) {
        return unsupported(
          "LIMIT_EXCEEDED",
          `저장소 tarball이 ${error.maxBytes}바이트를 넘어 소스 한도(${limits.maxBytes}바이트)를 초과합니다`,
        );
      }
      if (error instanceof RepoNotAccessibleError) {
        return unsupported("REPO_NOT_ACCESSIBLE", error.detail);
      }
      throw error;
    }

    let built;
    try {
      built = await buildSnapshotFromTarball(archiveFile, workDir, limits);
    } catch (error) {
      if (error instanceof SnapshotLimitExceededError) {
        return unsupported("LIMIT_EXCEEDED", error.detail);
      }
      if (error instanceof SnapshotArchiveError) {
        // GitHub가 만든 아카이브를 읽지 못한 것이므로 제출물 탓으로 돌리지 않고 재시도한다
        throw new RepoEnvironmentError(error.detail);
      }
      throw error;
    }

    const manifest: SnapshotManifest = {
      version: 1,
      repo: { owner: parsed.owner, name: parsed.repo },
      submissionSha,
      requestedRef: refLabel,
      snapshotDigest: built.digest,
      fileCount: built.fileCount,
      totalBytes: built.totalBytes,
      files: built.files,
      dropped: built.dropped,
      collectedAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
    await store.put(snapshotRef, built.bytes, { contentType: ARTIFACT_CONTENT_TYPES.snapshot });
    await store.put(manifestRef, JSON.stringify(manifest, null, 2), {
      contentType: ARTIFACT_CONTENT_TYPES.snapshotManifest,
    });
    deps.logger?.info(
      {
        submissionSha,
        snapshotDigest: built.digest,
        fileCount: built.fileCount,
        totalBytes: built.totalBytes,
        dropped: built.dropped,
      },
      "스냅샷을 저장했습니다",
    );
    return { outcome: "PINNED", submissionSha, snapshotRef, manifestRef, manifest, reused: false };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function resolveSha(
  github: GitHubClient,
  owner: string,
  repo: string,
  requestedRef: string | undefined,
): Promise<{ sha: string; refLabel: string }> {
  const repository = await github.getRepository(owner, repo);
  if (repository.isPrivate) {
    // 토큰이 있으면 비공개 저장소가 200으로 올 수 있다. MVP는 공개 저장소만 지원한다 (PRD 3장)
    throw new RepoNotAccessibleError("비공개 저장소는 지원하지 않습니다");
  }
  const ref = requestedRef ?? repository.defaultBranch;
  const explicitSha = normalizeSha(ref);
  const commit = await github.resolveCommit(owner, repo, explicitSha ?? ref);
  if (explicitSha && commit.sha !== explicitSha) {
    throw new RepoNotAccessibleError(`요청한 SHA ${explicitSha}가 저장소에 없습니다`);
  }
  return { sha: commit.sha, refLabel: ref };
}

export interface RepoCheckStageDeps extends Omit<CollectRepositoryDeps, "store"> {
  db: Database;
  store: ArtifactStore;
}

/**
 * REPO_CHECK 단계: 제출 행을 읽어 수집하고 결과를 DB에 기록한다.
 * UNSUPPORTED면 제출 상태를 UNSUPPORTED로 바꾸고 정상 반환한다. 환경 오류는 그대로 던진다.
 */
export async function runRepoCheckStage(
  submissionId: string,
  deps: RepoCheckStageDeps,
): Promise<{ result: RepoCheckResult; submission: SubmissionRow }> {
  const submission = await getSubmission(deps.db, submissionId);
  if (!submission) throw new Error(`제출을 찾을 수 없습니다: ${submissionId}`);

  const result = await collectRepository(
    {
      submissionId,
      repoUrl: submission.repoUrl,
      repoRef: submission.repoRef,
      pinnedSha: submission.submissionSha,
    },
    deps,
  );

  if (result.outcome === "UNSUPPORTED") {
    const updated = await markSubmissionUnsupported(
      deps.db,
      submissionId,
      formatUnsupportedReason(result.reason, result.detail),
    );
    deps.logger?.warn({ reason: result.reason, detail: result.detail }, "지원하지 않는 제출입니다");
    return { result, submission: updated };
  }

  const updated = await pinSubmissionSnapshot(deps.db, submissionId, {
    submissionSha: result.submissionSha,
    snapshotRef: result.snapshotRef,
  });
  return { result, submission: updated };
}

/** `submissions.unsupported_reason` 형식: `<CODE>: <detail>` */
export function formatUnsupportedReason(reason: RepoUnsupportedReason, detail: string): string {
  return `${reason}: ${detail}`;
}
