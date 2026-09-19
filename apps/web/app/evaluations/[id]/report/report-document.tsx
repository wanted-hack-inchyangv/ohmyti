import type { ReactNode } from "react";
import { ANCHOR_LABELS } from "@ohmyti/core";
import {
  Badge,
  LinkButton,
  Notice,
  REVIEW_STATE_LABEL,
  ReviewStateBadge,
  VerdictBadge,
} from "@/components/ui";
import type { KitRefView } from "@/lib/workbench/interview-kit";
import type {
  HiringReportView,
  KeyObservationView,
  ReportBarView,
} from "@/lib/reports/hiring-report-view";
import { CopyButton } from "../copy-button";

/**
 * 채용 리포트 문서 (TICKET.md T-706, PRD 14.3의 9개 절). 채용 담당자와 결정권자가 읽는 한 건의 문서다.
 *
 * - 값은 표시 모델(`buildHiringReportView`)에서만 온다. 이 컴포넌트는 점수·판정을 계산하지 않는다.
 * - 첫 화면(A4 1쪽)에 점수 표기와 핵심 관측이 들어오도록 1·2절을 먼저 둔다.
 * - 모든 관측 항목은 워크벤치 딥링크를 갖고, 인쇄물에는 링크 대신 기준 ID와 고정 SHA 주소를 글자로 싣는다.
 * - 스코어카드는 사람이 기입하는 빈 양식이며 시스템이 값을 채우지 않는다.
 * - 절 단위 `break-inside: avoid`와 A4 규칙은 `globals.css`의 `@page`·`@media print`에 있다(`.report-section`).
 */
