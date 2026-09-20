import type { StageView, SubmissionStatusView } from "@/lib/submissions/service";

/**
 * 7단계 세로 스테퍼 (PRD 6장 ②). `stage_log`에서 만든 `StageView`만 그린다.
 * 진행률 바·퍼센트는 두지 않는다. 완료된 단계는 기록된 결과 요약만 보여 준다.
 * 색: 실패·미지원 빨강(fail), 진행 중 파랑(primary, 정보), 완료 차콜, 대기·건너뜀 회색.
 */

/** 단계 번호 원 */
const DOT_CLASS: Record<StageView["state"], string> = {
  PENDING: "border-2 border-neutral-200 bg-surface text-neutral-400",
  RUNNING: "border-2 border-primary bg-surface text-primary ring-4 ring-primary/10",
  DONE: "bg-ink text-surface",
  SKIPPED: "border-2 border-dashed border-neutral-300 bg-surface text-neutral-400",
  FAILED: "bg-fail text-surface",
  UNSUPPORTED: "border-2 border-fail bg-surface text-fail",
};

/** 상태 라벨 */
const STATE_CLASS: Record<StageView["state"], string> = {
  PENDING: "bg-neutral-100 text-neutral-500",
  RUNNING: "bg-primary/8 text-primary",
  DONE: "bg-ink text-surface",
  SKIPPED: "bg-neutral-100 text-neutral-500",
  FAILED: "bg-fail text-surface",
  UNSUPPORTED: "bg-fail/10 text-fail",
};

/** 다음 단계로 이어지는 세로선. 끝난 단계 아래만 진하게 긋는다 */
const LINE_CLASS: Record<StageView["state"], string> = {
  PENDING: "bg-neutral-200",
  RUNNING: "bg-neutral-200",
  DONE: "bg-ink",
  SKIPPED: "bg-neutral-200",
  FAILED: "bg-neutral-200",
  UNSUPPORTED: "bg-neutral-200",
};

const FAILURE_KIND_LABEL: Record<NonNullable<StageView["failureKind"]>, string> = {
  NONE: "-",
  ASSERTION: "판정 실패",
  SUBMISSION: "제출 코드 오류",
  ENVIRONMENT: "환경 장애",
  TIMEOUT: "시간 초과 (환경)",
};

export function formatTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("ko-KR", { hour12: false, timeZone: "Asia/Seoul" });
}

function StageDot({ state, index }: { state: StageView["state"]; index: number }) {
  return (
    <span
      aria-hidden="true"
      className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold ${DOT_CLASS[state]}`}
    >
      {state === "DONE" ? (
        <svg
          viewBox="0 0 16 16"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
        >
          <path d="M3.5 8.5 6.5 11.5 12.5 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : state === "FAILED" || state === "UNSUPPORTED" ? (
        "!"
      ) : (
        index + 1
      )}
    </span>
  );
}

export function StageList({
  stages,
  reference,
}: {
  stages: StageView[];
  /** 단계별 참고 시간을 잰 저장된 실행 (T-904). 없으면 시간을 보이지 않는다 */
  reference?: { href: string; label: string } | null;
}) {
  return (
    <ol className="flex flex-col" data-testid="stage-list">
      {stages.map((stage, index) => {
        const last = index === stages.length - 1;
        const hasTime = stage.startedAt !== null || stage.finishedAt !== null;
        return (
          <li
            key={stage.stage}
            data-stage={stage.stage}
            data-state={stage.state}
            className="relative flex gap-4"
          >
            {!last ? (
              <span
                aria-hidden="true"
                className={`absolute top-9 bottom-1 left-[15px] w-0.5 rounded-full ${LINE_CLASS[stage.state]}`}
              />
            ) : null}
            <StageDot state={stage.state} index={index} />
            <div className={`flex min-w-0 flex-1 flex-col gap-1.5 pt-1 ${last ? "" : "pb-7"}`}>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                <span
                  className={`text-base font-bold tracking-tight ${stage.state === "PENDING" || stage.state === "SKIPPED" ? "text-neutral-500" : "text-ink"}`}
                >
                  {stage.label}
                </span>
                <span
                  className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${STATE_CLASS[stage.state]}`}
                  data-testid={`stage-state-${stage.stage}`}
                >
                  {stage.stateLabel}
                </span>
                {stage.failureKind ? (
                  <span className="text-[13px] font-semibold text-fail">
                    {FAILURE_KIND_LABEL[stage.failureKind]}
                  </span>
                ) : null}
                {hasTime ? (
                  <span className="text-[13px] text-neutral-500 tabular-nums sm:ml-auto">
                    {formatTime(stage.startedAt)} → {formatTime(stage.finishedAt)}
                  </span>
                ) : null}
              </div>
              <p className="text-sm leading-relaxed text-neutral-500">{stage.description}</p>
              {reference && stage.referenceSeconds !== null ? (
                <p
                  className="text-[13px] text-neutral-500"
                  data-testid={`stage-reference-${stage.stage}`}
                >
                  {`저장된 실행에서 잰 소요 시간 ${stage.referenceSeconds}초 (참고값, `}
                  <a href={reference.href} className="font-semibold text-primary hover:underline">
                    {reference.label}
                  </a>
                  {")"}
                </p>
              ) : null}
              {stage.summary ? (
                <p className="text-sm leading-relaxed text-neutral-600">{stage.summary}</p>
              ) : null}
              {stage.reason ? (
                <p
                  className={`text-sm leading-relaxed ${stage.state === "SKIPPED" ? "text-neutral-500" : "text-fail"}`}
                >
                  {stage.reason}
                </p>
              ) : null}
              {stage.unsupportedReasons.length > 0 ? (
                <UnsupportedReasons reasons={stage.unsupportedReasons} />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function UnsupportedReasons({
  reasons,
}: {
  reasons: SubmissionStatusView["submission"]["unsupportedReasons"];
}) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm" data-testid="unsupported-reasons">
      {reasons.map((reason, index) => (
        <li
          key={`${reason.code}-${index}`}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
        >
          {reason.code ? (
            <code className="rounded bg-fail/10 px-1.5 py-0.5 font-mono text-xs text-fail">
              {reason.code}
            </code>
          ) : null}
          <span className="text-neutral-800">{reason.detail}</span>
        </li>
      ))}
    </ul>
  );
}
