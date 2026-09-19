"use client";

import { useState } from "react";
import type { KitPlanView } from "@/lib/workbench/interview-kit";

/**
 * 인터뷰 키트 진행안 (T-704). 45분·60분을 버튼으로 바꿔 본다. 구간과 시간은 저장된 진행안 그대로다.
 * 선택은 화면 안에서만 바뀌며 URL·서버 상태를 바꾸지 않는다.
 */
export function KitPlanSwitch({ plans }: { plans: readonly KitPlanView[] }) {
  const [duration, setDuration] = useState(plans[0]?.durationMinutes ?? 45);
  const plan = plans.find((p) => p.durationMinutes === duration) ?? plans[0];
  if (!plan) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="kit-plan">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-ink">진행안</span>
        <div role="group" aria-label="진행안 길이" className="flex gap-1">
          {plans.map((p) => {
            const active = p.durationMinutes === plan.durationMinutes;
            return (
              <button
                key={p.durationMinutes}
                type="button"
                aria-pressed={active ? "true" : "false"}
                data-plan-duration={p.durationMinutes}
                onClick={() => setDuration(p.durationMinutes)}
                className={`h-8 rounded-lg border px-3 text-[13px] font-semibold transition-colors ${active ? "border-ink bg-ink text-surface" : "border-neutral-300 bg-surface text-neutral-700 hover:bg-neutral-50"}`}
              >
                {p.durationMinutes}분
              </button>
            );
          })}
        </div>
        <span className="text-[13px] text-neutral-500" data-testid="kit-plan-total">
          구간 합 {plan.totalMinutes}분 / {plan.durationMinutes}분
        </span>
      </div>
      <KitPlanSegments plan={plan} />
    </div>
  );
}

export function KitPlanSegments({ plan }: { plan: KitPlanView }) {
  return (
    <ol
      className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200"
      data-plan={plan.durationMinutes}
    >
      {plan.segments.map((segment, index) => (
        <li
          key={`${segment.name}-${index}`}
          data-plan-segment={segment.name}
          data-minutes={segment.minutes}
          className="flex flex-col gap-1 px-3 py-2 text-[13px] sm:flex-row sm:items-baseline sm:gap-3"
        >
          <span className="flex shrink-0 items-baseline gap-2 sm:w-44">
            <span className="font-semibold text-ink">{segment.name}</span>
            <span className="text-neutral-500 tabular-nums">{segment.minutes}분</span>
          </span>
          {segment.questions.length > 0 ? (
            <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-neutral-600">
              {segment.questions.map((q) => (
                <a
                  key={q.anchorId}
                  href={`#${q.anchorId}`}
                  className="hover:text-primary hover:underline"
                >
                  Q{q.number} {q.label} · {q.minutes}분
                </a>
              ))}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
