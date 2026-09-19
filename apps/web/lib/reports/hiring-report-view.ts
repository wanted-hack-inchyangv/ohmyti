/**
 * 채용 리포트 화면의 표시 모델 (TICKET.md T-706, PRD 14.3).
 *
 * - 값은 조립된 리포트(`HiringReport`, T-705)에서만 온다. 여기서 점수를 다시 만들거나 판단 문장을 더하지 않는다.
 * - 근거 참조는 인터뷰 키트 화면(T-704)과 같은 규칙(`observationRefView`)으로 워크벤치 딥링크가 된다. 인쇄물에는
 *   링크 대신 기준 ID와 고정 SHA 주소를 글자로 싣는다(`printLabel`).
 * - 막대는 저장된 점수·판정 개수의 비율을 그릴 뿐이며 새 총점을 만들지 않는다. 색은 T-301 규칙을 따른다:
 *   빨강(`fail`)은 실제 실패에만, 주황(`pending`)은 미확정·검토 대기에만 쓴다.
 * - 핵심 관측은 프로필의 영향 문장을 관측 문장과 함께 보인다. 영향 문장이 없으면 기준의 판정 조건을 대신 보이고,
 *   그마저 없으면 그 줄을 생략한다 (G-09: 없는 문장을 지어내지 않는다).
 * - 인터뷰 키트 질문은 슬롯 ID가 아니라 키트와 같은 번호(Q1, Q2 …)와 주 질문 문장으로 보인다.
 */
import {
  COMPETENCIES,
  INTERVIEW_QUESTION_KIND_LABELS,
  type Competency,
  type CompetencyObservation,
  type EvaluationReport,
  type HiringReport,
  type KeyObservation,
  type ObservationRef,
  type RubricArea,
  type Verdict,
  type VerdictCounts,
} from "@ohmyti/core";
import { observationRefView, type KitRefView } from "@/lib/workbench/interview-kit";
import { AREA_LABEL } from "@/lib/workbench/view";
import { workbenchHref, type WorkbenchUrlState } from "@/lib/workbench/state";
import { hiringReportToMarkdown } from "./hiring-report-markdown";

/** 상단 고지 (티켓 T-706 범위). 리포트를 여는 모든 사람이 첫 화면에서 읽는다 */
export const HIRING_REPORT_DISCLAIMER =
  "이 문서는 실행 근거를 정리한 자료이며 채용 결정은 사람이 합니다. LLM은 점수와 판정에 관여하지 않았습니다.";

/** 인쇄 안내 (화면에만 보인다) */
export const HIRING_REPORT_PRINT_HINT =
  "브라우저의 인쇄(Ctrl/Cmd+P)로 A4에 맞추어 뽑거나 PDF로 저장해 주세요. 인쇄물에는 링크 대신 기준 ID와 고정 SHA 주소가 실립니다.";

export const HIRING_REPORT_SECTION_TITLES: readonly string[] = [
  "한눈 요약",
  "핵심 관측",
  "역량별 관측",
  "요구사항별 결과",
  "이력서 주장과 근거",
  "면접 권고",
  "평가 범위와 한계",
  "면접관 스코어카드",
  "감사 정보",
];

export function hiringReportHref(evaluationId: string): string {
  return `/evaluations/${evaluationId}/report`;
}

/** 막대 한 칸. `percent`는 저장된 값의 비율일 뿐이며 새 점수가 아니다 */
export interface ReportBarPartView {
  key: string;
  label: string;
  value: number;
  percent: number;
  tone: "ink" | "fail" | "pending" | "neutral";
}

export interface ReportBarView {
  label: string;
  /** 막대 옆에 적는 값 표기 (저장된 표기 그대로) */
  display: string;
  parts: ReportBarPartView[];
}

export interface KeyObservationView {
  criterionId: string;
  title: string;
  verdict: Verdict;
  observation: string;
  /** 프로필의 영향 문장. 없으면 null이고 화면은 `condition`을 대신 보인다 */
  impact: string | null;
  /** 영향 문장이 없을 때 대신 보이는 기준의 판정 조건. 기준을 찾지 못하면 null */
  condition: string | null;
  aiDraft: string | null;
  refs: KitRefView[];
  /** 기준으로 이동하는 딥링크 (제목 자체가 근거로 간다) */
  href: string | null;
}

export interface CompetencyQuestionView {
  questionId: string;
  /** `Q1` */
  label: string;
  question: string;
  /** 인터뷰 키트 탭의 그 질문 카드 */
  href: string;
}

export interface CompetencyObservationView {
  competency: Competency;
  name: string;
  definition: string;
  interviewOnly: boolean;
  verdictCounts: VerdictCounts;
  bar: ReportBarView | null;
  criteria: Array<
    Omit<CompetencyObservation["criteria"][number], "refs"> & {
      href: string | null;
      refs: KitRefView[];
    }
  >;
  questions: CompetencyQuestionView[];
  /** 질문이 없을 때 보이는 문구. 질문이 있으면 null */
  questionsEmpty: string | null;
}