export function HiringReportDocument({ view }: { view: HiringReportView }) {
  return (
    <main
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pt-8 pb-20 sm:px-6 print:max-w-none print:gap-2 print:px-0 print:pt-0 print:pb-0"
      data-testid="hiring-report"
      data-evaluation={view.evaluationId}
    >
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        data-print-hide
        data-testid="report-actions"
      >
        <p className="text-[13px] text-neutral-500">{view.printHint}</p>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton
            value={view.markdown}
            label="채용 리포트 Markdown 복사"
            idleText="Markdown 복사"
          />
          <LinkButton
            href={view.interviewKitHref}
            variant="secondary"
            size="sm"
            data-testid="report-kit-link"
          >
            인터뷰 키트
          </LinkButton>
          <LinkButton
            href={view.workbenchHref}
            variant="secondary"
            size="sm"
            data-testid="report-workbench-link"
          >
            채점 워크벤치
          </LinkButton>
        </div>
      </div>

      <header className="flex flex-col gap-2 border-b border-neutral-200 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight text-ink">{view.title}</h1>
          {view.isSample ? (
            <Badge tone="neutral" data-testid="report-sample-badge">
              저장된 실행
            </Badge>
          ) : null}
        </div>
        <p className="text-[13px] text-neutral-600">
          {view.assignmentLabel} · 제출 코드{" "}
          <code className="font-mono">{view.audit.submissionSha}</code>
        </p>
        <p
          className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-[13px] leading-relaxed text-neutral-700 print:bg-transparent"
          data-testid="report-disclaimer"
        >
          {view.disclaimer}
        </p>
      </header>

      <Section index={1} title="한눈 요약" testId="report-summary">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-2xl font-bold text-ink" data-testid="report-score">
            {view.scoreDisplay}
          </span>
          {view.scoreNotice ? (
            <span className="text-[13px] text-neutral-500">{view.scoreNotice}</span>
          ) : null}
        </div>
        {view.areaNotice ? (
          <p className="text-[13px] text-neutral-500" data-testid="report-area-notice">
            {view.areaNotice}
          </p>
        ) : null}
        {view.areaBars.length > 0 ? (
          <div className="flex flex-col gap-2" data-testid="report-area-bars">
            {view.areaBars.map((bar) => (
              <Bar key={bar.label} bar={bar} />
            ))}
          </div>
        ) : null}
        <div data-testid="report-verdict-bar">
          <Bar bar={view.verdictBar} />
        </div>
        <p className="text-[13px] text-neutral-600" data-testid="report-pending-review">
          검토 대기:{" "}
          {view.pendingReview.length === 0
            ? "없음"
            : view.pendingReview.map((c) => `${c.criterionId} ${c.title}`).join(", ")}
        </p>
      </Section>

      <Section index={2} title="핵심 관측" testId="report-key-observations">
        <div className="contents print:grid print:grid-cols-2 print:items-start print:gap-x-4">
          <ObservationGroup
            title="확인된 결함"
            testId="report-defects"
            items={view.defects}
            empty="관측으로 확인된 결함이 없습니다."
          />
          <ObservationGroup
            title="확인된 강점"
            testId="report-strengths"
            items={view.strengths}
            empty="관측으로 확인된 강점 항목이 없습니다."
          />
        </div>
      </Section>

      <Section index={3} title="역량별 관측" testId="report-competencies">
        <div className="flex flex-col gap-3 print:grid print:grid-cols-2 print:gap-1.5">
          {view.competencies.map((competency) => (
            <div
              key={competency.competency}
              data-competency={competency.competency}
              className="report-card flex flex-col gap-1.5 rounded-lg border border-neutral-200 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[13px] font-bold text-ink">{competency.name}</h3>
                {competency.interviewOnly ? (
                  <Badge tone="neutral" data-testid="report-interview-only">
                    과제로 관측 불가: 면접에서 확인
                  </Badge>
                ) : null}
              </div>
              {competency.bar ? <Bar bar={competency.bar} compact /> : null}
              {competency.criteria.length === 0 ? (
                <p className="text-[12px] text-neutral-500">
                  이 역량에 매핑된 기준의 판정이 없습니다.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {competency.criteria.map((criterion) => (
                    <li
                      key={criterion.criterionId}
                      className="flex flex-wrap items-center gap-2 text-[12px] text-neutral-700"
                    >
                      <CriterionLink
                        criterionId={criterion.criterionId}
                        title={criterion.title}
                        href={criterion.href}
                      />
                      <VerdictBadge verdict={criterion.verdict} />
                      <span className="text-neutral-500">
                        {REVIEW_STATE_LABEL[criterion.reviewState]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-col gap-1" data-testid="report-competency-questions">
                <span className="text-[12px] font-semibold text-neutral-500">
                  면접에서 확인할 질문
                </span>
                {competency.questions.length === 0 ? (
                  <span className="text-[12px] text-neutral-500">{competency.questionsEmpty}</span>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {competency.questions.map((question) => (
                      <li
                        key={question.questionId}
                        data-question={question.questionId}
                        className="text-[12px] text-neutral-700"
                      >
                        <a
                          href={question.href}
                          className="font-semibold text-primary hover:underline print:text-ink"
                        >
                          {question.label}
                        </a>
                        . {question.question}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section index={4} title="요구사항별 결과" testId="report-requirements">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-neutral-200 text-neutral-500">
                <Th>기준</Th>
                <Th>영역</Th>
                <Th>판정</Th>
                <Th>점수</Th>
                <Th>검토 상태</Th>
                <Th>관측</Th>
              </tr>
            </thead>
            <tbody>
              {view.requirements.map((row) => (
                <tr
                  key={row.criterionId}
                  data-criterion={row.criterionId}
                  className="border-b border-neutral-100 align-top"
                >
                  <Td>
                    <CriterionLink
                      criterionId={row.criterionId}
                      title={row.title}
                      href={row.href}
                    />
                  </Td>
                  <Td>{row.areaLabel}</Td>
                  <Td>
                    <VerdictBadge verdict={row.verdict} />
                  </Td>
                  <Td>{row.pointsDisplay}</Td>
                  <Td>
                    <ReviewStateBadge state={row.reviewState} />
                  </Td>
                  <Td>{row.observation ?? "-"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="text-[13px] font-bold text-ink">테스트 실효성</h3>
        {view.testEffectiveness.length === 0 ? (
          <p className="text-[12px] text-neutral-500">자료 없음</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {view.testEffectiveness.map((group) => (
              <li
                key={group.groupId}
                data-group={group.groupId}
                className="flex flex-wrap items-center gap-2 text-[12px] text-neutral-700"
              >
                <span className="font-semibold">
                  {group.groupId} {group.name}
                </span>
                {group.verdict ? <VerdictBadge verdict={group.verdict} /> : null}
                <span className="text-neutral-500">
                  {Object.entries(group.outcomes)
                    .filter(([, count]) => count > 0)
                    .map(([outcome, count]) => `${outcome} ${count}`)
                    .join(", ") || "변이 결과 없음"}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="text-[13px] font-bold text-ink">
          설계 검토
          <Badge tone="pending" className="ml-2">
            AI 초안
          </Badge>
        </h3>
        {view.designReview.status === "NO_DATA" ? (
          <p className="text-[12px] text-neutral-500" data-testid="report-design-no-data">
            자료 없음
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {view.designReview.items.length === 0 ? (
              <p className="text-[12px] text-neutral-500">설계 검토 초안이 없습니다.</p>
            ) : (
              view.designReview.items.map((item) => (
                <div key={item.criterionId} className="flex flex-col gap-1 text-[12px]">
                  <p className="text-neutral-700">
                    <span className="font-semibold">{item.criterionId}</span> {item.rationale}
                  </p>
                  <RefList refs={item.refs} />
                </div>
              ))
            )}
            {view.designReview.signalsLine ? (
              <p className="text-[12px] text-neutral-500" data-testid="report-design-signals">
                코드 신호: {view.designReview.signalsLine}
              </p>
            ) : null}
          </div>
        )}
      </Section>

      <Section index={5} title="이력서 주장과 근거" testId="report-resume">
        {view.resumeLinks.notice ? (
          <p className="text-[13px] text-neutral-600" data-testid="report-resume-notice">
            {view.resumeLinks.notice}
          </p>
        ) : (
          <div className="flex flex-col gap-3 print:grid print:grid-cols-2 print:gap-1.5">
            {view.resumeLinks.links.map((link) => (
              <div
                key={link.contextLinkId}
                data-claim={link.contextLinkId}
                className="report-card flex flex-col gap-1 rounded-lg border border-neutral-200 p-3 text-[12px]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={link.href}
                    className="font-semibold text-primary hover:underline print:text-ink"
                  >
                    {link.claim}
                  </a>
                  <Badge tone={link.status === "NEEDS_CHECK" ? "pending" : "neutral"}>
                    {link.statusLabel}
                  </Badge>
                </div>
                {link.observation ? (
                  <p className="text-neutral-700">
                    과제 관측:{" "}
                    {link.observation.criterionId ? (
                      <CriterionLink
                        criterionId={link.observation.criterionId}
                        title=""
                        href={link.observationHref}
                      />
                    ) : null}{" "}
                    {link.observation.summary}
                  </p>
                ) : null}
                {link.evidence.map((evidence) => (
                  <p key={evidence.url} className="break-all text-neutral-600">
                    근거: {evidence.summary} ({evidence.url})
                  </p>
                ))}
                {link.question ? (
                  <p className="text-neutral-700">면접 질문: {link.question}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section index={6} title="면접 권고" testId="report-guide">
        {view.interviewGuide.notice ? (
          <Notice tone="neutral" data-testid="report-guide-notice">
            {view.interviewGuide.notice}
          </Notice>
        ) : null}
        {view.interviewGuide.questions.length === 0 ? (
          <p className="text-[13px] text-neutral-500">필수 질문이 없습니다.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {view.interviewGuide.questions.map((question) => (
              <li
                key={question.questionId}
                data-question={question.questionId}
                className="report-card flex flex-col gap-1 rounded-lg border border-neutral-200 p-3 text-[12px]"
              >
                <div className="flex flex-wrap items-center gap-2 text-neutral-500">
                  <a
                    href={question.href}
                    className="font-semibold text-primary hover:underline print:text-ink"
                  >
                    {question.label}
                  </a>
                  <span>
                    {question.kindLabel} · {question.competencyName} · {question.minutes}분
                  </span>
                  {question.isTemplate ? <Badge tone="neutral">기본 질문</Badge> : null}
                </div>
                <p className="text-[13px] text-ink">{question.question}</p>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section index={7} title="평가 범위와 한계" testId="report-scope">
        <div className="contents print:grid print:grid-cols-2 print:gap-x-4 print:gap-y-1">
        <ScopeList
          title="미평가 영역"
          testId="report-unassessed"
          items={view.scope.unassessedAreas}
          empty="기록된 미평가 영역이 없습니다."
        />
        <div className="flex flex-col gap-1" data-testid="report-inconclusive">
          <h3 className="text-[13px] font-bold text-ink">미확정 기준</h3>
          {view.scope.inconclusive.length === 0 ? (
            <p className="text-[12px] text-neutral-500">미확정 기준이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {view.scope.inconclusive.map((item) => (
                <li
                  key={item.criterionId}
                  data-criterion={item.criterionId}
                  className="flex flex-wrap items-center gap-2 text-[12px] text-neutral-700"
                >
                  <span className="font-semibold">
                    {item.criterionId} {item.title}
                  </span>
                  {item.environmental ? (
                    <Badge tone="pending">
                      실행 환경 장애이며 제출 코드의 결함이 아닙니다
                    </Badge>
                  ) : null}
                  <span className="text-neutral-500">
                    {item.reason ?? "사유가 기록되지 않았습니다"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-1" data-testid="report-scope-pending">
          <h3 className="text-[13px] font-bold text-ink">사람 검토 대기</h3>
          {view.scope.pendingReview.length === 0 ? (
            <p className="text-[12px] text-neutral-500">검토 대기 기준이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-0.5 text-[12px] text-neutral-700">
              {view.scope.pendingReview.map((item) => (
                <li key={item.criterionId} data-criterion={item.criterionId}>
                  {item.criterionId} {item.title}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-1" data-testid="report-llm-usage">
          <h3 className="text-[13px] font-bold text-ink">LLM 사용 범위</h3>
          {view.scope.llmUsage.length === 0 ? (
            <p className="text-[12px] text-neutral-500">LLM을 쓴 단계 기록이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-0.5 text-[12px] text-neutral-700">
              {view.scope.llmUsage.map((usage) => (
                <li key={usage.stage} data-stage={usage.stage}>
                  {usage.stage}: {usage.state}
                  {usage.model ? ` · 모델 ${usage.model}` : ""}
                  {usage.promptVersion ? ` · 프롬프트 ${usage.promptVersion}` : ""}
                  {usage.reason ? ` · ${usage.reason}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
        <ScopeList
          title="지원 범위"
          testId="report-support-scope"
          items={view.scope.supportScope}
          empty="지원 범위 안내가 없습니다."
        />
        </div>
      </Section>

      <Section index={8} title="면접관 스코어카드" testId="report-scorecard">
        <p className="text-[12px] text-neutral-500">
          면접관이 기입하는 빈 양식입니다. 시스템은 값을 채우지 않습니다. 척도:{" "}
          {Object.entries(ANCHOR_LABELS)
            .map(([value, label]) => `${value} ${label}`)
            .join(" · ")}
        </p>
        <div className="flex flex-col gap-2 print:grid print:grid-cols-2 print:gap-1.5">
          {view.scorecard.competencies.map((competency) => (
            <div
              key={competency.competency}
              data-scorecard-competency={competency.competency}
              className="report-card flex flex-col gap-1 rounded-lg border border-neutral-200 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13px] font-bold text-ink">
                  {competency.name}
                  {competency.interviewOnly ? (
                    <span className="ml-2 text-[12px] font-medium text-neutral-500">
                      면접에서만 확인
                    </span>
                  ) : null}
                </h3>
                <span className="text-[12px] text-neutral-500">
                  {competency.anchors.map((anchor) => `${anchor.value} ${anchor.label}`).join(" · ")}
                </span>
              </div>
              <p className="text-[12px] text-neutral-500 print:hidden">{competency.definition}</p>
              <div className="flex flex-wrap items-center gap-3 text-[12px] text-neutral-700">
                {competency.anchors.map((anchor) => (
                  <span key={anchor.value} className="flex items-center gap-1">
                    <span
                      aria-hidden
                      className="inline-block h-3.5 w-3.5 rounded-[3px] border border-neutral-400"
                    />
                    {anchor.value}
                  </span>
                ))}
                <span className="min-w-[8rem] flex-1 border-b border-dashed border-neutral-300 pb-3 text-neutral-400">
                  메모
                </span>
              </div>
            </div>
          ))}
          <div
            className="report-card flex flex-col gap-2 rounded-lg border border-neutral-200 p-3"
            data-testid="report-final-note"
          >
            <h3 className="text-[13px] font-bold text-ink">면접관 최종 의견</h3>
            <span className="block h-12 border-b border-dashed border-neutral-300" />
          </div>
        </div>
      </Section>

      <Section index={9} title="감사 정보" testId="report-audit">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
          <AuditRow label="평가 ID" value={view.audit.evaluationId} />
          <AuditRow label="제출 ID" value={view.audit.submissionId} />
          <AuditRow label="기준 버전" value={view.audit.rubricVersion} />
          <AuditRow label="하네스 버전" value={view.audit.harnessVersion} />
          <AuditRow label="환경 다이제스트" value={view.audit.environmentDigest} />
          <AuditRow label="제출 SHA" value={view.audit.submissionSha} />
          <AuditRow label="저장소" value={view.audit.repoUrl} />
          <AuditRow label="평가 종료 시각" value={view.audit.finishedAt ?? "기록 없음"} />
          {view.audit.llmStages.map((stage) => (
            <AuditRow
              key={stage.stage}
              label={`${stage.stage} 모델`}
              value={`${stage.model ?? "없음"}${stage.promptVersion ? ` · 프롬프트 ${stage.promptVersion}` : ""}${stage.aiReviewId ? ` · 호출 기록 ${stage.aiReviewId}` : ""}`}
            />
          ))}
          <AuditRow
            label="사람 수정 이력"
            value={`${view.audit.humanEdits.count}건${view.audit.humanEdits.lastAt ? ` (마지막 ${view.audit.humanEdits.lastAt})` : ""}`}
          />
        </dl>
      </Section>
    </main>
  );
}

function Section({
  index,
  title,
  testId,
  children,
}: {
  index: number;
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      className="report-section flex flex-col gap-3"
      data-testid={testId}
      data-section={index}
    >
      <h2 className="text-base font-bold text-ink">
        <span className="mr-2 text-neutral-400">{index}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

const BAR_TONE_CLASS: Record<ReportBarView["parts"][number]["tone"], string> = {
  ink: "bg-ink",
  fail: "bg-fail",
  pending: "bg-pending",
  neutral: "bg-neutral-300",
};

/** 저장된 값의 비율 막대. 빨강은 실제 실패, 주황은 미확정·검토 대기에만 쓴다 (T-301) */
function Bar({ bar, compact = false }: { bar: ReportBarView; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-1" data-bar={bar.label}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
        {/* 카드 안(`compact`)에서는 제목이 이미 같은 이름이라 막대 이름을 적지 않는다 */}
        {compact ? null : <span className="font-semibold text-neutral-700">{bar.label}</span>}
        <span className="ml-auto text-neutral-500">{bar.display}</span>
      </div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-100 print:h-1.5"
        role="img"
        aria-label={`${bar.label}: ${bar.display}`}
      >
        {bar.parts.map((part) => (
          <span
            key={part.key}
            data-bar-part={part.key}
            data-tone={part.tone}
            title={`${part.label} ${part.value}`}
            style={{ width: `${part.percent}%` }}
            className={BAR_TONE_CLASS[part.tone]}
          />
        ))}
      </div>
    </div>
  );
}

function ObservationGroup({
  title,
  testId,
  items,
  empty,
}: {
  title: string;
  testId: string;
  items: readonly KeyObservationView[];
  empty: string;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <h3 className="text-[13px] font-bold text-ink">{title}</h3>
      {items.length === 0 ? (
        <p className="text-[13px] text-neutral-500">{empty}</p>
      ) : (
        items.map((item) => (
          <div
            key={item.criterionId}
            data-observation={item.criterionId}
            className="report-card flex flex-col gap-1.5 rounded-lg border border-neutral-200 p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <CriterionLink
                criterionId={item.criterionId}
                title={item.title}
                href={item.href}
                strong
              />
              <VerdictBadge verdict={item.verdict} />
            </div>
            <p className="text-[13px] text-neutral-700">{item.observation}</p>
            {item.impact ? (
              <p
                className="rounded-md bg-neutral-50 px-2.5 py-1.5 text-[13px] font-semibold text-ink print:bg-transparent print:px-0"
                data-testid="report-impact"
              >
                영향: {item.impact}
              </p>
            ) : item.condition ? (
              <p className="text-[12px] text-neutral-500" data-testid="report-condition">
                판정 조건: {item.condition}
              </p>
            ) : null}
            {item.aiDraft ? (
              <p className="text-[12px] text-neutral-600" data-testid="report-ai-draft">
                <Badge tone="pending" className="mr-2">
                  AI 초안
                </Badge>
                {item.aiDraft}
              </p>
            ) : null}
            <RefList refs={item.refs} />
          </div>
        ))
      )}
    </div>
  );
}

/** 근거 목록. 화면은 딥링크, 인쇄물은 기준 ID와 고정 SHA 주소를 글자로 보인다 */
function RefList({ refs }: { refs: readonly KitRefView[] }) {
  if (refs.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
      {refs.map((ref, index) => (
        <li key={`${ref.kind}-${index}`} data-report-ref={ref.kind} className="min-w-0">
          {ref.href ? (
            <a href={ref.href} className="text-primary hover:underline print:hidden">
              {ref.label}
            </a>
          ) : (
            <span className="text-neutral-500 print:hidden">{ref.label}</span>
          )}
          <span className="hidden break-all text-neutral-600 print:inline">
            {ref.exportUrl ? `${ref.label} (${ref.exportUrl})` : ref.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CriterionLink({
  criterionId,
  title,
  href,
  strong = false,
}: {
  criterionId: string;
  title: string;
  href: string | null;
  strong?: boolean;
}) {
  const text = title ? `${criterionId} · ${title}` : criterionId;
  const className = strong ? "text-[14px] font-bold" : "font-semibold";
  return href ? (
    <a
      href={href}
      data-criterion-link={criterionId}
      className={`${className} text-primary hover:underline print:text-ink print:no-underline`}
    >
      {text}
    </a>
  ) : (
    <span className={`${className} text-ink`}>{text}</span>
  );
}

function ScopeList({
  title,
  testId,
  items,
  empty,
}: {
  title: string;
  testId: string;
  items: readonly string[];
  empty: string;
}) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <h3 className="text-[13px] font-bold text-ink">{title}</h3>
      {items.length === 0 ? (
        <p className="text-[12px] text-neutral-500">{empty}</p>
      ) : (
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[12px] text-neutral-700">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AuditRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-neutral-800">{value}</dd>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-2 py-1.5 font-semibold">{children}</th>;
}

function Td({ children }: { children: ReactNode }) {
  return <td className="px-2 py-1.5 text-neutral-700">{children}</td>;
}
