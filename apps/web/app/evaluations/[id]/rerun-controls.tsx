"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { buttonClass } from "@/components/ui";
import { requestRerunAction } from "@/lib/reruns/actions";
import {
  rerunJobView,
  type ReplayRerunControlView,
  type ReplayRerunJobView,
} from "@/lib/workbench/replay";

/**
 * `재실행` 버튼과 진행 상태 (TICKET.md T-307). `재생`(저장된 기록 강조)과 달리 같은 조건으로 새 실행 기록을 만든다.
 * - 클릭 → 서버 액션 `requestRerunAction`이 `RERUN_EXECUTION` job을 넣는다 (dedupeKey로 중복 방지).
 * - job이 QUEUED·RUNNING인 동안 `GET /api/evaluations/[id]/reruns`를 폴링한다 (1.1: 상태 갱신은 폴링).
 * - SUCCEEDED면 `router.refresh()`로 서버 컴포넌트를 다시 그려 새 기록이 목록에 나타난다. 기존 기록은 그대로다 (G-03).
 * - FAILED면 `재실행 실패`와 사유, 원본 기록 열기 링크를 보인다. 성공으로 표시하지 않는다 (G-14).
 * 워커의 거부(환경 digest 불일치 등, `CODE: 사유`)는 `재실행 거부`로 구분한다.
 */

export const RERUN_POLL_INTERVAL_MS = 2000;

interface StatusResponse {
  ok: boolean;
  data?: { jobs: Array<Parameters<typeof rerunJobView>[0]> };
  message?: string;
}

function latestJobFor(
  jobs: Array<Parameters<typeof rerunJobView>[0]>,
  caseId: string,
): ReplayRerunJobView | null {
  const mine = jobs.filter((j) => j.caseId === caseId);
  const last = mine.at(-1);
  return last ? rerunJobView(last) : null;
}

