/**
 * 과제 설정 화면(T-406)과 과제 목록(T-405)이 함께 쓰는 표시 전용 컴포넌트. 훅이 없어 서버 컴포넌트와
 * 클라이언트 편집기 양쪽에서 쓰고, 테스트는 `renderToStaticMarkup`으로 그린다.
 */
import {
  VALIDATION_SAMPLE_KIND_CHECK,
  ValidationResultSchema,
  type ExecutionContract,
  type Rubric,
  type ValidationResult,
  type ValidationSampleKind,
} from "@ohmyti/core";
import {
  AREA_LABEL,
  CONTRACT_FIELD_LABEL,
  METHOD_LABEL,
  contractToForm,
  markdownBlocks,
  type ContractForm,
  type EditorIssue,
} from "@/lib/assignments/editor";
import type { SetupSample } from "@/lib/assignments/service";
import Link from "next/link";
import { Badge } from "@/components/ui";

const SAMPLE_STATUS_LABEL: Record<ValidationResult["perSample"][number]["status"], string> = {
  MATCH: "일치",
  MISMATCH: "불일치",
  ERROR: "채점 미완료",
};

type SampleStatus = ValidationResult["perSample"][number]["status"];

/** 샘플 대조 결과 색: 일치는 차콜, 불일치·채점 미완료는 실제 실패라 빨강 */
function sampleStatusTone(status: SampleStatus) {
  return status === "MATCH" ? ("ink" as const) : ("fail" as const);
}

export const SAMPLE_KIND_LABEL: Record<ValidationSampleKind, string> = {
  CORRECT: "정답 구현",
  ALTERNATIVE: "대안 구현",
  DEFECTIVE: "결함 구현",
  ADVERSARIAL: "적대 샘플",
};

/**
 * 버전 상태 배지. 승인됨은 차콜, 검증 중은 파란 옅은 배경(진행 정보), 초안·폐기는 회색이다.
 * 판정 색(fail·pending)은 버전 상태에 쓰지 않는다. 라벨은 서버 모듈의 상태 라벨을 넘겨받는다 (클라이언트 번들에 DB 코드를 넣지 않는다).
 */