export interface RequirementRowView {
  criterionId: string;
  area: RubricArea;
  areaLabel: string;
  title: string;
  verdict: Verdict;
  reviewState: HiringReport["requirements"]["criteria"][number]["reviewState"];
  pointsDisplay: string;
  observation: string | null;
  href: string | null;
  refs: KitRefView[];
}

export interface DesignReviewItemView {
  criterionId: string;
  rationale: string;
  refs: KitRefView[];
}

export interface ResumeLinkView {
  contextLinkId: string;
  claim: string;
  status: HiringReport["resumeLinks"]["links"][number]["status"];
  statusLabel: string;
  evidence: Array<{ url: string; summary: string }>;
  observation: { criterionId: string | null; summary: string } | null;
  observationHref: string | null;
  question: string | null;
  href: string;
}

export interface InterviewGuideQuestionView {
  questionId: string;
  /** 키트 안의 질문 번호 (Q1, Q2 …). 스코어카드의 질문별 메모가 같은 번호를 쓴다 */
  number: number;
  label: string;
  kindLabel: string;
  competencyName: string;
  minutes: number;
  question: string;
  isTemplate: boolean;
  href: string;
}

export interface HiringReportView {
  evaluationId: string;
  title: string;
  assignmentLabel: string;
  isSample: boolean;
  disclaimer: string;
  printHint: string;
  /** 워크벤치 (상대 경로) */
  workbenchHref: string;
  /** 인터뷰 키트 탭 (상대 경로) */
  interviewKitHref: string;
  /** 내보내기에 쓰는 워크벤치 절대 주소 */
  workbenchUrl: string;
  scoreDisplay: string;
  /** 판정이 아직 저장되지 않았으면 사유 */
  scoreNotice: string | null;
  areaBars: ReportBarView[];
  /** 영역 소계가 저장되지 않은 이전 평가의 안내 */
  areaNotice: string | null;
  verdictBar: ReportBarView;
  pendingReview: HiringReport["summary"]["pendingReview"];
  strengths: KeyObservationView[];
  defects: KeyObservationView[];
  competencies: CompetencyObservationView[];
  requirements: RequirementRowView[];
  testEffectiveness: HiringReport["requirements"]["testEffectiveness"];
  designReview: {
    status: HiringReport["requirements"]["designReview"]["status"];
    items: DesignReviewItemView[];
    signalsLine: string | null;
  };
  resumeLinks: {
    status: HiringReport["resumeLinks"]["status"];
    notice: string | null;
    links: ResumeLinkView[];
  };
  interviewGuide: {
    status: HiringReport["interviewGuide"]["status"];
    /** 키트가 없거나 LLM을 부르지 못했으면 사유 (G-14) */
    notice: string | null;
    questions: InterviewGuideQuestionView[];
  };
  scope: HiringReport["scope"];
  scorecard: HiringReport["scorecard"];
  audit: HiringReport["audit"];
  markdown: string;
}

const CONTEXT_STATUS_LABEL: Record<ResumeLinkView["status"], string> = {
  EVIDENCE_FOUND: "근거 있음",
  NEEDS_CHECK: "확인 필요",
  NO_DATA: "자료 없음",
};

const VERDICT_BAR_TONE: Record<Verdict, ReportBarPartView["tone"]> = {
  PASS: "ink",
  FAIL: "fail",
  PARTIAL: "neutral",
  INCONCLUSIVE: "pending",
};

const VERDICT_BAR_LABEL: Record<Verdict, string> = {
  PASS: "통과",
  FAIL: "실패",
  PARTIAL: "부분",
  INCONCLUSIVE: "미확정",
};

const EMPTY_STATE: WorkbenchUrlState = {
  criterionId: null,
  runId: null,
  tab: null,
  filter: "all",
  pane: "code",
  source: null,
  mutationId: null,
};

function percentOf(value: number, total: number): number {
  if (total <= 0 || value <= 0) return 0;
  return Math.round((value / total) * 1000) / 10;
}

function absolute(origin: string | null, href: string): string {
  return origin ? `${origin.replace(/\/$/, "")}${href}` : href;
}

