/**
 * REVIEW_WRITE 단계 (TICKET.md T-407). 관측된 실패의 추정 원인, 최소 재현 설명, 설계 평가 초안, 명세 외 개선 제안을 만든다.
 * 점수는 바꾸지 않는다: 판정 행에는 `interpretation`과 근거 목록만 쓰고(`setCriterionInterpretation`),
 * `earned_points`·`verdict`·`observation`·`review_state`는 건드리지 않는다 (G-01). 평가 점수도 다시 쓰지 않는다.
 *
 * - LLM 근거는 kind `LLM_INTERPRETATION` + `detail`(출처 `ai_reviews` 행과 제안 내용)로 저장한다. 코드 위치는 후처리로
 *   스냅샷과 대조한 것만 남기고 스니펫을 함께 저장한다.
 * - 설계 평가 초안의 `suggestedPoints`는 근거(`detail`)에만 두며 사람 검토 기준은 `earned_points = null`, `PENDING` 그대로다.
 * - 명세 외 개선 제안은 단계 기록(`stage_log[].detail.suggestions`)에만 둔다. 점수와 무관하다.
 * - 다시 실행하면(job 재시도) `ai_reviews`에 새 버전이 쌓이고, 판정 행은 새 버전의 근거로 다시 연결된다(이전 근거 행은 남는다).
 * - 예산 초과·설정 오류는 "LLM 미실행", 스키마 불일치·제공자 오류는 "LLM 결과 미확정"으로 단계는 DONE이며 점수는 그대로다 (G-14).
 * - 출력은 항목 단위로 받는다 (T-601). 외곽 구조가 맞으면 스키마에 맞지 않는 항목만 버리고(`droppedItems`·`invalidItems`,
 *   위치와 사유 코드만 기록) 나머지를 저장한다. 버린 항목뿐이고 유효 항목이 0개면 "LLM 결과 미확정"이다.
 */
import {
  REVIEW_WRITE_BUDGET_EXCEEDED_REASON,
  REVIEW_WRITE_INCONCLUSIVE_REASON,
  REVIEW_WRITE_LLM_CONFIG_REASON,
  EvidenceReviewLenientOutputSchema,
  evidenceReviewItemCount,
  splitEvidenceReviewOutput,
  type EvidenceDetail,
  type EvidenceReviewLenientOutput,
  type Rubric,
  type ReviewWriteSummary,
  type SourceLocation,
} from "@ohmyti/core";
import {
  insertEvidences,
  listAiReviews,
  listCriterionResults,
  listEvidences,
  lockCriterionResults,
  setCriterionInterpretation,
  type Database,
  type NewEvidence,
} from "@ohmyti/db";
import { llmStepOutcome, type LlmClient, type LlmResult } from "@ohmyti/llm";
import type { ArtifactStore } from "@ohmyti/storage";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logger";
import { loadSnapshotFiles } from "../support";
import { buildReviewWriteInput, collectReviewWriteContext, reviewTargetsOf } from "./input";
import { postprocessEvidenceReview, sourceLines, type ProcessedReview } from "./postprocess";
import {
  EVIDENCE_REVIEW_EXAMPLE,
  EVIDENCE_REVIEW_MAX_TOKENS,
  EVIDENCE_REVIEW_PROMPT,
} from "./prompt";

/** 근거 스니펫 줄 수 상한 */
export const MAX_SNIPPET_LINES = 120;

export interface ReviewWriteStageInput {
  evaluationId: string;
  submissionSha: string;
  rubric: Rubric;
  snapshotRef: string;
}

export interface ReviewWriteStageDeps {
  db: Database;
  store: ArtifactStore;
  llm: LlmClient;
  logger: Logger;
}

export interface ReviewWriteStageOutcome {
  state: "DONE";
  /** LLM을 부르지 않았거나 결과를 쓸 수 없었을 때의 사유 */
  reason?: string | undefined;
  detail: ReviewWriteSummary;
}

function emptySummary(
  llm: ReviewWriteSummary["llm"],
  llmError: string | null,
  targets: string[],
): ReviewWriteSummary {
  return {
    llm,
    llmError,
    promptVersion: EVIDENCE_REVIEW_PROMPT.promptVersion,
    model: null,
    aiReviewId: null,
    aiReviewVersion: null,
    targets,
    interpretations: [],
    designSuggestions: [],
    suggestions: [],
    dropped: [],
    droppedItems: 0,
    invalidItems: [],
  };
}

function isReviewWriteEvidence(detail: EvidenceDetail | null): boolean {
  return detail?.origin === "REVIEW_WRITE";
}

