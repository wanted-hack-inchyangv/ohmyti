import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LinkButton, Notice, PageContainer, PageHeader } from "@/components/ui";
import { getDb } from "@/lib/db";
import { readSubmissionStatus, type SubmissionStatusView } from "@/lib/submissions/service";
import { DeleteSubmission } from "./delete-submission";
import { SubmissionStatus } from "./submission-status";

export const metadata: Metadata = { title: "제출 상태 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

interface SubmissionPageProps {
  params: Promise<{ id: string }>;
}

/** PRD 6장 ② 작업 단계 화면. 서버가 첫 상태를 그리고 클라이언트가 종료 전까지만 폴링한다 */
export default async function SubmissionPage({ params }: SubmissionPageProps) {
  const { id } = await params;
  let result: Awaited<ReturnType<typeof readSubmissionStatus>>;
  try {
    result = await readSubmissionStatus({ db: getDb().db }, id);
  } catch {
    return (
      <PageContainer width="narrow">
        <PageHeader title="제출 상태" />
        <Notice tone="error">
          제출 상태를 읽지 못했습니다. 데이터베이스 연결을 확인하세요 (<code>/api/health</code>).
        </Notice>
      </PageContainer>
    );
  }
  if (!result.ok) {
    if (result.code === "SUBMISSION_NOT_FOUND" || result.code === "INVALID_INPUT") notFound();
    throw new Error(result.message);
  }
  const view: SubmissionStatusView = result.data;
  return (
    <PageContainer width="narrow">
      <PageHeader
        title="제출 상태"
        description={
          <span className="break-all font-mono text-[13px] text-neutral-500">
            {view.submission.id}
          </span>
        }
      />
      <SubmissionStatus initial={view} />
      <div className="flex items-center justify-between gap-4 border-t border-neutral-200 pt-6">
        <LinkButton href="/submissions/new" variant="secondary">
          새 제출
        </LinkButton>
        <DeleteSubmission submissionId={view.submission.id} running={!view.terminal} />
      </div>
    </PageContainer>
  );
}
