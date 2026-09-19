/**
 * 워크벤치 하단 탭 `인터뷰 키트`와 인쇄용 보기의 표시 모델 (TICKET.md T-704, PRD 14.2).
 *
 * - 키트는 워커의 INTERVIEW_KIT 단계(T-702)가 저장한 값 그대로다. 이 모듈은 질문·우선순위·시간·진행안을 다시 정하지 않고,
 *   점수·판정을 읽지 않는다(G-01). 평가 척도는 역량별 고정 앵커(`COMPETENCY_ANCHORS`)이며 값을 채우지 않는다.
 * - 근거 참조는 기존 워크벤치 딥링크로 바꾼다: 기준 `?criterion=`, 실행 기록 `?criterion=&run=`(재생), 코드 위치 `?source=`,
 *   변이 `?criterion=<그룹 기준>&mutation=`(diff), 맥락 연결 `?tab=resume#claim-<id>`.
 * - Markdown 내보내기의 코드 위치는 고정 SHA 링크(`githubBlobUrl`)를 쓴다. 브랜치 이름·`HEAD`는 쓰지 않는다.
 * - 키트가 없는 이전 평가는 사유와 함께 이전 후속 질문 목록으로 보인다(화면이 `QuestionsTabView`를 함께 그린다).
 */
import {
  COMPETENCIES,
  COMPETENCY_ANCHORS,
  CompetencySchema,
  INTERVIEW_PRIORITY_LABELS,
  INTERVIEW_QUESTION_KIND_LABELS,
  InterviewPrioritySchema,
  type Competency,
  type CompetencyAnchor,
  type EvaluationReport,
  type InterviewKit,
  type InterviewKitReport,
  type InterviewPriority,
  type InterviewQuestion,
  type InterviewQuestionKind,
  type ObservationRef,
} from "@ohmyti/core";
import type { EvaluationContextInput } from "@/lib/context/service";
import type { ReportResult } from "@/lib/reports/service";
import { STAGE_STATE_LABEL } from "@/lib/submissions/service";
import { githubBlobUrl } from "./code-evidence";
import { sourceParam } from "./graph";
import type { WorkbenchUrlState } from "./state";

export type InterviewKitInput = ReportResult<InterviewKitReport>;

/** 복사 버튼 옆의 안내. 이력서 연결 질문이 있으면 이력서 인용이 들어 있다 */
export const RESUME_QUOTE_NOTICE =
  "이력서 연결 질문에는 지원자 이력서의 인용이 들어 있습니다. 복사한 내용은 면접 담당자에게만 공유해 주세요.";

export interface KitRefView {
  kind: ObservationRef["kind"];
  /** 화면 표시 이름 (예: `R-05 재생`, `src/app.ts:10-24`) */
  label: string;
  /** 워크벤치 딥링크 (상대 경로). 이동할 곳이 없으면 null */
  href: string | null;
  /** 내보내기용 URL. 코드 위치는 고정 SHA 링크, 나머지는 워크벤치 절대 주소다. 없으면 null */
  exportUrl: string | null;
}

export interface KitQuestionView {
  id: string;
  /** DOM id (`kit-q-…`). 진행안이 이 id로 이동한다 */
  anchorId: string;
  /** 키트 안의 순번 (Q1, Q2, …). 진행안과 내보내기가 같은 번호를 쓴다 */
  number: number;
  kind: InterviewQuestionKind;
  kindLabel: string;
  competency: Competency;
  competencyName: string;
  priority: InterviewPriority;
  priorityLabel: string;
  minutes: number;
  question: string;
  intent: string;
  probes: string[];
  positiveSignals: string[];
  concernSignals: string[];
  /** 기본 질문(`TEMPLATE`)이면 true */
  isTemplate: boolean;
  refs: KitRefView[];
  /** 이력서 연결 질문이면 연결된 이력서 주장. 맥락을 읽지 못했으면 null */
  claim: string | null;
}

export interface KitGroupView {
  priority: InterviewPriority;
  label: string;
  minutes: number;
  questions: KitQuestionView[];
}

