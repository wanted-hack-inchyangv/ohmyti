import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { BOOTSTRAP_APPROVAL_BADGE } from "@ohmyti/core";
import { getDb } from "@/lib/db";
import {
  ASSIGNMENT_VERSION_STATUS_LABEL,
  formatVersionLabel,
  readAssignmentList,
  type AssignmentListItem,
} from "@/lib/assignments/service";
import { Badge, EmptyState, Notice, PageContainer, PageHeader, buttonClass } from "@/components/ui";
import { ValidationResultView, VersionStatusBadge } from "./setup-views";

export const metadata: Metadata = { title: "과제 목록 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

function formatDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "-";
}

/** 메타 한 칸: 회색 라벨 + 값 */
function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-neutral-400">{label}</span>
      <span className="text-neutral-700">{children}</span>
    </span>
  );
}

/** 목록 본문. 페이지가 DB에서 읽은 항목을 넘긴다 (테스트에서 직접 렌더링) */
export function AssignmentList({ items }: { items: AssignmentListItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="등록된 과제가 없습니다"
        description={
          <>
            <code className="font-mono text-[13px]">pnpm db:seed:sample</code>로 샘플 과제를
            등록하거나{" "}
            <Link href="/assignments/new" className="font-semibold text-primary hover:underline">
              새 과제
            </Link>
            를 만드세요.
          </>
        }
      />
    );
  }
  return (
    <ul className="flex flex-col gap-4">
      {items.map((item) => (
        <li
          key={item.id}
          className="overflow-hidden rounded-xl border border-neutral-200 bg-surface"
        >
          <div className="flex flex-col gap-1.5 px-5 pt-5 pb-4 sm:px-6">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold tracking-tight sm:text-xl">{item.name}</h2>
              <span className="text-[13px] text-neutral-500">버전 {item.versions.length}개</span>
            </div>
            {item.description ? (
              <p className="text-[15px] leading-relaxed text-neutral-600">{item.description}</p>
            ) : null}
          </div>
          {item.versions.length === 0 ? (
            <p className="border-t border-neutral-200 px-5 py-4 text-sm text-neutral-500 sm:px-6">
              버전이 아직 없습니다.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-200 border-t border-neutral-200">
              {item.versions.map((version) => (
                <li
                  key={version.id}
                  className="group relative flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-neutral-50 sm:px-6"
                  data-version-label={formatVersionLabel(item.name, version)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/assignments/${item.id}/versions/${version.version}`}
                          className="text-base font-bold after:absolute after:inset-0 after:content-['']"
                        >
                          v{version.version}
                        </Link>
                        {version.title !== `v${version.version}` ? (
                          <span className="min-w-0 text-[15px] text-neutral-700">
                            {version.title}
                          </span>
                        ) : null}
                        <VersionStatusBadge
                          status={version.status}
                          label={ASSIGNMENT_VERSION_STATUS_LABEL[version.status]}
                        />
                        {version.bootstrapPendingReview ? (
                          <Badge tone="pending" data-testid="bootstrap-approval-badge">
                            {BOOTSTRAP_APPROVAL_BADGE}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                        <Meta label="기준">
                          <span className="font-mono break-all">{version.rubricVersion}</span>
                        </Meta>
                        <Meta label="하네스">
                          <span className="font-mono break-all">{version.harnessVersion}</span>
                        </Meta>
                        <Meta label="승인">
                          {version.status === "APPROVED" || version.status === "RETIRED"
                            ? `${version.approvedBy ?? "-"} · ${formatDate(version.approvedAt)}`
                            : "-"}
                        </Meta>
                        <Meta label="검증 샘플">
                          {version.samplesTotal === 0
                            ? "없음"
                            : `${version.samplesTotal}개 · 검토 ${version.samplesReviewed}/${version.samplesTotal}`}
                        </Meta>
                        <Meta label="제출">{version.submissionCount}건</Meta>
                      </div>
                    </div>
                    <span
                      aria-hidden="true"
                      className="mt-0.5 text-xl leading-none text-neutral-300 transition-colors group-hover:text-neutral-500"
                    >
                      ›
                    </span>
                  </div>
                  <div className="relative empty:hidden">
                    <ValidationResultView result={version.validationResult} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

export default async function AssignmentsPage() {
  let items: AssignmentListItem[];
  try {
    items = await readAssignmentList({ db: getDb().db });
  } catch {
    // 연결 문자열 등 비밀값이 섞일 수 있으므로 오류 본문은 화면에 내지 않는다
    return (
      <PageContainer>
        <PageHeader title="과제" />
        <Notice tone="error">
          과제 목록을 읽지 못했습니다. 데이터베이스 연결을 확인하세요 (
          <code className="font-mono">/api/health</code>).
        </Notice>
      </PageContainer>
    );
  }
  return (
    <PageContainer>
      <PageHeader
        title="과제"
        description="승인된 버전에만 제출을 받습니다. 승인된 버전은 바꿀 수 없고, 수정은 새 버전으로 만듭니다."
        actions={
          <Link href="/assignments/new" className={buttonClass("primary", "lg")}>
            새 과제
          </Link>
        }
      />
      <AssignmentList items={items} />
    </PageContainer>
  );
}
