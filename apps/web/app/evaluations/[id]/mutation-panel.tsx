import { Badge, EmptyState } from "@/components/ui";
import type {
  MutationDiffView,
  MutationPanelView,
  MutationRecordView,
} from "@/lib/workbench/mutation";

/**
 * 테스트 실효성 변형 실험 (TICKET.md T-404). 중앙 패널에서 MUTATION 기준(G1~G3)을 고르면 실행 기록 목록 위에 놓인다.
 * 그룹의 실험 목록 → 선택한 실험의 diff → 유효성 검증 기록 → 제출 테스트 기록 순이다. 값은 모두 `view.mutation`에서 온다.
 * 결과는 실험별로만 보여 주며 개수·비율 표기를 만들지 않는다.
 */
export function MutationPanel({ mutation }: { mutation: MutationPanelView }) {
  const { selected } = mutation;
  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-neutral-200 p-4"
      data-testid="mutation-panel"
      data-group={mutation.groupId}
      data-selected-mutation={selected?.mutationId}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-bold text-ink">
          변형 실험 · {mutation.groupId} {mutation.groupName}
        </h3>
        {mutation.unverifiedCriterionIds.length > 0 ? (
          <p className="text-[13px] font-medium text-neutral-800" data-testid="mutation-unverified">
            검증되지 않은 요구사항{" "}
            {mutation.unverifiedCriterionIds.map((id) => (
              <code key={id} className="mr-1 font-mono" data-unverified={id}>
                {id}
              </code>
            ))}
          </p>
        ) : null}
      </div>

      {mutation.experiments.length === 0 ? (
        <EmptyState
          title="변형 실험 기록 없음"
          description="이 평가에서는 이 그룹의 변형을 실행하지 않았습니다. 판정 사유는 오른쪽 관측에 있습니다."
          testId="mutation-empty"
        />
      ) : (
        <ol className="flex min-w-0 flex-col gap-1.5" data-testid="mutation-list">
          {mutation.experiments.map((e) => (
            <li
              key={e.mutationId}
              data-mutation={e.mutationId}
              data-outcome={e.outcome}
              data-mutation-selected={e.selected ? "true" : "false"}
            >
              <a
                href={e.href}
                className={`flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border px-3 py-2.5 text-[13px] transition-colors ${e.selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50"}`}
                aria-current={e.selected ? "true" : undefined}
              >
                <code className="font-mono font-semibold">{e.mutationId}</code>
                <Badge tone="neutral" title={e.outcomeDescription}>
                  {e.outcomeLabel}
                </Badge>
                <span className="text-neutral-500">대상 {e.targetCriterionId}</span>
                {e.reason ? (
                  <span className="min-w-0 truncate text-neutral-500" title={e.reason}>
                    {e.reason}
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ol>
      )}
      {mutation.missingMutationIds.length > 0 && mutation.experiments.length > 0 ? (
        <p className="text-[13px] text-neutral-500" data-testid="mutation-missing">
          실험 기록 없음: {mutation.missingMutationIds.join(", ")}
        </p>
      ) : null}

      {selected ? (
        <div
          className="flex min-w-0 flex-col gap-4 border-t border-neutral-100 pt-4"
          data-testid="mutation-detail"
        >
          <p className="text-[13px] leading-relaxed break-words text-neutral-700">
            <code className="font-mono">{selected.mutationId}</code> {selected.outcomeDescription}
            {selected.target ? (
              <>
                {" "}
                · 위치{" "}
                <code className="font-mono" data-testid="mutation-target">
                  {selected.target.path}:{selected.target.startLine}-{selected.target.endLine}
                </code>
              </>
            ) : null}
          </p>
          <DiffBlock diff={mutation.diff} />
          <RecordBlock
            record={mutation.validation}
            testId="mutation-validation"
            missing="유효성 검증 기록 없음"
          />
          <RecordBlock
            record={mutation.tests}
            testId="mutation-tests"
            missing="제출 테스트 기록 없음"
          />
        </div>
      ) : null}
    </section>
  );
}

const DIFF_LINE_CLASS: Record<string, string> = {
  meta: "text-neutral-500",
  hunk: "text-neutral-500",
  add: "bg-neutral-100 text-ink",
  del: "bg-neutral-100 text-neutral-600 line-through",
  context: "text-neutral-700",
};

function DiffBlock({ diff }: { diff: MutationDiffView | null }) {
  if (!diff) {
    return (
      <p className="text-[13px] text-neutral-500" data-testid="mutation-diff-none">
        이 실험에는 diff가 없습니다 (변형을 적용하지 않았습니다).
      </p>
    );
  }
  if (!diff.ok) {
    return (
      <EmptyState
        title="diff를 읽지 못했습니다"
        description={diff.message}
        testId="mutation-diff-error"
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-[13px] font-bold text-ink">diff</h4>
      {diff.empty ? (
        <p className="text-[13px] text-neutral-500" data-testid="mutation-diff">
          빈 diff
        </p>
      ) : (
        <pre
          className="overflow-x-auto rounded-lg bg-neutral-50 p-3 font-mono text-[12px] leading-5"
          data-testid="mutation-diff"
        >
          {diff.lines.map((line, index) => (
            <div key={index} className={DIFF_LINE_CLASS[line.kind]} data-diff-line={line.kind}>
              {line.text === "" ? " " : line.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function RecordBlock({
  record,
  testId,
  missing,
}: {
  record: MutationRecordView | null;
  testId: string;
  missing: string;
}) {
  if (!record) {
    return (
      <p className="text-[13px] text-neutral-500" data-testid={`${testId}-none`}>
        {missing}
      </p>
    );
  }
  if (!record.ok) {
    return (
      <EmptyState
        title="실행 기록 본문을 읽지 못했습니다"
        description={record.message}
        testId={`${testId}-error`}
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId} data-run={record.runId}>
      <h4 className="text-[13px] font-bold text-ink">
        {record.kindLabel}{" "}
        <a href={record.href} className="font-mono font-semibold text-primary hover:underline">
          {record.shortId}
        </a>
      </h4>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg bg-neutral-50 px-3 py-2.5 text-[13px]">
        {record.fields.map((field) => (
          <div key={field.label} className="contents">
            <dt className="text-neutral-500">{field.label}</dt>
            <dd className="min-w-0 break-words text-neutral-800">{field.value}</dd>
          </div>
        ))}
      </dl>
      {record.failures.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[12px] text-neutral-700">
          {record.failures.map((failure) => (
            <li key={failure} className="break-words font-mono">
              {failure}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
