/**
 * CONTEXT_LINK 단계 (TICKET.md T-501 → T-502 → T-503). 이력서 텍스트 추출 → GitHub 보충 조회 → 맥락 연결 순서로 한다.
 *
 * 결과는 `submission_context`·`context_links`에만 저장하고 채점 단계는 읽지 않는다 (G-10). 이 단계는 점수를 바꿀 권한이 없어
 * 판정 행의 점수 열과 평가 합계 열을 참조하지 않는다 (`scripts/check-context-isolation.ts`가 이 파일도 검사한다).
 * 로그와 단계 기록에는 이력서 본문·claim 없이 상태·개수·사유만 남긴다.
 *
 * GitHub 보충 조회에는 제출 저장소를 근거 후보에서 빼도록 넘긴다(T-603). 제출 URL의 이름과, 수집 단계(T-202)가
 * manifest에 남긴 정식 이름을 모두 넘긴다. 이름이 바뀐 저장소는 옛 URL로 제출해도 목록에는 새 이름으로 나오기 때문이다.
 */
import type { ContextLinkSummary, Rubric } from "@ohmyti/core";
import {
  runContextLinkStage,
  runGitHubSourcesCollection,
  runResumeExtraction,
  type GitHubSourcesCollector,
  type GitHubSourcesSummary,
  type ResumeExtractionSummary,
} from "@ohmyti/context";
import type { Database } from "@ohmyti/db";
import type { LlmClient } from "@ohmyti/llm";
import { artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import type { Logger } from "../logger";
import { parseGitHubRepoUrl, SnapshotManifestSchema } from "../repo";

export interface ContextLinkPipelineInput {
  submissionId: string;
  evaluationId: string;
  rubric: Rubric;
  /** 제출 저장소 URL. GitHub 근거 후보에서 제출 저장소를 뺄 때 쓴다 (T-603) */
  repoUrl?: string | undefined;
}

export interface ContextLinkPipelineDeps {
  db: Database;
  store: ArtifactStore;
  logger: Logger;
  now: () => Date;
  llm?: LlmClient | undefined;
  githubSources?: GitHubSourcesCollector | undefined;
  secrets?: readonly string[] | undefined;
}

export interface ContextLinkPipelineOutcome {
  state: "DONE";
  reason?: string | undefined;
  detail: {
    resume: ResumeExtractionSummary;
    github?: GitHubSourcesSummary;
    contextLink: ContextLinkSummary;
  };
}

export async function runContextLinkPipelineStage(
  input: ContextLinkPipelineInput,
  deps: ContextLinkPipelineDeps,
): Promise<ContextLinkPipelineOutcome> {
  const { db, store, logger } = deps;
  const resume = await runResumeExtraction({ db, store }, input.submissionId);
  logger.info(
    {
      resume: {
        status: resume.status,
        action: resume.action,
        pageCount: resume.pageCount,
        chars: resume.chars,
        reason: resume.reason,
      },
    },
    "이력서 텍스트 추출",
  );

  let github: GitHubSourcesSummary | undefined;
  if (deps.githubSources) {
    const excludeRepos = await submissionRepoNames(store, input.submissionId, input.repoUrl);
    github = await runGitHubSourcesCollection(
      { db, collect: deps.githubSources, now: deps.now },
      input.submissionId,
      { excludeRepos },
    );
    logger.info({ github }, "GitHub 프로필 보충 조회");
  }

  const linked = await runContextLinkStage(
    {
      submissionId: input.submissionId,
      evaluationId: input.evaluationId,
      criteria: input.rubric.criteria.map((c) => ({ id: c.id, title: c.title })),
    },
    { db, llm: deps.llm, secrets: deps.secrets },
  );
  const summary = linked.detail;
  logger.info(
    {
      llm: summary.llm,
      llmError: summary.llmError,
      aiReviewId: summary.aiReviewId,
      linkCount: summary.linkCount,
      statusCounts: summary.statusCounts,
      dropped: summary.dropped.map((d) => `${d.index}:${d.field}:${d.reason}`),
      reason: linked.reason ?? null,
    },
    "맥락 연결",
  );
  return {
    state: "DONE",
    ...(linked.reason ? { reason: linked.reason } : {}),
    detail: { resume, ...(github ? { github } : {}), contextLink: summary },
  };
}

/**
 * 제출 저장소의 `owner/name` 목록: 제출 URL의 이름과 manifest의 정식 이름(있으면). 읽지 못한 값은 건너뛴다.
 * 비교는 수집기가 대소문자를 무시하고 하므로 여기서는 중복만 뺀다
 */
export async function submissionRepoNames(
  store: ArtifactStore,
  submissionId: string,
  repoUrl: string | undefined,
): Promise<string[]> {
  const names = new Set<string>();
  if (repoUrl) {
    try {
      const parsed = parseGitHubRepoUrl(repoUrl);
      names.add(`${parsed.owner}/${parsed.repo}`);
    } catch {
      // 제출 폼이 검사한 URL이라 여기서 실패할 일은 없다. 실패해도 맥락 연결을 막지 않는다
    }
  }
  const object = await store.get(artifactKeys.snapshotManifest(submissionId)).catch(() => null);
  if (object) {
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(object.body).toString("utf8"));
    } catch {
      raw = null;
    }
    const manifest = SnapshotManifestSchema.safeParse(raw);
    if (manifest.success) {
      const { owner, name, fullName } = manifest.data.repo;
      names.add(`${owner}/${name}`);
      if (fullName) names.add(fullName);
    }
  }
  return [...new Map([...names].map((n) => [n.toLowerCase(), n])).values()];
}