export function RerunControls({ control }: { control: ReplayRerunControlView }) {
  const [job, setJob] = useState<ReplayRerunJobView | null>(control.latestJob);
  const [message, setMessage] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // 서버가 새 상태를 그리면(refresh) 그 값으로 맞춘다 (렌더 중 prop 변화를 감지해 상태를 갱신하는 React 패턴)
  const [seenLatest, setSeenLatest] = useState(control.latestJob);
  if (control.latestJob !== seenLatest) {
    setSeenLatest(control.latestJob);
    setJob(control.latestJob);
  }

  const active = job?.active ?? false;
  const enabled = control.enabled && !active && !pending;
  const disabledReason = active
    ? `이 케이스의 재실행이 ${job!.label}입니다`
    : (control.disabledReason ?? null);

  const onClick = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await requestRerunAction(control.evaluationId, control.caseId);
      if (!result.ok) {
        setMessage(`재실행을 요청하지 못했습니다: ${result.message}`);
        return;
      }
      const next = latestJobFor(result.data.status.jobs, control.caseId);
      setJob(next);
      setMessage(
        result.data.created
          ? "재실행을 요청했습니다. 워커가 처리하면 새 기록이 추가됩니다."
          : "이미 같은 케이스의 재실행이 진행 중입니다.",
      );
    });
  };

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5"
      data-testid="rerun-controls"
      data-case-id={control.caseId}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={!enabled}
        aria-disabled={enabled ? undefined : "true"}
        data-testid="rerun-button"
        data-rerun-enabled={enabled ? "true" : "false"}
        title={disabledReason ?? "같은 SHA·기준·환경으로 이 케이스를 다시 실행합니다"}
        className={`${buttonClass("secondary", "sm")} min-w-18 disabled:hover:bg-surface`}
      >
        {pending ? "요청 중…" : "재실행"}
      </button>
      <span className="text-[13px] text-neutral-500">
        같은 조건으로 새 실행 기록을 만듭니다 · {control.used}/{control.limit}회 사용
      </span>
      {disabledReason && !active ? (
        <span className="text-[13px] text-neutral-500" data-testid="rerun-disabled-reason">
          {disabledReason}
        </span>
      ) : null}
      {job ? <RerunJobStatus job={job} control={control} /> : null}
      {job?.active ? (
        <RerunPoller
          job={job}
          control={control}
          onUpdate={(next) => {
            setPollError(null);
            setJob(next);
            if (!next.active) {
              setMessage(
                next.kind === "succeeded"
                  ? "재실행이 끝났습니다. 새 실행 기록이 목록에 추가됩니다."
                  : "재실행이 실패했습니다. 기존 기록은 그대로입니다.",
              );
            }
          }}
          onError={setPollError}
        />
      ) : null}
      {message ? (
        <span
          className="text-[13px] font-medium text-neutral-800"
          data-testid="rerun-message"
          role="status"
        >
          {message}
        </span>
      ) : null}
      {pollError ? (
        <span className="text-[13px] text-neutral-500" data-testid="rerun-poll-error">
          상태 조회 오류: {pollError}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 활성 job이 있는 동안만 마운트되어 상태 API를 폴링한다. 끝나면 `router.refresh()`로 서버 컴포넌트를 다시 그린다.
 * (`useRouter`는 앱 라우터 문맥이 필요하므로 폴링이 필요한 때에만 마운트한다)
 */
function RerunPoller({
  job,
  control,
  onUpdate,
  onError,
}: {
  job: ReplayRerunJobView;
  control: ReplayRerunControlView;
  onUpdate: (next: ReplayRerunJobView) => void;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetch(control.statusUrl, { cache: "no-store" });
        const body = (await response.json()) as StatusResponse;
        if (cancelled) return;
        if (!body.ok || !body.data) {
          onError(body.message ?? `상태 조회 실패 (${response.status})`);
          return;
        }
        const next = latestJobFor(body.data.jobs, control.caseId);
        if (!next) return;
        onUpdate(next);
        if (!next.active) router.refresh();
      } catch (error) {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), RERUN_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // job.id가 바뀌면(새 요청) 다시 폴링한다
  }, [job.id, control.statusUrl, control.caseId, router, onUpdate, onError]);
  return null;
}

function RerunJobStatus({
  job,
  control,
}: {
  job: ReplayRerunJobView;
  control: ReplayRerunControlView;
}) {
  const rejected = job.kind === "failed" && job.rejectionCode !== null;
  const label = rejected ? `재실행 거부 (${job.rejectionCode})` : job.label;
  const tone =
    job.kind === "failed"
      ? "border-neutral-900 text-neutral-900"
      : job.kind === "succeeded"
        ? "border-neutral-400 text-neutral-700"
        : "border-neutral-400 text-neutral-600";
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]"
      data-testid="rerun-status"
      data-rerun-status={job.kind}
      data-rerun-job={job.id}
      data-rerun-rejected={rejected ? "true" : undefined}
    >
      <span
        className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${tone}`}
        data-testid="rerun-status-label"
      >
        {label}
      </span>
      {job.active ? (
        <span className="text-neutral-500">
          시도 {job.attempts}/{job.maxAttempts} · 워커가 처리하면 갱신됩니다
        </span>
      ) : null}
      {job.kind === "failed" ? (
        <>
          <span className="text-neutral-700" data-testid="rerun-failure-reason">
            {job.lastError ?? "사유 없음"}
          </span>
          {control.originalHref ? (
            <a
              href={control.originalHref}
              className="font-semibold text-primary hover:underline"
              data-testid="rerun-original-link"
            >
              원본 기록 열기
            </a>
          ) : null}
        </>
      ) : null}
      {job.active && job.lastError ? (
        <span className="text-neutral-500" data-testid="rerun-retry-reason">
          직전 시도 실패: {job.lastError}
        </span>
      ) : null}
    </span>
  );
}
