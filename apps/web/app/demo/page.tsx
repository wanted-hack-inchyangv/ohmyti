import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, LinkButton, Notice, PageContainer, PageHeader, buttonClass } from "@/components/ui";
import { getDb } from "@/lib/db";
import { isDemoModeEnabled, readDemoOverview, type DemoOverview } from "@/lib/demo/service";
import { ApprovalBadge } from "./approval-badge";
import { DemoRunButton } from "./demo-run-button";

export const metadata: Metadata = { title: "샘플 체험 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

/**
 * 샘플 체험 (T-505, PRD 7장). 샘플 카드 4개가 저장된 평가(`저장된 실행 · <시각>`)로 연결된다.
 * 결과와 숫자는 `pnpm demo:seed` 또는 성공한 새 실행이 실제 파이프라인으로 만든 값이며 이 화면은 저장된 값을 옮기기만 한다.
 */
export default async function DemoPage() {
  if (!isDemoModeEnabled()) notFound();
  let overview: DemoOverview;
  try {
    overview = await readDemoOverview({ db: getDb().db });
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
          description="과제: TypeScript 주문·재고 API. 같은 Idempotency-Key의 반복 주문은 한 번만 처리되어야 합니다. 샘플은 공개 저장소의 고정 커밋이며 예시 이력서는 가상 인물입니다."
        />
        <Notice data-testid="demo-notice">{overview.notice}</Notice>
      </div>

      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5" data-testid="demo-samples">
        {overview.samples.map((sample) => (
          <li
            key={sample.id}
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
                  <dd className="font-mono break-all text-neutral-700">
                    {sample.saved.rubricVersion}
                  </dd>
                </dl>
              </div>
            ) : (
              <p
                className="mt-auto rounded-lg bg-neutral-50 px-4 py-3.5 text-sm leading-relaxed text-neutral-600"
                data-testid={`demo-saved-missing-${sample.id}`}
              >
                저장된 실행이 없습니다. <code>pnpm demo:seed</code>로 실제 실행을 먼저 만들어야
                합니다.
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
              <DemoRunButton sampleId={sample.id} disabled={!sample.saved} />
            </div>
          </li>
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
          <LinkButton href="/submissions/new" variant="secondary">
            직접 제출하기
          </LinkButton>
        </nav>
      </div>
    </PageContainer>
  );
}
