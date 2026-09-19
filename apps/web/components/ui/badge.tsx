import type { ReactNode } from "react";
import type { ReviewState, Verdict } from "@ohmyti/core";

/**
 * 배지 색 규칙 (T-301). `fail`은 실제 실패(verdict FAIL)에만, `pending`은 미확정(INCONCLUSIVE·PENDING, T-305의 LLM `추정` 라벨)에만 쓴다.
 * 그 밖은 회색 계열이다. `data-tone`으로 테스트가 클래스와 대조한다.
 */
export type BadgeTone = "neutral" | "ink" | "fail" | "pending";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "border-transparent bg-neutral-100 text-neutral-700",
  ink: "border-transparent bg-ink text-surface",
  fail: "border-transparent bg-fail text-surface",
  pending: "border-pending/30 bg-pending/10 text-pending",
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
  "data-testid"?: string;
}

export function Badge({ tone = "neutral", children, className, title, ...rest }: BadgeProps) {
  return (
    <span
      data-tone={tone}
      data-testid={rest["data-testid"]}
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  PASS: "통과",
  FAIL: "실패",
  PARTIAL: "부분",
  INCONCLUSIVE: "미확정",
};

/** verdict → 색. FAIL만 fail, INCONCLUSIVE만 pending, PASS는 차콜, PARTIAL은 회색이다 */
export function verdictTone(verdict: Verdict): BadgeTone {
  switch (verdict) {
    case "FAIL":
      return "fail";
    case "INCONCLUSIVE":
      return "pending";
    case "PASS":
      return "ink";
    case "PARTIAL":
      return "neutral";
  }
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span data-verdict={verdict} className="contents">
      <Badge tone={verdictTone(verdict)}>{VERDICT_LABEL[verdict]}</Badge>
    </span>
  );
}

export const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  NOT_REQUIRED: "자동 판정",
  PENDING: "검토 대기",
  CONFIRMED: "사람 확인",
};

/** reviewState → 색. PENDING만 pending이다 */
export function reviewStateTone(state: ReviewState): BadgeTone {
  return state === "PENDING" ? "pending" : "neutral";
}

export function ReviewStateBadge({ state }: { state: ReviewState }) {
  return (
    <span data-review-state={state} className="contents">
      <Badge tone={reviewStateTone(state)}>{REVIEW_STATE_LABEL[state]}</Badge>
    </span>
  );
}
