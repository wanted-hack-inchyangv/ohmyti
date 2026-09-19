import type { ReactNode } from "react";
import type { ContextStatus } from "@ohmyti/core";
import { Badge, Card, EmptyState, VerdictBadge } from "@/components/ui";
import {
  type ContextTabsView,
  type GitHubTabView,
  type QuestionsTabView,
  type ResumeTabView,
  type TabEmptyView,
  type UnevaluatedTabView,
} from "@/lib/workbench/context-tabs";
import type { InterviewKitView } from "@/lib/workbench/interview-kit";
import { CopyButton } from "./copy-button";
import { InterviewKitTab } from "./interview-kit";

/**
 * 워크벤치 하단 탭 본문 (TICKET.md T-504). 이력서 연결 · GitHub 근거 · 인터뷰 키트 · 미평가 영역.
 * 세 번째 탭은 T-704에서 인터뷰 키트로 바뀌었고, 키트가 없는 이전 평가만 이전 후속 질문 목록을 보인다.
 * 상태 칩은 세 종류(`근거 있음`·`확인 필요`·`자료 없음`)뿐이며 모두 회색 계열이다. 점수·합격 성격의 표시는 없다.
 */

/** 상태 칩 색. 미확정·실패 토큰(주황·빨강)은 쓰지 않는다 */
const STATUS_TONE: Record<ContextStatus, "ink" | "neutral"> = {
  EVIDENCE_FOUND: "ink",
  NEEDS_CHECK: "neutral",
  NO_DATA: "neutral",
};

function StatusChip({ status, label }: { status: ContextStatus; label: string }) {
  return (
    <span data-context-status={status} className="contents">
      <Badge tone={STATUS_TONE[status]} className={status === "NO_DATA" ? "border-dashed" : ""}>
        {label}
      </Badge>
    </span>
  );
}

function TabEmpty({ empty, testId }: { empty: TabEmptyView; testId: string }) {
  return <EmptyState title={empty.title} description={empty.description} testId={testId} />;
}

export function ContextTabPanel({
  view,
  interviewKit = null,
}: {
  view: ContextTabsView;
  /** 인터뷰 키트 표시 모델 (T-704). 키트를 읽지 못했으면 이전 후속 질문 목록을 대신 보인다 */
  interviewKit?: InterviewKitView | null;
}) {
  switch (view.tab) {
    case "resume":
      return <ResumeTab view={view.resume} />;
    case "github":
      return <GitHubTab view={view.github} />;
    case "questions":
      return (
        <InterviewKitTab kit={interviewKit} fallback={<QuestionsTab view={view.questions} />} />
      );
    case "unevaluated":
      return <UnevaluatedTab view={view.unevaluated} loadError={view.loadError} />;
  }
}