/** 판정 분포 막대. 저장된 판정 개수를 세어 둔 값을 비율로만 바꾼다 */
export function verdictBarOf(counts: VerdictCounts, label: string): ReportBarView {
  const total = counts.PASS + counts.FAIL + counts.PARTIAL + counts.INCONCLUSIVE;
  const parts = (Object.keys(VERDICT_BAR_TONE) as Verdict[])
    .filter((verdict) => counts[verdict] > 0)
    .map((verdict) => ({
      key: verdict,
      label: VERDICT_BAR_LABEL[verdict],
      value: counts[verdict],
      percent: percentOf(counts[verdict], total),
      tone: VERDICT_BAR_TONE[verdict],
    }));
  return {
    label,
    display: `통과 ${counts.PASS} · 실패 ${counts.FAIL} · 부분 ${counts.PARTIAL} · 미확정 ${counts.INCONCLUSIVE}`,
    parts,
  };
}

export interface HiringReportViewInput {
  /** 근거 딥링크와 기준의 판정 조건에 쓰는 저장값 (`GET /api/evaluations/[id]`와 같다) */
  report: EvaluationReport;
  hiring: HiringReport;
  /** 내보내기에 쓸 절대 주소의 origin. 모르면 null이며 상대 경로를 쓴다 */
  origin: string | null;
}

