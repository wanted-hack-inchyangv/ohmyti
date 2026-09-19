import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LinkButton, Notice, PageContainer, PageHeader } from "@/components/ui";
import { getDb } from "@/lib/db";
import { readDemoRunStatus, type DemoRunStatusView } from "@/lib/demo/service";
import { DemoRunStatus } from "./demo-run-status";

export const metadata: Metadata = { title: "샘플 새 실행 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

interface DemoRunPageProps {
  params: Promise<{ id: string }>;
}

/** 샘플 새 실행 화면 (T-505). 서버가 첫 상태를 그리고 클라이언트가 끝날 때까지 폴링한다 */
export default async function DemoRunPage({ params }: DemoRunPageProps) {
  const { id } = await params;
  let result: Awaited<ReturnType<typeof readDemoRunStatus>>;
  try {
    result = await readDemoRunStatus({ db: getDb().db }, id);
  } catch {
    return (
      <PageContainer width="narrow">
        <PageHeader title="샘플 새 실행" />
        <Notice tone="neutral">
          상태를 읽지 못했습니다. 데이터베이스 연결을 확인하세요 (<code>/api/health</code>).
        </Notice>
      </PageContainer>
    );
  }
  if (!result.ok) {
    if (result.code === "RUN_NOT_FOUND" || result.code === "INVALID_INPUT") notFound();
    throw new Error(result.message);
  }
  const view: DemoRunStatusView = result.data;
  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="샘플 새 실행"
        title={view.sampleName}
        description={
          <span className="break-all font-mono text-[13px] text-neutral-500">
            {view.submissionId}
          </span>
        }
      />
      <DemoRunStatus initial={view} />
      <nav className="flex flex-col gap-2 border-t border-neutral-200 pt-6 sm:flex-row">
        <LinkButton href="/demo" variant="secondary">
          샘플 체험으로
        </LinkButton>
        <LinkButton href={`/submissions/${view.submissionId}`} variant="ghost">
          단계별 제출 상태
        </LinkButton>
      </nav>
    </PageContainer>
  );
}
