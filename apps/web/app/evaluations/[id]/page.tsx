import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Notice, PageContainer, PageHeader } from "@/components/ui";
import { getArtifactStore } from "@/lib/artifacts";
import { readEvaluationContext, type EvaluationContextInput } from "@/lib/context/service";
import { getDb } from "@/lib/db";
import { readApprovalBadge, type ApprovalBadgeView } from "@/lib/demo/service";
import {
  readDesignSignals,
  readEvaluationReport,
  readFunctionGraph,
  readInterviewKit,
  readMutationDiff,
  readRunRecord,
} from "@/lib/reports/service";
import { requestOrigin } from "@/lib/request-path";
import { readRerunStatus } from "@/lib/reruns/service";
import { buildContextTabsView } from "@/lib/workbench/context-tabs";
import {
  buildInterviewKitView,
  type InterviewKitInput,
  type InterviewKitView,
} from "@/lib/workbench/interview-kit";
import type { DesignSignalsInput } from "@/lib/workbench/evidence-panel";
import type { FunctionGraphInput } from "@/lib/workbench/graph";
import { selectMutationExperiment, type MutationDetailInput } from "@/lib/workbench/mutation";
import {
  selectReplayRunId,
  type RerunStatusInput,
  type RunRecordInput,
} from "@/lib/workbench/replay";
import {
  parseWorkbenchSearchParams,
  workbenchHref,
  type SearchParamsInput,
} from "@/lib/workbench/state";
import { buildWorkbenchView, defaultCriterionId } from "@/lib/workbench/view";
import { WorkbenchShell } from "./workbench-shell";

export const metadata: Metadata = { title: "채점 워크벤치 · CodeGraph Reviewer" };
export const dynamic = "force-dynamic";

interface EvaluationPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParamsInput>;
}

/**
 * PRD 6장 ③ 채점 워크벤치. 리포트는 `/api/evaluations/[id]`와 같은 `readEvaluationReport`로 읽어
 * 헤더 값이 API 응답과 같다. 중앙 패널의 실행 기록 본문(T-303)은 `/api/evaluations/[id]/runs/[runId]`와 같은
 * `readRunRecord`로 읽는다. 관련 함수 그래프(T-304)는 그래프 탭(`?pane=graph`)일 때만 `/api/evaluations/[id]/graph`와 같은
 * `readFunctionGraph`로 읽는다. 재실행 상태(T-307)는 `/api/evaluations/[id]/reruns`와 같은 `readRerunStatus`로 읽는다.
 * 사람 검토 기준(R-12 등)을 고르면 설계 신호(T-605)를 `/api/evaluations/[id]/design-signals`와 같은 `readDesignSignals`로 읽는다.
 * 테스트 실효성 그룹(T-404)을 고르면 펼친 변형 실험의 diff와 두 실행 기록(검증·제출 테스트)을 함께 읽는다.
 * 하단 탭(T-504)을 열면 맥락 연결·GitHub 근거를 `readEvaluationContext`로 읽고, 미평가 영역 탭이면 분석 범위 한계를 보이려고
 * 관련 함수 그래프 결과도 읽는다. 인터뷰 키트 탭(T-704)이면 `/api/evaluations/[id]/interview-kit`과 같은 `readInterviewKit`으로
 * 키트 아티팩트를 읽는다. 키트가 없는 이전 평가는 이전 후속 질문 목록을 보인다.
 * 선택 상태(기준·실행 기록·탭)는 URL 쿼리에만 둔다.
 */
