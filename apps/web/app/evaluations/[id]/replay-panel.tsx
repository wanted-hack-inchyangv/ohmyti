import { Badge, EmptyState, PanelHeader } from "@/components/ui";
import { CENTER_PANES, CENTER_PANE_LABEL } from "@/lib/workbench/state";
import type {
  ReplayBodyView,
  ReplayCheckView,
  ReplayRerunComparisonView,
  ReplayRerunControlView,
  ReplayRunView,
} from "@/lib/workbench/replay";
import type { WorkbenchView } from "@/lib/workbench/view";
import { CodeEvidencePanel } from "./code-evidence-panel";
import { GraphPanel } from "./graph-panel";
import { MutationPanel } from "./mutation-panel";
import { ReplayTimeline } from "./replay-timeline";

/**
 * 중앙 패널: 실패 재생 뷰 (PRD 6장 ③, TICKET.md T-303).
 * 선택 기준의 실행 기록 목록 → 선택 기록의 기대/실제 비교 → 요청·상태 타임라인 → 러너 로그 키 순으로 보여 준다.
 * 모든 값은 `runs/[runId]` API와 같은 `readRunRecord` 결과를 옮긴 `view.replay`에서 온다. 이 패널은 관측만 보여 주며
 * 추정 문구(interpretation)는 두지 않는다 (결정 로그: 관측과 추정 분리). 하단 탭: 코드 근거(T-305, `CodeEvidencePanel`)·관련 함수 그래프(T-304, `GraphPanel`).
 * 재실행(T-307): RERUN 기록은 워커가 기록한 원본 비교 배지를, 타임라인 옆 `재실행` 버튼은 `view.replay.rerunControl`을 받는다.
 * 테스트 실효성 그룹(T-404)을 고르면 실행 기록 목록 위에 변형 실험(diff·검증 기록·제출 테스트 기록, `MutationPanel`)을 둔다.
 */

/** ISO 타임스탬프를 `YYYY-MM-DD HH:MM:SSZ`로. 시간대 변환 없이 문자열만 다듬는다(서버·클라이언트가 같은 값을 그린다) */
export function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+(?=Z$|[+-]\d{2}:\d{2}$)/, "");
}

/** 중앙 패널 안 소제목 */
const SECTION_TITLE = "text-sm font-bold text-ink";

export function ReplayPanel({ view }: { view: WorkbenchView }) {
  const selected = view.selectedCriterion;
  const { replay } = view;
  return (
    <section
      className="flex min-w-0 flex-col rounded-xl border border-neutral-200 bg-surface"
      data-panel="replay"
      data-selected-run={replay.selectedRun?.id}
    >
      <PanelHeader
        title="실패 재생 / 코드"
        aside={
          selected ? (
            <code className="font-mono text-[13px] text-neutral-600" data-testid="replay-criterion">
              {selected.id}
            </code>
          ) : null
        }
      />
      <div className="flex min-w-0 flex-col gap-5 p-4 sm:p-5">
        {view.unknownCriterionId ? (
          <p className="text-[13px] text-neutral-500" data-testid="unknown-criterion">
            기준 <code className="font-mono">{view.unknownCriterionId}</code>은(는) 이 기준 버전에
            없습니다.
          </p>
        ) : null}
        {view.unknownRunId ? (
          <p className="text-[13px] text-neutral-500" data-testid="unknown-run">
            실행 기록 <code className="font-mono">{view.unknownRunId}</code>은(는) 이 평가에
            없습니다.
          </p>
        ) : null}

        {!selected ? (
          <EmptyState
            title="기준을 선택하세요"
            description="왼쪽에서 기준을 누르면 해당 재현·코드·판정만 엽니다."
            testId="replay-empty"
          />
        ) : (
          <>
            {view.mutation ? <MutationPanel mutation={view.mutation} /> : null}
            <RunList runs={replay.runs} criterionId={selected.id} />
            {replay.selectedRunOutsideCriterion && replay.selectedRun ? (
              <p className="text-[13px] text-neutral-500" data-testid="run-outside-criterion">
                실행 기록 <code className="font-mono">{replay.selectedRun.shortId}</code>은(는){" "}
                {selected.id}의 근거가 아닙니다. 기록은 그대로 보여 줍니다.
              </p>
            ) : null}
          </>
        )}

        {replay.selectedRun && replay.bodyError ? (
          <EmptyState
            title="실행 기록 본문을 읽지 못했습니다"
            description={`${replay.bodyError.code}: ${replay.bodyError.message}`}
            testId="replay-body-error"
          />
        ) : null}
        {replay.selectedRun && replay.body ? (
          <RunBody
            run={replay.selectedRun}
            body={replay.body}
            shapeIssue={replay.bodyShapeIssue}
            rerun={replay.rerunControl}
          />
        ) : null}
        {selected && replay.selectedRun && !replay.body && !replay.bodyError ? (
          <EmptyState
            title="실행 기록 본문 없음"
            description="이 화면은 기록 본문을 아직 읽지 않았습니다."
            testId="replay-body-missing"
          />
        ) : null}
      </div>
      <CenterPanes view={view} />
    </section>
  );
}