export function buildHiringReportView(input: HiringReportViewInput): HiringReportView {
  const { report, hiring, origin } = input;
  const evaluationId = hiring.evaluationId;
  const href = (patch: Partial<WorkbenchUrlState>) =>
    workbenchHref(evaluationId, EMPTY_STATE, patch);
  const refsOf = (refs: readonly ObservationRef[]) =>
    refs.map((ref) => observationRefView(ref, report, href, origin));
  const criterionHref = (criterionId: string) =>
    report.rubric.criteria.some((c) => c.id === criterionId) ? href({ criterionId }) : null;
  const conditionOf = (criterionId: string) =>
    report.rubric.criteria.find((c) => c.id === criterionId)?.condition ?? null;

  const observationView = (item: KeyObservation): KeyObservationView => ({
    criterionId: item.criterionId,
    title: item.title,
    verdict: item.verdict,
    observation: item.observation,
    impact: item.impact,
    // 영향 문장이 없으면 기준의 판정 조건을 대신 보인다. 둘 다 없으면 화면이 그 줄을 생략한다
    condition: item.impact ? null : conditionOf(item.criterionId),
    aiDraft: item.aiDraft,
    refs: refsOf(item.refs),
    href: criterionHref(item.criterionId),
  });

  const score = hiring.summary.score;
  const areaBars: ReportBarView[] = (score?.byArea ?? []).map((area) => {
    const confirmed = Math.max(0, area.earned);
    const pending = Math.max(0, area.pendingPoints);
    const lost = Math.max(0, area.total - confirmed - pending);
    return {
      label: AREA_LABEL[area.area],
      display:
        pending > 0
          ? `${area.min}~${area.max}/${area.total} · ${pending}점 검토 대기`
          : `${area.earned}/${area.total}`,
      parts: [
        {
          key: "earned",
          label: "확정 점수",
          value: confirmed,
          percent: percentOf(confirmed, area.total),
          tone: "ink" as const,
        },
        {
          key: "pending",
          label: "검토 대기",
          value: pending,
          percent: percentOf(pending, area.total),
          tone: "pending" as const,
        },
        {
          key: "lost",
          label: "감점",
          value: lost,
          percent: percentOf(lost, area.total),
          tone: "neutral" as const,
        },
      ].filter((part) => part.value > 0),
    };
  });

  const questionNumberLabel = (number: number) => `Q${number}`;
  const kitQuestionHref = (questionId: string) =>
    `${href({ tab: "questions" })}#kit-q-${questionId.replace(/[^A-Za-z0-9_-]/g, "-")}`;

  const competencies: CompetencyObservationView[] = hiring.competencies.map((competency) => {
    const total =
      competency.verdictCounts.PASS +
      competency.verdictCounts.FAIL +
      competency.verdictCounts.PARTIAL +
      competency.verdictCounts.INCONCLUSIVE;
    return {
      competency: competency.competency,
      name: competency.name,
      definition: COMPETENCIES[competency.competency].definition,
      interviewOnly: competency.interviewOnly,
      verdictCounts: competency.verdictCounts,
      bar: total > 0 ? verdictBarOf(competency.verdictCounts, competency.name) : null,
      criteria: competency.criteria.map((criterion) => ({
        ...criterion,
        href: criterionHref(criterion.criterionId),
        refs: refsOf(criterion.refs),
      })),
      questions: competency.kitQuestions.map((question) => ({
        questionId: question.questionId,
        label: questionNumberLabel(question.number),
        question: question.question,
        href: kitQuestionHref(question.questionId),
      })),
      questionsEmpty:
        competency.kitQuestions.length > 0
          ? null
          : hiring.interviewGuide.status === "NO_DATA"
            ? "인터뷰 키트 없음"
            : "이 역량을 확인하는 키트 질문이 없습니다.",
    };
  });

  const requirements: RequirementRowView[] = hiring.requirements.criteria.map((criterion) => ({
    criterionId: criterion.criterionId,
    area: criterion.area,
    areaLabel: AREA_LABEL[criterion.area],
    title: criterion.title,
    verdict: criterion.verdict,
    reviewState: criterion.reviewState,
    // 미확정은 0점과 다르므로 `?`로 적는다 (G-04)
    pointsDisplay: `${criterion.earnedPoints ?? "?"}/${criterion.maxPoints}`,
    observation: criterion.observation,
    href: criterionHref(criterion.criterionId),
    refs: refsOf(criterion.refs),
  }));

  const signals = hiring.requirements.designReview.signals;
  const signalsLine =
    signals && signals.status === "ok"
      ? `소스 파일 ${signals.sourceFiles}개 · 테스트 파일 ${signals.testFiles}개 · 명시적 any ${signals.explicitAny.count}곳`
      : null;

  const resumeNotice =
    hiring.resumeLinks.status === "NO_DATA"
      ? "맥락 연결 자료가 없습니다. 이 평가는 맥락 연결 단계가 생기기 전에 만들어졌거나 연결을 읽지 못했습니다."
      : hiring.resumeLinks.status === "NO_RESUME"
        ? "이력서가 제출되지 않아 연결할 주장이 없습니다. 모든 관측은 과제 실행에서 나왔습니다."
        : null;

  const guideNotice =
    hiring.interviewGuide.status === "NO_DATA"
      ? "이 평가에는 인터뷰 키트가 없습니다. 질문 없이 관측만 실었습니다."
      : hiring.interviewGuide.llm && hiring.interviewGuide.llm !== "OK"
        ? `질문 문장 생성: ${hiring.interviewGuide.llmReason ?? "LLM 미실행"}. 슬롯별 기본 질문으로 채웠습니다. 질문 선정과 우선순위는 저장된 판정에서 정했습니다.`
        : null;

  return {
    evaluationId,
    title: `채용 리포트 · ${hiring.assignment.title}`,
    assignmentLabel: `${hiring.assignment.name} v${hiring.assignment.version}`,
    isSample: hiring.isSample,
    disclaimer: HIRING_REPORT_DISCLAIMER,
    printHint: HIRING_REPORT_PRINT_HINT,
    workbenchHref: href({}),
    interviewKitHref: href({ tab: "questions" }),
    workbenchUrl: absolute(origin, `/evaluations/${evaluationId}`),
    scoreDisplay: score ? score.display : "판정이 아직 저장되지 않았습니다",
    scoreNotice: score ? null : "채점이 끝나지 않아 점수 표기를 만들 수 없습니다.",
    areaBars,
    areaNotice:
      score && score.byArea === null
        ? "이 평가는 영역별 소계를 저장하기 전에 만들어져 소계를 보일 수 없습니다."
        : null,
    verdictBar: verdictBarOf(hiring.summary.verdictCounts, "판정 분포"),
    pendingReview: hiring.summary.pendingReview,
    strengths: hiring.keyObservations.strengths.map(observationView),
    defects: hiring.keyObservations.defects.map(observationView),
    competencies,
    requirements,
    testEffectiveness: hiring.requirements.testEffectiveness,
    designReview: {
      status: hiring.requirements.designReview.status,
      items: hiring.requirements.designReview.items.map((item) => ({
        criterionId: item.criterionId,
        rationale: item.rationale,
        refs: refsOf(item.refs),
      })),
      signalsLine,
    },
    resumeLinks: {
      status: hiring.resumeLinks.status,
      notice: resumeNotice,
      links: hiring.resumeLinks.links.map((link) => ({
        contextLinkId: link.contextLinkId,
        claim: link.claim,
        status: link.status,
        statusLabel: CONTEXT_STATUS_LABEL[link.status],
        evidence: link.evidence,
        observation: link.observation,
        observationHref: link.observation?.criterionId
          ? criterionHref(link.observation.criterionId)
          : null,
        question: link.question,
        href: `${href({ tab: "resume" })}#claim-${link.contextLinkId}`,
      })),
    },
    interviewGuide: {
      status: hiring.interviewGuide.status,
      notice: guideNotice,
      questions: hiring.interviewGuide.mustQuestions.map((question) => ({
        questionId: question.questionId,
        number: question.number,
        label: questionNumberLabel(question.number),
        kindLabel: INTERVIEW_QUESTION_KIND_LABELS[question.kind],
        competencyName: COMPETENCIES[question.competency].name,
        minutes: question.minutes,
        question: question.question,
        isTemplate: question.source === "TEMPLATE",
        href: kitQuestionHref(question.questionId),
      })),
    },
    scope: hiring.scope,
    scorecard: hiring.scorecard,
    audit: hiring.audit,
    markdown: hiringReportToMarkdown(hiring),
  };
}