export function VersionStatusBadge({
  status,
  label,
  ...rest
}: {
  status: "DRAFT" | "VALIDATING" | "APPROVED" | "RETIRED";
  label: string;
  "data-testid"?: string;
  "data-status"?: string;
}) {
  const cls =
    status === "APPROVED"
      ? "bg-ink text-surface"
      : status === "VALIDATING"
        ? "bg-primary/8 text-primary"
        : status === "RETIRED"
          ? "bg-neutral-100 text-neutral-500 line-through"
          : "bg-neutral-100 text-neutral-700";
  return (
    <span
      data-testid={rest["data-testid"]}
      data-status={rest["data-status"]}
      className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}

/** 상단의 `← 과제 목록` 링크 */
export function BackLink() {
  return (
    <Link
      href="/assignments"
      className="w-fit text-sm font-semibold text-neutral-500 transition-colors hover:text-ink"
    >
      ← 과제 목록
    </Link>
  );
}

function formatValue(value: string | number | boolean | null): string {
  return value === null ? "없음" : String(value);
}

/**
 * 채점기 사전 검증 결과 (T-405): 샘플별 확인 항목(정답 통과 / 대안 통과 / 결함 탐지 / 적대 샘플 동일)과 불일치 표.
 * 시드 버전의 1단계 게이트 JSON처럼 `ValidationResult`가 아닌 값은 표시하지 않는다.
 * `showSamples=false`면 샘플 칩을 빼고 요약·불일치 표만 그린다 (결과 카드와 함께 쓸 때).
 */
export function ValidationResultView({
  result,
  showSamples = true,
}: {
  result: unknown;
  showSamples?: boolean;
}) {
  const parsed = ValidationResultSchema.safeParse(result);
  if (!parsed.success) return null;
  const { perSample, mismatches, pass } = parsed.data;
  return (
    <div className="flex flex-col gap-3" data-validation-pass={pass ? "true" : "false"}>
      <p className={`text-sm font-semibold ${pass ? "text-ink" : "text-fail"}`}>
        {pass
          ? "채점기 검증 통과: 모든 검증 샘플이 기대 결과와 일치합니다"
          : `채점기 검증 불일치 ${mismatches.length}건: 승인할 수 없습니다`}
      </p>
      {showSamples ? (
        <ul className="flex flex-wrap gap-2 text-[13px]">
          {perSample.map((sample) => (
            <li
              key={sample.sampleId}
              className={`rounded-full px-3 py-1 font-medium ${sample.status === "MATCH" ? "bg-neutral-100 text-neutral-700" : "bg-fail/10 text-fail"}`}
              data-sample-check={sample.check}
              data-sample-status={sample.status}
            >
              {sample.check} · {sample.name} · {SAMPLE_STATUS_LABEL[sample.status]}
            </li>
          ))}
        </ul>
      ) : null}
      {mismatches.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full min-w-[32rem] text-sm" data-testid="validation-mismatches">
            <caption className="px-4 pt-3 text-left text-[13px] font-semibold text-neutral-600">
              불일치 표
            </caption>
            <thead className="text-left text-[13px] text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">샘플</th>
                <th className="px-4 py-2 font-medium">대상</th>
                <th className="px-4 py-2 font-medium">항목</th>
                <th className="px-4 py-2 font-medium">기대</th>
                <th className="px-4 py-2 font-medium">실제</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 border-t border-neutral-200">
              {mismatches.map((m, index) => (
                <tr key={`${m.sampleId ?? m.ref}-${m.ref}-${m.field ?? ""}-${index}`}>
                  <td className="px-4 py-2.5">{m.sampleName ?? m.sampleKind ?? "-"}</td>
                  <td className="px-4 py-2.5 font-mono text-[13px]">{m.ref}</td>
                  <td className="px-4 py-2.5 font-mono text-[13px]">{m.field ?? "-"}</td>
                  <td className="px-4 py-2.5 font-mono text-[13px]">{formatValue(m.expected)}</td>
                  <td className="px-4 py-2.5 font-mono text-[13px] font-semibold text-fail">
                    {formatValue(m.actual)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** 검증 결과 카드: 샘플 종류별 확인 항목(정답 통과 / 대안 통과 / 결함 탐지 / 적대 샘플 동일) 한 장씩 (T-406 하단) */
export function ValidationChecksTable({ result }: { result: ValidationResult }) {
  return (
    <ul
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="validation-checks"
    >
      {result.perSample.map((sample) => (
        <li
          key={sample.sampleId}
          className={`flex flex-col gap-3 rounded-xl border bg-surface p-5 ${sample.status === "MATCH" ? "border-neutral-200" : "border-fail/40"}`}
          data-check-row={sample.check}
          data-sample-status={sample.status}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-base font-bold tracking-tight">{sample.check}</p>
            <Badge tone={sampleStatusTone(sample.status)}>
              {SAMPLE_STATUS_LABEL[sample.status]}
            </Badge>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <p className="text-neutral-700">{sample.name}</p>
            <p className="text-[13px] text-neutral-500 tabular-nums">
              {sample.scoreDisplay ?? "점수 없음"}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function IssueList({ issues, title }: { issues: readonly EditorIssue[]; title: string }) {
  if (issues.length === 0) return null;
  return (
    <div
      className="rounded-lg bg-fail/5 px-4 py-3 text-sm text-neutral-800 ring-1 ring-fail/20"
      role="alert"
      data-testid="rubric-issues"
    >
      <p className="font-semibold text-fail">{title}</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {issues.map((issue, index) => (
          <li
            key={`${issue.code}-${issue.ref ?? ""}-${index}`}
            className="leading-relaxed"
            data-issue-code={issue.code}
          >
            <span className="mr-1.5 rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-neutral-600 ring-1 ring-neutral-200">
              {issue.code}
            </span>{" "}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SpecPreview({ text }: { text: string }) {
  const blocks = markdownBlocks(text);
  if (blocks.length === 0) return <p className="text-sm text-neutral-500">명세가 비어 있습니다.</p>;
  return (
    <div
      className="flex flex-col gap-3 text-[15px] leading-relaxed text-neutral-800"
      data-testid="spec-preview"
    >
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return block.level === 1 ? (
              <h3 key={index} className="text-lg font-bold tracking-tight text-ink">
                {block.text}
              </h3>
            ) : (
              <h4 key={index} className="pt-1 font-bold text-ink">
                {block.text}
              </h4>
            );
          case "list":
            return (
              <ul key={index} className="flex list-disc flex-col gap-1 pl-5">
                {block.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            );
          case "code":
            return (
              <pre
                key={index}
                className="overflow-x-auto rounded-lg bg-neutral-50 p-3 font-mono text-[13px] leading-relaxed"
              >
                {block.text}
              </pre>
            );
          default:
            return <p key={index}>{block.text}</p>;
        }
      })}
    </div>
  );
}

export function ContractTable({ contract }: { contract: ExecutionContract }) {
  const form = contractToForm(contract);
  return (
    <dl className="flex flex-col divide-y divide-neutral-200 text-sm" data-testid="contract">
      {(Object.keys(CONTRACT_FIELD_LABEL) as Array<keyof ContractForm>).map((key) => (
        <div
          key={key}
          className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-3 py-2.5"
        >
          <dt className="text-neutral-500">{CONTRACT_FIELD_LABEL[key]}</dt>
          <dd className="font-mono text-[13px] break-all text-ink">{form[key] || "-"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 요구사항·배점 읽기 전용 표: ID · 요구사항(영역·방법·판정 조건) · 배점 세 칸 */
export function RubricReadOnlyTable({ rubric }: { rubric: Rubric }) {
  const total = rubric.criteria.reduce((sum, c) => sum + c.maxPoints, 0);
  return (
    <table className="w-full text-sm" data-testid="rubric-table">
      <thead className="border-b border-neutral-200 text-left text-[13px] text-neutral-500">
        <tr>
          <th className="hidden w-16 py-2 pr-3 font-medium sm:table-cell">ID</th>
          <th className="py-2 pr-3 font-medium">요구사항 · 판정 조건</th>
          <th className="w-14 py-2 text-right font-medium">배점</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-neutral-200">
        {rubric.criteria.map((c) => (
          <tr key={c.id} className="align-top" data-criterion={c.id}>
            <td className="hidden py-4 pr-3 font-mono text-[13px] font-semibold text-neutral-700 sm:table-cell">
              {c.id}
            </td>
            <td className="py-4 pr-3">
              <div className="flex flex-col gap-1.5">
                <p className="text-[15px] font-semibold text-ink">
                  <span className="mr-2 font-mono text-[13px] text-neutral-500 sm:hidden">
                    {c.id}
                  </span>
                  {c.title}
                </p>
                <p className="flex flex-wrap gap-1.5 text-xs">
                  <span className="rounded-md bg-neutral-100 px-2 py-0.5 font-medium text-neutral-700">
                    {AREA_LABEL[c.area]}
                  </span>
                  <span className="rounded-md bg-neutral-100 px-2 py-0.5 font-medium text-neutral-700">
                    {METHOD_LABEL[c.method]}
                    {c.groupId ? ` · ${c.groupId}` : ""}
                  </span>
                </p>
                <p className="text-[13px] leading-relaxed break-words text-neutral-600">
                  {c.condition}
                </p>
              </div>
            </td>
            <td className="py-4 text-right text-[15px] font-bold tabular-nums">{c.maxPoints}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-neutral-300">
          <td className="hidden sm:table-cell" />
          <td className="py-3 pr-3 text-sm font-semibold text-neutral-600">합계</td>
          <td className="py-3 text-right text-[15px] font-bold tabular-nums">{total}</td>
        </tr>
      </tfoot>
    </table>
  );
}

export function SampleTable({ samples }: { samples: readonly SetupSample[] }) {
  if (samples.length === 0) {
    return (
      <p
        className="rounded-lg bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-600"
        data-testid="samples-empty"
      >
        이 버전에는 검증 샘플이 없습니다. 정답·대안·결함 샘플이 하나씩 있어야 검증을 통과할 수
        있습니다.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="validation-samples">
        <thead className="border-b border-neutral-200 text-left text-[13px] text-neutral-500">
          <tr>
            <th className="py-2 pr-3 font-medium">샘플</th>
            <th className="hidden py-2 pr-3 font-medium sm:table-cell">종류</th>
            <th className="py-2 pr-3 font-medium">확인 항목</th>
            <th className="py-2 font-medium">검토자</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200">
          {samples.map((s) => (
            <tr key={s.id} data-sample={s.name}>
              <td className="py-3 pr-3 font-semibold">{s.name}</td>
              <td className="hidden py-3 pr-3 text-neutral-700 sm:table-cell">
                {SAMPLE_KIND_LABEL[s.kind]}
              </td>
              <td className="py-3 pr-3 text-neutral-700">{VALIDATION_SAMPLE_KIND_CHECK[s.kind]}</td>
              <td className="py-3">
                {s.humanReviewedBy ? (
                  <span className="text-neutral-700">{s.humanReviewedBy}</span>
                ) : (
                  <Badge tone="pending">검토 대기</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