export interface KitPlanSegmentView {
  name: string;
  minutes: number;
  questions: Array<{ number: number; anchorId: string; label: string; minutes: number }>;
}

export interface KitPlanView {
  durationMinutes: number;
  /** 구간 시간의 합. 진행안 길이를 넘지 않는다(키트 스키마가 보장한다) */
  totalMinutes: number;
  segments: KitPlanSegmentView[];
}

export interface KitAnchorGroupView {
  competency: Competency;
  name: string;
  definition: string;
  /** 과제 실행만으로는 관측할 수 없고 면접에서만 확인하는 역량 */
  interviewOnly: boolean;
  anchors: readonly CompetencyAnchor[];
}

export interface KitEmptyView {
  title: string;
  description: string;
}

export interface InterviewKitView {
  /** 키트가 없으면 사유. 이때 화면은 이전 후속 질문 목록을 보인다 */
  missing: KitEmptyView | null;
  /** LLM을 부르지 못했거나 결과가 미확정이면 사유 (G-14) */
  llmNotice: string | null;
  /** LLM 문장 일부가 검사에서 버려져 기본 질문으로 바뀐 경우의 안내 */
  templateNotice: string | null;
  /** 이력서 연결 질문이 없을 때의 이유 */
  resumeNotice: string | null;
  /** 이력서 인용이 들어 있으면 복사 버튼 옆에 둘 안내 */
  resumeQuoteNotice: string | null;
  questionCount: number;
  templateCount: number;
  groups: KitGroupView[];
  plans: KitPlanView[];
  anchors: KitAnchorGroupView[];
  /** Markdown 내보내기 본문 */
  markdown: string;
  /** 인쇄용 보기 (`/evaluations/<id>/interview-kit`) */
  printHref: string;
}

type Href = (patch: Partial<WorkbenchUrlState>) => string;

const PRIORITY_ORDER = InterviewPrioritySchema.options;
const COMPETENCY_ORDER = CompetencySchema.options;

export function interviewKitPrintHref(evaluationId: string): string {
  return `/evaluations/${evaluationId}/interview-kit`;
}

export function kitQuestionAnchorId(questionId: string): string {
  return `kit-q-${questionId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function absolute(origin: string | null, href: string): string {
  return origin ? `${origin.replace(/\/$/, "")}${href}` : href;
}

/** 변이 ID가 속한 테스트 실효성 그룹의 MUTATION 기준. 없으면 null */
function mutationCriterionId(report: EvaluationReport, mutationId: string): string | null {
  const group = report.rubric.groups.find((g) => g.mutationIds.includes(mutationId));
  if (!group) return null;
  return (
    report.rubric.criteria.find((c) => c.method === "MUTATION" && c.groupId === group.id)?.id ??
    null
  );
}

/**
 * 근거 참조 하나를 워크벤치 딥링크로 바꾼다. 채용 리포트 화면(T-706)도 같은 규칙을 쓴다.
 * `exportUrl`은 내보내기(Markdown·인쇄물)용이며 코드 위치만 고정 SHA GitHub 링크다.
 */
export function observationRefView(
  ref: ObservationRef,
  report: EvaluationReport,
  href: Href,
  origin: string | null,
): KitRefView {
  const criterionTitle = (id: string) => report.rubric.criteria.find((c) => c.id === id)?.title;
  // 기준을 바꾸는 링크는 이전 선택(실행 기록·코드 위치·변이)을 풀어 둔다
  const clear = { runId: null, source: null, mutationId: null } as const;
  switch (ref.kind) {
    case "CRITERION": {
      const title = criterionTitle(ref.criterionId);
      const link = title ? href({ ...clear, criterionId: ref.criterionId }) : null;
      return {
        kind: ref.kind,
        label: title ? `${ref.criterionId} · ${title}` : ref.criterionId,
        href: link,
        exportUrl: link ? absolute(origin, link) : null,
      };
    }
    case "EXECUTION_RECORD": {
      const known = report.executionRecords.some((r) => r.id === ref.runId);
      const link = known
        ? href({ ...clear, criterionId: ref.criterionId ?? null, runId: ref.runId, pane: "code" })
        : null;
      return {
        kind: ref.kind,
        label: ref.criterionId ? `${ref.criterionId} 재생` : `실행 기록 ${ref.runId.slice(0, 8)}`,
        href: link,
        exportUrl: link ? absolute(origin, link) : null,
      };
    }
    case "SOURCE": {
      const location = sourceParam(ref.location);
      const link = href({ source: location, pane: "code" });
      return {
        kind: ref.kind,
        label: location,
        href: link,
        exportUrl:
          githubBlobUrl(report.submission.repoUrl, report.evaluation.submissionSha, ref.location) ??
          absolute(origin, link),
      };
    }
    case "MUTATION": {
      const criterionId = mutationCriterionId(report, ref.mutationId);
      const link = criterionId
        ? href({ ...clear, criterionId, mutationId: ref.mutationId, pane: "code" })
        : null;
      return {
        kind: ref.kind,
        label: `변이 ${ref.mutationId}`,
        href: link,
        exportUrl: link ? absolute(origin, link) : null,
      };
    }
    case "CONTEXT_LINK": {
      const link = `${href({ tab: "resume" })}#claim-${ref.contextLinkId}`;
      return {
        kind: ref.kind,
        label: "이력서 연결",
        href: link,
        exportUrl: absolute(origin, link),
      };
    }
  }
}

