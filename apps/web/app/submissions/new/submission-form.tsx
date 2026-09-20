"use client";

import {
  InvalidRepoUrlError,
  isCommitShaInput,
  parseGitHubProfileUrl,
  parseGitHubRepoUrl,
} from "@ohmyti/core";
import { useRouter } from "next/navigation";
import { Fragment, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { buttonClass, inputClassName } from "@/components/ui";
import { createSubmissionFromFormAction } from "@/lib/submissions/actions";
import type { ExampleResumeId, PrefillExample, PrefillValues } from "@/lib/submissions/prefill";
import type { ApprovedVersionSummary } from "@/lib/submissions/service";

interface SubmissionFormProps {
  options: ApprovedVersionSummary[];
  /** `?sample=`·`?persona=`에서 읽은 초기값 (T-902). 아는 값이 아니면 빈 값이다 */
  prefill: PrefillValues;
  /** `예시로 채우기` 칩 목록 */
  examples: PrefillExample[];
}

type FieldErrors = Partial<
  Record<"assignmentVersionId" | "repoUrl" | "commitSha" | "githubProfileUrl" | "resume", string>
>;

/** 서버로 보내기 전에 브라우저에서 같은 규칙으로 검사한다. 서버(`SubmissionFormSchema`)가 다시 검사한다 */
export function validateClientFields(values: {
  assignmentVersionId: string;
  repoUrl: string;
  commitSha: string;
  githubProfileUrl: string;
  resumeName: string | null;
}): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.assignmentVersionId) errors.assignmentVersionId = "과제를 선택하세요";
  if (!values.repoUrl.trim()) {
    errors.repoUrl = "과제 저장소 URL을 입력하세요";
  } else {
    try {
      parseGitHubRepoUrl(values.repoUrl);
    } catch (error) {
      errors.repoUrl =
        error instanceof InvalidRepoUrlError
          ? `지원하지 않는 저장소 URL: ${error.detail}`
          : "저장소 URL이 올바르지 않습니다";
    }
  }
  if (values.commitSha.trim() && !isCommitShaInput(values.commitSha)) {
    errors.commitSha = "커밋 SHA는 7~40자 16진수여야 합니다";
  }
  if (values.githubProfileUrl.trim()) {
    try {
      parseGitHubProfileUrl(values.githubProfileUrl);
    } catch (error) {
      errors.githubProfileUrl =
        error instanceof InvalidRepoUrlError
          ? `지원하지 않는 프로필 URL: ${error.detail}`
          : "GitHub 프로필 URL이 올바르지 않습니다";
    }
  }
  if (values.resumeName && !/\.pdf$/i.test(values.resumeName)) {
    errors.resume = "이력서는 PDF 파일만 받습니다";
  }
  return errors;
}

const inputClass = inputClassName;

