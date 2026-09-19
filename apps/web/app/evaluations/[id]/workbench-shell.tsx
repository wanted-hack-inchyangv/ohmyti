import { Badge, EmptyState, LinkButton } from "@/components/ui";
import type { ApprovalBadgeView } from "@/lib/demo/service";
import type { ContextTabsView } from "@/lib/workbench/context-tabs";
import type { InterviewKitView } from "@/lib/workbench/interview-kit";
import { WORKBENCH_TABS, WORKBENCH_TAB_LABEL } from "@/lib/workbench/state";
import type { WorkbenchView } from "@/lib/workbench/view";
import { ApprovalBadge } from "../../demo/approval-badge";
import { ContextTabPanel } from "./context-tabs";
import { CopyButton } from "./copy-button";
import { CriteriaPanel } from "./criteria-panel";
import { EvidencePanel } from "./evidence-panel";
import { ReplayPanel } from "./replay-panel";

/**
 * 채점 워크벤치 뼈대 (PRD 6장 ③, TICKET.md T-301).
 * 헤더 · 25/50/25 세 열 · 하단 탭 4개. 세 번째 탭은 인터뷰 키트(T-704)다. 헤더 값은 리포트(T-207 API 응답)에서 그대로 온다.
 * 패널 본문은 T-302(왼쪽, `criteria-panel.tsx`)·T-303(중앙, `replay-panel.tsx`)·T-305(중앙 하단)·T-306(오른쪽, `evidence-panel.tsx`)·T-504(하단 탭, `context-tabs.tsx`)가 채운다.
 * 하단 탭 본문(`contextTabs`)은 탭을 열었을 때만 페이지가 맥락을 읽어 넘긴다.
 */

const SUBMISSION_STATUS_LABEL: Record<WorkbenchView["header"]["submissionStatus"], string> = {
  RECEIVED: "접수",
  QUEUED: "대기",
  RUNNING: "실행 중",
  COMPLETED: "완료",
  FAILED: "실패",
  UNSUPPORTED: "미지원",
  DELETED: "삭제됨",
};

export function WorkbenchShell({
  view,
  contextTabs = null,
  interviewKit = null,
  approval = null,
}: {
  view: WorkbenchView;
  contextTabs?: ContextTabsView | null;
  /** 인터뷰 키트 표시 모델 (T-704). 인터뷰 키트 탭을 열었을 때만 페이지가 넘긴다 */
  interviewKit?: InterviewKitView | null;
  /** 기준 버전의 `채점기 사전 검증 완료` 배지 (T-505). 읽지 못했으면 null */
  approval?: ApprovalBadgeView | null;
}) {
  return (
    <main
      className="flex min-h-screen w-full min-w-0 flex-col bg-surface text-ink"
      data-testid="workbench"
      data-layout="full-width"
      data-selected-criterion={view.selectedCriterion?.id}
      data-selected-run={view.selectedRun?.id}
      data-tab={view.tab ?? undefined}
    >
      <WorkbenchHeader view={view} approval={approval} />
      <div
        className="grid min-w-0 flex-1 grid-cols-1 items-start gap-4 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] lg:px-6"
        data-testid="workbench-columns"
      >
        <CriteriaPanel view={view} />
        <ReplayPanel view={view} />
        <EvidencePanel view={view.evidencePanel} />
      </div>
      <BottomTabs view={view} contextTabs={contextTabs} interviewKit={interviewKit} />
    </main>
  );
}

/**
 * `score.display`("54~69/100 · 15점 검토 대기")를 큰 점수("54~69")·만점("/100")·나머지로 나눠 그린다.
 * 요소의 글자 전체(textContent)는 `score.display` 그대로다. 나머지 문구는 옆 배지와 겹치므로 화면에서만 숨긴다.
 */
function splitScoreDisplay(display: string): { value: string; total: string; rest: string } {
  const sep = display.indexOf(" · ");
  const main = sep < 0 ? display : display.slice(0, sep);
  const rest = sep < 0 ? "" : display.slice(sep);
  const slash = main.lastIndexOf("/");
  return slash < 0
    ? { value: main, total: "", rest }
    : { value: main.slice(0, slash), total: main.slice(slash), rest };
}

