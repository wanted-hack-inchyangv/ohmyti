import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { LinkButton, Notice } from "@/components/ui";
import { getArtifactStore } from "@/lib/artifacts";
import { readEvaluationContext, type EvaluationContextInput } from "@/lib/context/service";
import { getDb } from "@/lib/db";
import { readEvaluationReport, readInterviewKit } from "@/lib/reports/service";
import { requestOrigin } from "@/lib/request-path";
import {
  buildInterviewKitView,
  type InterviewKitInput,
  type KitPlanView,
} from "@/lib/workbench/interview-kit";
import { workbenchHref } from "@/lib/workbench/state";
import { AnchorTable, KitNotices, KitQuestionGroups, KitSummary } from "../interview-kit";
import { KitPlanSegments } from "../interview-kit-plan";

export const metadata: Metadata = { title: "인터뷰 키트 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

/**
 * 인터뷰 키트 인쇄용 보기 (TICKET.md T-704). 워크벤치 하단 탭과 같은 표시 모델을 쓰되 접힘·전환 없이 한 번에 펴서 보인다.
 * 진행안 45분·60분을 모두 적고, 근거는 누를 수 없는 인쇄물이므로 주소를 글자로 함께 적는다.
 * A4 인쇄 규칙(`@page`, 질문 카드의 `break-inside: avoid`)은 `globals.css`의 `@media print`에 있다.
 * 키트가 없는 평가는 사유를 적는다. 이전 후속 질문 목록은 워크벤치 탭에서만 보인다.
 */
export default async function InterviewKitPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const report = await readEvaluationReport({ db: getDb().db }, id);
  if (!report.ok) {
    if (report.code === "EVALUATION_NOT_FOUND" || report.code === "INVALID_INPUT") notFound();
    throw new Error(report.message);
  }
  let kit: InterviewKitInput;
  try {
    kit = await readInterviewKit({ db: getDb().db, store: getArtifactStore() }, id);
  } catch (error) {
    kit = {
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
      message: `인터뷰 키트를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let context: EvaluationContextInput;
  try {
    context = await readEvaluationContext(
      { db: getDb().db },
      { submissionId: report.data.evaluation.submissionId, evaluationId: id },
    );
  } catch (error) {
    context = {
      ok: false,
      message: `맥락을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const origin = requestOrigin(await headers());
  const workbench = workbenchHref(id, {
    criterionId: null,
    runId: null,
    tab: "questions",
    filter: "all",
    pane: "code",
    source: null,
    mutationId: null,
  });
  const view = buildInterviewKitView({
    report: report.data,
    kit,
    context,
    href: (patch) =>
      workbenchHref(
        id,
        {
          criterionId: null,
          runId: null,
          tab: null,
          filter: "all",
          pane: "code",
          source: null,
          mutationId: null,
        },
        patch,
      ),
    origin,
  });
  const { assignment, submission, evaluation } = report.data;
  return (
    <main
      className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pt-8 pb-20 sm:px-6 print:max-w-none print:gap-4 print:px-0 print:pt-0 print:pb-0"
      data-testid="interview-kit-print"
      data-kit-state={view.missing ? "missing" : "ok"}
    >
      <div
        className="flex flex-wrap items-center justify-between gap-3"
        data-print-hide
        data-testid="kit-print-actions"
      >
        <p className="text-[13px] text-neutral-500">
          브라우저의 인쇄(Ctrl/Cmd+P)로 A4에 맞추어 뽑거나 PDF로 저장해 주세요.
        </p>
        <LinkButton href={workbench} variant="secondary" size="sm">
          워크벤치로 돌아가기
        </LinkButton>
      </div>
      <header className="flex flex-col gap-2 border-b border-neutral-200 pb-4">
        <h1 className="text-xl font-bold tracking-tight text-ink">
          인터뷰 키트 · {assignment.title}
        </h1>
        <dl className="flex flex-col gap-1 text-[13px] text-neutral-600">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 font-semibold text-neutral-500">제출</dt>
            <dd className="min-w-0 break-all">
              {submission.repoUrl} @ <code className="font-mono">{evaluation.submissionSha}</code>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 font-semibold text-neutral-500">기준 버전</dt>
            <dd className="min-w-0 break-all">
              <code className="font-mono">{evaluation.rubricVersion}</code>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 font-semibold text-neutral-500">워크벤치</dt>
            <dd className="min-w-0 break-all">{origin ? `${origin}${workbench}` : workbench}</dd>
          </div>
        </dl>
        {view.missing ? null : <KitSummary kit={view} />}
      </header>
      {view.missing ? (
        <Notice tone="neutral" data-testid="kit-print-missing">
          <span className="font-semibold">{view.missing.title}</span>
          <span className="block text-neutral-600">{view.missing.description}</span>
        </Notice>
      ) : (
        <>
          <KitNotices kit={view} />
          {view.resumeQuoteNotice ? (
            <p className="text-[12px] text-neutral-500" data-testid="kit-print-resume-notice">
              {view.resumeQuoteNotice}
            </p>
          ) : null}
          {view.plans.map((plan) => (
            <PrintPlan key={plan.durationMinutes} plan={plan} />
          ))}
          <KitQuestionGroups kit={view} print />
          {view.anchors.length > 0 ? (
            <section className="flex flex-col gap-3" data-testid="kit-print-anchors">
              <h2 className="text-sm font-bold text-ink">평가 척도 (역량별 4단계)</h2>
              <p className="text-[12px] text-neutral-500">
                면접관이 기입할 때 쓰는 기준이며 시스템은 값을 채우지 않습니다.
              </p>
              {view.anchors.map((group) => (
                <div
                  key={group.competency}
                  data-anchor-competency={group.competency}
                  className="kit-anchor flex flex-col gap-1 rounded-lg border border-neutral-200 p-3"
                >
                  <h3 className="text-[13px] font-bold text-ink">
                    {group.name}
                    {group.interviewOnly ? (
                      <span className="ml-2 font-medium text-neutral-500">면접에서만 확인</span>
                    ) : null}
                  </h3>
                  <p className="text-[12px] text-neutral-500">{group.definition}</p>
                  <AnchorTable group={group} />
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

function PrintPlan({ plan }: { plan: KitPlanView }) {
  return (
    <section className="kit-plan flex flex-col gap-2" data-testid="kit-print-plan">
      <h2 className="text-sm font-bold text-ink">
        {plan.durationMinutes}분 진행안
        <span className="ml-2 font-medium text-neutral-500">구간 합 {plan.totalMinutes}분</span>
      </h2>
      <KitPlanSegments plan={plan} />
    </section>
  );
}
