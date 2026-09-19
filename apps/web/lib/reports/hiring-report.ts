/**
 * 채용 리포트 조립 (TICKET.md T-705, PRD 14.3). 저장된 평가 결과를 PRD 14.3의 9개 절로 결정적으로 옮긴다.
 *
 * - 새 판단도 새 LLM 호출도 없다. 점수는 `EvaluationReport.score`(저장값)를 그대로 옮기며 이 모듈은 `aggregateScore`를
 *   부르지 않고 배점을 더하지 않는다 (T-207과 같은 소스 검사 테스트가 고정한다).
 * - 핵심 관측의 선정은 저장된 판정만 보는 결정적 규칙이다: 확인된 결함은 잃은 배점 순(같은 `issueId`는 한 번, G-12),
 *   확인된 강점은 PASS한 `EDGE_AND_FAILURE`·`TEST_EFFECTIVENESS` 기준을 배점 순으로 고른다.
 * - 역량별 관측은 판정 분포와 근거만 보이며 역량 점수·등급을 만들지 않는다 (G-01, G-13, PRD 14.4).
 * - 프로필이 없는 과제는 `impact`가 null이다. 문장을 지어내지 않는다 (G-09).
 * - LLM이 쓴 설계 검토 초안에 금지 표현(`findForbiddenReportExpressions`)이 있으면 그 초안을 버린다.
 */
import { z } from "zod";
import {
  COMPETENCIES,
  COMPETENCY_ANCHORS,
  CompetencySchema,
  ContextLinkSummarySchema,
  HIRING_REPORT_KEY_OBSERVATIONS_MAX,
  HIRING_REPORT_SCHEMA_VERSION,
  HiringReportSchema,
  INTERVIEW_MAX_REFS,
  InterviewKitLlmStatusSchema,
  MutationOutcomeSchema,
  ReviewWriteSummarySchema,
  ReportProfileSchema,
  competencyForCriterion,
  findForbiddenReportExpressions,
  impactForCriterion,
  interviewQuestionNumbers,
  type Competency,
  type CompetencyObservation,
  type ContextLink,
  type CriterionResult,
  type DesignSignals,
  type EvaluationReport,
  type EvaluationStage,
  type EvaluationStageRecord,
  type Evidence,
  type HiringReport,
  type HiringReportQuestionRef,
  type InterviewKit,
  type InterviewScorecard,
  type KeyObservation,
  type MutationOutcome,
  type ObservationRef,
  type ReportProfile,
  type Rubric,
  type VerdictCounts,
} from "@ohmyti/core";
import { getAssignmentVersion } from "@ohmyti/db";
import { readEvaluationContext } from "@/lib/context/service";
import { readScorecards } from "@/lib/scorecards/service";
import {
  readDesignSignals,
  readEvaluationReport,
  readInterviewKit,
  type ReportDeps,
  type ReportResult,
} from "./service";

/** 리포트가 LLM 사용 범위로 보이는 단계 (점수·판정에는 쓰지 않는다) */
export const HIRING_REPORT_LLM_STAGES: readonly EvaluationStage[] = [
  "REVIEW_WRITE",
  "CONTEXT_LINK",
  "INTERVIEW_KIT",
];

/** 평가 범위와 한계 절의 지원 범위 안내 (PRD 10장). 과제와 무관한 고정 문구다 */
export const HIRING_REPORT_SUPPORT_SCOPE: readonly string[] = [
  "승인된 TypeScript 과제 템플릿과 고정 의존성으로만 실행합니다. 그 밖의 저장소는 미지원으로 표시하고 채점하지 않습니다.",
  "판정은 과제 명세와 채점 기준에 적힌 항목만 다룹니다. 기준에 없는 역량은 이 리포트로 판단할 수 없으며 면접에서 확인해야 합니다.",
  "LLM은 근거 요약과 질문 문장, 이력서 연결에만 쓰고 점수와 판정에는 쓰지 않습니다.",
  "이 리포트는 채용 결정을 대신하지 않습니다. 사람이 근거를 열어 확인한 뒤 판단합니다.",
];

/** 강점으로 고르는 영역 (관측으로 확인된 경계·실패 처리와 테스트 실효성) */
const STRENGTH_AREAS = new Set(["EDGE_AND_FAILURE", "TEST_EFFECTIVENESS"]);