function RunList({ runs, criterionId }: { runs: ReplayRunView[]; criterionId: string }) {
  if (runs.length === 0) {
    return (
      <EmptyState
        title="실행 기록 없음"
        description={`${criterionId}의 근거가 가리키는 실행 기록이 없습니다.`}
        testId="run-list-empty"
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="run-list">
      <h3 className={SECTION_TITLE}>
        실행 기록 <span className="font-medium text-neutral-400">{runs.length}</span>
      </h3>
      <ol className="flex flex-col gap-1.5">
        {runs.map((run) => (
          <li
            key={run.id}
            data-run={run.id}
            data-run-selected={run.selected ? "true" : "false"}
            data-testid={run.selected ? "selected-run" : undefined}
            data-origin={run.isRerun ? "rerun" : "original"}
          >
            <a
              href={run.href}
              aria-current={run.selected ? "true" : undefined}
              className={`flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border px-3 py-2.5 text-[13px] transition-colors ${run.selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50"}`}
            >
              <Badge tone={run.isRerun ? "neutral" : "ink"}>{run.originLabel}</Badge>
              <span className="font-semibold text-ink">{run.kindLabel}</span>
              {run.testId ? (
                <code className="min-w-0 truncate font-mono text-neutral-700">{run.testId}</code>
              ) : null}
              <span className="ml-auto flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span
                  className="font-mono text-[12px] text-neutral-500"
                  data-testid="run-recorded-at"
                >
                  {run.recordedAt ? formatTimestamp(run.recordedAt) : "시각 없음"}
                </span>
                <span className="text-neutral-600">{run.failureKindLabel}</span>
                <code className="font-mono text-[12px] text-neutral-400">{run.shortId}</code>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RunBody({
  run,
  body,
  shapeIssue,
  rerun,
}: {
  run: ReplayRunView;
  body: ReplayBodyView;
  shapeIssue: string | null;
  rerun: ReplayRerunControlView | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="run-body" data-run-id={body.runId}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone="neutral"
          data-testid="stored-run-badge"
          title="저장된 실행 기록입니다. 화면의 값은 기록에서 그대로 옵니다"
        >
          저장된 실행 · {body.recordedAt ? formatTimestamp(body.recordedAt) : "시각 없음"}
        </Badge>
        <Badge
          tone="ink"
          data-testid="observed-label"
          title="실제 실행에서 관측한 값입니다 (추정 아님)"
        >
          관측
        </Badge>
        <span className="text-[13px] text-neutral-500">
          {run.kindLabel}
          {body.caseId ? (
            <>
              {" · "}
              <code className="font-mono">{body.caseId}</code>
            </>
          ) : null}
          {body.verdict ? ` · ${body.verdict}` : null}
        </span>
        {body.rerun ? <RerunComparison comparison={body.rerun} /> : null}
      </div>
      {body.reason ? (
        <p
          className="-mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-[13px] leading-relaxed text-neutral-700"
          data-testid="run-reason"
        >
          {body.reason}
        </p>
      ) : null}

      <Comparison body={body} />

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className={SECTION_TITLE}>요청·상태 타임라인</h3>
        {body.timeline ? (
          <ReplayTimeline groups={body.timeline} replaySeqs={body.replaySeqs} rerun={rerun} />
        ) : (
          <EmptyState
            title="타임라인 없음"
            description={shapeIssue ?? "요청·상태 타임라인은 하네스 케이스 기록에만 있습니다."}
            testId="timeline-empty"
          />
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-2" data-testid="run-logs">
        <h3 className={SECTION_TITLE}>러너 로그</h3>
        {body.logs.stdout.length === 0 && body.logs.stderr.length === 0 ? (
          <p className="text-[13px] text-neutral-400">이 기록의 근거에 로그 아티팩트가 없습니다</p>
        ) : (
          <ul className="flex flex-col gap-1 rounded-lg bg-neutral-50 px-3 py-2 font-mono text-[12px] break-all text-neutral-600">
            {body.logs.stdout.map((key) => (
              <li key={key} data-log="stdout">
                stdout · {key}
              </li>
            ))}
            {body.logs.stderr.map((key) => (
              <li key={key} data-log="stderr">
                stderr · {key}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** RERUN 기록의 원본 비교 (T-307). 워커가 기록한 값을 그대로 보여 준다 */
function RerunComparison({ comparison }: { comparison: ReplayRerunComparisonView }) {
  return (
    <span
      className="flex flex-wrap items-center gap-2 text-[13px]"
      data-testid="rerun-comparison"
      data-outcome={comparison.outcome}
    >
      <Badge
        tone={comparison.outcome === "same" ? "neutral" : "ink"}
        title="워커가 재실행 직후 원본 기록의 actual.json과 대조한 결과입니다"
      >
        {comparison.outcomeLabel}
      </Badge>
      {comparison.outcome === "different" ? (
        <span className="text-neutral-600" data-testid="rerun-differing-checks">
          달라진 검사:{" "}
          {comparison.differingChecks.length === 0 ? "없음" : comparison.differingChecks.join(", ")}
          {comparison.sameVerdict ? "" : " · verdict 다름"}
        </span>
      ) : null}
      <a
        href={comparison.originalHref}
        className="font-semibold text-primary hover:underline"
        data-testid="rerun-comparison-original-link"
      >
        원본 기록 열기
      </a>
    </span>
  );
}

function Comparison({ body }: { body: ReplayBodyView }) {
  const hasVerdicts = body.kind === "harness-case";
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="comparison">
      <h3 className={`${SECTION_TITLE} flex flex-wrap items-baseline gap-x-2`}>
        기대값 ↔ 실제값
        {hasVerdicts ? (
          <span
            className="text-[13px] font-medium text-neutral-500"
            data-testid="comparison-summary"
          >
            검사 {body.checks.length}개 · 실패 {body.failedCheckNames.length}개
          </span>
        ) : (
          <span className="text-[13px] font-medium text-neutral-500">
            기록 값 나란히 보기 (검사 판정 없음)
          </span>
        )}
      </h3>
      {body.checks.length === 0 ? (
        <p className="text-[13px] text-neutral-400">비교할 검사가 없습니다</p>
      ) : (
        <div className="min-w-0 overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-[13px] text-neutral-500">
                <th className="w-[34%] px-2.5 py-2 font-semibold sm:px-3">검사</th>
                <th className="px-2.5 py-2 font-semibold sm:px-3">기대</th>
                <th className="px-2.5 py-2 font-semibold sm:px-3">실제</th>
                <th className="w-16 px-2.5 py-2 font-semibold sm:w-18 sm:px-3">결과</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {body.checks.map((check) => (
                <CheckRow key={check.name} check={check} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="group/raw text-[13px]">
        <summary className="inline-flex cursor-pointer items-center gap-1 font-semibold text-neutral-600 hover:text-ink">
          expected.json · actual.json 원문
        </summary>
        <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-2">
          <pre
            className="max-h-64 overflow-auto rounded-lg bg-neutral-50 p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all"
            data-testid="expected-json"
          >
            {body.expectedDisplay}
          </pre>
          <pre
            className="max-h-64 overflow-auto rounded-lg bg-neutral-50 p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all"
            data-testid="actual-json"
          >
            {body.actualDisplay}
          </pre>
        </div>
      </details>
    </section>
  );
}

function CheckRow({ check }: { check: ReplayCheckView }) {
  const failed = check.ok === false;
  return (
    <tr
      className="align-top"
      data-check={check.name}
      data-ok={check.ok === null ? undefined : check.ok ? "true" : "false"}
    >
      <td
        className="px-2.5 py-2.5 font-mono break-all text-neutral-800 sm:truncate sm:px-3 sm:break-normal"
        title={check.name}
      >
        {check.name}
      </td>
      <td
        className="px-2.5 py-2.5 font-mono break-all text-neutral-700 sm:px-3"
        data-testid="check-expected"
      >
        {check.expectedDisplay}
      </td>
      <td
        className="px-2.5 py-2.5 font-mono break-all text-neutral-700 sm:px-3"
        data-testid="check-actual"
      >
        {failed ? (
          // 실제 실패한 검사의 관측값만 `fail` 토큰으로 강조한다 (T-301 토큰 규칙: FAIL 래퍼 뒤에만)
          <span data-verdict="FAIL" className="contents">
            <span data-tone="fail" className="font-bold text-fail">
              {check.actualDisplay}
            </span>
          </span>
        ) : (
          check.actualDisplay
        )}
      </td>
      <td className="px-2.5 py-2 sm:px-3">
        {check.ok === null ? (
          <span className="text-neutral-400">-</span>
        ) : failed ? (
          <span data-verdict="FAIL" className="contents">
            <Badge tone="fail">실패</Badge>
          </span>
        ) : (
          <Badge tone="neutral">통과</Badge>
        )}
      </td>
    </tr>
  );
}

function CenterPanes({ view }: { view: WorkbenchView }) {
  const { replay } = view;
  return (
    <div className="mt-auto border-t border-neutral-200 p-4 sm:p-5" data-testid="center-panes">
      <nav aria-label="중앙 탭" className="inline-flex gap-1 rounded-lg bg-neutral-100 p-1">
        {CENTER_PANES.map((pane) => {
          const active = replay.pane === pane;
          return (
            <a
              key={pane}
              href={replay.hrefForPane(pane)}
              data-pane={pane}
              role="tab"
              aria-selected={active ? "true" : "false"}
              className={`inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-semibold transition-colors ${active ? "bg-surface text-ink shadow-sm" : "text-neutral-500 hover:text-ink"}`}
            >
              {CENTER_PANE_LABEL[pane]}
            </a>
          );
        })}
      </nav>
      <div className="mt-4" role="tabpanel" data-testid={`center-pane-${replay.pane}`}>
        {replay.pane === "code" ? (
          <CodeEvidencePanel view={view.codeEvidence} />
        ) : (
          <GraphPanel graph={view.graph} />
        )}
      </div>
    </div>
  );
}
