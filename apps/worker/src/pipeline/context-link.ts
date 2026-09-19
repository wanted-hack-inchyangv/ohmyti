/**
 * CONTEXT_LINK 단계 (TICKET.md T-501 → T-502 → T-503). 이력서 텍스트 추출 → GitHub 보충 조회 → 맥락 연결 순서로 한다.
 *
 * 결과는 `submission_context`·`context_links`에만 저장하고 채점 단계는 읽지 않는다 (G-10). 이 단계는 점수를 바꿀 권한이 없어
 * 판정 행의 점수 열과 평가 합계 열을 참조하지 않는다 (`scripts/check-context-isolation.ts`가 이 파일도 검사한다).
 * 로그와 단계 기록에는 이력서 본문·claim 없이 상태·개수·사유만 남긴다.
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
import type { ArtifactStore } from "@ohmyti/storage";
import type { Logger } from "../logger";

export interface ContextLinkPipelineInput {
  submissionId: string;
  evaluationId: string;
  rubric: Rubric;
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
    github = await runGitHubSourcesCollection(
      { db, collect: deps.githubSources, now: deps.now },
      input.submissionId,
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
