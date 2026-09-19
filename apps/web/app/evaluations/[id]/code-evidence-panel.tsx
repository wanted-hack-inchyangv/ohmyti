import { Badge, EmptyState } from "@/components/ui";
import type {
  CodeEvidenceItemView,
  CodeEvidenceLabel,
  CodeEvidenceView,
} from "@/lib/workbench/code-evidence";

/**
 * 코드 근거 뷰어 (PRD 6장 ③, TICKET.md T-305). 중앙 하단 `코드 근거` 탭.
 * 선택한 기준의 근거 중 코드 위치가 있는 것을 `고정 SHA + 경로 + 라인`으로 보여 준다. 원문은 근거에 저장된 스니펫이며
 * 링크는 고정 SHA의 blob URL만 만든다(현재 HEAD·브랜치 링크 없음). 라벨은 근거 `kind`에 따라 `관측`/`정적 관계`/`추정`이다.
 * `추정`은 미확정 해석이므로 `pending` 토큰을 쓰며, 다른 두 라벨은 회색·차콜이다.
 */

const LABEL_TONE: Record<CodeEvidenceLabel, "ink" | "neutral" | "pending"> = {
  관측: "ink",
  "정적 관계": "neutral",
  추정: "pending",
  "사람 검토": "neutral",
};

export function CodeEvidencePanel({ view }: { view: CodeEvidenceView }) {
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid="code-evidence"
      data-code-status={view.status}
      data-pinned-sha={view.sha}
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-neutral-500">
        <span>
          고정 SHA{" "}
          <code className="font-mono text-neutral-800" title={view.sha}>
            {view.shortSha}
          </code>
        </span>
        {view.status === "ok" ? (
          <span data-testid="code-evidence-count">
            코드 위치 {view.items.length}건 · 근거 {view.evidenceCount}건
          </span>
        ) : null}
        {view.githubUnavailable ? (
          <span data-testid="github-unavailable">
            GitHub 저장소가 아니어서 링크를 만들지 않습니다
          </span>
        ) : null}
      </p>

      {view.status === "no-criterion" ? (
        <EmptyState
          title="기준을 선택하세요"
          description="왼쪽에서 기준을 누르면 그 근거의 코드 위치를 보여 줍니다."
          testId="code-evidence-no-criterion"
        />
      ) : null}
      {view.status === "no-location" ? (
        <EmptyState
          title="코드 위치 미확정 · 라우트 분석 결과 없음"
          description={
            view.evidenceCount === 0
              ? "이 기준의 판정에는 근거가 없습니다."
              : `근거 ${view.evidenceCount}건에 코드 위치가 없습니다. 실행 근거는 요청·응답 기록이며, 라우트 분석이 핸들러를 찾지 못하면 위치가 붙지 않습니다.`
          }
          testId="code-evidence-empty"
        />
      ) : null}

      {view.items.length > 0 ? (
        <ol className="flex min-w-0 flex-col gap-3" data-testid="code-evidence-list">
          {view.items.map((item) => (
            <li key={item.evidenceId ?? item.locationLabel}>
              <CodeEvidenceItem item={item} />
            </li>
          ))}
        </ol>
      ) : null}

      {view.standalone ? (
        <section className="flex min-w-0 flex-col gap-2" data-testid="code-evidence-standalone">
          <p className="text-[13px] text-neutral-500">
            그래프에서 고른 위치입니다. 이 기준의 근거가 아니어서 저장된 코드 원문이 없습니다.
          </p>
          <CodeEvidenceItem item={view.standalone} />
        </section>
      ) : null}
    </div>
  );
}

function CodeEvidenceItem({ item }: { item: CodeEvidenceItemView }) {
  const tone = LABEL_TONE[item.label];
  const badge = (
    <Badge tone={tone} title={item.labelDescription} data-testid="evidence-kind-label">
      {item.label}
    </Badge>
  );
  return (
    <article
      className={`flex min-w-0 flex-col overflow-hidden rounded-lg border ${item.selected ? "border-primary ring-1 ring-primary" : "border-neutral-200"}`}
      data-testid="code-evidence-item"
      data-evidence-id={item.evidenceId ?? undefined}
      data-evidence-kind={item.kind ?? "none"}
      data-evidence-label={item.label}
      data-source={item.locationLabel}
      data-selected={item.selected ? "true" : "false"}
    >
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-neutral-200 px-3 py-2.5 text-[13px]">
        {item.label === "추정" ? (
          // 추정은 사람 확인 전의 미확정 해석이다. pending 토큰은 이 래퍼 뒤에만 온다 (T-301 토큰 규칙)
          <span data-interpretation="true" className="contents">
            {badge}
          </span>
        ) : (
          badge
        )}
        <a
          href={item.href}
          className="min-w-0 font-mono font-medium break-all text-ink hover:text-primary hover:underline"
          data-testid="evidence-location"
        >
          {item.locationLabel}
        </a>
        {item.testId ? (
          <code className="font-mono text-[12px] text-neutral-500" data-testid="evidence-test-id">
            {item.testId}
          </code>
        ) : null}
        {item.githubUrl ? (
          <a
            href={item.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 font-semibold text-primary hover:underline"
            data-testid="github-link"
          >
            GitHub에서 보기 (고정 SHA)
          </a>
        ) : null}
      </header>
      {item.snippetMissing ? (
        <p className="px-3 py-3 text-[13px] text-neutral-500" data-testid="snippet-missing">
          저장된 코드 원문이 없습니다. 위치는 고정 SHA 기준이며 링크로 확인할 수 있습니다.
        </p>
      ) : (
        <pre
          className="max-h-96 overflow-auto bg-neutral-50 py-2 font-mono text-[12px] leading-5"
          data-testid="snippet"
        >
          <code className="grid">
            {item.lines.map((line) => (
              <span
                key={line.number}
                data-line={line.number}
                data-highlight={line.highlighted ? "true" : "false"}
                className={`grid grid-cols-[3.5rem_minmax(0,1fr)] pr-3 ${line.highlighted ? "bg-primary/8 shadow-[inset_3px_0_0_var(--color-primary)]" : ""}`}
              >
                <span className="select-none pr-3 text-right text-neutral-400">{line.number}</span>
                <span className="whitespace-pre">{line.text}</span>
              </span>
            ))}
            {item.truncated ? (
              <span
                className="grid grid-cols-[3.5rem_minmax(0,1fr)] text-neutral-400"
                data-testid="snippet-truncated"
              >
                <span />
                <span>… (저장 상한에서 잘림. 나머지는 GitHub 링크로 확인)</span>
              </span>
            ) : null}
          </code>
        </pre>
      )}
    </article>
  );
}