function WorkbenchHeader({
  view,
  approval,
}: {
  view: WorkbenchView;
  approval: ApprovalBadgeView | null;
}) {
  const { header } = view;
  const score = header.scoreDisplay ? splitScoreDisplay(header.scoreDisplay) : null;
  return (
    <header
      className="flex min-w-0 flex-col gap-5 border-b border-neutral-200 px-4 pt-6 pb-5 lg:flex-row lg:items-end lg:justify-between lg:px-6"
      data-testid="workbench-header"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-sm font-semibold text-primary">채점 워크벤치</h1>
          <p
            className="truncate text-[15px] font-semibold text-neutral-800"
            title={header.assignmentLabel}
          >
            {header.assignmentLabel}
          </p>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-baseline gap-2" data-testid="header-score">
            <span className="text-sm font-medium text-neutral-500">점수</span>
            {score ? (
              <span
                className="text-[32px] leading-none font-bold tracking-tight tabular-nums"
                data-testid="score-display"
              >
                {score.value}
                {score.total ? (
                  <span className="text-xl font-semibold text-neutral-400">{score.total}</span>
                ) : null}
                {score.rest ? <span className="sr-only">{score.rest}</span> : null}
              </span>
            ) : (
              <Badge tone="neutral" data-testid="score-missing">
                판정 저장 전
              </Badge>
            )}
          </div>

          {header.showPendingBadge ? (
            <span data-review-state="PENDING" className="contents">
              <Badge tone="pending" data-testid="pending-badge" className="h-7 px-2.5">
                {header.pendingPoints}점 검토 대기
              </Badge>
            </span>
          ) : null}

          {approval ? <ApprovalBadge view={approval} /> : null}

          {header.isSample ? (
            <Badge
              tone="neutral"
              data-testid="sample-badge"
              title="준비된 샘플입니다. 결과와 숫자는 실제 실행에서 생성했습니다"
            >
              {header.sampleLabel}
            </Badge>
          ) : null}
        </div>

        <dl className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-neutral-500">
          <div className="flex items-center gap-1.5" data-testid="header-sha">
            <dt>제출 SHA</dt>
            <dd className="flex items-center gap-1.5">
              <code className="font-mono text-[13px] text-neutral-800" title={header.submissionSha}>
                {header.shortSha}
              </code>
              <CopyButton value={header.submissionSha} label="제출 SHA 전체 복사" />
            </dd>
          </div>
          <div className="flex items-center gap-1.5" data-testid="header-rubric-version">
            <dt>기준 버전</dt>
            <dd>
              <code className="font-mono text-[13px] text-neutral-800">{header.rubricVersion}</code>
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt>제출</dt>
            <dd className="text-neutral-800">{SUBMISSION_STATUS_LABEL[header.submissionStatus]}</dd>
          </div>
        </dl>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <LinkButton href={`/submissions/${header.submissionId}`} variant="secondary" size="sm">
          제출 상태
        </LinkButton>
        <LinkButton
          href={`/evaluations/${header.evaluationId}/report`}
          variant="secondary"
          size="sm"
          data-testid="hiring-report-link"
        >
          채용 리포트
        </LinkButton>
        <LinkButton href={`/api/evaluations/${header.evaluationId}`} variant="secondary" size="sm">
          리포트 JSON
        </LinkButton>
      </div>
    </header>
  );
}

function BottomTabs({
  view,
  contextTabs,
  interviewKit,
}: {
  view: WorkbenchView;
  contextTabs: ContextTabsView | null;
  interviewKit: InterviewKitView | null;
}) {
  return (
    <footer className="px-4 pb-12 lg:px-6" data-panel="tabs">
      <div className="min-w-0 rounded-xl border border-neutral-200 bg-surface">
        <div className="overflow-x-auto border-b border-neutral-200 px-2 sm:px-4">
          <nav aria-label="하단 탭" className="flex gap-1 sm:gap-4" data-testid="bottom-tabs">
            {WORKBENCH_TABS.map((tab) => {
              const active = view.tab === tab;
              return (
                <a
                  key={tab}
                  href={view.hrefForTab(active ? null : tab)}
                  data-tab={tab}
                  aria-selected={active ? "true" : "false"}
                  role="tab"
                  className={`relative -mb-px flex h-13 shrink-0 items-center border-b-2 px-2 text-[15px] font-semibold whitespace-nowrap transition-colors ${active ? "border-ink text-ink" : "border-transparent text-neutral-500 hover:text-ink"}`}
                >
                  {WORKBENCH_TAB_LABEL[tab]}
                </a>
              );
            })}
          </nav>
        </div>
        {view.tab ? (
          <div className="p-4 sm:p-6" role="tabpanel" data-testid={`tab-panel-${view.tab}`}>
            {contextTabs && contextTabs.tab === view.tab ? (
              <ContextTabPanel view={contextTabs} interviewKit={interviewKit} />
            ) : (
              <EmptyState
                title={WORKBENCH_TAB_LABEL[view.tab]}
                description="맥락을 읽지 않았습니다"
              />
            )}
          </div>
        ) : (
          <p className="px-4 py-4 text-sm text-neutral-500 sm:px-6">
            탭을 누르면 이력서 주장·GitHub 근거·인터뷰 키트·미평가 영역을 엽니다.
          </p>
        )}
      </div>
    </footer>
  );
}
