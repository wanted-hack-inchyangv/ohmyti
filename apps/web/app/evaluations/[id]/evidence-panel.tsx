import { Badge, EmptyState, PanelHeader, ReviewStateBadge, VerdictBadge } from "@/components/ui";
import { REVIEW_STATE_LABEL, VERDICT_LABEL } from "@/components/ui/badge";
import type { CodeEvidenceLabel } from "@/lib/workbench/code-evidence";
import {
  CONFIDENCE_LABEL,
  type EvidenceItemView,
  type EvidencePanelView,
  type ReviewHistoryItemView,
  type ReviewWriteView,
} from "@/lib/workbench/evidence-panel";
import { ReviewActions } from "./review-actions";

/**
 * 평가 근거·검토 이력 패널 (PRD 6장 ③ 오른쪽 열, TICKET.md T-306).
 * 관측(`observation`)과 추정(`interpretation`)을 나눠 보여 주고, 근거 목록은 클릭하면 중앙 패널(실패 재생·코드 근거)로 이동한다.
 * 검토 이력은 `review_events`를 시간순으로 나열하며 삭제 액션이 없다. 액션(확인·수정·이의·설계 확정)은 `review-actions.tsx`(클라이언트)다.
 * `추정` 라벨은 사람 확인 전의 미확정 해석이라 `pending` 토큰을 쓰고 `data-interpretation="true"` 래퍼 뒤에만 온다 (T-301 토큰 규칙).
 */

const LABEL_TONE: Record<CodeEvidenceLabel, "ink" | "neutral" | "pending"> = {
  관측: "ink",
  "정적 관계": "neutral",
  추정: "pending",
  "사람 검토": "neutral",
};

export function formatReviewTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", {
    hour12: false,
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function EvidencePanel({ view }: { view: EvidencePanelView }) {
  return (
    <aside
      className="flex min-w-0 flex-col rounded-xl border border-neutral-200 bg-surface"
      data-panel="evidence"
      data-evidence-status={view.status}
    >
      <PanelHeader
        title="평가 근거"
        aside={
          view.criterionId ? (
            <code className="font-mono text-[13px] text-neutral-600">{view.criterionId}</code>
          ) : null
        }
      />
      <div className="flex min-w-0 flex-col gap-6 p-4 sm:p-5">
        {view.status === "no-criterion" ? (
          <EmptyState
            title="선택된 기준 없음"
            description="왼쪽에서 기준을 누르면 관측·추정·근거와 검토 이력을 보여 줍니다."
            testId="evidence-empty"
          />
        ) : null}
        {view.status === "no-result" ? (
          <EmptyState
            title={`${view.criterionId} · 판정 저장 전`}
            description="이 기준의 판정이 아직 저장되지 않았습니다. 판정이 저장되면 검토할 수 있습니다."
            testId="evidence-no-result"
          />
        ) : null}
        {view.status === "ok" ? <CriterionSummary view={view} /> : null}
        {view.status === "ok" ? <ObservationSection view={view} /> : null}
        {view.status === "ok" ? <EvidenceList items={view.evidences} /> : null}
        {view.actions ? <ReviewActions actions={view.actions} /> : null}
        <HistorySection history={view.history} scope={view.historyScope} />
        {view.status === "no-criterion" && view.review ? (
          <SuggestionsSection review={view.review} />
        ) : null}
      </div>
    </aside>
  );
}

function CriterionSummary({ view }: { view: EvidencePanelView }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="evidence-summary">
      <p className="text-lg leading-snug font-bold tracking-tight" title={view.title ?? undefined}>
        {view.title}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-neutral-600">
        <span className="text-[15px] font-bold text-ink tabular-nums" data-testid="evidence-points">
          {view.pointsDisplay}
        </span>
        <span data-testid="evidence-method">{view.methodLabel}</span>
        {view.verdict ? <VerdictBadge verdict={view.verdict} /> : null}
        {view.reviewState ? <ReviewStateBadge state={view.reviewState} /> : null}
        {view.issueId ? (
          <code
            className="font-mono text-[12px] break-all text-neutral-500"
            data-testid="evidence-issue-id"
          >
            {view.issueId}
          </code>
        ) : null}
      </div>
    </section>
  );
}