function missingView(report: EvaluationReport, kit: InterviewKitInput | null): KitEmptyView {
  const stage = report.stages.find((s) => s.stage === "INTERVIEW_KIT");
  if (!stage) {
    return {
      title: "인터뷰 키트가 없는 평가",
      description:
        "이 평가는 인터뷰 키트 단계가 생기기 전에 만들어졌습니다. 이전 후속 질문 목록을 대신 보여 드립니다.",
    };
  }
  if (stage.state !== "DONE") {
    return {
      title: `인터뷰 키트 ${STAGE_STATE_LABEL[stage.state]}`,
      description: stage.reason
        ? `인터뷰 키트 단계가 완료되지 않았습니다: ${stage.reason}`
        : "인터뷰 키트 단계가 아직 완료되지 않았습니다.",
    };
  }
  return {
    title: "인터뷰 키트를 읽지 못함",
    description:
      kit && !kit.ok
        ? kit.message
        : "인터뷰 키트를 읽지 않았습니다. 이전 후속 질문 목록을 보입니다.",
  };
}

function llmNoticeOf(kit: InterviewKit): string | null {
  const { generation } = kit;
  if (generation.llm === "OK") return null;
  const reason = generation.llmReason ?? "LLM 미실행";
  return generation.templateCount === generation.slotCount
    ? `${reason}: 모든 질문을 슬롯별 기본 질문으로 채웠습니다. 질문 선정·우선순위·시간은 LLM과 관계없이 저장된 판정에서 정했습니다.`
    : `${reason}: 질문 ${generation.templateCount}개를 슬롯별 기본 질문으로 채웠습니다.`;
}

function templateNoticeOf(kit: InterviewKit): string | null {
  const { generation } = kit;
  if (generation.llm !== "OK" || generation.templateCount === 0) return null;
  return `LLM이 쓴 문장 중 ${generation.templateCount}개가 질문 검사에 걸려 기본 질문으로 바꿨습니다.`;
}

function resumeNoticeOf(kit: InterviewKit, context: EvaluationContextInput | null): string | null {
  if (kit.questions.some((q) => q.kind === "RESUME_BRIDGE")) return null;
  if (context?.ok) {
    const { resume } = context.data;
    if (!resume.uploaded && resume.textStatus === "NONE") {
      return "이력서가 제출되지 않아 이력서 연결 질문이 없습니다. 모든 질문은 과제 관측에서 나왔습니다.";
    }
    if (resume.textStatus === "NONE" || resume.textStatus === "IMAGE_ONLY") {
      return `이력서에서 텍스트를 추출하지 못해 이력서 연결 질문이 없습니다${resume.reason ? ` (${resume.reason})` : ""}.`;
    }
  }
  return "이력서 주장과 연결된 질문이 없습니다. 모든 질문은 과제 관측에서 나왔습니다.";
}

