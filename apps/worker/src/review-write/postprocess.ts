/**
 * REVIEW_WRITE LLM 출력 후처리 (T-407). 순수 함수이며 DB·스토어를 모른다.
 *
 * - `sourceRefs`: 스냅샷에 실제로 있는 파일이고 `1 ≤ startLine ≤ endLine ≤ 파일 줄 수`인 것만 남긴다. 무효 참조는 그 참조만 버리고
 *   `dropped`에 사유를 남긴다. 나머지 출력은 그대로 쓴다.
 * - `minimalReproSummary.stepIds`: 그 기준에 입력으로 준 실패 재생 스텝(`<caseId>#<seq>`)만 남긴다.
 *   `minimalReproSummary`가 없거나 `summary`가 공백뿐이면 최소 재현은 null이다 (T-601).
 * - `failures`: 추정 원인을 요청한 FAIL 기준만 받는다. 같은 기준이 두 번 나오면 처음 것만 쓴다.
 * - `designReviews`: 요청한 사람 검토 기준만 받고, `suggestedPoints`가 그 기준의 만점을 넘으면 항목 전체를 버린다.
 *   제안 점수는 근거로만 저장되며 판정 점수로 옮기지 않는다 (G-01).
 */
import type {
  EvidenceReviewOutput,
  ReviewConfidence,
  ReviewSourceRef,
  ReviewSuggestion,
  ReviewWriteDropped,
  SourceLocation,
} from "@ohmyti/core";

/** 스냅샷 파일의 줄 수. 없는 파일이면 null */
export type SnapshotLineCounter = (path: string) => number | null;

export interface ReviewTargets {
  /** FAIL 기준 ID → 참조 가능한 실패 재생 스텝 ID */
  failures: ReadonlyMap<string, ReadonlySet<string>>;
  /** 사람 검토 기준 ID → 만점 */
  design: ReadonlyMap<string, number>;
}

export interface ProcessedFailure {
  criterionId: string;
  interpretation: string;
  confidence: ReviewConfidence;
  refs: SourceLocation[];
  minimalRepro: { summary: string; stepIds: string[] } | null;
}

export interface ProcessedDesignReview {
  criterionId: string;
  suggestedPoints: number;
  maxPoints: number;
  rationale: string;
  refs: SourceLocation[];
}

export interface ProcessedReview {
  failures: ProcessedFailure[];
  designReviews: ProcessedDesignReview[];
  suggestions: ReviewSuggestion[];
  dropped: ReviewWriteDropped[];
}

/** 파일 끝 줄바꿈 뒤의 빈 줄은 세지 않는다 (프롬프트의 라인 번호와 같게) */
export function sourceLines(text: string): string[] {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function normalizePath(raw: string): string {
  return raw
    .trim()
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
}

function refLabel(ref: ReviewSourceRef): string {
  return `${ref.path}:${ref.startLine}-${ref.endLine}`;
}

/** 참조 하나를 검사한다. 유효하면 정규화한 위치, 아니면 사유 */
export function checkSourceRef(
  ref: ReviewSourceRef,
  lineCount: SnapshotLineCounter,
): { ok: true; location: SourceLocation } | { ok: false; reason: string } {
  const path = normalizePath(ref.path);
  if (path === "" || path.split("/").some((s) => s === ".." || s === "node_modules")) {
    return { ok: false, reason: "허용하지 않는 경로" };
  }
  const lines = lineCount(path);
  if (lines === null) return { ok: false, reason: "스냅샷에 없는 파일" };
  if (ref.startLine < 1 || ref.endLine < ref.startLine) {
    return { ok: false, reason: "라인 범위가 올바르지 않음" };
  }
  if (ref.endLine > lines) {
    return { ok: false, reason: `라인 범위가 파일 길이(${lines}줄)를 넘음` };
  }
  return { ok: true, location: { path, startLine: ref.startLine, endLine: ref.endLine } };
}

function keepRefs(
  refs: readonly ReviewSourceRef[],
  criterionId: string,
  lineCount: SnapshotLineCounter,
  dropped: ReviewWriteDropped[],
): SourceLocation[] {
  const kept: SourceLocation[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const checked = checkSourceRef(ref, lineCount);
    if (!checked.ok) {
      dropped.push({
        kind: "SOURCE_REF",
        criterionId,
        value: refLabel(ref),
        reason: checked.reason,
      });
      continue;
    }
    const key = refLabel(checked.location);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(checked.location);
  }
  return kept;
}

export function postprocessEvidenceReview(
  output: EvidenceReviewOutput,
  targets: ReviewTargets,
  lineCount: SnapshotLineCounter,
): ProcessedReview {
  const dropped: ReviewWriteDropped[] = [];

  const failures: ProcessedFailure[] = [];
  const seenFailures = new Set<string>();
  for (const failure of output.failures) {
    const allowedSteps = targets.failures.get(failure.criterionId);
    if (!allowedSteps) {
      dropped.push({
        kind: "FAILURE",
        criterionId: failure.criterionId,
        value: failure.criterionId,
        reason: "추정 원인을 요청하지 않은 기준",
      });
      continue;
    }
    if (seenFailures.has(failure.criterionId)) {
      dropped.push({
        kind: "FAILURE",
        criterionId: failure.criterionId,
        value: failure.criterionId,
        reason: "같은 기준이 반복됨",
      });
      continue;
    }
    seenFailures.add(failure.criterionId);
    const repro = failure.minimalReproSummary;
    const summary = repro?.summary.trim() ?? "";
    const stepIds: string[] = [];
    for (const stepId of summary === "" ? [] : (repro?.stepIds ?? [])) {
      if (!allowedSteps.has(stepId)) {
        dropped.push({
          kind: "STEP",
          criterionId: failure.criterionId,
          value: stepId,
          reason: "입력으로 준 실패 재생 스텝이 아님",
        });
        continue;
      }
      if (!stepIds.includes(stepId)) stepIds.push(stepId);
    }
    failures.push({
      criterionId: failure.criterionId,
      interpretation: failure.interpretation.trim(),
      confidence: failure.confidence,
      refs: keepRefs(failure.sourceRefs, failure.criterionId, lineCount, dropped),
      minimalRepro: summary === "" ? null : { summary, stepIds },
    });
  }

  const designReviews: ProcessedDesignReview[] = [];
  const seenDesign = new Set<string>();
  for (const review of output.designReviews) {
    const maxPoints = targets.design.get(review.criterionId);
    const reject = (reason: string) =>
      dropped.push({
        kind: "DESIGN_REVIEW",
        criterionId: review.criterionId,
        value: `${review.criterionId}:${review.suggestedPoints}`,
        reason,
      });
    if (maxPoints === undefined) {
      reject("설계 평가를 요청하지 않은 기준");
      continue;
    }
    if (seenDesign.has(review.criterionId)) {
      reject("같은 기준이 반복됨");
      continue;
    }
    if (review.suggestedPoints > maxPoints) {
      reject(`제안 점수가 만점(${maxPoints})을 넘음`);
      continue;
    }
    seenDesign.add(review.criterionId);
    designReviews.push({
      criterionId: review.criterionId,
      suggestedPoints: review.suggestedPoints,
      maxPoints,
      rationale: review.rationale.trim(),
      refs: keepRefs(review.sourceRefs, review.criterionId, lineCount, dropped),
    });
  }

  const suggestions: ReviewSuggestion[] = output.suggestions.map((s) => ({
    title: s.title.trim(),
    detail: s.detail.trim(),
    outsideSpec: true,
  }));

  return { failures, designReviews, suggestions, dropped };
}
