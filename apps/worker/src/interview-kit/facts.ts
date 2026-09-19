/**
 * INTERVIEW_KIT 질문 계획의 입력 수집 (TICKET.md T-702). 저장된 판정·근거·변이·설계 신호·관련 함수 그래프·맥락 연결을 읽는다.
 *
 * - 이력서 본문·JD·GitHub 소스(`submission_context`)는 읽지 않는다. 맥락 연결은 이력서 연결 슬롯의 질문과 연결 ID만 옮긴다
 *   (`scripts/check-context-isolation.ts`가 이 파일을 검사한다).
 * - 잃은 배점은 실패 슬롯의 순서를 정하는 데만 쓰고 LLM 입력에는 넘기지 않는다.
 * - 설계 검토 초안은 초안이 있는 기준 ID만 옮긴다. 초안 문장은 LLM 출력이라 실행마다 달라질 수 있어 다음 LLM 입력에 넣지 않는다.
 */
import { MUTATION_CATALOG } from "@ohmyti/analysis";
import {
  ContextQuestionSchema,
  DesignSignalsSchema,
  FunctionGraphAnalysisSchema,
  ReviewWriteSummarySchema,
  type DesignSignals,
  type EvaluationStageRecord,
  type ExecutionContract,
  type FunctionGraphAnalysis,
  type Rubric,
} from "@ohmyti/core";
import {
  listContextLinks,
  listCriterionResults,
  listEvidences,
  listMutationExperiments,
  type Database,
} from "@ohmyti/db";
import { artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import type { InterviewKitFacts, KitCaseRun } from "./plan";

async function readJson(store: ArtifactStore, key: string | null): Promise<unknown> {
  if (!key) return undefined;
  const object = await store.get(key).catch(() => null);
  if (!object) return undefined;
  try {
    return JSON.parse(Buffer.from(object.body).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function readText(store: ArtifactStore, key: string): Promise<string> {
  const object = await store.get(key).catch(() => null);
  return object ? Buffer.from(object.body).toString("utf8") : "";
}

/** 케이스 요청이 매치된 핸들러(깊이 0 노드) 목록. 케이스 하나가 여러 라우트를 부를 수 있다 */
function caseHandlers(graph: FunctionGraphAnalysis | null, caseId: string): KitCaseRun["handlers"] {
  if (graph?.status !== "ok") return [];
  return (graph.cases.find((c) => c.caseId === caseId)?.nodes ?? [])
    .filter((node) => node.depth === 0)
    .map((node) => ({ name: node.name, location: node.location }));
}

export interface CollectInterviewKitFactsInput {
  evaluationId: string;
  submissionId: string;
  rubric: Rubric;
  contract: ExecutionContract;
  spec: { title: string; specRef: string };
  /** 평가의 단계 기록 (설계 검토 초안이 있는 기준을 찾는다) */
  stageLog: readonly EvaluationStageRecord[];
}

export async function collectInterviewKitFacts(
  input: CollectInterviewKitFactsInput,
  deps: { db: Database; store: ArtifactStore },
): Promise<InterviewKitFacts> {
  const { db, store } = deps;
  const [results, evidences, experiments, links, specText, graphRaw, signalsRaw] =
    await Promise.all([
      listCriterionResults(db, input.evaluationId),
      listEvidences(db, input.evaluationId),
      listMutationExperiments(db, input.evaluationId),
      listContextLinks(db, input.submissionId),
      readText(store, input.spec.specRef),
      readJson(store, artifactKeys.functionGraph(input.evaluationId)),
      readJson(store, artifactKeys.designSignals(input.evaluationId)),
    ]);
  const graphParsed = FunctionGraphAnalysisSchema.safeParse(graphRaw);
  const graph = graphParsed.success ? graphParsed.data : null;
  const signalsParsed = DesignSignalsSchema.safeParse(signalsRaw);
  const designSignals: DesignSignals | null = signalsParsed.success ? signalsParsed.data : null;

  const resultById = new Map(results.map((r) => [r.criterionId, r]));
  const evidenceById = new Map(evidences.map((e) => [e.id, e]));

  const criteria: InterviewKitFacts["criteria"] = [];
  for (const criterion of input.rubric.criteria) {
    const result = resultById.get(criterion.id);
    if (!result) continue;
    const runs: KitCaseRun[] = [];
    const seen = new Set<string>();
    for (const evidenceId of result.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      // 하네스 케이스 실행 근거만 (정적 관계·LLM·사람 검토 근거는 kind가 있다)
      if (!evidence || evidence.kind !== null || !evidence.runId || !evidence.testId) continue;
      if (seen.has(evidence.runId)) continue;
      seen.add(evidence.runId);
      runs.push({
        runId: evidence.runId,
        caseId: evidence.testId,
        handlers: caseHandlers(graph, evidence.testId),
      });
    }
    criteria.push({
      id: criterion.id,
      title: criterion.title,
      condition: criterion.condition,
      area: criterion.area,
      method: criterion.method,
      groupId: criterion.groupId ?? null,
      verdict: result.verdict,
      issueId: result.issueId,
      maxPoints: criterion.maxPoints,
      lostPoints:
        result.verdict === "FAIL" || result.verdict === "PARTIAL"
          ? Math.max(0, criterion.maxPoints - (result.earnedPoints ?? 0))
          : 0,
      observation: result.observation,
      runs,
    });
  }

  const descriptions = new Map(MUTATION_CATALOG.map((m) => [m.id, m.description]));
  const mutations: InterviewKitFacts["mutations"] = experiments.map((e) => ({
    mutationId: e.mutationId,
    experimentId: e.id,
    groupId: e.groupId,
    outcome: e.outcome,
    description: descriptions.get(e.mutationId) ?? null,
    target: e.target ?? null,
  }));

  const review = input.stageLog.find((s) => s.stage === "REVIEW_WRITE");
  const reviewSummary = ReviewWriteSummarySchema.safeParse(review?.detail ?? null);
  const designDrafts = reviewSummary.success
    ? [...new Set(reviewSummary.data.designSuggestions.map((d) => d.criterionId))]
        .sort()
        .map((criterionId) => ({ criterionId }))
    : [];

  const contextLinks: InterviewKitFacts["contextLinks"] = links
    .filter((link) => link.claimSource === "RESUME" && Boolean(link.followUpQuestion?.trim()))
    .map((link) => {
      const observed = link.assignmentObservation as { criterionId?: unknown } | null;
      const structured = ContextQuestionSchema.safeParse(link.question);
      return {
        id: link.id,
        question: link.followUpQuestion!.trim(),
        structured: structured.success ? structured.data : null,
        criterionId:
          typeof observed?.criterionId === "string" && resultById.has(observed.criterionId)
            ? observed.criterionId
            : null,
      };
    });

  return {
    spec: { title: input.spec.title, summary: specText },
    resetPath: input.contract.resetPath ?? null,
    criteria,
    independentGroups: input.rubric.independentReasons.map((r) => [...r.criterionIds]),
    groups: input.rubric.groups.map((g) => ({
      id: g.id,
      name: g.name,
      criterionIds: [...g.criterionIds],
    })),
    mutations,
    designSignals,
    designDrafts,
    contextLinks,
  };
}