export async function runReviewWriteStage(
  input: ReviewWriteStageInput,
  deps: ReviewWriteStageDeps,
): Promise<ReviewWriteStageOutcome> {
  const { db, store, logger } = deps;
  const [results, evidences, files] = await Promise.all([
    listCriterionResults(db, input.evaluationId),
    listEvidences(db, input.evaluationId),
    loadSnapshotFiles(store, input.snapshotRef),
  ]);
  const context = await collectReviewWriteContext({
    evaluationId: input.evaluationId,
    rubric: input.rubric,
    results,
    evidences,
    files,
    store,
  });
  const targetIds = context.failures.map((f) => f.criterion.id);

  const outcome = await llmStepOutcome<LlmResult<EvidenceReviewLenientOutput>>(() =>
    deps.llm.complete({
      purpose: EVIDENCE_REVIEW_PROMPT.purpose,
      promptVersion: EVIDENCE_REVIEW_PROMPT.promptVersion,
      system: EVIDENCE_REVIEW_PROMPT.system,
      input: buildReviewWriteInput(context),
      schema: EvidenceReviewLenientOutputSchema,
      example: EVIDENCE_REVIEW_EXAMPLE,
      maxTokens: EVIDENCE_REVIEW_MAX_TOKENS,
    }),
  );
  if (outcome.status === "NOT_RUN") {
    const reason =
      outcome.errorName === "LlmBudgetExceededError"
        ? REVIEW_WRITE_BUDGET_EXCEEDED_REASON
        : REVIEW_WRITE_LLM_CONFIG_REASON;
    logger.warn({ errorName: outcome.errorName, detail: outcome.reason }, reason);
    return { state: "DONE", reason, detail: emptySummary("NOT_RUN", outcome.errorName, targetIds) };
  }
  if (outcome.status === "INCONCLUSIVE") {
    const reason = `${REVIEW_WRITE_INCONCLUSIVE_REASON}: ${outcome.reason.slice(0, 300)}`;
    logger.warn({ errorName: outcome.errorName }, REVIEW_WRITE_INCONCLUSIVE_REASON);
    return {
      state: "DONE",
      reason,
      detail: emptySummary("INCONCLUSIVE", outcome.errorName, targetIds),
    };
  }

  // 방금 호출의 기록 (RecordingLlmClient가 남긴 마지막 행). 기록하지 않는 클라이언트면 없다
  const reviews = await listAiReviews(db, {
    evaluationId: input.evaluationId,
    kind: "EVIDENCE_REVIEW",
  });
  const latest = reviews.at(-1) ?? null;
  const aiReview =
    latest && latest.promptVersion === EVIDENCE_REVIEW_PROMPT.promptVersion
      ? { id: latest.id, version: latest.version }
      : null;

  const { output, invalidItems } = splitEvidenceReviewOutput(outcome.value.output);
  const itemsDetail = { droppedItems: invalidItems.length, invalidItems };
  if (invalidItems.length > 0) {
    // 위치·사유 코드만 남긴다. 버린 항목의 본문은 로그에 쓰지 않는다
    logger.warn(itemsDetail, "LLM 출력에서 형식 오류 항목을 제외했습니다");
  }
  if (invalidItems.length > 0 && evidenceReviewItemCount(output) === 0) {
    const reason = `${REVIEW_WRITE_INCONCLUSIVE_REASON}: 유효한 출력 항목이 없습니다(형식 오류 ${invalidItems.length}건)`;
    return {
      state: "DONE",
      reason,
      detail: {
        ...emptySummary("INCONCLUSIVE", "LlmOutputInvalidError", targetIds),
        model: outcome.value.model,
        aiReviewId: aiReview?.id ?? null,
        aiReviewVersion: aiReview?.version ?? null,
        ...itemsDetail,
      },
    };
  }

  const lineCache = new Map<string, string[] | null>();
  const linesOf = async (path: string): Promise<string[] | null> => {
    if (!lineCache.has(path)) {
      const text = await files.readText(path);
      lineCache.set(path, text === null ? null : sourceLines(text));
    }
    return lineCache.get(path)!;
  };
  // 후처리는 동기 함수라 참조된 경로를 미리 읽어 둔다
  for (const ref of [...output.failures, ...output.designReviews].flatMap((x) => x.sourceRefs)) {
    await linesOf(
      ref.path
        .trim()
        .replace(/^(\.\/)+/, "")
        .replace(/^\/+/, ""),
    );
  }
  const processed = postprocessEvidenceReview(output, reviewTargetsOf(context), (path) => {
    const lines = lineCache.get(path);
    return lines ? lines.length : null;
  });
  if (processed.dropped.length > 0) {
    logger.warn({ dropped: processed.dropped }, "LLM 출력의 무효 참조를 제거했습니다");
  }

  const summary = await persistReview(
    {
      evaluationId: input.evaluationId,
      submissionSha: input.submissionSha,
      processed,
      aiReview,
      snippet: (location) => {
        const lines = lineCache.get(location.path);
        if (!lines) return undefined;
        const end = Math.min(location.endLine, location.startLine + MAX_SNIPPET_LINES - 1);
        return lines.slice(location.startLine - 1, end).join("\n");
      },
      targets: new Set(targetIds),
    },
    db,
  );
  logger.info(
    {
      aiReviewId: aiReview?.id ?? null,
      version: aiReview?.version ?? null,
      interpretations: summary.interpretations.length,
      designSuggestions: summary.designSuggestions.length,
      suggestions: summary.suggestions.length,
      droppedItems: invalidItems.length,
    },
    "REVIEW_WRITE 결과를 저장했습니다",
  );
  return {
    state: "DONE",
    detail: {
      ...summary,
      llm: "OK",
      llmError: null,
      promptVersion: EVIDENCE_REVIEW_PROMPT.promptVersion,
      model: outcome.value.model,
      aiReviewId: aiReview?.id ?? null,
      aiReviewVersion: aiReview?.version ?? null,
      targets: targetIds,
      ...itemsDetail,
    },
  };
}

