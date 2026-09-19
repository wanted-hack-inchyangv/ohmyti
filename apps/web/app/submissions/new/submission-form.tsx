"use client";

import {
  InvalidRepoUrlError,
  isCommitShaInput,
  parseGitHubProfileUrl,
  parseGitHubRepoUrl,
} from "@ohmyti/core";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { buttonClass, inputClassName } from "@/components/ui";
import { createSubmissionFromFormAction } from "@/lib/submissions/actions";
import type { ApprovedVersionOption } from "@/lib/submissions/service";

interface SubmissionFormProps {
  options: ApprovedVersionOption[];
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

export function SubmissionForm({ options }: SubmissionFormProps) {
  const [assignmentVersionId, setAssignmentVersionId] = useState(options[0]?.id ?? "");
  const [repoUrl, setRepoUrl] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [githubProfileUrl, setGithubProfileUrl] = useState("");
  const [resumeName, setResumeName] = useState<string | null>(null);
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

  const disabled = options.length === 0 || pending;

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-6"
      noValidate
      aria-describedby={serverError ? "submission-server-error" : undefined}
    >
      <FormSection title="필수 정보" description="채점 기준이 될 과제와 제출된 저장소입니다.">
        <Field label="채용 과제" error={fieldErrors.assignmentVersionId}>
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
