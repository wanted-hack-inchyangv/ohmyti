"use client";

import { useEffect, useState } from "react";
import { Badge, buttonClass } from "@/components/ui";
import type { DemoResult, DemoRunStatusView } from "@/lib/demo/service";

export const DEMO_POLL_INTERVAL_MS = 3000;

const PHASE_LABEL: Record<DemoRunStatusView["phase"], string> = {
  WAITING: "대기 중",
  RUNNING: "실행 중",
  SUCCEEDED: "새 실행 완료",
  FAILED: "새 실행 실패",
};

/**
 * 새 실행 상태 (T-505). 끝나기 전에는 결과를 보이지 않고, 실패하면 사유와 이전의 저장된 실행 링크를 보인다.
 * 실패 화면에서 저장된 실행을 열 수 있지만 그것을 이번 실행의 결과로 표시하지 않는다 (PRD 7장).
 * 워커 응답 없음으로 실패한 경우에도 job은 대기열에 남아 있으므로 폴링을 계속한다.
 */
export function DemoRunStatus({ initial }: { initial: DemoRunStatusView }) {
  const [view, setView] = useState(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const id = view.submissionId;
  const terminal = view.terminal;

  useEffect(() => {
    if (terminal) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/demo/runs/${id}`, {
            headers: { accept: "application/json" },
            cache: "no-store",
          });
          const body = (await response.json()) as DemoResult<DemoRunStatusView>;
          if (cancelled) return;
          if (!body.ok) {
            setPollError(`${body.code}: ${body.message}`);
            return;
          }
          setPollError(null);
          setView(body.data);
        } catch {
          if (!cancelled) setPollError("상태를 읽지 못했습니다. 연결을 확인한 뒤 계속 기다립니다");
        }
      })();
    }, DEMO_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, terminal]);

  return (
    <div
      className="flex flex-col gap-6"
      data-testid="demo-run-status"
      data-phase={view.phase}
      data-terminal={terminal ? "true" : "false"}
    >
      <section className="flex flex-col gap-5 rounded-xl border border-neutral-200 bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={view.phase === "SUCCEEDED" ? "ink" : "neutral"} data-testid="demo-run-phase">
            {PHASE_LABEL[view.phase]}
          </Badge>
          <Badge tone="neutral">샘플</Badge>
          {!terminal ? (
            <span className="inline-flex items-center gap-1.5 text-[13px] text-neutral-500">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
              />
              {DEMO_POLL_INTERVAL_MS / 1000}초마다 상태를 다시 읽습니다
            </span>
          ) : null}
        </div>
        <p className="text-[15px] leading-relaxed text-ink" data-testid="demo-run-message">
          {view.message}
        </p>
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-2.5 text-sm">
          <dt className="text-neutral-500">제출 상태</dt>
          <dd className="font-mono text-[13px]">{view.submissionStatus}</dd>
          <dt className="text-neutral-500">작업 상태</dt>
          <dd className="font-mono text-[13px]">{view.jobStatus ?? "없음"}</dd>
          {view.runningStage ? (
            <>
              <dt className="text-neutral-500">진행 단계</dt>
              <dd className="font-mono text-[13px]">{view.runningStage}</dd>
            </>
          ) : null}
        </dl>
        {view.failureReason ? (
          <p
            className="rounded-lg bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-800 ring-1 ring-neutral-200"
            data-testid="demo-run-failure"
          >
            실패 사유: {view.failureReason}
          </p>
        ) : null}
        {view.evaluationHref ? (
          <a
            href={view.evaluationHref}
            className={`${buttonClass("primary", "lg")} w-full sm:w-auto sm:self-start`}
            data-testid="demo-run-result-link"
          >
            이번 실행 결과 열기
          </a>
        ) : null}
        {pollError ? <p className="text-[13px] text-neutral-600">{pollError}</p> : null}
      </section>

      {view.phase === "FAILED" ? (
        <section
          className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-surface p-5 sm:p-6"
          data-testid="demo-run-saved"
        >
          <h2 className="text-lg font-bold tracking-tight">이전의 저장된 실행</h2>
          {view.saved ? (
            <>
              <p className="text-[15px] leading-relaxed text-neutral-600">
                이번 실행의 결과가 아닙니다. 이전에 실제로 실행해 저장한 기록입니다.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <a
                  href={view.saved.href}
                  className={`${buttonClass("secondary", "md")} w-full sm:w-auto`}
                  data-testid="demo-run-saved-link"
                >
                  {view.saved.label} 워크벤치 열기
                </a>
              </div>
            </>
          ) : (
            <p className="text-[15px] text-neutral-600">이 샘플의 저장된 실행이 없습니다.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
