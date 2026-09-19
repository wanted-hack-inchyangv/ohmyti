/**
 * 워크벤치 하단 탭(T-504)이 읽는 지원자 맥락. 맥락 연결(`context_links`, T-503)과 GitHub 보충 조회 결과
 * (`submission_context.github_sources`, T-502)를 core 스키마로 검증해 돌려준다.
 *
 * - 이력서 본문(`resume_text`)은 읽어 넘기지 않는다. 화면에는 이력서 유무와 텍스트 상태·사유만 필요하다.
 * - 채점 경로(리포트·점수)와 섞지 않는다. 하단 탭을 열었을 때만 페이지가 부른다.
 */
import {
  EvaluationContextReportSchema,
  GitHubSourcesSchema,
  type ContextLink,
  type EvaluationContextReport,
  type GitHubSources,
  type ResumeTextStatus,
} from "@ohmyti/core";
import {
  getEvaluation,
  getSubmissionContext,
  listContextLinks,
  toContextLink,
  type Database,
} from "@ohmyti/db";
import { isUuid, type ReportResult } from "@/lib/reports/service";

export interface EvaluationContextData {
  /** 이 평가가 만든 연결 (저장 순서). 평가 ID가 없는 이전 행도 제출의 연결로 본다 */
  links: ContextLink[];
  /** 같은 제출을 다른 평가가 다시 연결해 이 평가에서 보이지 않는 연결 수 */
  otherEvaluationLinkCount: number;
  resume: {
    /** 이력서 원본이 제출됐는지 */
    uploaded: boolean;
    textStatus: ResumeTextStatus;
    reason: string | null;
  };
  github: {
    login: string | null;
    /** 아직 조회하지 않았으면 null */
    sources: GitHubSources | null;
    /** 저장된 값이 스키마와 맞지 않아 읽지 못했다 */
    invalid: boolean;
  };
}

export type EvaluationContextInput =
  { ok: true; data: EvaluationContextData } | { ok: false; message: string };

export async function readEvaluationContext(
  deps: { db: Database },
  input: { submissionId: string; evaluationId: string },
): Promise<EvaluationContextInput> {
  const [context, rows] = await Promise.all([
    getSubmissionContext(deps.db, input.submissionId),
    listContextLinks(deps.db, input.submissionId),
  ]);
  const mine = rows.filter(
    (row) => row.evaluationId === null || row.evaluationId === input.evaluationId,
  );
  let links: ContextLink[];
  try {
    links = mine.map(toContextLink);
  } catch (error) {
    return {
      ok: false,
      message: `맥락 연결을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const rawSources = context?.githubSources ?? null;
  const parsed = rawSources === null ? null : GitHubSourcesSchema.safeParse(rawSources);
  return {
    ok: true,
    data: {
      links,
      otherEvaluationLinkCount: rows.length - mine.length,
      resume: {
        uploaded: Boolean(context?.resumeRef),
        textStatus: context?.resumeTextStatus ?? "NONE",
        reason: context?.resumeTextReason ?? null,
      },
      github: {
        login: context?.githubLogin ?? null,
        sources: parsed?.success ? parsed.data : null,
        invalid: parsed !== null && !parsed.success,
      },
    },
  };
}

/**
 * `GET /api/evaluations/[id]/context` (T-606). 하단 탭과 같은 데이터를 조회 API 봉투로 돌려준다.
 * 게이트(`gate:personas`)가 GitHub 근거 선정과 후속 질문을 대조할 때 읽는다
 */
export async function readEvaluationContextReport(
  deps: { db: Database },
  evaluationId: string,
): Promise<ReportResult<EvaluationContextReport>> {
  if (!isUuid(evaluationId)) {
    return { ok: false, code: "INVALID_INPUT", message: "평가 ID 형식이 올바르지 않습니다" };
  }
  const evaluation = await getEvaluation(deps.db, evaluationId);
  if (!evaluation) {
    return {
      ok: false,
      code: "EVALUATION_NOT_FOUND",
      message: `평가 ${evaluationId}를 찾을 수 없습니다`,
    };
  }
  const context = await readEvaluationContext(deps, {
    submissionId: evaluation.submissionId,
    evaluationId,
  });
  if (!context.ok) return { ok: false, code: "ARTIFACT_NOT_FOUND", message: context.message };
  const parsed = EvaluationContextReportSchema.safeParse({
    evaluationId,
    submissionId: evaluation.submissionId,
    ...context.data,
  });
  if (!parsed.success) {
    return {
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
      message: `맥락 연결의 형태가 맞지 않습니다: ${parsed.error.issues[0]?.message ?? "알 수 없음"}`,
    };
  }
  return { ok: true, data: parsed.data };
}
