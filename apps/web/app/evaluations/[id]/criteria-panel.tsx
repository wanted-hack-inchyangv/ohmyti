import {
  Badge,
  Card,
  EmptyState,
  PanelHeader,
  ReviewStateBadge,
  VerdictBadge,
} from "@/components/ui";
import {
  CRITERIA_FILTERS,
  CRITERIA_FILTER_LABEL,
  type CriteriaFilter,
} from "@/lib/workbench/state";
import {
  AREA_LABEL,
  METHOD_LABEL,
  type WorkbenchAreaGroupView,
  type WorkbenchAreaSubtotalView,
  type WorkbenchCriterionView,
  type WorkbenchEffectivenessGroupView,
  type WorkbenchView,
} from "@/lib/workbench/view";
import { CriteriaKeyboardNav } from "./criteria-keyboard-nav";

/**
 * 요구사항·점수 패널 (PRD 6장 ③ 왼쪽 25%, TICKET.md T-302).
 * 영역별 그룹과 소계, 기준 카드(ID·제목·`earned/max` 또는 `?/max`·verdict·method·검토 상태), 실패 필터,
 * 테스트 실효성 섹션(G1~G3). 모든 값은 리포트(T-207)에서 그대로 오고 소계는 `score.byArea` 저장값이다.
 * 카드는 `<a href>`라 클릭이 URL을 바꾸고 서버가 중앙·오른쪽 패널을 다시 그린다.
 */
export function CriteriaPanel({ view }: { view: WorkbenchView }) {
  return (
    <aside
      className="flex min-w-0 flex-col rounded-xl border border-neutral-200 bg-surface"
      data-panel="criteria"
    >
      <PanelHeader
        title="요구사항·점수"
        aside={<span className="text-[13px] text-neutral-500">{view.criteria.length}개 기준</span>}
      />
      <div className="flex flex-col gap-4 p-4">
        {view.unknownCriterionId ? (
          <p className="text-[13px] text-neutral-500" data-testid="unknown-criterion">
            기준 <code className="font-mono">{view.unknownCriterionId}</code>은(는) 이 기준 버전에
            없습니다.
          </p>
        ) : null}
        <FilterBar view={view} />
        {view.subtotalsMissing ? (
          <p className="text-[13px] text-neutral-500" data-testid="subtotals-missing">
            영역 소계가 저장되지 않은 평가입니다. 다시 평가하면 소계가 기록됩니다.
          </p>
        ) : null}
        {view.criteria.length === 0 ? (
          <EmptyState title="기준이 없습니다" description="기준 버전에 요구사항이 없습니다." />
        ) : (
          <CriteriaKeyboardNav>
            <div className="flex flex-col gap-5" data-testid="criteria-list">
              {view.areaGroups.map((group) =>
                group.area === "TEST_EFFECTIVENESS" ? (
                  <EffectivenessSection key={group.area} view={view} group={group} />
                ) : (
                  <AreaGroup key={group.area} group={group} />
                ),
              )}
            </div>
          </CriteriaKeyboardNav>
        )}
      </div>
    </aside>
  );
}

function FilterBar({ view }: { view: WorkbenchView }) {
  const { filter } = view;
  return (
    <nav aria-label="기준 필터" className="flex flex-wrap gap-1.5" data-testid="criteria-filter">
      {CRITERIA_FILTERS.map((key: CriteriaFilter) => {
        const active = filter.filter === key;
        return (
          <a
            key={key}
            href={filter.hrefFor(key)}
            data-filter={key}
            data-count={filter.counts[key]}
            aria-current={active ? "true" : undefined}
            className={`inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[13px] font-semibold transition-colors ${active ? "border-ink bg-ink text-surface" : "border-neutral-200 bg-surface text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50"}`}
          >
            {CRITERIA_FILTER_LABEL[key]}{" "}
            <span className={`tabular-nums ${active ? "text-surface/70" : "text-neutral-400"}`}>
              {filter.counts[key]}
            </span>
          </a>
        );
      })}
    </nav>
  );
}