/** 키트 아티팩트를 읽는다. 스토어 설정·연결 오류도 사유로 바꿔 화면이 이전 후속 질문 목록을 보이게 한다 (G-14) */
async function readInterviewKitSafely(id: string): Promise<InterviewKitInput> {
  try {
    return await readInterviewKit({ db: getDb().db, store: getArtifactStore() }, id);
  } catch (error) {
    return {
      ok: false,
      code: "ARTIFACT_NOT_FOUND",
      message: `인터뷰 키트를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export default async function EvaluationPage({ params, searchParams }: EvaluationPageProps) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  let result: Awaited<ReturnType<typeof readEvaluationReport>>;
  try {
    result = await readEvaluationReport({ db: getDb().db }, id);
  } catch {
    return (
      <PageContainer width="narrow">
        <PageHeader title="채점 워크벤치" eyebrow="평가를 열 수 없습니다" />
        <Notice tone="error">
          평가를 읽지 못했습니다. 데이터베이스 연결을 확인하세요 (
          <code className="font-mono">/api/health</code>).
        </Notice>
      </PageContainer>
    );
  }
  if (!result.ok) {
    if (result.code === "EVALUATION_NOT_FOUND" || result.code === "INVALID_INPUT") notFound();
    throw new Error(result.message);
  }
  const parsed = parseWorkbenchSearchParams(query);
  // 아무것도 고르지 않고 들어오면 실패한 기준부터 연다. 실행 기록만 고른 딥링크는 그대로 둔다
  const urlState =
    parsed.criterionId || parsed.runId
      ? parsed
      : { ...parsed, criterionId: defaultCriterionId(result.data) };
  const runId = selectReplayRunId(result.data, urlState);
  let runRecord: RunRecordInput | null = null;
  if (runId) {
    try {
      runRecord = await readRunRecord({ db: getDb().db, store: getArtifactStore() }, id, runId);
    } catch (error) {
      // 스토어 설정·연결 오류. 리포트는 보여 주고 본문 자리에 사유를 적는다 (G-14)
      runRecord = {
        ok: false,
        code: "ARTIFACT_NOT_FOUND",
        message: `실행 기록 본문을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  let rerunStatus: RerunStatusInput | null = null;
  if (runId) {
    try {
      rerunStatus = await readRerunStatus({ db: getDb().db }, id);
    } catch (error) {
      rerunStatus = {
        ok: false,
        code: "INTERNAL",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  let functionGraph: FunctionGraphInput | null = null;
  if (urlState.pane === "graph" || urlState.tab === "unevaluated") {
    try {
      functionGraph = await readFunctionGraph({ db: getDb().db, store: getArtifactStore() }, id);
    } catch (error) {
      functionGraph = {
        ok: false,
        code: "ARTIFACT_NOT_FOUND",
        message: `분석 결과를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  let mutationDetail: MutationDetailInput | null = null;
  const experiment = selectMutationExperiment(result.data, urlState);
  if (experiment) {
    const deps = { db: getDb().db, store: getArtifactStore() };
    const readRun = async (recordId: string | undefined): Promise<RunRecordInput | null> => {
      if (!recordId) return null;
      if (recordId === runId && runRecord) return runRecord;
      try {
        return await readRunRecord(deps, id, recordId);
      } catch (error) {
        return {
          ok: false,
          code: "ARTIFACT_NOT_FOUND",
          message: `실행 기록 본문을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    const readDiff = async (): Promise<MutationDetailInput["diff"]> => {
      if (!experiment.patchRef) return null;
      try {
        const diff = await readMutationDiff(deps, id, experiment.mutationId);
        return diff.ok ? { ok: true, text: diff.data.diff } : { ok: false, message: diff.message };
      } catch (error) {
        return {
          ok: false,
          message: `diff를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    const [diff, validation, tests] = await Promise.all([
      readDiff(),
      readRun(experiment.validationRecordId),
      readRun(experiment.testRecordId),
    ]);
    mutationDetail = { mutationId: experiment.mutationId, diff, validation, tests };
  }
  let designSignals: DesignSignalsInput | null = null;
  const selectedCriterion = result.data.rubric.criteria.find((c) => c.id === urlState.criterionId);
  if (selectedCriterion?.method === "HUMAN_REVIEW") {
    try {
      designSignals = await readDesignSignals({ db: getDb().db, store: getArtifactStore() }, id);
    } catch (error) {
      designSignals = {
        ok: false,
        code: "READ_FAILED",
        message: `코드 신호를 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const href = (patch: Parameters<typeof workbenchHref>[2]) => workbenchHref(id, urlState, patch);
  const view = buildWorkbenchView(
    result.data,
    urlState,
    href,
    runRecord,
    urlState.pane === "graph" ? functionGraph : null,
    rerunStatus,
    mutationDetail,
    designSignals,
  );
  let contextTabs = null;
  let interviewKit: InterviewKitView | null = null;
  if (urlState.tab) {
    let context: EvaluationContextInput;
    try {
      context = await readEvaluationContext(
        { db: getDb().db },
        { submissionId: result.data.evaluation.submissionId, evaluationId: id },
      );
    } catch (error) {
      context = {
        ok: false,
        message: `맥락을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    contextTabs = buildContextTabsView(result.data, urlState.tab, context, functionGraph, href);
    if (urlState.tab === "questions") {
      interviewKit = buildInterviewKitView({
        report: result.data,
        kit: await readInterviewKitSafely(id),
        context,
        href,
        origin: requestOrigin(await headers()),
      });
    }
  }
  // 배지는 보조 정보다. 읽지 못하면 배지 없이 리포트를 보인다 (G-14)
  const approval: ApprovalBadgeView | null = await readApprovalBadge(
    { db: getDb().db },
    result.data.evaluation.assignmentVersionId,
  ).catch(() => null);
  return (
    <WorkbenchShell
      view={view}
      contextTabs={contextTabs}
      interviewKit={interviewKit}
      approval={approval}
    />
  );
}