/**
 * 한 트랜잭션에서: 판정 행 잠금 → 이 단계가 전에 연결한 LLM 근거를 떼고 → 새 근거 추가 → `interpretation`·근거 목록만 갱신.
 * 요청한 FAIL 기준 중 출력에 없는 기준의 `interpretation`은 비운다(최신 버전과 어긋나지 않게).
 */
async function persistReview(
  input: {
    evaluationId: string;
    submissionSha: string;
    processed: ProcessedReview;
    aiReview: { id: string; version: number } | null;
    snippet: (location: SourceLocation) => string | undefined;
    targets: ReadonlySet<string>;
  },
  db: Database,
): Promise<
  Pick<ReviewWriteSummary, "interpretations" | "designSuggestions" | "suggestions" | "dropped">
> {
  const { processed, aiReview } = input;
  return db.transaction(async (tx) => {
    const rows = await lockCriterionResults(tx, input.evaluationId);
    const previous = new Set(
      (await listEvidences(tx, input.evaluationId))
        .filter((e) => e.kind === "LLM_INTERPRETATION" && isReviewWriteEvidence(e.detail))
        .map((e) => e.id),
    );
    const base = {
      origin: "REVIEW_WRITE" as const,
      aiReviewId: aiReview?.id ?? null,
      aiReviewVersion: aiReview?.version ?? null,
    };
    const newEvidences: NewEvidence[] = [];
    const added = new Map<string, string[]>();
    const add = (
      criterionId: string,
      evidence: Omit<
        NewEvidence,
        "id" | "evaluationId" | "submissionSha" | "artifactRefs" | "kind"
      >,
    ) => {
      const id = randomUUID();
      newEvidences.push({
        id,
        evaluationId: input.evaluationId,
        submissionSha: input.submissionSha,
        kind: "LLM_INTERPRETATION",
        artifactRefs: [],
        ...evidence,
      });
      added.set(criterionId, [...(added.get(criterionId) ?? []), id]);
      return id;
    };

    const interpretations: ReviewWriteSummary["interpretations"] = [];
    for (const failure of processed.failures) {
      const evidenceIds = failure.refs.map((source) =>
        add(failure.criterionId, {
          source,
          snippet: input.snippet(source),
          detail: {
            ...base,
            role: "FAILURE_CAUSE",
            criterionId: failure.criterionId,
            confidence: failure.confidence,
          },
        }),
      );
      interpretations.push({
        criterionId: failure.criterionId,
        confidence: failure.confidence,
        evidenceIds,
        minimalRepro: failure.minimalRepro,
      });
    }

    const designSuggestions: ReviewWriteSummary["designSuggestions"] = [];
    for (const review of processed.designReviews) {
      const detail: EvidenceDetail = {
        ...base,
        role: "DESIGN_SUGGESTION",
        criterionId: review.criterionId,
      };
      // 제안 점수·근거 문장은 코드 위치가 없는 요약 근거 하나에만 둔다
      const summaryId = add(review.criterionId, {
        detail: {
          ...detail,
          suggestedPoints: review.suggestedPoints,
          maxPoints: review.maxPoints,
          rationale: review.rationale,
        },
      });
      const refIds = review.refs.map((source) =>
        add(review.criterionId, { source, snippet: input.snippet(source), detail }),
      );
      designSuggestions.push({
        criterionId: review.criterionId,
        suggestedPoints: review.suggestedPoints,
        maxPoints: review.maxPoints,
        rationale: review.rationale,
        evidenceIds: [summaryId, ...refIds],
      });
    }

    await insertEvidences(tx, newEvidences);

    const interpretationById = new Map(
      processed.failures.map((f) => [f.criterionId, f.interpretation]),
    );
    for (const row of rows) {
      const kept = row.evidenceIds.filter((id) => !previous.has(id));
      const evidenceIds = [...kept, ...(added.get(row.criterionId) ?? [])];
      const interpretation = input.targets.has(row.criterionId)
        ? (interpretationById.get(row.criterionId) ?? null)
        : row.interpretation;
      const changed =
        interpretation !== row.interpretation ||
        evidenceIds.length !== row.evidenceIds.length ||
        evidenceIds.some((id, i) => id !== row.evidenceIds[i]);
      if (!changed) continue;
      await setCriterionInterpretation(tx, row.id, { interpretation, evidenceIds });
    }

    return {
      interpretations,
      designSuggestions,
      suggestions: processed.suggestions,
      dropped: processed.dropped,
    };
  });
}