function questionView(
  question: InterviewQuestion,
  number: number,
  report: EvaluationReport,
  context: EvaluationContextInput | null,
  href: Href,
  origin: string | null,
): KitQuestionView {
  const linkId = question.refs.find((r) => r.kind === "CONTEXT_LINK");
  const claim =
    linkId && context?.ok
      ? (context.data.links.find((l) => l.id === linkId.contextLinkId)?.claim ?? null)
      : null;
  return {
    id: question.id,
    anchorId: kitQuestionAnchorId(question.id),
    number,
    kind: question.kind,
    kindLabel: INTERVIEW_QUESTION_KIND_LABELS[question.kind],
    competency: question.competency,
    competencyName: COMPETENCIES[question.competency].name,
    priority: question.priority,
    priorityLabel: INTERVIEW_PRIORITY_LABELS[question.priority],
    minutes: question.minutes,
    question: question.question,
    intent: question.intent,
    probes: question.probes,
    positiveSignals: question.positiveSignals,
    concernSignals: question.concernSignals,
    isTemplate: question.source === "TEMPLATE",
    refs: question.refs.map((ref) => observationRefView(ref, report, href, origin)),
    claim,
  };
}

function planViews(kit: InterviewKit, byId: Map<string, KitQuestionView>): KitPlanView[] {
  return [...kit.plans]
    .sort((a, b) => a.durationMinutes - b.durationMinutes)
    .map((plan) => ({
      durationMinutes: plan.durationMinutes,
      totalMinutes: plan.segments.reduce((sum, s) => sum + s.minutes, 0),
      segments: plan.segments.map((segment) => ({
        name: segment.name,
        minutes: segment.minutes,
        questions: segment.questionIds.flatMap((id) => {
          const q = byId.get(id);
          return q
            ? [
                {
                  number: q.number,
                  anchorId: q.anchorId,
                  label: `${q.priorityLabel} · ${q.kindLabel}`,
                  minutes: q.minutes,
                },
              ]
            : [];
        }),
      })),
    }));
}

function anchorViews(questions: readonly KitQuestionView[]): KitAnchorGroupView[] {
  const used = new Set(questions.map((q) => q.competency));
  return COMPETENCY_ORDER.filter((c) => used.has(c)).map((competency) => ({
    competency,
    name: COMPETENCIES[competency].name,
    definition: COMPETENCIES[competency].definition,
    interviewOnly: COMPETENCIES[competency].interviewOnly,
    anchors: COMPETENCY_ANCHORS[competency],
  }));
}

export interface InterviewKitMarkdownInput {
  report: EvaluationReport;
  groups: readonly KitGroupView[];
  plans: readonly KitPlanView[];
  anchors: readonly KitAnchorGroupView[];
  llmNotice: string | null;
  resumeQuoteNotice: string | null;
  /** 워크벤치 절대 주소 */
  workbenchUrl: string;
}

