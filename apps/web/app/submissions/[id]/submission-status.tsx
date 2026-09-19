"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { retrySubmissionAction } from "@/lib/submissions/actions";
import type { SubmissionActionResult, SubmissionStatusView } from "@/lib/submissions/service";
import { buttonClass } from "@/components/ui";
import { ResumeTextPanel } from "./resume-text-panel";
import { StageList, UnsupportedReasons, formatTime } from "./stage-list";

export const POLL_INTERVAL_MS = 3000;

const STATUS_CLASS: Record<SubmissionStatusView["submission"]["status"], string> = {
  RECEIVED: "bg-neutral-100 text-neutral-700",
  QUEUED: "bg-neutral-100 text-neutral-700",
  RUNNING: "bg-primary/8 text-primary",
  COMPLETED: "bg-ink text-surface",
  FAILED: "bg-fail text-surface",
  UNSUPPORTED: "bg-fail/10 text-fail",
  DELETED: "bg-neutral-100 text-neutral-500",
};

interface SubmissionStatusProps {
  initial: SubmissionStatusView;
}

/**
 * 서버가 그린 초기 상태에서 시작해 `terminal`이 아닐 때만 3초마다 `/api/submissions/<id>/status`를 읽는다.
 * 종료 상태(COMPLETED·FAILED·UNSUPPORTED)면 타이머를 만들지 않으므로 새로고침해도 폴링 요청이 없다.
 */
