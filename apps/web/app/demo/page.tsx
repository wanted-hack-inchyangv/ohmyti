import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, LinkButton, Notice, PageContainer, PageHeader, buttonClass } from "@/components/ui";
import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import {
  isDemoModeEnabled,
  readDemoOverview,
  type DemoAssignmentSummary,
  type DemoOverview,
  type DemoSampleCardView,
} from "@/lib/demo/service";
import { ApprovalBadge } from "./approval-badge";
import { DemoRunButton } from "./demo-run-button";

export const metadata: Metadata = { title: "샘플 체험 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

/**
 * 샘플 체험 (T-505, T-901, PRD 7장). 샘플 카드 4개가 저장된 평가(`저장된 실행 · <시각>`)로 연결된다.
 * 결과와 숫자는 `pnpm demo:seed` 또는 성공한 새 실행이 실제 파이프라인으로 만든 값이며 이 화면은 저장된 값을 옮기기만 한다.
 * T-901에서 과제 요약·추천 순서·샘플 설명·확인할 것 딥링크를 더했다. 설명 문구에는 판정·점수를 적지 않는다.
 */
export default async function DemoPage() {
  if (!isDemoModeEnabled()) notFound();
  let overview: DemoOverview;
  try {
    overview = await readDemoOverview({ db: getDb().db, store: getArtifactStore() });
  } catch {
    return (
      <PageContainer>
        <PageHeader title="샘플 체험" />
        <Notice tone="neutral">
          저장된 실행을 읽지 못했습니다. 데이터베이스 연결을 확인하세요 (<code>/api/health</code>).
        </Notice>
      </PageContainer>
    );
  }
  return (
    <PageContainer data-testid="demo-page">
      <div className="flex flex-col gap-5">
        <PageHeader
          title="샘플 체험"
          badges={overview.approval ? <ApprovalBadge view={overview.approval} /> : null}
          description="같은 채용 과제를 네 가지 방식으로 제출한 결과입니다. 샘플은 공개 저장소의 고정 커밋이며 예시 이력서는 가상 인물입니다."
        />
        <Notice data-testid="demo-notice">{overview.notice}</Notice>
      </div>

      {overview.assignment ? <AssignmentSummary summary={overview.assignment} /> : null}

      <section className="flex flex-col gap-4" data-testid="demo-order">
        <h2 className="text-lg font-bold tracking-tight">추천 체험 순서</h2>
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {overview.recommendedOrder.map((step, index) => (
            <li
              key={step.title}
              className="flex flex-col gap-1.5 rounded-lg bg-neutral-50 px-4 py-3.5 ring-1 ring-neutral-200"
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[11px] font-bold text-neutral-700"
                >
                  {index + 1}
                </span>
                <span className="text-sm font-bold text-ink">{step.title}</span>
              </span>
              <span className="text-[13px] leading-relaxed text-neutral-600">{step.detail}</span>
            </li>
          ))}
        </ol>
      </section>

      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5" data-testid="demo-samples">
        {overview.samples.map((sample) => (
          <SampleCard key={sample.id} sample={sample} />
        ))}
      </ul>

      <div className="flex flex-col gap-4 border-t border-neutral-200 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-[13px] leading-relaxed text-neutral-500">
          새로 실행하면 저장된 스냅샷(GitHub 재수집 없음)으로 전체 파이프라인을 다시 돌립니다.
          실패하면 사유와 함께 이전의 저장된 실행을 안내합니다.
        </p>
        <nav className="flex shrink-0 gap-2">
          <LinkButton href="/" variant="ghost">
            처음으로
          </LinkButton>
          <LinkButton href="/submissions/new?sample=C" variant="secondary">
            직접 제출하기
          </LinkButton>
        </nav>
      </div>
    </PageContainer>
  );
}

/** 과제 요약. 명세 발췌·요구사항 수·총 배점은 DB의 승인된 버전에서 읽은 값이다 */
function AssignmentSummary({ summary }: { summary: DemoAssignmentSummary }) {
  return (
    <section
      className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-surface p-5 sm:p-6"
      data-testid="demo-assignment"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold tracking-tight">채용 과제</h2>
        <a
          href={summary.href}
          className="text-[13px] font-semibold text-primary hover:underline"
          data-testid="demo-assignment-link"
        >
          과제 상세 보기
        </a>
      </div>
      <p className="text-[15px] font-semibold text-ink">{summary.label}</p>
      {summary.specExcerpt ? (
        <p
          className="text-[15px] leading-relaxed text-neutral-600"
          data-testid="demo-assignment-spec"
        >
          {summary.specExcerpt}
        </p>
      ) : null}
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
        <div className="flex items-baseline gap-2">
          <dt className="text-neutral-500">요구사항</dt>
          <dd className="text-sm font-bold text-ink" data-testid="demo-assignment-criteria">
            {summary.requirementCount}개
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-neutral-500">총 배점</dt>
          <dd className="text-sm font-bold text-ink" data-testid="demo-assignment-points">
            {summary.totalPoints}점
          </dd>
        </div>
      </dl>
    </section>
  );
}

function SampleCard({ sample }: { sample: DemoSampleCardView }) {
  return (
    <li
      className="flex min-w-0 flex-col gap-5 rounded-xl border border-neutral-200 bg-surface p-5 transition-shadow hover:shadow-[0_4px_16px_rgba(23,23,25,0.08)] sm:p-6"
      data-testid={`demo-sample-${sample.id}`}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold tracking-tight">{sample.name}</h2>
          <Badge tone="neutral">샘플</Badge>
        </div>
        <p className="text-[15px] leading-relaxed text-neutral-600">{sample.description}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-[13px] font-bold text-neutral-500">어떤 구현인가</h3>
        <p
          className="text-sm leading-relaxed text-neutral-700"
          data-testid={`demo-implementation-${sample.id}`}
        >
          {sample.implementation}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-bold text-neutral-500">이 샘플로 확인할 것</h3>
        <ul className="flex flex-col gap-1.5" data-testid={`demo-checks-${sample.id}`}>
          {sample.checkViews.map((check) => (
            <li key={check.label} className="text-sm leading-relaxed">
              {check.href ? (
                <a
                  href={check.href}
                  className="font-medium text-primary hover:underline"
                  data-testid={`demo-check-${sample.id}-${check.criterionId}`}
                >
                  {check.label}
                </a>
              ) : (
                <span className="text-neutral-600">{check.label}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <a
          href={sample.repoUrl}
          className="font-medium text-neutral-700 hover:underline"
          data-testid={`demo-repo-${sample.id}`}
        >
          공개 저장소
        </a>
        <a
          href={sample.commitHref}
          className="font-mono text-neutral-500 hover:underline"
          data-testid={`demo-commit-${sample.id}`}
        >
          커밋 {sample.shortCommit}
        </a>
      </div>

      {sample.saved ? (
        <div className="mt-auto flex flex-col gap-3 rounded-lg bg-neutral-50 px-4 py-3.5">
          <span className="self-start">
            <Badge tone="neutral" data-testid={`demo-saved-badge-${sample.id}`}>
              {sample.saved.label}
            </Badge>
          </span>
          <dl className="grid grid-cols-[3.5rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            <dt className="text-neutral-500">점수</dt>
            <dd className="text-sm font-bold text-ink">
              {sample.saved.scoreDisplay ?? "판정 저장 전"}
            </dd>
            <dt className="text-neutral-500">SHA</dt>
            <dd className="font-mono text-neutral-700">{sample.saved.shortSha}</dd>
            <dt className="text-neutral-500">기준</dt>
            <dd className="font-mono break-all text-neutral-700">{sample.saved.rubricVersion}</dd>
          </dl>
        </div>
      ) : (
        <p
          className="mt-auto rounded-lg bg-neutral-50 px-4 py-3.5 text-sm leading-relaxed text-neutral-600"
          data-testid={`demo-saved-missing-${sample.id}`}
        >
          이 샘플의 저장된 실행이 아직 없습니다. 실행이 준비되면 워크벤치 링크가 여기에 나타납니다.
          지금은 공개 저장소를 열어 코드를 보거나 직접 채점을 요청할 수 있습니다.
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        {sample.saved ? (
          <a
            href={sample.saved.href}
            className={`${buttonClass("primary", "lg")} w-full sm:flex-1`}
            data-testid={`demo-saved-link-${sample.id}`}
          >
            워크벤치 열기
          </a>
        ) : null}
        <a
          href={sample.prefillHref}
          className={`${buttonClass("secondary", "lg")} w-full sm:flex-1`}
          data-testid={`demo-prefill-${sample.id}`}
        >
          이 샘플로 채점 요청
        </a>
        <DemoRunButton sampleId={sample.id} disabled={!sample.saved} />
      </div>
    </li>
  );
}