function ResumeTab({ view }: { view: ResumeTabView }) {
  return (
    <div className="flex flex-col gap-4">
      {view.notice ? (
        <p className="text-[13px] text-neutral-500" data-testid="context-notice">
          {view.notice}
        </p>
      ) : null}
      {view.empty ? <TabEmpty empty={view.empty} testId="resume-empty" /> : null}
      {view.claims.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-testid="claim-list">
          {view.claims.map((claim) => (
            <li key={claim.id} data-claim-id={claim.id}>
              <Card className="flex h-full flex-col gap-3 p-5 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <p
                    className="min-w-0 text-[15px] leading-snug font-semibold break-words text-ink"
                    data-testid="claim-text"
                  >
                    {claim.claim}
                  </p>
                  <StatusChip status={claim.status} label={claim.statusLabel} />
                </div>
                {claim.observation ? (
                  <p
                    className="text-[13px] leading-relaxed text-neutral-600"
                    data-testid="claim-observation"
                  >
                    <span className="font-semibold text-neutral-500">과제 관측 </span>
                    {claim.observation.href ? (
                      <a
                        href={claim.observation.href}
                        className="font-semibold text-primary hover:underline"
                        data-claim-criterion={claim.observation.criterionId}
                      >
                        {claim.observation.criterionId}
                        {claim.observation.title ? ` · ${claim.observation.title}` : ""}
                      </a>
                    ) : (
                      <span className="font-semibold">{claim.observation.criterionId}</span>
                    )}
                    <span className="mt-0.5 block break-words">{claim.observation.summary}</span>
                  </p>
                ) : (
                  <p className="text-[13px] text-neutral-500">과제 관측: 연결된 기준 없음</p>
                )}
                {claim.evidence.length > 0 ? (
                  <ul className="flex flex-col gap-1 border-t border-neutral-100 pt-3 text-[13px] leading-relaxed text-neutral-600">
                    {claim.evidence.map((e) => (
                      <li key={e.url} className="break-words">
                        <a
                          href={e.url}
                          className="font-semibold text-primary hover:underline"
                          rel="noreferrer"
                          target="_blank"
                        >
                          {e.repo}
                        </a>
                        {` · ${e.summary}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="border-t border-neutral-100 pt-3 text-[13px] text-neutral-500">
                    GitHub 근거: 없음
                  </p>
                )}
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function GitHubTab({ view }: { view: GitHubTabView }) {
  return (
    <div className="flex flex-col gap-4">
      {view.statusLabel ? (
        <p
          className="flex flex-wrap items-center gap-2 text-[13px] text-neutral-600"
          data-testid="github-scope"
        >
          <Badge tone="neutral">{view.statusLabel}</Badge>
          {view.login ? <span className="font-mono">@{view.login}</span> : null}
          {view.scope ? <span>{view.scope}</span> : null}
          {view.reason && view.repos.length > 0 ? <span>{view.reason}</span> : null}
        </p>
      ) : null}
      {view.selectionNotes.length > 0 ? (
        <ul className="text-[13px] text-neutral-600" data-testid="github-selection-notes">
          {view.selectionNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {view.empty ? <TabEmpty empty={view.empty} testId="github-empty" /> : null}
      {view.repos.length > 0 ? (
        <ul
          className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
          data-testid="repo-list"
        >
          {view.repos.map((repo) => (
            <li key={repo.fullName} data-repo={repo.fullName}>
              <Card className="flex h-full flex-col gap-2 p-5 text-sm">
                <a
                  href={repo.url}
                  className="font-mono text-[14px] font-semibold break-all text-ink hover:text-primary hover:underline"
                  rel="noreferrer"
                  target="_blank"
                >
                  {repo.fullName}
                </a>
                {repo.description ? (
                  <p className="text-[13px] leading-relaxed break-words text-neutral-600">
                    {repo.description}
                  </p>
                ) : null}
                <p
                  className="text-[13px] leading-relaxed text-neutral-700"
                  data-testid="repo-selection"
                >
                  <span className="font-semibold text-neutral-500">선정 사유 </span>
                  {repo.selectionReason}
                </p>
                <p
                  className="text-[13px] leading-relaxed text-neutral-700"
                  data-testid="repo-collected"
                >
                  <span className="font-semibold text-neutral-500">수집 </span>
                  {repo.collected.length > 0 ? repo.collected.join(" · ") : "없음"}
                </p>
                {repo.missing.length > 0 ? (
                  <ul className="text-[13px] text-neutral-500">
                    {repo.missing.map((m) => (
                      <li key={m}>수집 못 함 · {m}</li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function QuestionsTab({ view }: { view: QuestionsTabView }) {
  if (view.empty) return <TabEmpty empty={view.empty} testId="questions-empty" />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 text-[13px] text-neutral-500">
        <span className="font-semibold">질문 전체</span>
        <CopyButton value={view.allText} label="후속 질문 전체 복사" />
      </div>
      {view.groups.map((group) => (
        <section
          key={group.criterionId ?? "none"}
          data-question-group={group.criterionId ?? "none"}
          className="flex flex-col gap-2"
        >
          <h3 className="text-sm font-bold text-ink">
            {group.href ? (
              <a href={group.href} className="hover:text-primary hover:underline">
                {group.label}
              </a>
            ) : (
              group.label
            )}
          </h3>
          <ul className="flex flex-col gap-2">
            {group.questions.map((q) => (
              <li
                key={q.linkId}
                data-question={q.linkId}
                className="flex items-start justify-between gap-3 rounded-lg border border-neutral-200 px-4 py-3 text-sm"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p
                    className="text-[15px] leading-relaxed break-words text-ink"
                    data-testid="question-text"
                  >
                    {q.question}
                  </p>
                  <p className="text-[13px] break-words text-neutral-500">이력서: {q.claim}</p>
                </div>
                <CopyButton value={q.question} label="후속 질문 복사" />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function UnevaluatedSection({
  title,
  testId,
  emptyText,
  children,
  count,
}: {
  title: string;
  testId: string;
  emptyText: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-lg bg-neutral-50 p-4"
      data-testid={testId}
    >
      <h3 className="text-sm font-bold text-ink">
        {title} <span className="font-medium text-neutral-400">{count}</span>
      </h3>
      {count === 0 ? <p className="text-[13px] text-neutral-500">{emptyText}</p> : children}
    </section>
  );
}

function UnevaluatedTab({
  view,
  loadError,
}: {
  view: UnevaluatedTabView;
  loadError: string | null;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-4">
      <UnevaluatedSection
        title="미확정 기준"
        testId="unevaluated-criteria"
        emptyText="미확정 기준이 없습니다"
        count={view.criteria.length}
      >
        <ul className="flex flex-col gap-2.5 text-sm">
          {view.criteria.map((c) => (
            <li key={c.id} data-unevaluated-criterion={c.id} className="flex flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <a href={c.href} className="font-mono font-semibold text-primary hover:underline">
                  {c.id}
                </a>
                <span className="min-w-0 truncate font-medium">{c.title}</span>
                {c.verdict ? <VerdictBadge verdict={c.verdict} /> : <Badge>판정 없음</Badge>}
              </span>
              <span className="text-[13px] break-words text-neutral-500">{c.note}</span>
            </li>
          ))}
        </ul>
      </UnevaluatedSection>
      <UnevaluatedSection
        title="완료되지 않은 단계"
        testId="unevaluated-stages"
        emptyText="모든 단계가 완료됐습니다"
        count={view.stages.length}
      >
        <ul className="flex flex-col gap-2.5 text-sm">
          {view.stages.map((s) => (
            <li key={s.stage} data-unevaluated-stage={s.stage} data-stage-state={s.state ?? "NONE"}>
              <span className="flex items-center gap-2 font-medium">
                {s.label}
                <Badge>{s.stateLabel}</Badge>
              </span>
              {s.reason ? (
                <span className="block text-[13px] break-words text-neutral-500">{s.reason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </UnevaluatedSection>
      <UnevaluatedSection
        title="맥락 자료 없음"
        testId="unevaluated-context"
        emptyText={
          loadError ? `맥락을 읽지 못했습니다: ${loadError}` : "자료 없는 맥락 항목이 없습니다"
        }
        count={view.context.length}
      >
        <ul className="flex flex-col gap-2.5 text-sm">
          {view.context.map((item) => (
            <li key={item} className="break-words" data-unevaluated-context="">
              {item}
            </li>
          ))}
        </ul>
      </UnevaluatedSection>
      <UnevaluatedSection
        title="분석 범위 한계"
        testId="unevaluated-limits"
        emptyText="기록된 분석 범위 한계가 없습니다"
        count={view.analysisLimits.length}
      >
        <ul className="flex flex-col gap-2.5 text-sm">
          {view.analysisLimits.map((item) => (
            <li key={item} className="break-words" data-unevaluated-limit="">
              {item}
            </li>
          ))}
        </ul>
      </UnevaluatedSection>
    </div>
  );
}