/** 환경 장애로 미확정이 된 실패 종류 (G-11: 제출 코드의 결함이 아니다) */
const ENVIRONMENTAL_FAILURE_KINDS = new Set(["ENVIRONMENT", "TIMEOUT"]);

export interface HiringReportInput {
  /** `GET /api/evaluations/[id]`와 같은 저장값 */
  report: EvaluationReport;
  /** 인터뷰 키트 (T-702). 키트를 만들기 전의 평가는 null */
  kit: InterviewKit | null;
  /** 맥락 연결 (T-503·T-703). 맥락을 읽지 못했거나 이전 평가면 null */
  contextLinks: readonly ContextLink[] | null;
  /** 설계 신호 (T-605). 신호를 추출하기 전의 평가는 null */
  designSignals: DesignSignals | null;
  /** 과제 버전의 리포트 프로필. 없으면 영향 문장 없이 조립한다 */
  profile: ReportProfile | null;
  /** 면접관이 기입한 스코어카드 (T-707). 저장 순서대로이며, 주지 않으면 기록이 없는 것으로 본다 */
  scorecards?: readonly InterviewScorecard[];
}

function stageOf(
  report: EvaluationReport,
  stage: EvaluationStage,
): EvaluationStageRecord | undefined {
  return report.stages.find((s) => s.stage === stage);
}

function reviewWriteSummaryOf(report: EvaluationReport) {
  const parsed = ReviewWriteSummarySchema.safeParse(
    stageOf(report, "REVIEW_WRITE")?.detail ?? null,
  );
  return parsed.success ? parsed.data : null;
}

