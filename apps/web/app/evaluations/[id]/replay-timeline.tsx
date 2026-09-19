"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createReplayPlayer } from "@/lib/workbench/replay-player";
import type {
  ReplayRerunControlView,
  ReplayTimelineGroupView,
  ReplayTimelineRowView,
} from "@/lib/workbench/replay";
import { buttonClass } from "@/components/ui";
import { RerunControls } from "./rerun-controls";

/**
 * 요청·상태 타임라인 표와 `재생`·`재실행` 버튼 (T-303).
 * 표의 모든 값은 서버가 `runs/[runId]` 본문에서 옮긴 props다. 이 컴포넌트는 값을 만들지 않으며
 * `재생`은 이미 그려진 줄을 순서대로 강조할 뿐 네트워크 요청을 보내지 않는다 (`fetch`를 참조하지 않는다).
 * `재실행`(T-307, `RerunControls`)은 같은 조건으로 새 실행 기록을 만드는 별도 동작이다. 두 버튼의 문구와 설명을 구분한다 (PRD 2장 W1).
 */

const GRID = "grid grid-cols-[2.75rem_6.5rem_minmax(0,1fr)_3.5rem_4.5rem_minmax(0,1.2fr)] gap-x-3";

export function ReplayTimeline({
  groups,
  replaySeqs,
  rerun = null,
}: {
  groups: ReplayTimelineGroupView[];
  replaySeqs: number[];
  /** `재실행` 버튼 상태. 하네스 케이스 기록이 아니면 null (버튼 비활성) */
  rerun?: ReplayRerunControlView | null;
}) {
  const [activeSeq, setActiveSeq] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const player = useMemo(
    () =>
      createReplayPlayer({
        seqs: replaySeqs,
        onStep: (seq) => {
          setActiveSeq(seq);
          setPlaying(seq !== null);
        },
      }),
    [replaySeqs],
  );
  useEffect(() => () => player.stop(), [player]);
  useEffect(() => {
    if (activeSeq === null || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-replay-seq="${activeSeq}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeSeq]);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="replay-timeline">
      <div className="flex min-w-0 flex-col gap-3 rounded-lg bg-neutral-50 p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <button
            type="button"
            onClick={() => (playing ? player.stop() : player.start())}
            disabled={replaySeqs.length === 0}
            data-testid="replay-button"
            data-playing={playing ? "true" : "false"}
            className={`${buttonClass("primary", "sm")} min-w-18`}
          >
            {playing ? "재생 중지" : "재생"}
          </button>
          <span className="text-[13px] text-neutral-500">
            저장된 기록을 순서대로 강조합니다. 네트워크 요청 없음
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-neutral-200 pt-3">
          {rerun ? (
            <RerunControls control={rerun} />
          ) : (
            <>
              <button
                type="button"
                disabled
                aria-disabled="true"
                data-testid="rerun-button"
                data-rerun-enabled="false"
                title="하네스 케이스 기록에서만 재실행할 수 있습니다"
                className={`${buttonClass("secondary", "sm")} min-w-18`}
              >
                재실행
              </button>
              <span className="text-[13px] text-neutral-500">
                같은 조건으로 새 실행 기록을 만듭니다 (하네스 케이스 기록에서만)
              </span>
            </>
          )}
        </div>
      </div>

      <div className="min-w-0 overflow-x-auto rounded-lg border border-neutral-200">
        <div className="min-w-[640px]">
          <div
            className={`${GRID} border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] font-semibold text-neutral-500`}
            role="row"
          >
            <span>seq</span>
            <span>종류</span>
            <span>method + path</span>
            <span>status</span>
            <span className="text-right">elapsed</span>
            <span>stateAfter</span>
          </div>
          <ol
            ref={listRef}
            className="flex flex-col divide-y divide-neutral-100"
            data-testid="timeline-rows"
          >
            {groups.map((group) => {
              const active = activeSeq !== null && group.rows[0]!.seq === activeSeq;
              return (
                <li
                  key={group.key}
                  data-replay-seq={group.rows[0]!.seq}
                  data-active={active ? "true" : undefined}
                  className={`transition-colors ${active ? "bg-primary/5 shadow-[inset_3px_0_0_var(--color-primary)]" : ""}`}
                >
                  {group.parallel ? (
                    <ParallelGroup group={group} />
                  ) : (
                    <TimelineRow row={group.rows[0]!} />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

function statusText(row: ReplayTimelineRowView): string {
  if (row.status !== null) return String(row.status);
  return row.error ? row.error.kind : "-";
}

function TimelineRow({ row, nested = false }: { row: ReplayTimelineRowView; nested?: boolean }) {
  return (
    <details
      data-timeline-row={row.seq}
      data-kind={row.kind}
      data-status={row.status ?? undefined}
      className={`group ${nested ? "pl-4" : ""}`}
    >
      <summary
        className={`${GRID} cursor-pointer list-none items-baseline px-3 py-2 text-[13px] hover:bg-neutral-50`}
      >
        <span className="font-mono text-neutral-400">{row.seq}</span>
        <span className="truncate" title={row.capture ?? undefined}>
          {row.kindLabel}
          {row.capture ? <span className="text-neutral-400"> · {row.capture}</span> : null}
        </span>
        <span className="truncate font-mono" title={`${row.method} ${row.path}`}>
          <span className="font-semibold">{row.method}</span> {row.path}
        </span>
        <span className="font-mono" data-testid="timeline-status">
          {statusText(row)}
        </span>
        <span className="text-right font-mono text-neutral-500">{row.elapsedMs} ms</span>
        <span
          className="font-mono break-words whitespace-normal text-neutral-800"
          data-testid="timeline-state-after"
          data-has-state={row.stateAfterDisplay === null ? "false" : "true"}
          title={row.stateAfterDisplay ?? undefined}
        >
          {row.stateAfterDisplay ?? <span className="text-neutral-300">-</span>}
        </span>
      </summary>
      <div className="grid grid-cols-2 gap-4 bg-neutral-50/60 px-3 pt-2 pb-3 text-[13px]">
        <Exchange
          title="요청"
          headers={row.requestHeaders}
          body={row.requestBodyDisplay}
          testId="timeline-request"
        />
        {row.responseHeaders !== null ? (
          <Exchange
            title="응답"
            headers={row.responseHeaders}
            body={row.responseBodyDisplay ?? "(없음)"}
            testId="timeline-response"
          />
        ) : (
          <div data-testid="timeline-response" className="text-neutral-600">
            <p className="font-semibold">응답 없음</p>
            {row.error ? (
              <p>
                {row.error.kind}: {row.error.message}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </details>
  );
}

function Exchange({
  title,
  headers,
  body,
  testId,
}: {
  title: string;
  headers: Record<string, string>;
  body: string;
  testId: string;
}) {
  const entries = Object.entries(headers);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <p className="font-semibold text-neutral-800">{title}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 font-mono text-[12px] text-neutral-600">
        {entries.length === 0 ? <dd className="col-span-2 text-neutral-400">헤더 없음</dd> : null}
        {entries.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-neutral-500">{name}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <pre className="max-h-48 overflow-auto rounded-lg border border-neutral-200 bg-surface p-2.5 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
        {body}
      </pre>
    </div>
  );
}

function ParallelGroup({ group }: { group: ReplayTimelineGroupView }) {
  const first = group.rows[0]!;
  return (
    <details data-timeline-group={first.stepIndex} data-kind="parallel" className="group">
      <summary
        className={`${GRID} cursor-pointer list-none items-baseline px-3 py-2 text-[13px] hover:bg-neutral-50`}
      >
        <span className="font-mono text-neutral-400">
          {first.seq}–{group.rows.at(-1)!.seq}
        </span>
        <span className="truncate">{group.label}</span>
        <span className="truncate font-mono" title={`${first.method} ${first.path}`}>
          <span className="font-semibold">{first.method}</span> {first.path}
        </span>
        <span className="truncate font-mono" title={group.rows.map(statusText).join(", ")}>
          {group.rows.map(statusText).join(", ")}
        </span>
        <span className="text-right font-mono text-neutral-500">{first.elapsedMs} ms</span>
        <span className="text-neutral-300">-</span>
      </summary>
      <ol className="flex flex-col border-l border-neutral-200">
        {group.rows.map((row) => (
          <li key={row.seq}>
            <TimelineRow row={row} nested />
          </li>
        ))}
      </ol>
    </details>
  );
}