function bullet(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

/**
 * Markdown 내보내기. 질문마다 주 질문·의도·꼬리 질문·좋은 답변의 신호·우려 신호·근거 URL을 적는다.
 * 코드 위치 근거는 고정 SHA 링크다. 점수·판정은 넣지 않는다.
 */
export function interviewKitMarkdown(input: InterviewKitMarkdownInput): string {
  const { report } = input;
  const lines: string[] = [
    `# 인터뷰 키트 · ${report.assignment.title}`,
    "",
    `- 워크벤치: ${input.workbenchUrl}`,
    `- 제출: ${report.submission.repoUrl} @ ${report.evaluation.submissionSha}`,
    `- 기준 버전: ${report.evaluation.rubricVersion}`,
  ];
  if (input.llmNotice) lines.push(`- ${input.llmNotice}`);
  if (input.resumeQuoteNotice) lines.push(`- ${input.resumeQuoteNotice}`);
  for (const plan of input.plans) {
    lines.push("", `## ${plan.durationMinutes}분 진행안 (구간 합 ${plan.totalMinutes}분)`, "");
    plan.segments.forEach((segment, index) => {
      const questions = segment.questions.map((q) => `Q${q.number}`).join(", ");
      lines.push(
        `${index + 1}. ${segment.name} · ${segment.minutes}분${questions ? `: ${questions}` : ""}`,
      );
    });
  }
  for (const group of input.groups) {
    lines.push("", `## ${group.label} 질문`);
    for (const q of group.questions) {
      lines.push(
        "",
        `### Q${q.number}. ${q.kindLabel} · ${q.competencyName} · ${q.minutes}분${q.isTemplate ? " · 기본 질문" : ""}`,
        "",
        `**질문**: ${q.question}`,
        "",
        `**의도**: ${q.intent}`,
      );
      if (q.claim) lines.push("", `**이력서 주장**: ${q.claim}`);
      lines.push("", "**꼬리 질문**", ...q.probes.map((p, i) => `${i + 1}. ${p}`));
      lines.push("", "**좋은 답변의 신호**", ...bullet(q.positiveSignals));
      lines.push("", "**우려 신호**", ...bullet(q.concernSignals));
      lines.push(
        "",
        "**근거**",
        ...bullet(q.refs.map((r) => (r.exportUrl ? `${r.label}: ${r.exportUrl}` : r.label))),
      );
    }
  }
  if (input.anchors.length > 0) {
    lines.push("", "## 평가 척도 (역량별 4단계, 면접관 기입)");
    for (const anchor of input.anchors) {
      lines.push(
        "",
        `### ${anchor.name}${anchor.interviewOnly ? " (면접에서만 확인)" : ""}`,
        "",
        ...anchor.anchors.map((a) => `${a.value}. ${a.label}: ${a.behavior}`),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function buildInterviewKitView(input: {
  report: EvaluationReport;
  kit: InterviewKitInput | null;
  context: EvaluationContextInput | null;
  href: Href;
  /** 내보내기에 쓸 절대 주소의 origin (`https://host`). 모르면 null이며 상대 경로를 쓴다 */
  origin: string | null;
}): InterviewKitView {
  const { report, kit, context, href, origin } = input;
  const printHref = interviewKitPrintHref(report.evaluation.id);
  if (!kit || !kit.ok) {
    return {
      missing: missingView(report, kit),
      llmNotice: null,
      templateNotice: null,
      resumeNotice: null,
      resumeQuoteNotice: null,
      questionCount: 0,
      templateCount: 0,
      groups: [],
      plans: [],
      anchors: [],
      markdown: "",
      printHref,
    };
  }
  const data = kit.data.kit;
  const ordered = PRIORITY_ORDER.flatMap((p) => data.questions.filter((q) => q.priority === p));
  const questions = ordered.map((q, index) =>
    questionView(q, index + 1, report, context, href, origin),
  );
  const byId = new Map(questions.map((q) => [q.id, q]));
  const groups: KitGroupView[] = PRIORITY_ORDER.flatMap((priority) => {
    const list = questions.filter((q) => q.priority === priority);
    return list.length === 0
      ? []
      : [
          {
            priority,
            label: INTERVIEW_PRIORITY_LABELS[priority],
            minutes: list.reduce((sum, q) => sum + q.minutes, 0),
            questions: list,
          },
        ];
  });
  const plans = planViews(data, byId);
  const anchors = anchorViews(questions);
  const llmNotice = llmNoticeOf(data);
  const resumeQuoteNotice = questions.some((q) => q.kind === "RESUME_BRIDGE")
    ? RESUME_QUOTE_NOTICE
    : null;
  return {
    missing: null,
    llmNotice,
    templateNotice: templateNoticeOf(data),
    resumeNotice: resumeNoticeOf(data, context),
    resumeQuoteNotice,
    questionCount: questions.length,
    templateCount: questions.filter((q) => q.isTemplate).length,
    groups,
    plans,
    anchors,
    markdown: interviewKitMarkdown({
      report,
      groups,
      plans,
      anchors,
      llmNotice,
      resumeQuoteNotice,
      workbenchUrl: absolute(origin, `/evaluations/${report.evaluation.id}`),
    }),
    printHref,
  };
}
