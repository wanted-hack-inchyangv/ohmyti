import type { ReactNode } from "react";
import { Badge, EmptyState, LinkButton, Notice } from "@/components/ui";
import type {
  InterviewKitView,
  KitAnchorGroupView,
  KitQuestionView,
} from "@/lib/workbench/interview-kit";
import { CopyButton } from "./copy-button";
import { KitPlanSwitch } from "./interview-kit-plan";

/**
 * 워크벤치 하단 탭 `인터뷰 키트` (T-704, PRD 14.2). 우선순위(필수·권장·선택)로 묶은 질문 카드, 45·60분 진행안,
 * 역량별 4단계 앵커, Markdown 복사와 인쇄용 보기를 둔다. 점수·판정·합격 성격의 표시는 없다 (G-13).
 * 키트가 없는 이전 평가는 사유와 함께 이전 후속 질문 목록(`fallback`)을 보인다.
 */
export function InterviewKitTab({
  kit,
  fallback,
}: {
  kit: InterviewKitView | null;
  fallback: ReactNode;
}) {
  if (!kit || kit.missing) {
    return (
      <div className="flex flex-col gap-4" data-testid="kit-missing">
        <Notice tone="neutral">
          <span className="font-semibold">{kit?.missing?.title ?? "인터뷰 키트를 읽지 않음"}</span>
          <span className="block text-neutral-600">
            {kit?.missing?.description ?? "인터뷰 키트를 읽지 않았습니다."}
          </span>
        </Notice>
        {fallback}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6" data-testid="interview-kit">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <KitSummary kit={kit} />
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton
              value={kit.markdown}
              label="인터뷰 키트 Markdown 복사"
              idleText="Markdown 복사"
            />
            <LinkButton
              href={kit.printHref}
              variant="secondary"
              size="sm"
              data-testid="kit-print-link"
            >
              인쇄용 보기
            </LinkButton>
          </div>
          {kit.resumeQuoteNotice ? (
            <p
              className="max-w-sm text-[12px] leading-relaxed text-neutral-500 sm:text-right"
              data-testid="kit-resume-quote-notice"
            >
              {kit.resumeQuoteNotice}
            </p>
          ) : null}
        </div>
      </div>
      <KitNotices kit={kit} />
      <KitPlanSwitch plans={kit.plans} />
      <KitQuestionGroups kit={kit} />
      <KitAnchors anchors={kit.anchors} />
    </div>
  );
}

export function KitSummary({ kit }: { kit: InterviewKitView }) {
  return (
    <p className="text-[13px] text-neutral-600" data-testid="kit-summary">
      질문 {kit.questionCount}개
      {kit.groups.map((g) => ` · ${g.label} ${g.questions.length}개`).join("")}
      {kit.templateCount > 0 ? ` · 기본 질문 ${kit.templateCount}개` : ""}
    </p>
  );
}

export function KitNotices({ kit }: { kit: InterviewKitView }) {
  return (
    <>
      {kit.llmNotice ? (
        <Notice tone="neutral" data-testid="kit-llm-notice">
          {kit.llmNotice}
        </Notice>
      ) : null}
      {kit.templateNotice ? (
        <p className="text-[13px] text-neutral-500" data-testid="kit-template-notice">
          {kit.templateNotice}
        </p>
      ) : null}
      {kit.resumeNotice ? (
        <p className="text-[13px] text-neutral-500" data-testid="kit-resume-notice">
          {kit.resumeNotice}
        </p>
      ) : null}
    </>
  );
}

export function KitQuestionGroups({
  kit,
  print = false,
}: {
  kit: InterviewKitView;
  print?: boolean;
}) {
  if (kit.questionCount === 0) {
    return (
      <EmptyState
        title="질문 없음"
        description="저장된 판정에서 만들 수 있는 질문이 없습니다."
        testId="kit-empty"
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {kit.groups.map((group) => (
        <section
          key={group.priority}
          data-kit-priority={group.priority}
          className="flex flex-col gap-3"
        >
          <h3 className="text-sm font-bold text-ink print:break-after-avoid">
            {group.label} 질문
            <span className="ml-2 font-medium text-neutral-500">
              {group.questions.length}개 · {group.minutes}분
            </span>
          </h3>
          <div className={print ? "flex flex-col gap-3" : "grid grid-cols-1 gap-3 xl:grid-cols-2"}>
            {group.questions.map((q) => (
              <KitQuestionCard key={q.id} question={q} print={print} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SignalList({ title, items, testId }: { title: string; items: string[]; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <p className="text-[12px] font-semibold text-neutral-500">{title}</p>
      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[13px] leading-relaxed text-neutral-700">
        {items.map((item) => (
          <li key={item} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function KitQuestionCard({
  question: q,
  print = false,
}: {
  question: KitQuestionView;
  print?: boolean;
}) {
  return (
    <article
      id={q.anchorId}
      data-kit-question={q.id}
      data-kind={q.kind}
      data-priority={q.priority}
      data-source={q.isTemplate ? "TEMPLATE" : "LLM"}
      className="kit-card flex min-w-0 scroll-mt-24 flex-col gap-3 rounded-xl border border-neutral-200 bg-surface p-4 break-inside-avoid"
    >
      <header className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="font-mono text-[12px] font-semibold text-neutral-500">Q{q.number}</span>
        <Badge tone={q.priority === "MUST" ? "ink" : "neutral"}>{q.priorityLabel}</Badge>
        <Badge tone="neutral">{q.kindLabel}</Badge>
        <span className="text-neutral-600" data-testid="kit-competency">
          {q.competencyName}
        </span>
        <span className="text-neutral-400">·</span>
        <span className="text-neutral-600 tabular-nums" data-testid="kit-minutes">
          {q.minutes}분
        </span>
        {q.isTemplate ? (
          <Badge
            tone="neutral"
            className="border-dashed border-neutral-300"
            data-testid="kit-template-badge"
            title="LLM 문장이 없어 슬롯의 기본 질문을 썼습니다"
          >
            기본 질문
          </Badge>
        ) : null}
      </header>
      <p
        className="text-[15px] leading-relaxed font-semibold break-words text-ink"
        data-testid="kit-question-text"
      >
        {q.question}
      </p>
      {q.claim ? (
        <p className="text-[13px] break-words text-neutral-500" data-testid="kit-claim">
          이력서: {q.claim}
        </p>
      ) : null}
      <p className="text-[13px] leading-relaxed break-words text-neutral-700">
        <span className="font-semibold text-neutral-500">의도 </span>
        {q.intent}
      </p>
      <div className="flex flex-col gap-1" data-testid="kit-probes">
        <p className="text-[12px] font-semibold text-neutral-500">꼬리 질문</p>
        <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-[13px] leading-relaxed text-neutral-700">
          {q.probes.map((probe) => (
            <li key={probe} className="break-words">
              {probe}
            </li>
          ))}
        </ol>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SignalList title="좋은 답변의 신호" items={q.positiveSignals} testId="kit-positive" />
        <SignalList title="우려 신호" items={q.concernSignals} testId="kit-concern" />
      </div>
      <div className="flex flex-col gap-1 border-t border-neutral-100 pt-2">
        <p className="text-[12px] font-semibold text-neutral-500">근거</p>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
          {q.refs.map((ref, index) => (
            <li key={`${ref.kind}-${index}`} data-kit-ref={ref.kind} className="min-w-0 break-all">
              {print ? (
                <span className="text-neutral-700">
                  {ref.label}
                  {ref.exportUrl ? (
                    <span className="block font-mono text-[11px] text-neutral-500">
                      {ref.exportUrl}
                    </span>
                  ) : null}
                </span>
              ) : ref.href ? (
                <a href={ref.href} className="font-medium text-primary hover:underline">
                  {ref.label}
                </a>
              ) : (
                <span className="text-neutral-500">{ref.label}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

export function AnchorTable({ group }: { group: KitAnchorGroupView }) {
  return (
    <ol className="flex flex-col gap-1 text-[13px] leading-relaxed text-neutral-700">
      {group.anchors.map((a) => (
        <li key={a.value} className="flex gap-2">
          <span className="w-20 shrink-0 font-semibold text-neutral-800">
            {a.value} {a.label}
          </span>
          <span className="min-w-0 break-words">{a.behavior}</span>
        </li>
      ))}
    </ol>
  );
}

function KitAnchors({ anchors }: { anchors: readonly KitAnchorGroupView[] }) {
  if (anchors.length === 0) return null;
  return (
    <details className="rounded-lg border border-neutral-200" data-testid="kit-anchors">
      <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-ink">
        평가 척도 (역량별 4단계)
        <span className="ml-2 font-medium text-neutral-500">
          면접관이 기입할 때 쓰는 기준이며 시스템은 값을 채우지 않습니다
        </span>
      </summary>
      <div className="flex flex-col gap-2 px-4 pb-4">
        {anchors.map((group) => (
          <details
            key={group.competency}
            data-anchor-competency={group.competency}
            className="rounded-md bg-neutral-50 px-3 py-2"
          >
            <summary className="cursor-pointer text-[13px] font-semibold text-neutral-800">
              {group.name}
              {group.interviewOnly ? (
                <span className="ml-2 font-medium text-neutral-500">면접에서만 확인</span>
              ) : null}
            </summary>
            <p className="mt-1 mb-2 text-[12px] text-neutral-500">{group.definition}</p>
            <AnchorTable group={group} />
          </details>
        ))}
      </div>
    </details>
  );
}