export function SubmissionForm({ options, prefill, examples }: SubmissionFormProps) {
  const [assignmentVersionId, setAssignmentVersionId] = useState(options[0]?.id ?? "");
  const [repoUrl, setRepoUrl] = useState(prefill.repoUrl);
  const [commitSha, setCommitSha] = useState(prefill.commitSha);
  const [githubProfileUrl, setGithubProfileUrl] = useState(prefill.githubProfileUrl);
  const [resumeName, setResumeName] = useState<string | null>(null);
  const [exampleId, setExampleId] = useState<string | null>(prefill.exampleId);
  const [resumeId, setResumeId] = useState<ExampleResumeId | null>(prefill.resumeId);
  const [useExampleResume, setUseExampleResume] = useState(prefill.resumeId !== null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const errors = validateClientFields({
      assignmentVersionId,
      repoUrl,
      commitSha,
      githubProfileUrl,
      resumeName,
    });
    setFieldErrors(errors);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;
    const formData = new FormData(form);
    startTransition(async () => {
      let result;
      try {
        result = await createSubmissionFromFormAction(formData);
      } catch {
        setServerError("제출을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요");
        return;
      }
      if (!result.ok) {
        setServerError(`${result.code}: ${result.message}`);
        return;
      }
      router.push(`/submissions/${result.data.submissionId}`);
    });
  }

  function applyExample(example: PrefillExample) {
    setExampleId(example.id);
    setRepoUrl(example.repoUrl);
    setCommitSha(example.commitSha);
    setGithubProfileUrl(example.githubProfileUrl);
    setResumeId(example.resumeId);
    setUseExampleResume(example.resumeId !== null);
    setFieldErrors({});
  }

  const disabled = options.length === 0 || pending;
  // 직접 고른 파일이 예시 이력서보다 우선한다 (서버 액션도 같은 순서다)
  const exampleResumeId = useExampleResume && !resumeName ? resumeId : null;
  const selected = options.find((option) => option.id === assignmentVersionId) ?? null;
  const parsedRepo = parseRepoLabel(repoUrl);
  const hasContext = Boolean(exampleResumeId || resumeName || githubProfileUrl.trim());

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-6"
      noValidate
      aria-describedby={serverError ? "submission-server-error" : undefined}
    >
      <ExampleChips examples={examples} selectedId={exampleId} onSelect={applyExample} />

      <FormSection title="필수 정보" description="채점 기준이 될 과제와 제출된 저장소입니다.">
        <Field
          label="채용 과제"
          hint="승인된 과제 버전만 고를 수 있습니다. 고른 버전의 채점 기준으로만 판정하며, 승인 뒤에는 기준이 바뀌지 않습니다."
          error={fieldErrors.assignmentVersionId}
        >
          {options.length === 0 ? (
            <p className="rounded-lg bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-700 ring-1 ring-neutral-200">
              승인된 과제 버전이 없습니다. 과제 설정 화면에서 기준을 승인한 뒤 제출할 수 있습니다.
            </p>
          ) : (
            <span className="relative block">
              <select
                name="assignmentVersionId"
                value={assignmentVersionId}
                onChange={(event) => setAssignmentVersionId(event.target.value)}
                aria-invalid={fieldErrors.assignmentVersionId ? true : undefined}
                className={`${inputClass} cursor-pointer appearance-none pr-11`}
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="pointer-events-none absolute top-1/2 right-4 h-4 w-4 -translate-y-1/2 text-neutral-500"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
              >
                <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          )}
        </Field>

        {selected ? <VersionSummary summary={selected} /> : null}

        <Field
          label="과제 저장소 URL"
          hint="공개 GitHub 저장소만 지원합니다. https://github.com/<owner>/<repo>[/tree/<ref>]"
          error={fieldErrors.repoUrl}
        >
          <input
            type="url"
            name="repoUrl"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/owner/order-api"
            aria-invalid={fieldErrors.repoUrl ? true : undefined}
            className={inputClass}
          />
          {parsedRepo ? (
            <span className="text-[13px] text-neutral-600" data-testid="repo-parsed">
              읽은 저장소: <span className="font-mono font-semibold text-ink">{parsedRepo}</span> ·{" "}
              {commitSha.trim() ? "고정 커밋으로 채점" : "기본 브랜치의 최신 커밋으로 채점"}
            </span>
          ) : null}
        </Field>
      </FormSection>

      <FormSection
        title="선택 정보"
        description="없어도 과제 채점은 진행됩니다. 이력서와 프로필은 면접 질문을 만드는 맥락 연결에만 씁니다."
      >
        <Field
          label="이력서 (PDF, 선택)"
          hint="원본만 저장합니다. 텍스트 추출과 맥락 연결은 이후 단계에서 합니다. 채점 입력에는 쓰지 않습니다."
          error={fieldErrors.resume}
        >
          <input
            type="file"
            name="resume"
            accept="application/pdf,.pdf"
            onChange={(event) => setResumeName(event.target.files?.[0]?.name ?? null)}
            aria-invalid={fieldErrors.resume ? true : undefined}
            className="peer sr-only"
          />
          {/* Field가 label이라 이 영역 어디를 눌러도 파일 선택 창이 열린다 */}
          <span
            className={`flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors hover:border-primary/50 hover:bg-primary/5 peer-focus-visible:border-primary peer-focus-visible:bg-primary/5 peer-aria-[invalid=true]:border-fail sm:flex-row sm:py-5 sm:text-left ${resumeName ? "border-primary/40 bg-primary/5" : "border-neutral-300 bg-neutral-50"}`}
          >
            <span
              aria-hidden="true"
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${resumeName ? "bg-primary text-surface" : "bg-surface text-neutral-500 ring-1 ring-neutral-200"}`}
            >
              <svg
                viewBox="0 0 20 20"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path
                  d="M11.5 2.5H5.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5V7l-4.5-4.5Z"
                  strokeLinejoin="round"
                />
                <path d="M11.5 2.5V7H16" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={`max-w-full truncate text-[15px] font-semibold ${resumeName ? "text-ink" : "text-neutral-700"}`}
              >
                {resumeName ?? "선택한 파일이 없습니다"}
              </span>
              <span className="text-[13px] text-neutral-500">PDF 한 개 · 눌러서 파일 선택</span>
            </span>
            <span className={`${buttonClass("secondary", "sm")} pointer-events-none`}>
              {resumeName ? "다른 파일" : "PDF 선택"}
            </span>
          </span>
        </Field>

        {resumeId ? (
          <div className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={useExampleResume}
                onChange={(event) => setUseExampleResume(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                data-testid="use-example-resume"
              />
              <span className="text-[15px] font-semibold text-ink">예시 이력서 사용</span>
            </label>
            <p className="text-[13px] leading-relaxed text-neutral-500">
              가상 인물의 예시 이력서를 붙입니다. 파일 선택 창에는 미리 채울 수 없어 이 항목으로
              대신합니다. 직접 고른 파일이 있으면 그 파일을 씁니다.
            </p>
          </div>
        ) : null}
        <input type="hidden" name="exampleResumeId" value={exampleResumeId ?? ""} />

        <Field
          label="GitHub 프로필 URL (선택)"
          hint="https://github.com/<login>. 이력서·과제와 관련된 공개 저장소만 보충 조회합니다."
          error={fieldErrors.githubProfileUrl}
        >
          <input
            type="url"
            name="githubProfileUrl"
            value={githubProfileUrl}
            onChange={(event) => setGithubProfileUrl(event.target.value)}
            placeholder="https://github.com/octocat"
            aria-invalid={fieldErrors.githubProfileUrl ? true : undefined}
            className={inputClass}
          />
        </Field>

        <Field
          label="커밋 SHA (선택)"
          hint={
            commitSha.trim()
              ? "입력한 커밋을 고정해 채점합니다."
              : "비우면 입력 시점의 HEAD 커밋을 고정합니다. 이후 브랜치가 바뀌어도 그 커밋만 채점합니다."
          }
          error={fieldErrors.commitSha}
        >
          <input
            type="text"
            name="commitSha"
            value={commitSha}
            onChange={(event) => setCommitSha(event.target.value)}
            placeholder="예: 1a2b3c4d (7~40자)"
            spellCheck={false}
            aria-invalid={fieldErrors.commitSha ? true : undefined}
            className={`${inputClass} ${commitSha ? "font-mono" : ""}`}
          />
        </Field>
      </FormSection>

      {serverError ? (
        <p
          id="submission-server-error"
          role="alert"
          className="rounded-lg bg-fail/5 px-4 py-3 text-sm leading-relaxed text-neutral-800 ring-1 ring-fail/20"
        >
          {serverError}
        </p>
      ) : null}

      <section
        className="flex flex-col gap-2 rounded-xl bg-neutral-50 p-5 sm:p-6"
        data-testid="submit-summary"
      >
        <h2 className="text-base font-bold tracking-tight">이대로 제출합니다</h2>
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-neutral-500">채점 대상</dt>
          <dd className="text-neutral-800 [overflow-wrap:anywhere]">
            {parsedRepo ? (
              <>
                <span className="font-mono font-semibold">{parsedRepo}</span> ·{" "}
                {commitSha.trim() ? `커밋 ${commitSha.trim()}` : "기본 브랜치의 최신 커밋"}
              </>
            ) : (
              "저장소 URL을 입력하세요"
            )}
          </dd>
          <dt className="text-neutral-500">채점 기준</dt>
          <dd className="text-neutral-800 [overflow-wrap:anywhere]">
            {selected ? (
              <>
                {selected.label} · <span className="font-mono">{selected.rubricVersion}</span>
              </>
            ) : (
              "과제를 선택하세요"
            )}
          </dd>
          <dt className="text-neutral-500">맥락 자료</dt>
          <dd className="text-neutral-800">
            {hasContext ? "이력서·GitHub 프로필 있음" : "없음"}
          </dd>
        </dl>
        <p className="text-[13px] leading-relaxed text-neutral-500">
          맥락 자료는 면접 질문을 만드는 데만 씁니다. 채점 입력에는 들어가지 않으며, 이력서가 달라도
          과제 판정과 점수는 같습니다.
        </p>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row-reverse sm:items-center sm:justify-between sm:gap-6">
        <button
          type="submit"
          disabled={disabled}
          className={`${buttonClass("primary", "lg")} w-full sm:w-auto sm:min-w-44`}
        >
          {pending ? "제출 저장 중…" : "분석 및 채점"}
        </button>
        <span className="text-[13px] leading-relaxed text-neutral-500">
          제출하면 저장소 스냅샷을 수집하고 워커가 격리 환경에서 실행합니다.
        </span>
      </div>
    </form>
  );
}

/** 저장소 URL에서 `owner/repo`를 읽는다. 형식이 아니면 null (화면 안내용, 서버가 다시 검사한다) */
function parseRepoLabel(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const parsed = parseGitHubRepoUrl(value);
    return `${parsed.owner}/${parsed.repo}`;
  } catch {
    return null;
  }
}

/** 고른 과제 버전의 요약 (T-903). 명세 발췌·배점 표·실행 계약·승인 시각을 저장된 값에서 옮긴다 */
function VersionSummary({ summary }: { summary: ApprovedVersionSummary }) {
  return (
    <section
      className="flex flex-col gap-4 rounded-lg bg-neutral-50 px-4 py-4 sm:px-5"
      data-testid="version-summary"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-ink">
          {summary.title}
          <span className="ml-2 font-mono text-[13px] font-normal text-neutral-500">
            {summary.rubricVersion}
          </span>
        </p>
        <a href={summary.href} className="text-[13px] font-semibold text-primary hover:underline">
          과제 상세 보기
        </a>
      </div>
      {summary.specExcerpt ? (
        <p className="text-[13px] leading-relaxed text-neutral-600">{summary.specExcerpt}</p>
      ) : null}

      {summary.criteria.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[22rem] text-left text-[13px]">
            <caption className="sr-only">요구사항과 배점</caption>
            <thead>
              <tr className="border-b border-neutral-200 text-neutral-500">
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  기준
                </th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  요구사항
                </th>
                <th scope="col" className="py-1.5 pr-3 font-semibold">
                  영역
                </th>
                <th scope="col" className="py-1.5 text-right font-semibold">
                  배점
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.criteria.map((criterion) => (
                <tr key={criterion.id} className="border-b border-neutral-200/70">
                  <td className="py-1.5 pr-3 font-mono text-neutral-700">{criterion.id}</td>
                  <td className="py-1.5 pr-3 text-neutral-800">{criterion.title}</td>
                  <td className="py-1.5 pr-3 text-neutral-500">{criterion.areaLabel}</td>
                  <td className="py-1.5 text-right font-semibold text-ink">
                    {criterion.maxPoints}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="py-1.5 pr-3 font-semibold text-neutral-600" colSpan={3}>
                  합계
                </td>
                <td
                  className="py-1.5 text-right font-bold text-ink"
                  data-testid="version-total-points"
                >
                  {summary.totalPoints}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}

      {summary.contract.length > 0 ? (
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-[13px]">
          {summary.contract.map((item) => (
            <Fragment key={item.label}>
              <dt className="text-neutral-500">{item.label}</dt>
              <dd className="font-mono text-neutral-700 [overflow-wrap:anywhere]">{item.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}

      <p className="text-[13px] text-neutral-500">
        버전 v{summary.version}
        {summary.approvedAt ? ` · 승인 ${summary.approvedBy ?? "?"} · ${summary.approvedAt}` : ""}
      </p>
    </section>
  );
}

/** `예시로 채우기` 칩 (T-902). 누르면 입력란이 한 번에 채워진다 */
function ExampleChips({
  examples,
  selectedId,
  onSelect,
}: {
  examples: PrefillExample[];
  selectedId: string | null;
  onSelect: (example: PrefillExample) => void;
}) {
  if (examples.length === 0) return null;
  const groups = [
    { kind: "SAMPLE" as const, title: "샘플 구현", hint: "공개 샘플 저장소의 고정 커밋입니다." },
    {
      kind: "PERSONA" as const,
      title: "가상 지원자",
      hint: "지어낸 인물의 과제 제출물과 이력서입니다.",
    },
  ];
  return (
    <section
      className="flex flex-col gap-4 rounded-xl bg-neutral-50 p-5 sm:p-6"
      data-testid="prefill-chips"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-bold tracking-tight">예시로 채우기</h2>
        <p className="text-sm leading-relaxed text-neutral-500">
          입력란을 직접 채우는 대신 아래에서 하나를 고르면 저장소 URL·커밋 SHA·프로필 URL이
          채워집니다.
        </p>
      </div>
      {groups.map((group) => {
        const items = examples.filter((example) => example.kind === group.kind);
        if (items.length === 0) return null;
        return (
          <div key={group.kind} className="flex flex-col gap-2">
            <p className="text-[13px] font-semibold text-neutral-500">
              {group.title}
              <span className="ml-2 font-normal text-neutral-400">{group.hint}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {items.map((example) => (
                <button
                  key={example.id}
                  type="button"
                  onClick={() => onSelect(example)}
                  title={example.hint}
                  aria-pressed={selectedId === example.id}
                  data-testid={`prefill-chip-${example.id}`}
                  className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
                    selectedId === example.id
                      ? "bg-primary text-surface"
                      : "bg-surface text-neutral-700 ring-1 ring-neutral-200 hover:ring-primary/50"
                  }`}
                >
                  {example.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6 rounded-xl border border-neutral-200 bg-surface p-5 sm:p-7">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        <p className="text-sm leading-relaxed text-neutral-500">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className="text-[15px] font-semibold text-ink">{label}</span>
      {children}
      {hint ? (
        <span className="text-[13px] leading-relaxed text-neutral-500 [overflow-wrap:anywhere]">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-[13px] font-medium text-fail">
          {error}
        </span>
      ) : null}
    </label>
  );
}