function SubtotalText({
  subtotal,
  testId,
}: {
  subtotal: WorkbenchAreaSubtotalView | null;
  testId: string;
}) {
  if (!subtotal) {
    return (
      <span className="text-[13px] text-neutral-400" data-testid={testId}>
        소계 없음
      </span>
    );
  }
  return (
    <span
      className="text-[13px] font-semibold text-neutral-700 tabular-nums"
      data-testid={testId}
      data-earned={subtotal.earned}
      data-min={subtotal.min}
      data-max={subtotal.max}
      data-pending={subtotal.pendingPoints}
      data-total={subtotal.total}
      title={
        subtotal.pendingPoints > 0
          ? `확정 ${subtotal.earned} · ${subtotal.pendingPoints}점 검토 대기`
          : `확정 ${subtotal.earned}`
      }
    >
      {subtotal.display}
    </span>
  );
}

function AreaGroup({ group }: { group: WorkbenchAreaGroupView }) {
  return (
    <section data-area={group.area} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 px-0.5 pb-1">
        <h3 className="text-sm font-bold text-ink">
          {group.label}
          <span className="ml-1 font-normal text-neutral-400">
            {group.criteria.length === group.totalCount
              ? group.totalCount
              : `${group.criteria.length}/${group.totalCount}`}
          </span>
        </h3>
        <SubtotalText subtotal={group.subtotal} testId={`subtotal-${group.area}`} />
      </div>
      {group.criteria.length === 0 ? (
        <p className="px-0.5 text-[13px] text-neutral-400" data-testid={`area-empty-${group.area}`}>
          필터에 해당하는 기준이 없습니다
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {group.criteria.map((criterion) => (
            <li key={criterion.id}>
              <CriterionCard criterion={criterion} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const CARD_LINK_CLASS =
  "flex min-w-0 flex-col gap-2 rounded-lg px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-primary";
const CARD_HOVER_CLASS = "hover:shadow-[0_4px_16px_rgba(23,23,25,0.08)]";

function CriterionCard({ criterion }: { criterion: WorkbenchCriterionView }) {
  return (
    <Card
      selected={criterion.selected}
      data-criterion={criterion.id}
      data-verdict={criterion.verdict ?? undefined}
      aria-current={criterion.selected ? "true" : undefined}
      className={CARD_HOVER_CLASS}
    >
      <a href={criterion.href} data-criterion-link={criterion.id} className={CARD_LINK_CLASS}>
        <div className="flex min-w-0 items-baseline gap-2">
          <code className="shrink-0 font-mono text-[12px] font-medium text-neutral-500">
            {criterion.id}
          </code>
          <span
            className="min-w-0 truncate text-[15px] font-semibold text-ink"
            title={criterion.title}
          >
            {criterion.title}
          </span>
          <span
            className="ml-auto shrink-0 text-sm font-bold text-ink tabular-nums"
            data-testid="criterion-points"
            title={criterion.earnedPoints === null ? "미확정 배점 (0점과 다름)" : undefined}
          >
            {criterion.pointsDisplay}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {criterion.verdict ? (
            <VerdictBadge verdict={criterion.verdict} />
          ) : (
            <Badge tone="neutral">판정 없음</Badge>
          )}
          {criterion.reviewState === "PENDING" ? <ReviewStateBadge state="PENDING" /> : null}
          <span className="text-[13px] text-neutral-500">
            {AREA_LABEL[criterion.area]} · {METHOD_LABEL[criterion.method]}
          </span>
        </div>
      </a>
    </Card>
  );
}

/**
 * 테스트 실효성 영역은 기준 카드 대신 요구사항 그룹(G1~G3) 행으로 보여 준다. 그룹 행이 그 MUTATION 기준의
 * 카드 역할(`data-criterion`·선택·링크)을 겸하므로 기준이 두 번 나오지 않는다. 필터는 그룹의 기준에 그대로 적용한다.
 */
function EffectivenessSection({
  view,
  group: areaGroup,
}: {
  view: WorkbenchView;
  group: WorkbenchAreaGroupView;
}) {
  const { effectiveness } = view;
  const visible = new Set(areaGroup.criteria.map((c) => c.id));
  const groups = effectiveness.groups.filter((g) => !g.criterion || visible.has(g.criterion.id));
  // 그룹에 연결되지 않은 이 영역의 기준은 일반 카드로 뒤에 둔다 (기준이 사라지지 않게)
  const grouped = new Set(effectiveness.groups.map((g) => g.criterion?.id));
  const leftover = areaGroup.criteria.filter((c) => !grouped.has(c.id));
  return (
    <section
      className="flex min-w-0 flex-col gap-1.5"
      data-area="TEST_EFFECTIVENESS"
      data-testid="effectiveness"
      data-not-implemented={effectiveness.notImplemented ? "true" : undefined}
    >
      <div className="flex items-baseline justify-between gap-2 px-0.5 pb-1">
        <h3 className="text-sm font-bold text-ink">
          {areaGroup.label}
          <span className="ml-1 font-normal text-neutral-400">
            {areaGroup.criteria.length === areaGroup.totalCount
              ? areaGroup.totalCount
              : `${areaGroup.criteria.length}/${areaGroup.totalCount}`}
          </span>
        </h3>
        <SubtotalText subtotal={effectiveness.subtotal} testId="subtotal-TEST_EFFECTIVENESS" />
      </div>
      {effectiveness.notImplemented ? (
        <p
          className="px-0.5 text-[13px] leading-relaxed text-neutral-500"
          data-testid="effectiveness-not-implemented"
        >
          mutation 실험은 4단계에서 연결됩니다. 그룹 점수는 검토 대기로 남아 있습니다.
        </p>
      ) : null}
      {effectiveness.groups.length === 0 ? (
        <EmptyState
          title="요구사항 그룹이 없습니다"
          description="기준 버전에 mutation 그룹이 없습니다."
        />
      ) : groups.length === 0 ? (
        <p
          className="px-0.5 text-[13px] text-neutral-400"
          data-testid="area-empty-TEST_EFFECTIVENESS"
        >
          필터에 해당하는 기준이 없습니다
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((group) => (
            <li key={group.id}>
              <EffectivenessGroupRow group={group} />
            </li>
          ))}
        </ul>
      )}
      {leftover.length > 0 ? (
        <ol className="flex flex-col gap-2">
          {leftover.map((criterion) => (
            <li key={criterion.id}>
              <CriterionCard criterion={criterion} />
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function EffectivenessGroupRow({ group }: { group: WorkbenchEffectivenessGroupView }) {
  const criterion = group.criterion;
  const body = (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
        <code className="shrink-0 font-mono text-[12px] font-medium text-neutral-500">
          {group.id}
        </code>
        <span className="min-w-0 truncate text-[15px] font-semibold text-ink" title={group.name}>
          {group.name}
        </span>
        <span
          className="ml-auto shrink-0 text-sm font-bold text-ink tabular-nums"
          data-testid="group-points"
        >
          {criterion ? criterion.pointsDisplay : "-"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {criterion?.verdict ? <VerdictBadge verdict={criterion.verdict} /> : null}
        {criterion?.reviewState === "PENDING" ? <ReviewStateBadge state="PENDING" /> : null}
        <span className="text-[13px] text-neutral-500" data-testid="group-status">
          {group.statusLabel}
        </span>
      </div>
      {group.unverifiedCriterionIds.length > 0 ? (
        <p className="text-[13px] font-medium text-neutral-800" data-testid="group-unverified">
          검증되지 않은 요구사항 {group.unverifiedCriterionIds.join(", ")}
        </p>
      ) : null}
      {group.experiments.length > 0 ? (
        <p className="text-[13px] text-neutral-600" data-testid="group-experiments">
          {group.experiments.map((e) => `${e.mutationId} ${e.outcomeLabel}`).join(" · ")}
        </p>
      ) : null}
      <p className="border-t border-neutral-100 pt-2 text-[13px] text-neutral-400">
        기준 {group.criterionIds.join(", ")} · 변형 {group.mutationIds.join(", ") || "없음"}
      </p>
    </>
  );
  return (
    <Card
      selected={criterion?.selected ?? false}
      data-group={group.id}
      data-criterion={criterion?.id}
      data-verdict={criterion?.verdict ?? undefined}
      aria-current={criterion?.selected ? "true" : undefined}
      className={criterion ? CARD_HOVER_CLASS : undefined}
    >
      {criterion ? (
        <a href={criterion.href} data-criterion-link={criterion.id} className={CARD_LINK_CLASS}>
          {body}
        </a>
      ) : (
        <div className="flex min-w-0 flex-col gap-2 px-4 py-3">{body}</div>
      )}
    </Card>
  );
}