/** CONTEXT_LINK 단계 기록의 요약은 `detail.contextLink`에 있다 (T-503) */
function contextSummaryOf(report: EvaluationReport) {
  const parsed = ContextLinkSummarySchema.safeParse(
    stageOf(report, "CONTEXT_LINK")?.detail?.contextLink,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * INTERVIEW_KIT 단계 기록의 요약. 저장된 값은 생성 요약에 `artifactKey`·`priorities`를 더한 것이라
 * 리포트가 쓰는 필드만 느슨하게 읽는다 (키트 아티팩트가 있으면 그 `generation`을 먼저 쓴다).
 */
const KitStageSummarySchema = z.looseObject({
  llm: InterviewKitLlmStatusSchema,
  llmReason: z.string().nullable(),
  promptVersion: z.string().min(1),
  model: z.string().nullable(),
  aiReviewId: z.uuid().nullable(),
});

function interviewKitSummaryOf(report: EvaluationReport, kit: InterviewKit | null) {
  if (kit) return kit.generation;
  const parsed = KitStageSummarySchema.safeParse(stageOf(report, "INTERVIEW_KIT")?.detail);
  return parsed.success ? parsed.data : null;
}

/** 판정 분포. 저장된 기준 판정을 세기만 한다 */
export function countVerdicts(results: readonly Pick<CriterionResult, "verdict">[]): VerdictCounts {
  const counts: VerdictCounts = { PASS: 0, FAIL: 0, PARTIAL: 0, INCONCLUSIVE: 0 };
  for (const result of results) counts[result.verdict] += 1;
  return counts;
}

/** 감점(FAIL·PARTIAL)에서 잃은 배점. PASS·INCONCLUSIVE는 0이다 */
export function lostPointsOf(result: CriterionResult): number {
  if (result.verdict !== "FAIL" && result.verdict !== "PARTIAL") return 0;
  return Math.max(0, result.maxPoints - (result.earnedPoints ?? 0));
}

/**
 * 기준 하나의 근거 참조. 저장된 근거(실행 기록·코드 위치)와 그룹 기준의 변이 실험을 옮긴다.
 * 순서는 기준 → 실행 기록 → 코드 위치 → 변이이며 상한은 키트와 같은 `INTERVIEW_MAX_REFS`다.
 */
export function refsForCriterion(report: EvaluationReport, criterionId: string): ObservationRef[] {
  const result = report.criterionResults.find((r) => r.criterionId === criterionId);
  const criterion = report.rubric.criteria.find((c) => c.id === criterionId);
  const evidenceById = new Map(report.evidences.map((e) => [e.id, e]));
  const evidences: Evidence[] = (result?.evidenceIds ?? [])
    .map((id) => evidenceById.get(id))
    .filter((evidence): evidence is Evidence => Boolean(evidence));

  const refs: ObservationRef[] = [{ kind: "CRITERION", criterionId }];
  const seenRuns = new Set<string>();
  for (const evidence of evidences) {
    if (!evidence.runId || seenRuns.has(evidence.runId)) continue;
    seenRuns.add(evidence.runId);
    refs.push({ kind: "EXECUTION_RECORD", runId: evidence.runId, criterionId });
  }
  const seenSources = new Set<string>();
  for (const evidence of evidences) {
    if (!evidence.source) continue;
    const key = `${evidence.source.path}:${evidence.source.startLine}-${evidence.source.endLine}`;
    if (seenSources.has(key)) continue;
    seenSources.add(key);
    refs.push({ kind: "SOURCE", location: evidence.source });
  }
  if (criterion?.groupId) {
    for (const experiment of report.mutationExperiments) {
      if (experiment.groupId !== criterion.groupId) continue;
      refs.push({
        kind: "MUTATION",
        mutationId: experiment.mutationId,
        experimentId: experiment.id,
      });
    }
  }
  return refs.slice(0, INTERVIEW_MAX_REFS);
}

/** LLM이 쓴 문장. 금지 표현이 있으면 버린다 (PRD 14.4) */
function llmTextOrNull(text: string | undefined | null): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return findForbiddenReportExpressions(trimmed).length > 0 ? null : trimmed;
}

function keyObservationOf(
  input: HiringReportInput,
  result: CriterionResult,
  aiDraftByCriterion: Map<string, string>,
): KeyObservation | null {
  const criterion = input.report.rubric.criteria.find((c) => c.id === result.criterionId);
  if (!criterion) return null;
  // 관측 문장이 비어 있으면(판정 조건만 남은 이전 평가) 기준의 판정 조건을 그대로 보인다. 문장을 지어내지 않는다 (G-09)
  const observation = result.observation.trim() || criterion.condition;
  return {
    criterionId: criterion.id,
    title: criterion.title,
    verdict: result.verdict,
    issueId: result.issueId ?? null,
    observation,
    impact: impactForCriterion(criterion.id, input.profile),
    aiDraft: aiDraftByCriterion.get(criterion.id) ?? null,
    refs: refsForCriterion(input.report, criterion.id),
  };
}

/** 기준 ID 순서 비교 (저장 순서와 같다) */
function byCriterionId(a: { criterionId: string }, b: { criterionId: string }): number {
  return a.criterionId < b.criterionId ? -1 : a.criterionId > b.criterionId ? 1 : 0;
}

function criterionTitle(rubric: Rubric, criterionId: string): string {
  return rubric.criteria.find((c) => c.id === criterionId)?.title ?? criterionId;
}

/** 저장된 실행 기록에서 이 기준의 실패 종류를 찾는다 (미확정 사유가 환경 장애인지 구분한다, G-11) */
function failureKindOf(report: EvaluationReport, result: CriterionResult): string | null {
  const evidenceById = new Map(report.evidences.map((e) => [e.id, e]));
  for (const evidenceId of result.evidenceIds) {
    const runId = evidenceById.get(evidenceId)?.runId;
    if (!runId) continue;
    const record = report.executionRecords.find((r) => r.id === runId);
    if (record) return record.failureKind;
  }
  return null;
}

export function buildHiringReport(input: HiringReportInput): HiringReport {
  const { report, kit, contextLinks, designSignals, profile } = input;
  const rubric = report.rubric;
  const results = [...report.criterionResults].sort(byCriterionId);
  const reviewWrite = reviewWriteSummaryOf(report);
  const contextSummary = contextSummaryOf(report);
  const kitSummary = interviewKitSummaryOf(report, kit);

  // REVIEW_WRITE 설계 검토 초안 (LLM). 금지 표현이 있는 초안은 버린다
  const aiDraftByCriterion = new Map<string, string>();
  for (const suggestion of reviewWrite?.designSuggestions ?? []) {
    const rationale = llmTextOrNull(suggestion.rationale);
    if (rationale && !aiDraftByCriterion.has(suggestion.criterionId)) {
      aiDraftByCriterion.set(suggestion.criterionId, rationale);
    }
  }

  const pendingReview = results
    .filter((result) => result.reviewState === "PENDING")
    .map((result) => ({
      criterionId: result.criterionId,
      title: criterionTitle(rubric, result.criterionId),
    }));

  // 2. 핵심 관측: 결함은 잃은 배점 순, 강점은 배점 순. 같은 배점이면 기준 ID 순이다
  const seenIssueIds = new Set<string>();
  const defects: KeyObservation[] = [];
  const defectCandidates = results
    .filter((result) => result.verdict === "FAIL" || result.verdict === "PARTIAL")
    .sort((a, b) => lostPointsOf(b) - lostPointsOf(a) || byCriterionId(a, b));
  for (const result of defectCandidates) {
    if (defects.length >= HIRING_REPORT_KEY_OBSERVATIONS_MAX) break;
    // 같은 결함으로 묶인 기준은 한 번만 보인다 (G-12: 감점 자체는 기준마다 그대로 남는다)
    if (result.issueId) {
      if (seenIssueIds.has(result.issueId)) continue;
      seenIssueIds.add(result.issueId);
    }
    const observation = keyObservationOf(input, result, aiDraftByCriterion);
    if (observation) defects.push(observation);
  }

  const strengths: KeyObservation[] = [];
  const strengthCandidates = results
    .filter((result) => {
      if (result.verdict !== "PASS") return false;
      const criterion = rubric.criteria.find((c) => c.id === result.criterionId);
      return Boolean(criterion && STRENGTH_AREAS.has(criterion.area));
    })
    .sort((a, b) => b.maxPoints - a.maxPoints || byCriterionId(a, b));
  for (const result of strengthCandidates) {
    if (strengths.length >= HIRING_REPORT_KEY_OBSERVATIONS_MAX) break;
    const observation = keyObservationOf(input, result, aiDraftByCriterion);
    if (observation) strengths.push(observation);
  }

  // 3. 역량별 관측: 매핑된 기준의 판정과 근거만 옮긴다. 역량 점수·등급을 만들지 않는다
  // 질문 참조는 슬롯 ID 대신 키트와 같은 번호(Q1, Q2 …)와 주 질문 문장으로 싣는다 (T-706)
  const questionNumbers = interviewQuestionNumbers(kit?.questions ?? []);
  const kitQuestionsByCompetency = new Map<Competency, HiringReportQuestionRef[]>();
  for (const question of kit?.questions ?? []) {
    const list = kitQuestionsByCompetency.get(question.competency) ?? [];
    list.push({
      questionId: question.id,
      number: questionNumbers.get(question.id) ?? list.length + 1,
      question: question.question,
    });
    kitQuestionsByCompetency.set(question.competency, list);
  }
  const competencies: CompetencyObservation[] = CompetencySchema.options.map((competency) => {
    const criteria = results
      .filter((result) => {
        const criterion = rubric.criteria.find((c) => c.id === result.criterionId);
        return Boolean(criterion && competencyForCriterion(criterion, profile) === competency);
      })
      .map((result) => ({
        criterionId: result.criterionId,
        title: criterionTitle(rubric, result.criterionId),
        verdict: result.verdict,
        reviewState: result.reviewState,
        refs: refsForCriterion(report, result.criterionId),
      }));
    return {
      competency,
      name: COMPETENCIES[competency].name,
      interviewOnly: COMPETENCIES[competency].interviewOnly,
      criteria,
      verdictCounts: countVerdicts(criteria),
      kitQuestions: kitQuestionsByCompetency.get(competency) ?? [],
    };
  });

  // 4. 요구사항별 결과 · 테스트 실효성 · 설계 검토
  const requirementCriteria = results.map((result) => {
    const criterion = rubric.criteria.find((c) => c.id === result.criterionId);
    return {
      criterionId: result.criterionId,
      area: criterion?.area ?? "REQUIRED_FEATURES",
      title: criterionTitle(rubric, result.criterionId),
      maxPoints: result.maxPoints,
      earnedPoints: result.earnedPoints,
      verdict: result.verdict,
      reviewState: result.reviewState,
      observation: result.observation.trim() ? result.observation : null,
      refs: refsForCriterion(report, result.criterionId),
    };
  });

  const testEffectiveness = rubric.groups.map((group) => {
    const criterion = rubric.criteria.find((c) => c.groupId === group.id);
    const result = criterion ? (results.find((r) => r.criterionId === criterion.id) ?? null) : null;
    // 변이 결과 분포는 모든 결과 값을 0으로 두고 실험 수만 센다 (없는 값도 0으로 보인다)
    const outcomes = Object.fromEntries(
      MutationOutcomeSchema.options.map((outcome) => [outcome, 0]),
    ) as Record<MutationOutcome, number>;
    for (const experiment of report.mutationExperiments) {
      if (experiment.groupId !== group.id) continue;
      outcomes[experiment.outcome] = (outcomes[experiment.outcome] ?? 0) + 1;
    }
    return {
      groupId: group.id,
      name: group.name,
      criterionId: criterion?.id ?? null,
      verdict: result?.verdict ?? null,
      outcomes,
    };
  });

  const designReviewItems = (reviewWrite?.designSuggestions ?? []).flatMap((suggestion) => {
    const rationale = aiDraftByCriterion.get(suggestion.criterionId);
    if (!rationale) return [];
    return [
      {
        criterionId: suggestion.criterionId,
        rationale,
        refs: refsForCriterion(report, suggestion.criterionId),
      },
    ];
  });

  // 5. 이력서 주장과 근거의 연결표
  const resumeRows = (contextLinks ?? [])
    .filter((link) => link.claimSource === "RESUME")
    .map((link) => ({
      contextLinkId: link.id,
      claim: link.claim,
      status: link.status,
      evidence: (link.githubEvidence ?? []).map((evidence) => ({
        url: evidence.url,
        summary: evidence.summary,
      })),
      observation: link.assignmentObservation
        ? {
            criterionId: link.assignmentObservation.criterionId ?? null,
            summary: link.assignmentObservation.summary,
          }
        : null,
      question: link.question?.question ?? link.followUpQuestion ?? null,
    }));
  const resumeStatus =
    contextLinks === null
      ? ("NO_DATA" as const)
      : resumeRows.length === 0
        ? ("NO_RESUME" as const)
        : ("AVAILABLE" as const);

  // 7. 평가 범위와 한계
  const inconclusive = results
    .filter((result) => result.verdict === "INCONCLUSIVE")
    .map((result) => {
      const failureKind = failureKindOf(report, result);
      return {
        criterionId: result.criterionId,
        title: criterionTitle(rubric, result.criterionId),
        failureKind:
          (failureKind as (typeof report.executionRecords)[number]["failureKind"]) ?? null,
        environmental: failureKind !== null && ENVIRONMENTAL_FAILURE_KINDS.has(failureKind),
        reason: result.observation.trim() ? result.observation : null,
      };
    });

  const llmUsage = HIRING_REPORT_LLM_STAGES.flatMap((stage) => {
    const record = stageOf(report, stage);
    if (!record) return [];
    const model =
      stage === "REVIEW_WRITE"
        ? (reviewWrite?.model ?? null)
        : stage === "CONTEXT_LINK"
          ? (contextSummary?.model ?? null)
          : (kitSummary?.model ?? null);
    const promptVersion =
      stage === "REVIEW_WRITE"
        ? (reviewWrite?.promptVersion ?? null)
        : stage === "CONTEXT_LINK"
          ? (contextSummary?.promptVersion ?? null)
          : (kitSummary?.promptVersion ?? null);
    const reason =
      record.reason ??
      (stage === "REVIEW_WRITE"
        ? (reviewWrite?.llmError ?? null)
        : stage === "CONTEXT_LINK"
          ? (contextSummary?.llmError ?? null)
          : (kitSummary?.llmReason ?? null));
    return [{ stage, state: record.state, model, promptVersion, reason }];
  });

  // 9. 감사 정보
  const llmStages = HIRING_REPORT_LLM_STAGES.flatMap((stage) => {
    const record = stageOf(report, stage);
    if (!record) return [];
    const summary =
      stage === "REVIEW_WRITE"
        ? reviewWrite
        : stage === "CONTEXT_LINK"
          ? contextSummary
          : kitSummary;
    return [
      {
        stage,
        model: summary?.model ?? null,
        promptVersion: summary?.promptVersion ?? null,
        aiReviewId: summary?.aiReviewId ?? null,
      },
    ];
  });
  const reviewTimes = report.reviewEvents.map((event) => event.createdAt).sort();

  const hiringReport: HiringReport = {
    schemaVersion: HIRING_REPORT_SCHEMA_VERSION,
    evaluationId: report.evaluation.id,
    assignment: {
      name: report.assignment.name,
      version: report.assignment.version,
      title: report.assignment.title,
    },
    isSample: report.evaluation.isSample,
    summary: {
      score: report.score,
      verdictCounts: countVerdicts(results),
      pendingReview,
    },
    keyObservations: { strengths, defects },
    competencies,
    requirements: {
      criteria: requirementCriteria,
      testEffectiveness,
      designReview: {
        status: designReviewItems.length > 0 || designSignals ? "AVAILABLE" : "NO_DATA",
        draft: true,
        items: designReviewItems,
        signals: designSignals,
      },
    },
    resumeLinks: { status: resumeStatus, links: resumeRows },
    interviewGuide: {
      status: kit ? "AVAILABLE" : "NO_DATA",
      llm: kit?.generation.llm ?? null,
      llmReason: kit?.generation.llmReason ?? null,
      mustQuestions: (kit?.questions ?? [])
        .filter((question) => question.priority === "MUST")
        .map((question) => ({
          questionId: question.id,
          number: questionNumbers.get(question.id) ?? 1,
          kind: question.kind,
          competency: question.competency,
          minutes: question.minutes,
          question: question.question,
          source: question.source,
        })),
    },
    scope: {
      unassessedAreas: contextSummary?.unassessedAreas ?? [],
      inconclusive,
      pendingReview,
      llmUsage,
      supportScope: [...HIRING_REPORT_SUPPORT_SCOPE],
    },
    scorecard: {
      humanOnly: true,
      competencies: CompetencySchema.options.map((competency) => ({
        competency,
        name: COMPETENCIES[competency].name,
        definition: COMPETENCIES[competency].definition,
        interviewOnly: COMPETENCIES[competency].interviewOnly,
        anchors: [...COMPETENCY_ANCHORS[competency]],
      })),
      // 사람이 기입한 기록 그대로. 평균·합산을 만들지 않는다 (PRD 14.4)
      saved: [...(input.scorecards ?? [])],
    },
    audit: {
      evaluationId: report.evaluation.id,
      submissionId: report.evaluation.submissionId,
      rubricVersion: report.evaluation.rubricVersion,
      harnessVersion: report.evaluation.harnessVersion,
      environmentDigest: report.evaluation.environmentDigest,
      submissionSha: report.evaluation.submissionSha,
      repoUrl: report.submission.repoUrl,
      isSample: report.evaluation.isSample,
      finishedAt: report.evaluation.finishedAt,
      llmStages,
      humanEdits: {
        count: report.reviewEvents.length,
        lastAt: reviewTimes.at(-1) ?? null,
      },
    },
  };
  return HiringReportSchema.parse(hiringReport);
}

/**
 * `GET /api/evaluations/[id]/hiring-report` (T-705). 저장된 평가 결과와 키트·맥락 연결·설계 신호·리포트 프로필을 모아
 * 조립한다. 평가가 없으면 `EVALUATION_NOT_FOUND`이고, 나머지 자료가 없으면 해당 절만 "자료 없음"으로 채운다.
 */
export async function readHiringReport(
  deps: ReportDeps,
  evaluationId: string,
): Promise<ReportResult<HiringReport>> {
  const report = await readEvaluationReport({ db: deps.db }, evaluationId);
  if (!report.ok) return report;

  const [kit, designSignals, version, context, scorecards] = await Promise.all([
    readInterviewKit(deps, evaluationId),
    readDesignSignals(deps, evaluationId),
    getAssignmentVersion(deps.db, report.data.evaluation.assignmentVersionId),
    readEvaluationContext(
      { db: deps.db },
      { submissionId: report.data.evaluation.submissionId, evaluationId },
    ),
    readScorecards({ db: deps.db }, evaluationId),
  ]);
  const profileParsed = ReportProfileSchema.safeParse(version?.reportProfile ?? null);

  return {
    ok: true,
    data: buildHiringReport({
      report: report.data,
      kit: kit.ok ? kit.data.kit : null,
      designSignals: designSignals.ok ? designSignals.data.signals : null,
      contextLinks: context.ok ? context.data.links : null,
      profile: profileParsed.success ? profileParsed.data : null,
      scorecards: scorecards.ok ? scorecards.data : [],
    }),
  };
}