export function SubmissionStatus({ initial }: SubmissionStatusProps) {
  const [view, setView] = useState(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, startRetry] = useTransition();
  const router = useRouter();
  const id = view.submission.id;
  const terminal = view.terminal;

  useEffect(() => {
    if (terminal) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/submissions/${id}/status`, {
            headers: { accept: "application/json" },
            cache: "no-store",
          });
          const body = (await response.json()) as SubmissionActionResult<SubmissionStatusView>;
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
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, terminal]);

  function onRetry() {
    setRetryError(null);
    startRetry(async () => {
      let result: SubmissionActionResult<{ submissionId: string }>;
      try {
        result = await retrySubmissionAction(id);
      } catch {
        setRetryError("재시도 요청을 보내지 못했습니다. 잠시 후 다시 시도해 주세요");
        return;
      }
      if (!result.ok) {
        setRetryError(`${result.code}: ${result.message}`);
        return;
      }
      router.push(`/submissions/${result.data.submissionId}`);
    });
  }

  const { submission } = view;

  return (
    <div className="flex flex-col gap-8" data-testid="submission-status" data-terminal={terminal}>
      <section className="flex flex-col gap-5 rounded-xl border border-neutral-200 bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-md px-2.5 py-1 text-sm font-bold ${STATUS_CLASS[submission.status]}`}
            data-testid="submission-status-badge"
          >
            {submission.statusLabel}
          </span>
          {submission.isSample ? (
            <span className="inline-flex items-center rounded-md bg-neutral-100 px-2 py-1 text-xs font-semibold text-neutral-700">
              {submission.status === "COMPLETED" ? "저장된 실행 (샘플)" : "샘플"}
            </span>
          ) : null}
          {!terminal ? (
            <span
              className="inline-flex items-center gap-1.5 text-[13px] text-neutral-500"
              data-testid="polling-indicator"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
              />
              {POLL_INTERVAL_MS / 1000}초마다 상태를 다시 읽습니다
            </span>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[15px] sm:grid-cols-[7.5rem_1fr] sm:gap-y-3">
          <dt className="text-sm text-neutral-500">과제</dt>
          <dd className="mb-3 font-medium sm:mb-0">{submission.assignmentLabel ?? "-"}</dd>
          <dt className="text-sm text-neutral-500">저장소</dt>
          <dd className="mb-3 break-all font-mono text-[13px] leading-relaxed sm:mb-0">
            {submission.repoUrl}
            {submission.repoRef ? ` @ ${submission.repoRef}` : ""}
          </dd>
          <dt className="text-sm text-neutral-500">고정 SHA</dt>
          <dd className="mb-3 break-all sm:mb-0">
            {submission.submissionSha ? (
              <span className="font-mono text-[13px]">{submission.submissionSha}</span>
            ) : (
              <span className="text-sm text-neutral-500">
                아직 고정되지 않음 (저장소 확인 단계에서 고정)
              </span>
            )}
          </dd>
          <dt className="text-sm text-neutral-500">이력서 · GitHub</dt>
          <dd className="mb-3 sm:mb-0">
            {view.context.hasResume ? "이력서 있음" : "이력서 없음"} ·{" "}
            {view.context.githubLogin ? `@${view.context.githubLogin}` : "GitHub 미제공"}
          </dd>
          <dt className="text-sm text-neutral-500">접수</dt>
          <dd className="tabular-nums">{formatTime(submission.createdAt)}</dd>
        </dl>

        {submission.status === "UNSUPPORTED" ? (
          <div className="flex flex-col gap-2 rounded-lg bg-fail/5 p-4 ring-1 ring-fail/20">
            <p className="text-[15px] font-bold text-fail">지원하지 않는 제출입니다</p>
            {submission.unsupportedReasons.length > 0 ? (
              <UnsupportedReasons reasons={submission.unsupportedReasons} />
            ) : (
              <p className="text-sm text-neutral-800">사유가 기록되지 않았습니다.</p>
            )}
            <p className="text-[13px] leading-relaxed text-neutral-600">
              MVP는 공개 GitHub 저장소와 승인된 TypeScript 주문 API 템플릿(고정 의존성)만
              실행합니다.
            </p>
          </div>
        ) : null}

        {submission.status === "FAILED" ? (
          <div className="flex flex-col gap-3 rounded-lg bg-fail/5 p-4 ring-1 ring-fail/20">
            <p className="text-[15px] font-bold text-fail">
              {view.retryable
                ? "환경 장애로 채점을 끝내지 못했습니다"
                : view.failureKind
                  ? "제출 코드 탓으로 채점이 실패했습니다"
                  : "채점이 실패했습니다"}
            </p>
            {view.evaluation === null ? (
              <p className="text-sm text-neutral-800">
                평가 기록이 만들어지기 전에 끝났습니다. 단계 기록이 없습니다.
              </p>
            ) : null}
            {view.retryable ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={retrying}
                  data-testid="retry-button"
                  className={buttonClass("primary", "md")}
                >
                  {retrying ? "재시도 준비 중…" : "같은 입력으로 재시도"}
                </button>
                <span className="text-[13px] leading-relaxed text-neutral-600">
                  고정된 커밋으로 새 제출을 만들어 다시 큐에 넣습니다. 이 기록은 그대로 남습니다.
                </span>
              </div>
            ) : null}
            {retryError ? (
              <p role="alert" className="text-sm font-medium text-fail">
                {retryError}
              </p>
            ) : null}
          </div>
        ) : null}

        {submission.status === "COMPLETED" && view.evaluation ? (
          <div className="flex flex-col gap-3 border-t border-neutral-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[15px]">
              채점이 끝났습니다.
              <span className="ml-2 text-[13px] text-neutral-500">
                평가 <span className="font-mono">{view.evaluation.id.slice(0, 8)}</span>
              </span>
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <a
                href={`/api/evaluations/${view.evaluation.id}`}
                className={buttonClass("ghost", "md")}
                data-testid="report-link"
              >
                리포트 JSON
              </a>
              <a
                href={`/evaluations/${view.evaluation.id}/report`}
                className={buttonClass("ghost", "md")}
                data-testid="hiring-report-link"
              >
                채용 리포트
              </a>
              <a
                href={`/evaluations/${view.evaluation.id}`}
                className={buttonClass("primary", "md")}
                data-testid="workbench-link"
              >
                채점 워크벤치 열기
              </a>
            </div>
          </div>
        ) : null}

        {pollError ? (
          <p role="alert" className="text-sm text-neutral-700">
            {pollError}
          </p>
        ) : null}
      </section>

      {view.context.hasResume ? (
        <ResumeTextPanel submissionId={id} initial={view.context.resumeText} />
      ) : null}

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold tracking-tight sm:text-xl">작업 단계</h2>
          <p className="text-sm text-neutral-500">워커가 기록한 단계 결과만 그대로 보여 줍니다.</p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-surface p-5 sm:p-6">
          {view.evaluation === null ? (
            <p className="mb-5 rounded-lg bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
              {terminal
                ? "평가 기록이 없습니다. 단계는 시작되지 않았습니다."
                : "워커가 저장소를 확인하면 단계 기록이 시작됩니다."}
            </p>
          ) : null}
          <StageList stages={view.stages} />
        </div>
      </section>
    </div>
  );
}
