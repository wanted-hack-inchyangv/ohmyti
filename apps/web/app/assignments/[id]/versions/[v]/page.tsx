import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BOOTSTRAP_APPROVAL_BADGE, isBootstrapApprovalPendingReview } from "@ohmyti/core";
import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import {
  contractToForm,
  formatExtras,
  rubricToExtras,
  rubricToRows,
} from "@/lib/assignments/editor";
import {
  ASSIGNMENT_VERSION_STATUS_LABEL,
  readVersionSetup,
  type VersionSetupView,
} from "@/lib/assignments/service";
import { AssignmentEditor } from "../../../assignment-editor";
import { Badge, Notice, PageContainer, PageHeader, SectionHeader } from "@/components/ui";
import {
  BackLink,
  ContractTable,
  RubricReadOnlyTable,
  SampleTable,
  SpecPreview,
  ValidationChecksTable,
  ValidationResultView,
  VersionStatusBadge,
} from "../../../setup-views";
import { NewVersionButton } from "./new-version-button";
import { ValidationControls } from "./validation-section";

export const metadata: Metadata = { title: "과제 설정 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

interface VersionPageProps {
  params: Promise<{ id: string; v: string }>;
}

/**
 * 버전 상태별 화면 구성 (T-406). 편집기는 DRAFT에서만, 검증·승인 컨트롤은 DRAFT·VALIDATING에서만 그린다.
 * 승인·폐기된 버전은 읽기 전용이며 `새 버전 만들기`로만 고친다.
 */
export function versionScreen(status: VersionSetupView["version"]["status"]) {
  return {
    editable: status === "DRAFT",
    validationControls: status === "DRAFT" || status === "VALIDATING",
    newVersion: status !== "DRAFT",
  };
}

const cardClass =
  "flex min-w-0 flex-col gap-4 rounded-xl border border-neutral-200 bg-surface p-5 sm:p-6";

/** 편집할 수 없는 버전의 본문: 명세·실행 계약·기준 표 (입력·버튼 없음) */
export function ReadOnlyVersionView({ setup }: { setup: VersionSetupView }) {
  const { version } = setup;
  return (
    <div
      className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
      data-testid="version-readonly"
    >
      <section className="flex min-w-0 flex-col gap-4" aria-label="명세와 실행 계약">
        <div className={cardClass}>
          <h2 className="text-lg font-bold tracking-tight">과제 명세</h2>
          {setup.specMarkdown !== null ? (
            <SpecPreview text={setup.specMarkdown} />
          ) : (
            <p className="rounded-lg bg-fail/5 px-4 py-3 text-sm leading-relaxed break-all text-neutral-800 ring-1 ring-fail/20">
              {setup.specError}
            </p>
          )}
        </div>
        <div className={cardClass}>
          <h2 className="text-lg font-bold tracking-tight">실행 계약</h2>
          <ContractTable contract={version.executionContract} />
          <p className="text-[13px] text-neutral-500">
            하네스{" "}
            <span className="font-mono break-all text-neutral-700">{version.harnessVersion}</span>
          </p>
        </div>
      </section>
      <section className={cardClass} aria-label="요구사항과 배점">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold tracking-tight">요구사항·배점</h2>
          <span className="font-mono text-[13px] text-neutral-500">{version.rubricVersion}</span>
        </div>
        <RubricReadOnlyTable rubric={version.rubric} />
      </section>
    </div>
  );
}

export default async function AssignmentVersionPage({ params }: VersionPageProps) {
  const { id, v } = await params;
  const versionNumber = Number(v);
  let result: Awaited<ReturnType<typeof readVersionSetup>>;
  try {
    result = await readVersionSetup(
      { db: getDb().db, store: getArtifactStore() },
      id,
      versionNumber,
    );
  } catch {
    // 연결 문자열 등 비밀값이 섞일 수 있으므로 오류 본문은 화면에 내지 않는다
    return (
      <PageContainer width="wide">
        <PageHeader title="과제 설정" />
        <Notice tone="error">
          과제 버전을 읽지 못했습니다. 데이터베이스 연결을 확인하세요 (
          <code className="font-mono">/api/health</code>).
        </Notice>
      </PageContainer>
    );
  }
  if (!result.ok) notFound();
  const setup = result.data;
  const { version, assignment } = setup;
  const screen = versionScreen(version.status);
  const bootstrap = isBootstrapApprovalPendingReview(
    version,
    setup.samples.map((s) => ({ humanReviewedBy: s.humanReviewedBy })),
  );

  return (
    <PageContainer width="wide">
      <div className="flex flex-col gap-4">
        <BackLink />
        <PageHeader
          title={assignment.name}
          badges={
            <>
              <VersionStatusBadge
                status={version.status}
                label={ASSIGNMENT_VERSION_STATUS_LABEL[version.status]}
                data-testid="version-status"
                data-status={version.status}
              />
              {bootstrap ? <Badge tone="pending">{BOOTSTRAP_APPROVAL_BADGE}</Badge> : null}
            </>
          }
          description={
            <div className="flex flex-col gap-1">
              <p className="font-semibold text-neutral-800">
                v{version.version} · {version.title}
              </p>
              {version.status === "APPROVED" || version.status === "RETIRED" ? (
                <p data-testid="approval-info">
                  {version.approvedBy ?? "-"} 승인 ·{" "}
                  {version.approvedAt?.toISOString().slice(0, 10) ?? "-"}
                  {version.status === "APPROVED"
                    ? " · 승인된 버전은 바꿀 수 없습니다. 수정은 새 버전으로 만듭니다."
                    : " · 폐기된 버전입니다."}
                </p>
              ) : null}
            </div>
          }
          actions={
            screen.newVersion ? (
              <NewVersionButton
                assignmentId={assignment.id}
                sourceVersionId={version.id}
                rubric={version.rubric}
              />
            ) : null
          }
        />
        {setup.versions.length > 1 ? (
          <nav className="flex flex-wrap gap-2" aria-label="버전">
            {setup.versions.map((item) => (
              <Link
                key={item.version}
                href={`/assignments/${assignment.id}/versions/${item.version}`}
                aria-current={item.version === version.version ? "page" : undefined}
                className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${item.version === version.version ? "bg-ink text-surface" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
              >
                v{item.version} · {ASSIGNMENT_VERSION_STATUS_LABEL[item.status]}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>

      {screen.editable ? (
        <AssignmentEditor
          key={version.rubricVersion}
          mode="draft"
          assignmentId={assignment.id}
          assignmentVersionId={version.id}
          initial={{
            name: assignment.name,
            description: assignment.description ?? "",
            title: version.title,
            specMarkdown: setup.specMarkdown ?? "",
            contract: contractToForm(version.executionContract),
            rows: rubricToRows(version.rubric),
            extrasJson: formatExtras(rubricToExtras(version.rubric)),
            harnessVersion: version.harnessVersion,
          }}
        />
      ) : (
        <ReadOnlyVersionView setup={setup} />
      )}

      <section
        className="flex flex-col gap-5 border-t border-neutral-200 pt-10"
        aria-label="채점기 검증"
      >
        <div className="flex flex-col gap-2">
          <SectionHeader title="채점기 검증" />
          <p className="max-w-3xl text-[15px] leading-relaxed text-neutral-600">
            사람이 검토한 검증 샘플을 이 기준으로 실제로 채점해 기대 결과와 대조합니다. 정답·대안
            구현은 통과하고 결함 구현은 해당 요구사항에서 실패해야 승인할 수 있습니다.
          </p>
        </div>
        <div className={cardClass}>
          <h3 className="text-base font-bold tracking-tight">검증 샘플</h3>
          <SampleTable samples={setup.samples} />
        </div>
        {setup.validation ? (
          <div className="flex flex-col gap-4" data-testid="validation-result">
            <ValidationChecksTable result={setup.validation} />
            <ValidationResultView result={setup.validation} showSamples={false} />
          </div>
        ) : null}
        {screen.validationControls ? (
          <ValidationControls
            assignmentVersionId={version.id}
            status={version.status}
            validation={setup.validation}
            validationJob={setup.validationJob}
            blockers={setup.blockers}
            sampleCount={setup.samples.length}
          />
        ) : null}
      </section>
    </PageContainer>
  );
}
