import type { Metadata } from "next";
import { Notice, PageContainer, PageHeader } from "@/components/ui";
import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import {
  listApprovedVersionSummaries,
  STAGE_LABEL,
  type ApprovedVersionSummary,
} from "@/lib/submissions/service";
import { listSavedRunMatches } from "@/lib/demo/service";
import { findSavedRunByRepo, type SavedRunMatch } from "@/lib/demo/saved-run";
import { PREFILL_EXAMPLES, readPrefill, type PrefillValues } from "@/lib/submissions/prefill";
import { SubmissionForm } from "./submission-form";

export const metadata: Metadata = { title: "제출 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

const DESCRIPTION =
  "공개 GitHub 저장소를 승인된 과제 기준으로 채점합니다. 이력서와 GitHub 프로필은 선택이며, 없어도 과제 채점은 진행됩니다.";

interface NewSubmissionPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * PRD 6장 ② 입력 폼. 과제 선택지는 승인된 버전뿐이다 (T-201).
 * T-902에서 `?sample=A|B|C|D`·`?persona=<핸들>` 프리필을 더했다. 아는 값이 아니면 빈 폼이다.
 */
export default async function NewSubmissionPage({ searchParams }: NewSubmissionPageProps) {
  const prefill = readPrefill(await searchParams);
  let options: ApprovedVersionSummary[];
  let savedRuns: SavedRunMatch[];
  try {
    options = await listApprovedVersionSummaries({ db: getDb().db, store: getArtifactStore() });
    // 같은 입력으로 이미 끝난 실행이 있으면 기다리지 않고 먼저 볼 수 있게 한다 (T-904)
    savedRuns = await listSavedRunMatches({ db: getDb().db });
  } catch {
    // 연결 문자열 등 비밀값이 섞일 수 있으므로 오류 본문은 화면에 내지 않는다
    return (
      <PageContainer width="narrow">
        <PageHeader eyebrow="채점 요청" title="제출" />
        <Notice tone="error">
          과제 목록을 읽지 못했습니다. 데이터베이스 연결을 확인하세요 (<code>/api/health</code>).
        </Notice>
      </PageContainer>
    );
  }
  return (
    <PageContainer width="narrow">
      <PageHeader eyebrow="채점 요청" title="제출" description={DESCRIPTION} />
      <SubmissionForm
        options={options}
        prefill={{ ...prefill, assignmentVersionId: prefillVersionId(prefill, savedRuns, options) }}
        examples={PREFILL_EXAMPLES}
        savedRuns={savedRuns}
      />
      <StagePreview />
    </PageContainer>
  );
}

/** 제출 뒤 진행되는 실제 7단계 이름. 진행 상태가 아니라 순서 안내다 */
function StagePreview() {
  const labels = Object.values(STAGE_LABEL);
  return (
    <section className="flex flex-col gap-4 rounded-xl bg-neutral-50 p-5 sm:p-7">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-bold tracking-tight">제출하면 이 순서로 진행됩니다</h2>
        <p className="text-sm leading-relaxed text-neutral-500">
          제출 상태 화면에서 단계마다 워커가 남긴 기록을 확인할 수 있습니다.
        </p>
      </div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {labels.map((label, index) => (
          <li
            key={label}
            className="flex items-center gap-3 rounded-lg bg-surface px-3.5 py-3 ring-1 ring-neutral-200"
          >
            <span
              aria-hidden="true"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-xs font-bold text-neutral-600"
            >
              {index + 1}
            </span>
            <span className="text-sm font-semibold text-neutral-800">{label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * 프리필이 가리키는 과제 버전 (T-902·T-904). 같은 저장소·커밋의 저장된 실행이 쓴 버전을 고르고,
 * 그 버전이 승인 목록에 없으면 null이라 폼이 첫 번째 승인 버전을 쓴다.
 */
function prefillVersionId(
  prefill: PrefillValues,
  savedRuns: SavedRunMatch[],
  options: ApprovedVersionSummary[],
): string | null {
  const saved = findSavedRunByRepo(savedRuns, prefill);
  if (!saved) return null;
  return options.some((option) => option.id === saved.assignmentVersionId)
    ? saved.assignmentVersionId
    : null;
}