function ObservationSection({ view }: { view: EvidencePanelView }) {
  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="observation-section">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <Badge tone="ink">관측</Badge>
          <span className="text-[13px] text-neutral-500">실행·검사에서 확인한 사실</span>
        </div>
        <p
          className="rounded-lg bg-neutral-50 px-3 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-neutral-800"
          data-testid="observation"
        >
          {view.observation}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {view.interpretation ? (
            // 추정은 사람 확인 전의 미확정 해석이다. pending 토큰은 이 래퍼 뒤에만 온다 (T-301 토큰 규칙)
            <span data-interpretation="true" className="contents">
              <Badge tone="pending">추정</Badge>
            </span>
          ) : (
            <Badge tone="neutral">추정</Badge>
          )}
          <span className="text-[13px] text-neutral-500">해석·원인 추정 (사람 확인 전 미확정)</span>
          {view.interpretation && view.review?.confidence ? (
            <span
              className="ml-auto text-[13px] font-medium text-neutral-600"
              data-testid="interpretation-confidence"
            >
              {CONFIDENCE_LABEL[view.review.confidence]}
            </span>
          ) : null}
        </div>
        {view.interpretation ? (
          <p
            className="rounded-lg border border-neutral-200 px-3 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-neutral-800"
            data-testid="interpretation"
          >
            {view.interpretation}
          </p>
        ) : (
          <p className="text-[13px] text-neutral-500" data-testid="interpretation-empty">
            {interpretationEmptyText(view)}
          </p>
        )}
        {view.interpretation && view.review?.minimalRepro ? (
          <p
            className="text-[13px] leading-relaxed break-words text-neutral-700"
            data-testid="minimal-repro"
          >
            <span className="font-semibold text-neutral-500">최소 재현 </span>
            {view.review.minimalRepro.summary}
            {view.review.minimalRepro.stepIds.length > 0 ? (
              <code className="ml-1 font-mono text-[12px] break-all text-neutral-400">
                ({view.review.minimalRepro.stepIds.join(", ")})
              </code>
            ) : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** 추정이 없는 이유. REVIEW_WRITE 단계 상태와 사유를 그대로 옮긴다 */
function interpretationEmptyText(view: EvidencePanelView): string {
  const review = view.review;
  if (!review) return "추정 없음. 이 평가에는 LLM 근거 탐색 단계 기록이 없습니다.";
  if (review.state === "PENDING" || review.state === "RUNNING") {
    return "추정 없음. LLM 근거 탐색이 아직 끝나지 않았습니다.";
  }
  if (review.reason) return `추정 없음. ${review.reason}`;
  return view.verdict === "FAIL"
    ? "추정 없음. LLM이 이 기준의 원인을 제시하지 않았습니다."
    : "추정 없음. 원인 추정은 FAIL 기준에만 작성합니다.";
}

function SuggestionsSection({ review }: { review: ReviewWriteView }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="review-suggestions">
      <div className="flex items-center gap-2">
        <span data-interpretation="true" className="contents">
          <Badge tone="pending">추정</Badge>
        </span>
        <p className="text-sm font-bold text-ink">
          명세 외 개선 제안 {review.suggestions.length}건
        </p>
      </div>
      <p className="text-[13px] text-neutral-500">LLM 리뷰 초안입니다. 점수와 무관합니다.</p>
      {review.droppedItems > 0 ? (
        <p className="text-[12px] text-neutral-400" data-testid="review-dropped-items">
          형식 오류로 제외한 항목 {review.droppedItems}건
        </p>
      ) : null}
      {review.suggestions.length === 0 ? (
        <p className="text-[13px] text-neutral-500" data-testid="review-suggestions-empty">
          {review.reason ? `제안 없음. ${review.reason}` : "제안 없음."}
        </p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-2">
          {review.suggestions.map((s, i) => (
            <li
              key={`${i}-${s.title}`}
              className="flex flex-col gap-1 rounded-lg border border-neutral-200 px-3 py-2.5 text-[13px] leading-relaxed"
              data-testid="review-suggestion"
            >
              <p className="font-semibold text-ink">{s.title}</p>
              <p className="whitespace-pre-wrap text-neutral-700">{s.detail}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EvidenceList({ items }: { items: EvidenceItemView[] }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="evidence-list-section">
      <p className="text-sm font-bold text-ink">
        근거 <span className="font-medium text-neutral-400">{items.length}건</span>
      </p>
      {items.length === 0 ? (
        <p className="text-[13px] text-neutral-500" data-testid="evidence-list-empty">
          이 판정에는 참조된 근거가 없습니다.
        </p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-1.5" data-testid="evidence-list">
          {items.map((item) => (
            <li key={item.id}>
              <EvidenceItem item={item} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EvidenceItem({ item }: { item: EvidenceItemView }) {
  const badge = (
    <Badge tone={LABEL_TONE[item.label]} title={item.labelDescription}>
      {item.label}
    </Badge>
  );
  const body = (
    <>
      {item.label === "추정" ? (
        <span data-interpretation="true" className="contents">
          {badge}
        </span>
      ) : (
        badge
      )}
      <span className="flex min-w-0 flex-col gap-0.5">
        {item.testId ? (
          <code className="truncate font-mono text-[12px] text-neutral-800">{item.testId}</code>
        ) : null}
        {item.locationLabel ? (
          <code className="truncate font-mono text-[12px] text-neutral-500">
            {item.locationLabel}
          </code>
        ) : null}
        {item.llm?.suggestion ? (
          <span className="flex min-w-0 flex-col" data-testid="design-suggestion">
            <span className="font-semibold text-neutral-800" data-testid="design-suggestion-points">
              제안 {item.llm.suggestion.suggestedPoints}/{item.llm.suggestion.maxPoints} · 사람 확인
              전
            </span>
            <span className="whitespace-pre-wrap text-neutral-700">
              {item.llm.suggestion.rationale}
            </span>
          </span>
        ) : null}
        {!item.testId && !item.locationLabel && !item.llm?.suggestion ? (
          <span className="text-neutral-500">
            {item.label === "사람 검토" ? "검토 이력의 사유가 근거입니다" : "실행 기록"}
          </span>
        ) : null}
        {item.llm?.confidence ? (
          <span className="text-neutral-500">{CONFIDENCE_LABEL[item.llm.confidence]}</span>
        ) : null}
      </span>
      {item.hrefTarget ? (
        <span className="ml-auto shrink-0 font-semibold text-primary">
          {item.hrefTarget === "run" ? "재생 →" : "코드 →"}
        </span>
      ) : null}
    </>
  );
  const className =
    "flex min-w-0 items-center gap-2.5 rounded-lg border border-neutral-200 px-3 py-2.5 text-[13px] transition-colors";
  return item.href ? (
    <a
      href={item.href}
      className={`${className} hover:border-neutral-300 hover:bg-neutral-50`}
      data-testid="evidence-item"
      data-evidence-id={item.id}
      data-evidence-kind={item.kind ?? "none"}
      data-href-target={item.hrefTarget ?? undefined}
    >
      {body}
    </a>
  ) : (
    <div
      className={className}
      data-testid="evidence-item"
      data-evidence-id={item.id}
      data-evidence-kind={item.kind ?? "none"}
    >
      {body}
    </div>
  );
}

function HistorySection({
  history,
  scope,
}: {
  history: ReviewHistoryItemView[];
  scope: EvidencePanelView["historyScope"];
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="review-history">
      <p className="text-sm font-bold text-ink">
        검토 이력 {history.length}건{scope === "evaluation" ? " · 평가 전체" : ""}
      </p>
      {history.length === 0 ? (
        <p className="text-[13px] text-neutral-500" data-testid="review-history-empty">
          아직 검토·이의·수정 기록이 없습니다.
        </p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-2" data-testid="review-history-list">
          {history.map((item) => (
            <li
              key={item.id}
              className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-neutral-200 px-3 py-2.5 text-[13px]"
              data-testid="review-event"
              data-review-kind={item.kind}
              data-criterion={item.criterionId}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{item.kindLabel}</Badge>
                {scope === "evaluation" ? (
                  <code className="font-mono text-[12px] text-neutral-600">{item.criterionId}</code>
                ) : null}
                <span className="font-semibold text-neutral-800" data-testid="review-reviewer">
                  {item.reviewer}
                </span>
                <time
                  dateTime={item.createdAt}
                  className="ml-auto text-[12px] text-neutral-500 tabular-nums"
                  data-testid="review-time"
                >
                  {formatReviewTime(item.createdAt)}
                </time>
              </div>
              <p
                className="font-semibold text-neutral-800 tabular-nums"
                data-testid="review-change"
              >
                {item.previous.points} → {item.next.points}
                {item.verdictChanged
                  ? ` · ${VERDICT_LABEL[item.previous.verdict]} → ${VERDICT_LABEL[item.next.verdict]}`
                  : ""}
                {item.reviewStateChanged
                  ? ` · ${REVIEW_STATE_LABEL[item.previous.reviewState]} → ${REVIEW_STATE_LABEL[item.next.reviewState]}`
                  : ""}
              </p>
              <p
                className="leading-relaxed break-words whitespace-pre-wrap text-neutral-700"
                data-testid="review-reason"
              >
                {item.reason}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
