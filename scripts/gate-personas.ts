/**
 * 6단계 게이트 (T-606) · 7단계 게이트 (T-708): 가상 지원자 페르소나 4종(`samples/personas/`)을 배포 환경에 실제로 제출하고
 * 조회 API의 결과를 `samples/personas/expected-matrix.json`과 대조한다.
 *
 * T-708에서 인터뷰 키트(`/api/evaluations/[id]/interview-kit`)와 채용 리포트(`/api/evaluations/[id]/hiring-report`) 대조를
 * 더했다. 키트의 질문 슬롯·유형별 수·우선순위, 질문마다의 결정적 검사와 근거 참조, 리포트와 워크벤치의 판정·점수 일치,
 * 금지 표현 0건이 실패 조건이고 기본 질문 대체·버린 LLM 출력은 경고다. 기록은 `docs/gates/stage7.md`에 남는다.
 *
 * 흐름: Playwright로 웹 폼(`/submissions/new`)에 저장소 URL·SHA·이력서 PDF·GitHub 프로필 URL을 넣어 제출한다
 * (`POST /api/submissions`는 이력서를 받지 않는다) → `GET /api/submissions/[id]` 폴링 → `GET /api/evaluations/[id]`
 * (판정·변이·단계) + `GET /api/evaluations/[id]/context`(GitHub 근거·맥락 연결) → 대조. 판정은 배포된 워커가 한다.
 * 이 스크립트는 아무것도 실행하지 않고 결과만 읽는다 (G-01, G-07).
 *
 * 실패 조건은 결정적인 항목(기준별 판정·점수, 변이 결과, 점수 표시, 단계 상태, GitHub 근거 선정·커밋 수집,
 * REVIEW_WRITE의 LLM 결과와 R-12 초안 존재)과 "후속 질문 존재"뿐이다. 주장 상태 라벨은 LLM 판단이라 경고로만 남긴다.
 * 끝나면 첫 화면 → 제출 → 워크벤치를 데스크톱·모바일로 캡처해 `docs/gates/personas/`에 둔다.
 *
 * 사용: `pnpm gate:personas --base-url https://ohmyti.vercel.app [--personas seojin,dohyun] [--password <pw>]
 *        [--out docs/gates/personas.md] [--json docs/gates/personas.json] [--screenshots docs/gates/personas]
 *        [--skip-screenshots] [--timeout-ms 1800000] [--poll-ms 10000] [--submissions seojin=<id>,...]`
 * 종료 코드: 0 = 모든 페르소나가 COMPLETED이고 실패 조건이 모두 기대와 같으며 화면 점검 통과. 1 = 그 밖.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, devices, type Browser, type Page } from "@playwright/test";
import { format as prettierFormat, resolveConfig as prettierResolveConfig } from "prettier";
import { z } from "zod";
import {
  ContextStatusSchema,
  EvaluationContextReportResponseSchema,
  EvaluationReportResponseSchema,
  findForbiddenReportExpressions,
  HiringReportResponseSchema,
  INTERVIEW_QUESTION_KIND_LABELS,
  InterviewKitReportResponseSchema,
  InterviewPrioritySchema,
  InterviewQuestionKindSchema,
  interviewQuestionNumbers,
  lintInterviewQuestion,
  MutationOutcomeSchema,
  VerdictSchema,
  type EvaluationContextReport,
  type EvaluationReport,
  type HiringReport,
  type InterviewKit,
  type ObservationRef,
} from "@ohmyti/core";
import "./load-env";
import { GateClient, unwrap, waitForTerminal } from "./gate-phase2";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MATRIX = path.join(repoRoot, "samples", "personas", "expected-matrix.json");
export const DEFAULT_OUT = path.join(repoRoot, "docs", "gates", "personas.md");
export const DEFAULT_JSON_OUT = path.join(repoRoot, "docs", "gates", "personas.json");
export const DEFAULT_SCREENSHOTS = path.join(repoRoot, "docs", "gates", "personas");
/** 7단계 게이트 기록 (T-708) */
export const DEFAULT_STAGE7_OUT = path.join(repoRoot, "docs", "gates", "stage7.md");
export const DEFAULT_STAGE7_DOCS = path.join(repoRoot, "docs", "gates", "stage7");
/** 워커가 페르소나를 순서대로 처리하므로 마지막 제출은 앞 제출이 끝날 때까지 기다린다 */
export const DEFAULT_TIMEOUT_MS = 40 * 60 * 1000;
export const DEFAULT_POLL_MS = 10_000;
export const STAGES = [
  "REPO_CHECK",
  "ENV_PREP",
  "REQUIREMENT_VERIFY",
  "TEST_EFFECTIVENESS",
  "REVIEW_WRITE",
  "CONTEXT_LINK",
  "INTERVIEW_KIT",
] as const;

// ── 기대값 ──────────────────────────────────────────────────────────────────────

const KeywordsSchema = z.array(z.string().min(1)).min(1);

/**
 * 인터뷰 키트 질문 하나의 기대값 (T-708). 슬롯 ID·유형·우선순위는 저장된 판정에서 결정적으로 정해지므로 실패 조건이고,
 * `anyOf`는 그 질문의 문장·근거에 있어야 하는 신호 키워드다(설계 신호 근거 같은 것).
 */
export const KitQuestionExpectationSchema = z.strictObject({
  id: z.string().min(1),
  kind: InterviewQuestionKindSchema,
  priority: InterviewPrioritySchema,
  anyOf: KeywordsSchema.optional(),
});
export type KitQuestionExpectation = z.infer<typeof KitQuestionExpectationSchema>;

/**
 * 유형별 질문 수의 기대값. 과제 관측에서 나오는 유형은 판정으로 수가 정해지므로 정수를 쓰고, 이력서 연결은 LLM이 고른
 * 주장 수에 따라 달라지므로 범위(`{ min, max }`)를 쓴다.
 */
export const KitCountExpectationSchema = z.union([
  z.int().min(0),
  z.strictObject({ min: z.int().min(0), max: z.int().min(0) }),
]);
export type KitCountExpectation = z.infer<typeof KitCountExpectationSchema>;

/** 페르소나의 인터뷰 키트 기대값 (T-708). 유형별 질문 수와 있어야 하는 질문 슬롯 */
export const PersonaKitExpectationSchema = z.strictObject({
  /** 유형별 질문 수. 여섯 유형을 모두 적는다 */
  kindCounts: z.record(InterviewQuestionKindSchema, KitCountExpectationSchema),
  questions: z.array(KitQuestionExpectationSchema),
});
export type PersonaKitExpectation = z.infer<typeof PersonaKitExpectationSchema>;

export const PersonaExpectationSchema = z.strictObject({
  level: z.string().min(1),
  repoUrl: z.url(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  /** 저장소 이름을 바꾸기 전의 이름. 근거에 선택되면 안 되는 제출 저장소로 함께 본다 */
  formerRepoNames: z.array(z.string().min(1)),
  resume: z.string().min(1),
  /** 근거로 선택되어야 하는 본인의 포트폴리오 저장소 이름 */
  portfolio: z.array(z.string().min(1)).min(1),
  criteria: z.record(z.string(), VerdictSchema),
  mutations: z.record(z.string(), MutationOutcomeSchema),
  mutationNotes: z.record(z.string(), z.string()),
  scoreDisplay: z.string().min(1),
  /** 후속 질문이 있어야 하는 주장. 주장 문장에 키워드 하나가 들어 있으면 그 주장으로 본다 */
  followUpClaims: z.array(z.strictObject({ label: z.string().min(1), anyOf: KeywordsSchema })),
  /** 주장별 기대 상태. LLM 판단이라 불일치는 경고다 */
  claims: z.array(z.strictObject({ anyOf: KeywordsSchema, status: ContextStatusSchema })),
  /** 인터뷰 키트 기대값 (T-708) */
  kit: PersonaKitExpectationSchema,
});
export type PersonaExpectation = z.infer<typeof PersonaExpectationSchema>;

export const PersonaMatrixSchema = z.strictObject({
  note: z.string().optional(),
  organization: z.string().min(1),
  githubProfileUrl: z.url(),
  rubricVersion: z.string().min(1),
  personas: z.record(z.string(), PersonaExpectationSchema),
});
export type PersonaMatrix = z.infer<typeof PersonaMatrixSchema>;

export function repoNameOf(url: string): string {
  const name = new URL(url).pathname.split("/").filter(Boolean)[1];
  if (!name) throw new Error(`저장소 URL이 아닙니다: ${url}`);
  return name;
}

/** 페르소나의 근거에 선택되면 안 되는 저장소: 본인 제출 저장소(옛 이름 포함)와 다른 페르소나의 모든 저장소 */
export function forbiddenRepos(matrix: PersonaMatrix, handle: string): string[] {
  const names = new Set<string>();
  for (const [other, p] of Object.entries(matrix.personas)) {
    names.add(repoNameOf(p.repoUrl));
    for (const n of p.formerRepoNames) names.add(n);
    if (other !== handle) for (const n of p.portfolio) names.add(n);
  }
  return [...names].sort().map((n) => `${matrix.organization}/${n}`);
}

// ── 대조 ───────────────────────────────────────────────────────────────────────

/** 키트 질문 하나의 관측값 (T-708). 기록(`docs/gates/stage7.md`)의 키트 전문도 이 값으로 쓴다 */
export interface KitQuestionFacts {
  id: string;
  /** 키트 안의 질문 번호 (Q1, Q2 …) */
  number: number;
  kind: string;
  competency: string;
  priority: string;
  minutes: number;
  question: string;
  intent: string;
  probes: string[];
  positiveSignals: string[];
  concernSignals: string[];
  /** 근거 참조를 사람이 읽는 문장으로 옮긴 것 */
  refs: string[];
  /** 근거 참조의 종류 (`CRITERION`, `MUTATION` …) */
  refKinds: string[];
  source: string;
  /** 결정적 질문 검사(`lintInterviewQuestion`) 위반. 비어 있어야 한다 */
  lint: string[];
}

export interface KitFacts {
  slotCount: number;
  templateCount: number;
  llm: string;
  llmReason: string | null;
  promptVersion: string;
  model: string | null;
  inputDigest: string | null;
  /** 후처리가 버린 LLM 출력 항목 */
  dropped: { index: number | null; slotId: string | null; reason: string; rules: string[] }[];
  /** 진행안별 구간 시간 합 */
  plans: { durationMinutes: number; totalMinutes: number; questionCount: number }[];
  questions: KitQuestionFacts[];
}

/** 채용 리포트의 관측값 (T-708). 리포트는 새 판단을 만들지 않으므로 평가 조회 API의 값과 같아야 한다 */
export interface ReportFacts {
  scoreDisplay: string | null;
  verdictCounts: Record<string, number>;
  criteria: Record<string, { verdict: string; earnedPoints: number | null }>;
  mustQuestions: { number: number; question: string; source: string }[];
  interviewGuideStatus: string;
  resumeLinksStatus: string;
  resumeLinkCount: number;
  designReviewStatus: string;
  /** 시스템이 쓴 문장에 남은 금지 표현 (PRD 14.4). 비어 있어야 한다 */
  forbidden: string[];
}

export interface PersonaFacts {
  criteria: Record<string, { verdict: string; earnedPoints: number | null }>;
  mutations: Record<string, { outcome: string; reason: string | null }>;
  scoreDisplay: string | null;
  stages: Record<string, string>;
  reviewWrite: { llm: string | null; reason: string | null; r12Draft: R12Draft | null };
  github: {
    status: string | null;
    selection: string | null;
    repos: {
      fullName: string;
      commits: number;
      mergedPulls: number;
      authorFilter: string | null;
    }[];
    excludedRepos: string[];
  };
  links: {
    claim: string;
    status: string;
    followUpQuestion: string | null;
    criterionId: string | null;
  }[];
  /** 인터뷰 키트 (T-708). 조회에 실패했으면 null */
  kit: KitFacts | null;
  /** 채용 리포트 (T-708). 조회에 실패했으면 null */
  report: ReportFacts | null;
}

export interface R12Draft {
  suggestedPoints: number | null;
  maxPoints: number | null;
  rationale: string;
}

export interface PersonaComparison {
  mismatches: string[];
  warnings: string[];
  facts: PersonaFacts;
}

function includesAny(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

const ReviewWriteDetailSchema = z.looseObject({
  llm: z.string().optional(),
  designSuggestions: z
    .array(
      z.looseObject({
        criterionId: z.string(),
        suggestedPoints: z.number().nullable().optional(),
        maxPoints: z.number().nullable().optional(),
        rationale: z.string().optional(),
      }),
    )
    .optional(),
});

/** 근거 참조 하나를 사람이 읽는 문장으로 (기록·키워드 검사용) */
export function refText(ref: ObservationRef): string {
  switch (ref.kind) {
    case "CRITERION":
      return `기준 ${ref.criterionId}`;
    case "EXECUTION_RECORD":
      return `실행 기록 ${ref.runId.slice(0, 8)}${ref.criterionId ? ` · ${ref.criterionId}` : ""}`;
    case "SOURCE":
      return `코드 ${ref.location.path}:${ref.location.startLine}-${ref.location.endLine}`;
    case "MUTATION":
      return `변이 ${ref.mutationId}`;
    case "CONTEXT_LINK":
      return `맥락 연결 ${ref.contextLinkId.slice(0, 8)}`;
  }
}

/** 질문 하나에서 키워드를 찾을 때 보는 텍스트 (문장 + 근거) */
export function kitQuestionText(question: KitQuestionFacts): string {
  return [
    question.question,
    question.intent,
    ...question.probes,
    ...question.positiveSignals,
    ...question.concernSignals,
    ...question.refs,
  ].join(" ");
}

export function kitFactsOf(kit: InterviewKit): KitFacts {
  const numbers = interviewQuestionNumbers(kit.questions);
  return {
    slotCount: kit.generation.slotCount,
    templateCount: kit.generation.templateCount,
    llm: kit.generation.llm,
    llmReason: kit.generation.llmReason,
    promptVersion: kit.generation.promptVersion,
    model: kit.generation.model,
    inputDigest: kit.generation.inputDigest,
    dropped: kit.generation.dropped.map((d) => ({
      index: d.index,
      slotId: d.slotId,
      reason: d.reason,
      rules: [...d.rules],
    })),
    plans: kit.plans.map((plan) => ({
      durationMinutes: plan.durationMinutes,
      totalMinutes: plan.segments.reduce((sum, s) => sum + s.minutes, 0),
      questionCount: plan.segments.reduce((sum, s) => sum + s.questionIds.length, 0),
    })),
    questions: kit.questions.map((q) => ({
      id: q.id,
      number: numbers.get(q.id) ?? 0,
      kind: q.kind,
      competency: q.competency,
      priority: q.priority,
      minutes: q.minutes,
      question: q.question,
      intent: q.intent,
      probes: [...q.probes],
      positiveSignals: [...q.positiveSignals],
      concernSignals: [...q.concernSignals],
      refs: q.refs.map(refText),
      refKinds: q.refs.map((ref) => ref.kind),
      source: q.source,
      lint: lintInterviewQuestion({
        question: q.question,
        probes: q.probes,
        intent: q.intent,
        positiveSignals: q.positiveSignals,
        concernSignals: q.concernSignals,
        refs: q.refs,
      }).map((v) => `${v.field}${v.index === null ? "" : `[${v.index}]`}: ${v.rule}`),
    })),
  };
}

/**
 * 금지 표현(PRD 14.4)을 검사할 텍스트. 시스템이 쓴 문장만 본다. 이력서 주장·관측 문장에는 제출물과 지원자가 쓴 값이
 * 그대로 들어 있어 (경력 연차 같은) 단어가 섞일 수 있고, 그것은 시스템의 판단이 아니다.
 */
export function reportSystemText(report: HiringReport): string {
  const observations = [...report.keyObservations.strengths, ...report.keyObservations.defects];
  return [
    ...observations.flatMap((o) => [o.impact ?? "", o.aiDraft ?? ""]),
    ...report.requirements.designReview.items.map((i) => i.rationale),
    ...report.interviewGuide.mustQuestions.map((q) => q.question),
    ...report.competencies.map((c) => c.name),
    ...report.scorecard.competencies.flatMap((c) => [
      c.name,
      c.definition,
      ...c.anchors.map((a) => `${a.label} ${a.behavior}`),
    ]),
    ...report.scope.supportScope,
    ...report.scope.unassessedAreas,
  ].join("\n");
}

export function reportFactsOf(report: HiringReport, kit: InterviewKit | null): ReportFacts {
  const kitText = kit
    ? kit.questions
        .flatMap((q) => [
          q.question,
          q.intent,
          ...q.probes,
          ...q.positiveSignals,
          ...q.concernSignals,
        ])
        .join("\n")
    : "";
  return {
    scoreDisplay: report.summary.score?.display ?? null,
    verdictCounts: { ...report.summary.verdictCounts },
    criteria: Object.fromEntries(
      report.requirements.criteria.map((c) => [
        c.criterionId,
        { verdict: c.verdict, earnedPoints: c.earnedPoints },
      ]),
    ),
    mustQuestions: report.interviewGuide.mustQuestions.map((q) => ({
      number: q.number,
      question: q.question,
      source: q.source,
    })),
    interviewGuideStatus: report.interviewGuide.status,
    resumeLinksStatus: report.resumeLinks.status,
    resumeLinkCount: report.resumeLinks.links.length,
    designReviewStatus: report.requirements.designReview.status,
    forbidden: findForbiddenReportExpressions(`${reportSystemText(report)}\n${kitText}`),
  };
}

export function factsOf(report: EvaluationReport, context: EvaluationContextReport): PersonaFacts {
  const reviewStage = report.stages.find((s) => s.stage === "REVIEW_WRITE");
  const detail = ReviewWriteDetailSchema.safeParse(reviewStage?.detail ?? {});
  const draft = detail.success
    ? detail.data.designSuggestions?.find((d) => d.criterionId === "R-12")
    : undefined;
  const sources = context.github.sources;
  return {
    criteria: Object.fromEntries(
      report.criterionResults.map((c) => [
        c.criterionId,
        { verdict: c.verdict, earnedPoints: c.earnedPoints },
      ]),
    ),
    mutations: Object.fromEntries(
      report.mutationExperiments.map((m) => [
        m.mutationId,
        { outcome: m.outcome, reason: m.reason ?? null },
      ]),
    ),
    scoreDisplay: report.score?.display ?? null,
    stages: Object.fromEntries(report.stages.map((s) => [s.stage, s.state])),
    reviewWrite: {
      llm: detail.success ? (detail.data.llm ?? null) : null,
      reason: reviewStage?.reason ?? null,
      r12Draft: draft
        ? {
            suggestedPoints: draft.suggestedPoints ?? null,
            maxPoints: draft.maxPoints ?? null,
            rationale: draft.rationale ?? "",
          }
        : null,
    },
    github: {
      status: sources?.status ?? null,
      selection: sources?.selection ?? null,
      repos: (sources?.repos ?? []).map((r) => ({
        fullName: r.fullName,
        commits: r.commits.length,
        mergedPulls: r.mergedPulls.length,
        authorFilter: r.authorFilter ?? null,
      })),
      excludedRepos: sources?.excludedRepos ?? [],
    },
    links: context.links.map((l) => ({
      claim: l.claim,
      status: l.status,
      followUpQuestion: l.followUpQuestion ?? null,
      criterionId: l.assignmentObservation?.criterionId ?? null,
    })),
    kit: null,
    report: null,
  };
}

/**
 * 이력서 연결 질문이 이번 과제와 비교하는 어조인지 보는 표현 (T-703의 프롬프트 규칙 (b)). 관측 기준이 없는 연결은
 * 이력서에 적힌 경험 자체를 물어야 한다.
 */
const ASSIGNMENT_COMPARISON_PATTERN = /이번 과제|과제에서|과제와|과제의|제출한 코드/;

/**
 * 인터뷰 키트 대조 (T-708). 슬롯 ID·유형·우선순위·유형별 질문 수는 저장된 판정에서 결정적으로 정해지므로 실패 조건이고,
 * 기본 질문(`TEMPLATE`) 대체와 후처리가 버린 항목은 LLM 출력의 품질이라 경고로 남긴다.
 */
export function compareKit(
  expected: PersonaKitExpectation,
  facts: PersonaFacts,
  mismatches: string[],
  warnings: string[],
): void {
  const kit = facts.kit;
  if (!kit) {
    mismatches.push("인터뷰 키트를 읽지 못함");
    return;
  }
  if (kit.llm !== "OK") {
    mismatches.push(
      `INTERVIEW_KIT LLM 결과: 기대 OK, 실제 ${kit.llm}${kit.llmReason ? ` (${kit.llmReason})` : ""}`,
    );
  }
  if (kit.questions.length !== kit.slotCount) {
    mismatches.push(
      `키트 질문 수(${kit.questions.length})가 계획한 슬롯 수(${kit.slotCount})와 다름`,
    );
  }
  for (const [kind, count] of Object.entries(expected.kindCounts)) {
    const actual = kit.questions.filter((q) => q.kind === kind).length;
    const min = typeof count === "number" ? count : count.min;
    const max = typeof count === "number" ? count : count.max;
    if (actual < min || actual > max) {
      mismatches.push(
        `${kind} 질문 수: 기대 ${min === max ? min : `${min}~${max}`}, 실제 ${actual}`,
      );
    }
  }
  for (const want of expected.questions) {
    const question = kit.questions.find((q) => q.id === want.id);
    if (!question) {
      mismatches.push(`키트에 질문 ${want.id}이 없음`);
      continue;
    }
    if (question.kind !== want.kind) {
      mismatches.push(`${want.id} 유형: 기대 ${want.kind}, 실제 ${question.kind}`);
    }
    if (question.priority !== want.priority) {
      mismatches.push(`${want.id} 우선순위: 기대 ${want.priority}, 실제 ${question.priority}`);
    }
    if (want.anyOf && !includesAny(kitQuestionText(question), want.anyOf)) {
      mismatches.push(`${want.id}에 ${want.anyOf.join("·")} 근거가 없음`);
    }
  }
  for (const question of kit.questions) {
    if (question.refs.length === 0) mismatches.push(`${question.id}: 근거 참조 없음`);
    if (question.lint.length > 0) {
      mismatches.push(`${question.id}: 질문 검사 위반 ${question.lint.join(", ")}`);
    }
    if (
      question.kind === "RESUME_BRIDGE" &&
      !question.refKinds.includes("CRITERION") &&
      ASSIGNMENT_COMPARISON_PATTERN.test([question.question, ...question.probes].join(" "))
    ) {
      mismatches.push(`${question.id}: 관측 기준이 없는 이력서 연결 질문이 과제와 비교함`);
    }
  }
  for (const plan of kit.plans) {
    if (plan.totalMinutes > plan.durationMinutes) {
      mismatches.push(
        `${plan.durationMinutes}분 진행안의 구간 합이 ${plan.totalMinutes}분으로 길이를 넘음`,
      );
    }
  }
  if (kit.templateCount > 0) {
    warnings.push(`기본 질문(TEMPLATE) 대체 ${kit.templateCount}/${kit.slotCount}`);
  }
  for (const dropped of kit.dropped) {
    warnings.push(
      `버린 LLM 출력 ${dropped.slotId ?? `#${dropped.index ?? "?"}`}: ${dropped.reason}${dropped.rules.length > 0 ? ` (${dropped.rules.join(", ")})` : ""}`,
    );
  }
}

/** 채용 리포트 대조 (T-708). 리포트는 저장된 값을 옮기기만 하므로 평가 조회 API의 판정·점수와 같아야 한다 */
export function compareReport(facts: PersonaFacts, mismatches: string[]): void {
  const report = facts.report;
  if (!report) {
    mismatches.push("채용 리포트를 읽지 못함");
    return;
  }
  if (report.scoreDisplay !== facts.scoreDisplay) {
    mismatches.push(
      `리포트 점수 표시: 워크벤치 ${facts.scoreDisplay ?? "없음"}, 리포트 ${report.scoreDisplay ?? "없음"}`,
    );
  }
  for (const [criterionId, actual] of Object.entries(facts.criteria)) {
    const inReport = report.criteria[criterionId];
    if (!inReport) {
      mismatches.push(`리포트에 기준 ${criterionId}이 없음`);
    } else if (
      inReport.verdict !== actual.verdict ||
      inReport.earnedPoints !== actual.earnedPoints
    ) {
      mismatches.push(
        `리포트 ${criterionId}: 워크벤치 ${actual.verdict} ${actual.earnedPoints ?? "null"}점, 리포트 ${inReport.verdict} ${inReport.earnedPoints ?? "null"}점`,
      );
    }
  }
  if (report.interviewGuideStatus !== "AVAILABLE") {
    mismatches.push(`리포트 면접 안내: 기대 AVAILABLE, 실제 ${report.interviewGuideStatus}`);
  }
  const mustInKit = (facts.kit?.questions ?? []).filter((q) => q.priority === "MUST");
  if (facts.kit && report.mustQuestions.length !== mustInKit.length) {
    mismatches.push(
      `리포트 필수 질문 수: 키트 ${mustInKit.length}, 리포트 ${report.mustQuestions.length}`,
    );
  }
  if (report.forbidden.length > 0) {
    mismatches.push(`금지 표현 ${report.forbidden.join(", ")}`);
  }
}

export function comparePersona(
  matrix: PersonaMatrix,
  handle: string,
  maxPointsOf: ReadonlyMap<string, number>,
  facts: PersonaFacts,
): PersonaComparison {
  const expected = matrix.personas[handle];
  if (!expected) throw new Error(`기대값에 없는 페르소나: ${handle}`);
  const mismatches: string[] = [];
  const warnings: string[] = [];

  for (const [criterionId, verdict] of Object.entries(expected.criteria)) {
    const actual = facts.criteria[criterionId];
    const max = maxPointsOf.get(criterionId);
    const points = verdict === "PASS" ? (max ?? null) : verdict === "FAIL" ? 0 : null;
    if (!actual) {
      mismatches.push(`${criterionId}: 판정 없음 (기대 ${verdict})`);
    } else if (actual.verdict !== verdict || actual.earnedPoints !== points) {
      mismatches.push(
        `${criterionId}: 기대 ${verdict} ${points ?? "null"}점, 실제 ${actual.verdict} ${actual.earnedPoints ?? "null"}점`,
      );
    }
  }
  for (const criterionId of Object.keys(facts.criteria)) {
    if (!(criterionId in expected.criteria)) mismatches.push(`${criterionId}: 기대값에 없는 기준`);
  }

  for (const [mutationId, outcome] of Object.entries(expected.mutations)) {
    const actual = facts.mutations[mutationId];
    if (!actual) mismatches.push(`${mutationId}: 실험 없음 (기대 ${outcome})`);
    else if (actual.outcome !== outcome) {
      mismatches.push(
        `${mutationId}: 기대 ${outcome}, 실제 ${actual.outcome}${actual.reason ? ` (${actual.reason})` : ""}`,
      );
    }
  }

  if (facts.scoreDisplay !== expected.scoreDisplay) {
    mismatches.push(
      `점수 표시: 기대 ${expected.scoreDisplay}, 실제 ${facts.scoreDisplay ?? "없음"}`,
    );
  }

  for (const stage of STAGES) {
    if (facts.stages[stage] !== "DONE") {
      mismatches.push(`${stage}: 기대 DONE, 실제 ${facts.stages[stage] ?? "없음"}`);
    }
  }
  if (facts.reviewWrite.llm !== "OK") {
    mismatches.push(
      `REVIEW_WRITE LLM 결과: 기대 OK, 실제 ${facts.reviewWrite.llm ?? "없음"}${facts.reviewWrite.reason ? ` (${facts.reviewWrite.reason})` : ""}`,
    );
  }
  if (!facts.reviewWrite.r12Draft) mismatches.push("R-12 설계 초안 없음");

  if (facts.github.status !== "COLLECTED") {
    mismatches.push(
      `GitHub 근거 상태: 기대 COLLECTED, 실제 ${facts.github.status ?? "조회 안 함"}`,
    );
  }
  const selected = facts.github.repos.map((r) => r.fullName.toLowerCase());
  for (const name of expected.portfolio) {
    const full = `${matrix.organization}/${name}`.toLowerCase();
    if (!selected.includes(full)) mismatches.push(`GitHub 근거에 ${name}이 없음`);
  }
  const forbidden = new Set(forbiddenRepos(matrix, handle).map((n) => n.toLowerCase()));
  for (const repo of facts.github.repos) {
    if (forbidden.has(repo.fullName.toLowerCase())) {
      mismatches.push(`GitHub 근거에 선택되면 안 되는 저장소: ${repo.fullName}`);
    }
  }
  const commits = facts.github.repos.reduce((sum, r) => sum + r.commits, 0);
  if (commits < 1) mismatches.push("GitHub 근거에 수집된 커밋 없음");

  for (const want of expected.followUpClaims) {
    const matched = facts.links.filter((l) => includesAny(l.claim, want.anyOf));
    if (matched.length === 0) {
      mismatches.push(`후속 질문 대상 주장 "${want.label}"이 맥락 연결에 없음`);
    } else if (!matched.some((l) => l.followUpQuestion)) {
      mismatches.push(`주장 "${want.label}"에 후속 질문 없음`);
    }
  }

  compareKit(expected.kit, facts, mismatches, warnings);
  compareReport(facts, mismatches);

  for (const want of expected.claims) {
    const matched = facts.links.filter((l) => includesAny(l.claim, want.anyOf));
    if (matched.length === 0) {
      warnings.push(`주장(${want.anyOf.join("·")}): 맥락 연결에서 찾지 못함 (기대 ${want.status})`);
    } else if (!matched.some((l) => l.status === want.status)) {
      warnings.push(
        `주장(${want.anyOf.join("·")}): 기대 ${want.status}, 실제 ${[...new Set(matched.map((l) => l.status))].join("·")}`,
      );
    }
  }

  return { mismatches, warnings, facts };
}

// ── 제출 (웹 폼) ────────────────────────────────────────────────────────────────

async function submitViaForm(
  browser: Browser,
  baseUrl: string,
  matrix: PersonaMatrix,
  expected: PersonaExpectation,
  screenshotPath: string | null,
): Promise<string> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(new URL("/submissions/new", baseUrl).toString(), { waitUntil: "networkidle" });
    const select = page.locator('select[name="assignmentVersionId"]');
    const optionTexts = await select.locator("option").allTextContents();
    if (optionTexts.length !== 1) {
      throw new Error(
        `승인된 과제 버전이 정확히 하나가 아님: ${optionTexts.join(" / ") || "없음"}`,
      );
    }
    await page.locator('input[name="repoUrl"]').fill(expected.repoUrl);
    await page.locator('input[name="commitSha"]').fill(expected.sha);
    await page.locator('input[name="githubProfileUrl"]').fill(matrix.githubProfileUrl);
    await page.locator('input[name="resume"]').setInputFiles(path.join(repoRoot, expected.resume));
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
    await Promise.all([
      page.waitForURL(/\/submissions\/[0-9a-f-]{36}(?:[/?#]|$)/, { timeout: 60_000 }),
      page.getByRole("button", { name: "분석 및 채점" }).click(),
    ]);
    const id = /\/submissions\/([0-9a-f-]{36})/.exec(page.url())?.[1];
    if (!id) throw new Error(`제출 ID를 URL에서 찾지 못함: ${page.url()}`);
    return id;
  } finally {
    await context.close();
  }
}

// ── 화면 캡처 ───────────────────────────────────────────────────────────────────

export interface ScreenCheck {
  name: string;
  viewport: "desktop" | "mobile";
  url: string;
  file: string;
  status: number | null;
  horizontalOverflowPx: number;
  consoleErrors: string[];
  problems: string[];
}

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: devices["iPhone 13"],
} as const;

async function capture(
  page: Page,
  name: string,
  viewport: "desktop" | "mobile",
  url: string,
  dir: string,
  /** 전체 페이지 캡처. 채용 리포트·인터뷰 키트처럼 긴 문서는 첫 화면만 담는다 (T-708) */
  fullPage = true,
): Promise<ScreenCheck> {
  const consoleErrors: string[] = [];
  const onConsole = (msg: { type(): string; text(): string }) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  };
  page.on("console", onConsole);
  const response = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1000);
  // 스크립트 tsconfig에는 DOM 타입이 없어 식을 문자열로 넘긴다
  const overflow = Number(
    await page.evaluate(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    ),
  );
  const bodyText = await page.locator("body").innerText();
  const file = path.join(dir, `${name}-${viewport}.png`);
  await page.screenshot({ path: file, fullPage });
  page.off("console", onConsole);
  const status = response?.status() ?? null;
  const problems: string[] = [];
  if (status === null || status >= 400) problems.push(`HTTP ${status ?? "응답 없음"}`);
  if (overflow > 1) problems.push(`가로 넘침 ${overflow}px`);
  if (/Application error|Unhandled Runtime Error|Internal Server Error/.test(bodyText)) {
    problems.push("오류 화면 문구");
  }
  if (consoleErrors.length > 0) problems.push(`콘솔 오류 ${consoleErrors.length}건`);
  return {
    name,
    viewport,
    url,
    file: path.relative(repoRoot, file),
    status,
    horizontalOverflowPx: Math.max(0, overflow),
    consoleErrors,
    problems,
  };
}

/** 심사위원 시점: 첫 화면 → 제출 화면 → 제출 상태 → 워크벤치 → 워크벤치 하단 맥락 탭 */
async function captureScreens(
  browser: Browser,
  baseUrl: string,
  dir: string,
  target: { submissionId: string; evaluationId: string },
): Promise<ScreenCheck[]> {
  await mkdir(dir, { recursive: true });
  const pages: [string, string][] = [
    ["01-home", "/"],
    ["02-submit", "/submissions/new"],
    ["03-submission-status", `/submissions/${target.submissionId}`],
    ["04-workbench", `/evaluations/${target.evaluationId}`],
    ["05-workbench-r12", `/evaluations/${target.evaluationId}?criterion=R-12`],
  ];
  const checks: ScreenCheck[] = [];
  for (const viewport of ["desktop", "mobile"] as const) {
    const context = await browser.newContext(VIEWPORTS[viewport]);
    const page = await context.newPage();
    for (const [name, pathname] of pages) {
      checks.push(await capture(page, name, viewport, new URL(pathname, baseUrl).toString(), dir));
    }
    await context.close();
  }
  return checks;
}

/** 인쇄 설정 (T-706 E2E와 같은 A4 14mm 여백) */
const A4_PRINT = {
  format: "A4",
  printBackground: true,
  margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" },
} as const;

/** PDF 쪽 수. 페이지 트리의 `/Count`를 먼저 보고, 없으면 `/Type /Page` 객체를 센다 */
export function countPdfPages(pdf: string): number {
  const count = /\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)/.exec(pdf);
  if (count) return Number(count[1]);
  return (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** 채용 담당자 시점: 페르소나마다 채용 리포트와 인터뷰 키트 인쇄용 보기를 캡처하고 PDF 쪽 수를 센다 (T-708) */
async function capturePersonaDocs(
  browser: Browser,
  baseUrl: string,
  dir: string,
  handle: string,
  evaluationId: string,
): Promise<PersonaDocCapture> {
  await mkdir(dir, { recursive: true });
  const pages: [string, string][] = [
    [`report-${handle}`, `/evaluations/${evaluationId}/report`],
    [`interview-kit-${handle}`, `/evaluations/${evaluationId}/interview-kit`],
  ];
  const screens: ScreenCheck[] = [];
  for (const viewport of ["desktop", "mobile"] as const) {
    const context = await browser.newContext(VIEWPORTS[viewport]);
    const page = await context.newPage();
    for (const [name, pathname] of pages) {
      // 문서 화면은 1쪽(첫 화면)만 담는다. 쪽 수와 전문은 아래 PDF와 기록의 키트 전문이 맡는다
      screens.push(
        await capture(page, name, viewport, new URL(pathname, baseUrl).toString(), dir, false),
      );
    }
    await context.close();
  }
  const context = await browser.newContext(VIEWPORTS.desktop);
  const page = await context.newPage();
  const pdfOf = async (name: string, pathname: string) => {
    await page.goto(new URL(pathname, baseUrl).toString(), { waitUntil: "networkidle" });
    const file = path.join(dir, `${name}.pdf`);
    const buffer = await page.pdf({ path: file, ...A4_PRINT });
    return { file: path.relative(repoRoot, file), pages: countPdfPages(buffer.toString("latin1")) };
  };
  try {
    return {
      screens,
      reportPdf: await pdfOf(`report-${handle}`, `/evaluations/${evaluationId}/report`),
      kitPdf: await pdfOf(`interview-kit-${handle}`, `/evaluations/${evaluationId}/interview-kit`),
    };
  } finally {
    await context.close();
  }
}

// ── 실행 ───────────────────────────────────────────────────────────────────────

export interface PersonaRun {
  handle: string;
  submissionId: string | null;
  evaluationId: string | null;
  status: string;
  waitMs: number;
  comparison: PersonaComparison | null;
  error: string | null;
  /** 저장된 키트 원본 (기록의 키트 전문에 쓴다) */
  kit: InterviewKit | null;
  kitError: string | null;
  reportError: string | null;
  /** 채용 리포트·인터뷰 키트 인쇄 캡처 (T-708) */
  docs: PersonaDocCapture | null;
}

/** 페르소나별 채용 리포트·인터뷰 키트 화면 캡처와 PDF 쪽 수 (T-708) */
export interface PersonaDocCapture {
  screens: ScreenCheck[];
  reportPdf: { file: string; pages: number } | null;
  kitPdf: { file: string; pages: number } | null;
}

export interface PersonaGateSummary {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  matrixPath: string;
  rubricVersion: string | null;
  runs: PersonaRun[];
  screens: ScreenCheck[];
  ok: boolean;
}

export interface PersonaGateOptions {
  baseUrl: string;
  password: string | null;
  handles: string[];
  matrixPath: string;
  screenshotsDir: string | null;
  /** 페르소나별 채용 리포트·인터뷰 키트 캡처를 둘 디렉터리 (T-708). null이면 캡처하지 않는다 */
  docsDir: string | null;
  timeoutMs: number;
  pollMs: number;
  /** 이미 제출한 페르소나의 제출 ID. 있으면 폼으로 다시 제출하지 않고 결과만 기다려 대조한다 */
  existingSubmissions?: Record<string, string>;
  log: (line: string) => void;
}

export async function runPersonaGate(options: PersonaGateOptions): Promise<PersonaGateSummary> {
  const startedAtMs = Date.now();
  const { log } = options;
  const matrix = PersonaMatrixSchema.parse(JSON.parse(await readFile(options.matrixPath, "utf8")));
  const client = new GateClient(options.baseUrl);
  if (options.password) await client.login(options.password);

  const browser = await chromium.launch();
  const runs: PersonaRun[] = [];
  let screens: ScreenCheck[] = [];
  let rubricVersion: string | null = null;
  try {
    const submitted: { handle: string; submissionId: string }[] = [];
    for (const handle of options.handles) {
      const expected = matrix.personas[handle];
      if (!expected) throw new Error(`기대값에 없는 페르소나: ${handle}`);
      const existing = options.existingSubmissions?.[handle];
      if (existing) {
        log(`기존 제출 ${handle}: ${existing} (다시 제출하지 않음)`);
        submitted.push({ handle, submissionId: existing });
        continue;
      }
      const shot = options.screenshotsDir
        ? path.join(options.screenshotsDir, `00-submit-form-${handle}.png`)
        : null;
      if (shot) await mkdir(path.dirname(shot), { recursive: true });
      const submissionId = await submitViaForm(browser, options.baseUrl, matrix, expected, shot);
      log(`제출 ${handle}: ${expected.repoUrl}@${expected.sha.slice(0, 7)} → ${submissionId}`);
      submitted.push({ handle, submissionId });
    }

    for (const { handle, submissionId } of submitted) {
      const run: PersonaRun = {
        handle,
        submissionId,
        evaluationId: null,
        status: "UNKNOWN",
        waitMs: 0,
        comparison: null,
        error: null,
        kit: null,
        kitError: null,
        reportError: null,
        docs: null,
      };
      runs.push(run);
      try {
        const summary = await waitForTerminal(
          client,
          submissionId,
          options.timeoutMs,
          options.pollMs,
        );
        run.status = summary.status;
        // 제출 시각 → 평가 종료 시각. 기존 제출을 대조할 때도 실제 채점 시간이 남는다
        const finishedAt = summary.latestEvaluation?.finishedAt ?? summary.updatedAt;
        run.waitMs = Date.parse(finishedAt) - Date.parse(summary.createdAt);
        run.evaluationId = summary.latestEvaluation?.id ?? null;
        log(`종료 ${handle}: ${summary.status} (${(run.waitMs / 1000).toFixed(0)}s)`);
        if (summary.status !== "COMPLETED" || !run.evaluationId) {
          run.error = `제출이 COMPLETED가 아님: ${summary.status}${summary.unsupportedReason ? ` (${summary.unsupportedReason})` : ""}`;
          continue;
        }
        const report = unwrap(
          await client.getJson(
            `/api/evaluations/${run.evaluationId}`,
            EvaluationReportResponseSchema,
          ),
          `GET /api/evaluations/${run.evaluationId}`,
        );
        const context = unwrap(
          await client.getJson(
            `/api/evaluations/${run.evaluationId}/context`,
            EvaluationContextReportResponseSchema,
          ),
          `GET /api/evaluations/${run.evaluationId}/context`,
        );
        rubricVersion = report.evaluation.rubricVersion;
        const facts = factsOf(report, context);
        // 인터뷰 키트(T-704)와 채용 리포트(T-705). 조회가 실패하면 대조에서 불일치로 남긴다
        try {
          const kitReport = unwrap(
            await client.getJson(
              `/api/evaluations/${run.evaluationId}/interview-kit`,
              InterviewKitReportResponseSchema,
            ),
            `GET /api/evaluations/${run.evaluationId}/interview-kit`,
          );
          run.kit = kitReport.kit;
          facts.kit = kitFactsOf(kitReport.kit);
        } catch (error) {
          run.kitError = error instanceof Error ? error.message : String(error);
        }
        try {
          const hiring = unwrap(
            await client.getJson(
              `/api/evaluations/${run.evaluationId}/hiring-report`,
              HiringReportResponseSchema,
            ),
            `GET /api/evaluations/${run.evaluationId}/hiring-report`,
          );
          facts.report = reportFactsOf(hiring, run.kit);
        } catch (error) {
          run.reportError = error instanceof Error ? error.message : String(error);
        }
        const comparison = comparePersona(
          matrix,
          handle,
          new Map(report.rubric.criteria.map((c) => [c.id, c.maxPoints])),
          facts,
        );
        if (report.evaluation.rubricVersion !== matrix.rubricVersion) {
          comparison.mismatches.push(
            `rubric 버전: 기대 ${matrix.rubricVersion}, 실제 ${report.evaluation.rubricVersion}`,
          );
        }
        if (report.evaluation.submissionSha !== matrix.personas[handle]!.sha) {
          comparison.mismatches.push(
            `평가 SHA가 제출 SHA와 다름: ${report.evaluation.submissionSha}`,
          );
        }
        run.comparison = comparison;
      } catch (error) {
        run.error = error instanceof Error ? error.message : String(error);
      }
    }

    const target =
      runs.find((r) => r.handle === "dohyun" && r.evaluationId) ?? runs.find((r) => r.evaluationId);
    if (options.screenshotsDir && target?.submissionId && target.evaluationId) {
      screens = await captureScreens(browser, options.baseUrl, options.screenshotsDir, {
        submissionId: target.submissionId,
        evaluationId: target.evaluationId,
      });
    }
    if (options.docsDir) {
      for (const run of runs) {
        if (!run.evaluationId) continue;
        run.docs = await capturePersonaDocs(
          browser,
          options.baseUrl,
          options.docsDir,
          run.handle,
          run.evaluationId,
        );
        log(
          `문서 캡처 ${run.handle}: 리포트 ${run.docs.reportPdf?.pages ?? "-"}쪽, 키트 ${run.docs.kitPdf?.pages ?? "-"}쪽`,
        );
      }
    }
  } finally {
    await browser.close();
  }

  const ok =
    runs.length === options.handles.length &&
    runs.every(
      (r) => r.status === "COMPLETED" && !r.error && r.comparison?.mismatches.length === 0,
    ) &&
    screens.every((s) => s.problems.length === 0) &&
    runs.every((r) => (r.docs?.screens ?? []).every((s) => s.problems.length === 0));
  const finishedAtMs = Date.now();
  return {
    baseUrl: options.baseUrl,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    totalMs: finishedAtMs - startedAtMs,
    matrixPath: path.relative(repoRoot, options.matrixPath),
    rubricVersion,
    runs,
    screens,
    ok,
  };
}

// ── 기록 ───────────────────────────────────────────────────────────────────────

function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function renderPersonaReport(matrix: PersonaMatrix, summary: PersonaGateSummary): string {
  const lines: string[] = [];
  const ids = Object.keys(matrix.personas[summary.runs[0]?.handle ?? ""]?.criteria ?? {});
  lines.push("# 6단계 게이트: 페르소나 4종 배포 환경 회귀 (T-606)");
  lines.push("");
  lines.push(
    "`pnpm gate:personas`가 만든 기록이다. 배포된 웹의 제출 폼(`/submissions/new`)에 페르소나의 과제 저장소 URL·커밋 SHA·이력서 PDF·GitHub 프로필 URL을 넣어 제출하고, Railway 워커가 채점·맥락 연결한 결과를 조회 API(`/api/evaluations/[id]`, `/api/evaluations/[id]/context`)로 읽어 `samples/personas/expected-matrix.json`과 대조한다. 실패 조건은 기준별 판정·점수, 변이 결과, 점수 표시, 단계 상태, REVIEW_WRITE의 LLM 결과와 R-12 초안, GitHub 근거 선정·커밋 수집, 후속 질문 존재다. 주장 상태 라벨은 LLM 판단이라 경고로만 적는다.",
  );
  lines.push("");
  lines.push(`- 결과: **${summary.ok ? "통과" : "실패"}**`);
  lines.push(`- 배포: ${summary.baseUrl}`);
  lines.push(
    `- 실행 일시: ${summary.startedAt} ~ ${summary.finishedAt} (총 ${(summary.totalMs / 1000 / 60).toFixed(1)}분)`,
  );
  lines.push(`- rubric: \`${summary.rubricVersion ?? "-"}\` · 기대값: \`${summary.matrixPath}\``);
  lines.push("");
  lines.push("## 제출");
  lines.push("");
  lines.push("| 페르소나 | 저장소 @ SHA | 제출 ID | 평가 ID | 상태 | 제출→종료 | 불일치 | 경고 |");
  lines.push("|---|---|---|---|---|---:|---:|---:|");
  for (const r of summary.runs) {
    const p = matrix.personas[r.handle]!;
    lines.push(
      `| ${r.handle} | ${repoNameOf(p.repoUrl)} @ \`${p.sha.slice(0, 7)}\` | ${r.submissionId ? `\`${r.submissionId}\`` : "-"} | ${r.evaluationId ? `[\`${r.evaluationId}\`](${new URL(`/evaluations/${r.evaluationId}`, summary.baseUrl).toString()})` : "-"} | ${r.status} | ${(r.waitMs / 1000).toFixed(0)}s | ${r.comparison ? r.comparison.mismatches.length : "-"} | ${r.comparison ? r.comparison.warnings.length : "-"} |`,
    );
  }
  lines.push("");
  lines.push("## 기준별 판정 (기대 → 실제)");
  lines.push("");
  lines.push(`| 기준 | ${summary.runs.map((r) => r.handle).join(" | ")} |`);
  lines.push(`|---|${summary.runs.map(() => "---").join("|")}|`);
  for (const id of ids) {
    const cells = summary.runs.map((r) => {
      const exp = matrix.personas[r.handle]!.criteria[id] ?? "?";
      const act = r.comparison?.facts.criteria[id];
      if (!act) return `${exp} → 없음`;
      return `${exp} → ${act.verdict}${act.earnedPoints === null ? "" : ` ${act.earnedPoints}`} ${act.verdict === exp ? "✓" : "✗"}`;
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  lines.push(
    `| 점수 | ${summary.runs
      .map((r) => {
        const exp = matrix.personas[r.handle]!.scoreDisplay;
        const act = r.comparison?.facts.scoreDisplay ?? "없음";
        return `${exp} → ${act} ${exp === act ? "✓" : "✗"}`;
      })
      .join(" | ")} |`,
  );
  lines.push("");
  lines.push("## 변이 결과 (기대 → 실제)");
  lines.push("");
  lines.push(`| 변이 | ${summary.runs.map((r) => r.handle).join(" | ")} |`);
  lines.push(`|---|${summary.runs.map(() => "---").join("|")}|`);
  for (const id of ["M-01", "M-02", "M-03", "M-04", "M-05"]) {
    const cells = summary.runs.map((r) => {
      const exp = matrix.personas[r.handle]!.mutations[id] ?? "?";
      const act = r.comparison?.facts.mutations[id];
      return act ? `${exp} → ${act.outcome} ${act.outcome === exp ? "✓" : "✗"}` : `${exp} → 없음`;
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  const notes = summary.runs.flatMap((r) =>
    Object.entries(matrix.personas[r.handle]!.mutationNotes).map(
      ([id, note]) =>
        `- ${r.handle} ${id}: ${note}${r.comparison?.facts.mutations[id]?.reason ? ` · 워커 사유: ${oneLine(r.comparison.facts.mutations[id].reason, 200)}` : ""}`,
    ),
  );
  if (notes.length > 0) {
    lines.push(...notes);
    lines.push("");
  }
  lines.push("## GitHub 근거 선정");
  lines.push("");
  lines.push(
    "| 페르소나 | 상태 · 선정 방식 | 선택된 저장소 (커밋·병합 PR·작성자 조건) | 제외한 제출 저장소 |",
  );
  lines.push("|---|---|---|---|");
  for (const r of summary.runs) {
    const g = r.comparison?.facts.github;
    lines.push(
      `| ${r.handle} | ${g ? `${g.status ?? "-"} · ${g.selection ?? "-"}` : "-"} | ${g ? g.repos.map((x) => `\`${x.fullName}\` (${x.commits}·${x.mergedPulls}·${x.authorFilter ?? "-"})`).join(", ") : "-"} | ${g ? g.excludedRepos.map((x) => `\`${x}\``).join(", ") || "-" : "-"} |`,
    );
  }
  lines.push("");
  lines.push("## 단계 · REVIEW_WRITE · R-12 초안");
  lines.push("");
  lines.push("| 페르소나 | 단계 | REVIEW_WRITE LLM | R-12 초안 |");
  lines.push("|---|---|---|---|");
  for (const r of summary.runs) {
    const f = r.comparison?.facts;
    lines.push(
      `| ${r.handle} | ${f ? STAGES.map((s) => `${s} ${f.stages[s] ?? "-"}`).join(" · ") : "-"} | ${f?.reviewWrite.llm ?? "-"} | ${f?.reviewWrite.r12Draft ? `${f.reviewWrite.r12Draft.suggestedPoints ?? "?"}/${f.reviewWrite.r12Draft.maxPoints ?? "?"}` : "없음"} |`,
    );
  }
  lines.push("");
  for (const r of summary.runs) {
    const draft = r.comparison?.facts.reviewWrite.r12Draft;
    if (draft) lines.push(`- ${r.handle} R-12 초안 근거: ${oneLine(draft.rationale, 1200)}`);
  }
  lines.push("");
  lines.push("## 맥락 연결과 후속 질문");
  lines.push("");
  for (const r of summary.runs) {
    const links = r.comparison?.facts.links ?? [];
    lines.push(`### ${r.handle}`);
    lines.push("");
    if (links.length === 0) {
      lines.push("연결 없음");
    } else {
      lines.push("| 주장 | 상태 | 관측 기준 | 후속 질문 |");
      lines.push("|---|---|---|---|");
      for (const l of links) {
        lines.push(
          `| ${oneLine(l.claim, 160)} | ${l.status} | ${l.criterionId ?? "-"} | ${l.followUpQuestion ? oneLine(l.followUpQuestion, 300) : "-"} |`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## 불일치");
  lines.push("");
  const mismatches = summary.runs.flatMap((r) => [
    ...(r.comparison?.mismatches ?? []).map((m) => `- ${r.handle}: ${m}`),
    ...(r.error ? [`- ${r.handle}: ${r.error}`] : []),
  ]);
  lines.push(mismatches.length === 0 ? "없음" : mismatches.join("\n"));
  lines.push("");
  lines.push("## 경고 (주장 상태 라벨, 실패 조건 아님)");
  lines.push("");
  const warnings = summary.runs.flatMap((r) =>
    (r.comparison?.warnings ?? []).map((w) => `- ${r.handle}: ${w}`),
  );
  lines.push(warnings.length === 0 ? "없음" : warnings.join("\n"));
  lines.push("");
  lines.push("## 화면 캡처");
  lines.push("");
  if (summary.screens.length === 0) {
    lines.push("캡처하지 않음");
  } else {
    lines.push(
      "데스크톱 1440×900, 모바일 iPhone 13(390×844) 전체 페이지 캡처다. 자동 점검: HTTP 상태, 가로 넘침, 오류 화면 문구, 콘솔 오류.",
    );
    lines.push("");
    lines.push("| 화면 | 뷰포트 | HTTP | 가로 넘침 | 콘솔 오류 | 파일 | 문제 |");
    lines.push("|---|---|---:|---:|---:|---|---|");
    for (const s of summary.screens) {
      lines.push(
        `| ${s.name} | ${s.viewport} | ${s.status ?? "-"} | ${s.horizontalOverflowPx}px | ${s.consoleErrors.length} | \`${s.file}\` | ${s.problems.join(", ") || "없음"} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 7단계 게이트 기록 (T-708): 페르소나별 키트 전문(질문·의도·꼬리 질문·신호·근거), 채용 리포트 캡처와 PDF 쪽 수,
 * 버린 항목 통계, 면접관 검토표. 6단계 기록(`docs/gates/personas.md`)이 판정·변이·맥락 연결을 담고, 이 기록은 키트와 리포트를 담는다.
 */
export function renderStage7Report(matrix: PersonaMatrix, summary: PersonaGateSummary): string {
  const lines: string[] = [];
  lines.push("# 7단계 게이트: 페르소나 4종의 키트·리포트 회귀 (T-708)");
  lines.push("");
  lines.push(
    "`pnpm gate:personas`가 만든 기록이다. 배포 환경에 페르소나 4종을 제출해 실제 LLM으로 인터뷰 키트(T-702·T-704)와 채용 리포트(T-705·T-706)를 만들고, 키트의 질문 슬롯·우선순위·유형별 질문 수를 `samples/personas/expected-matrix.json`의 기대값과 대조한다. 질문은 모두 결정적 검사(`lintInterviewQuestion`)를 통과하고 저장된 근거를 하나 이상 참조해야 하며, 리포트의 판정·점수는 워크벤치(평가 조회 API)의 값과 같아야 하고 시스템이 쓴 문장에 금지 표현(PRD 14.4)이 없어야 한다. 기본 질문 대체와 버린 LLM 출력은 품질 관찰이라 경고로 남긴다.",
    "",
    "이 파일은 게이트를 돌릴 때마다 덮어쓴다. 8단계(T-801·T-802) 개선의 전후 비교는 [`docs/gates/stage8.md`](stage8.md)에 있다.",
  );
  lines.push("");
  lines.push(`- 결과: **${summary.ok ? "통과" : "실패"}**`);
  lines.push(`- 배포: ${summary.baseUrl}`);
  lines.push(`- 실행 일시: ${summary.startedAt} ~ ${summary.finishedAt}`);
  lines.push(`- rubric: \`${summary.rubricVersion ?? "-"}\``);
  lines.push("");
  lines.push("## 키트 생성 요약");
  lines.push("");
  lines.push(
    "| 페르소나 | 평가 | 질문 수 | 기본 질문 대체 | LLM | 모델 · 프롬프트 | 버린 항목 | 진행안(45·60분) |",
  );
  lines.push("|---|---|---:|---:|---|---|---|---|");
  for (const r of summary.runs) {
    const k = r.comparison?.facts.kit;
    lines.push(
      `| ${r.handle} | ${r.evaluationId ? `[\`${r.evaluationId.slice(0, 8)}\`](${new URL(`/evaluations/${r.evaluationId}`, summary.baseUrl).toString()})` : "-"} | ${k?.questions.length ?? "-"} | ${k ? `${k.templateCount}/${k.slotCount}` : "-"} | ${k?.llm ?? "-"} | ${k ? `${k.model ?? "-"} · ${k.promptVersion}` : "-"} | ${k ? (k.dropped.length === 0 ? "없음" : k.dropped.map((d) => `${d.slotId ?? `#${d.index ?? "?"}`} ${d.reason}`).join(", ")) : "-"} | ${k ? k.plans.map((p) => `${p.durationMinutes}분 ${p.totalMinutes}분·${p.questionCount}문`).join(" / ") : "-"} |`,
    );
  }
  lines.push("");
  lines.push("## 채용 리포트");
  lines.push("");
  lines.push(
    "| 페르소나 | 점수 표시(워크벤치 = 리포트) | 판정 분포 | 필수 질문 | 이력서 연결 | 설계 검토 | PDF 쪽 수 (리포트 / 키트) | 금지 표현 |",
  );
  lines.push("|---|---|---|---:|---|---|---|---|");
  for (const r of summary.runs) {
    const rep = r.comparison?.facts.report;
    const counts = rep
      ? Object.entries(rep.verdictCounts)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ")
      : "-";
    lines.push(
      `| ${r.handle} | ${rep?.scoreDisplay ?? "-"} | ${counts} | ${rep?.mustQuestions.length ?? "-"} | ${rep ? `${rep.resumeLinksStatus} ${rep.resumeLinkCount}건` : "-"} | ${rep?.designReviewStatus ?? "-"} | ${r.docs ? `${r.docs.reportPdf?.pages ?? "-"} / ${r.docs.kitPdf?.pages ?? "-"}` : "-"} | ${rep ? (rep.forbidden.length === 0 ? "0건" : rep.forbidden.join(", ")) : "-"} |`,
    );
  }
  lines.push("");
  const docScreens = summary.runs.flatMap((r) => r.docs?.screens ?? []);
  if (docScreens.length > 0) {
    lines.push("### 화면 캡처 (채용 리포트 · 인터뷰 키트)");
    lines.push("");
    lines.push("| 화면 | 뷰포트 | HTTP | 가로 넘침 | 콘솔 오류 | 파일 | 문제 |");
    lines.push("|---|---|---:|---:|---:|---|---|");
    for (const s of docScreens) {
      lines.push(
        `| ${s.name} | ${s.viewport} | ${s.status ?? "-"} | ${s.horizontalOverflowPx}px | ${s.consoleErrors.length} | \`${s.file}\` | ${s.problems.join(", ") || "없음"} |`,
      );
    }
    lines.push("");
  }
  lines.push("## 페르소나별 키트 전문");
  lines.push("");
  for (const r of summary.runs) {
    const kit = r.comparison?.facts.kit;
    const persona = matrix.personas[r.handle];
    lines.push(`### ${r.handle}${persona ? ` · ${repoNameOf(persona.repoUrl)}` : ""}`);
    lines.push("");
    if (!kit) {
      lines.push(`키트 없음${r.kitError ? ` (${r.kitError})` : ""}`);
      lines.push("");
      continue;
    }
    for (const q of kit.questions) {
      lines.push(
        `#### Q${q.number}. ${q.question} <sub>${INTERVIEW_QUESTION_KIND_LABELS[q.kind as keyof typeof INTERVIEW_QUESTION_KIND_LABELS] ?? q.kind} · ${q.priority} · ${q.minutes}분 · ${q.competency} · ${q.source}</sub>`,
      );
      lines.push("");
      lines.push(`- 슬롯: \`${q.id}\``);
      lines.push(`- 의도: ${q.intent}`);
      lines.push(`- 꼬리 질문: ${q.probes.map((p) => `${p}`).join(" / ")}`);
      lines.push(`- 좋은 답변의 신호: ${q.positiveSignals.join(" / ")}`);
      lines.push(`- 우려 신호: ${q.concernSignals.join(" / ")}`);
      lines.push(`- 근거: ${q.refs.join(", ")}`);
      lines.push("");
    }
  }
  lines.push("## 면접관 검토표 (사람 확인)");
  lines.push("");
  lines.push(
    '기술 면접관이 필수 질문을 읽고 "그대로 면접에 쓸 수 있는가"를 질문별로 표시한다. 고칠 점이 있으면 메모에 적는다.',
  );
  lines.push("");
  lines.push("| 페르소나 | 질문 | 유형 | 그대로 쓸 수 있는가 (예/아니오) | 메모 |");
  lines.push("|---|---|---|---|---|");
  for (const r of summary.runs) {
    for (const q of (r.comparison?.facts.kit?.questions ?? []).filter(
      (q) => q.priority === "MUST",
    )) {
      lines.push(
        `| ${r.handle} | Q${q.number}. ${oneLine(q.question, 200)} | ${INTERVIEW_QUESTION_KIND_LABELS[q.kind as keyof typeof INTERVIEW_QUESTION_KIND_LABELS] ?? q.kind} |  |  |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function personaGateJson(summary: PersonaGateSummary): unknown {
  return {
    ok: summary.ok,
    baseUrl: summary.baseUrl,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    rubricVersion: summary.rubricVersion,
    runs: summary.runs.map((r) => ({
      handle: r.handle,
      submissionId: r.submissionId,
      evaluationId: r.evaluationId,
      status: r.status,
      waitMs: r.waitMs,
      mismatches: r.comparison?.mismatches ?? [],
      warnings: r.comparison?.warnings ?? [],
      error: r.error,
      kitError: r.kitError,
      reportError: r.reportError,
      docs: r.docs,
      facts: r.comparison?.facts ?? null,
    })),
    screens: summary.screens,
  };
}

/** `seojin=<uuid>,dohyun=<uuid>` → { seojin, dohyun }. 형식이 틀리면 null */
export function parseExistingSubmissions(text: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const part of text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const match = /^([a-z]+)=([0-9a-f-]{36})$/.exec(part);
    if (!match) return null;
    result[match[1]!] = match[2]!;
  }
  return result;
}

function usage(): never {
  console.error(
    "사용법: gate:personas --base-url <url> [--password <pw>] [--personas seojin,taeyun,gaeun,dohyun] [--matrix <path>] [--out <file>] [--json <file>] [--screenshots <dir>] [--stage7 <file>] [--stage7-docs <dir>] [--skip-screenshots] [--timeout-ms <ms>] [--poll-ms <ms>] [--submissions handle=<id>,...]",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "base-url": { type: "string" },
      password: { type: "string" },
      personas: { type: "string" },
      matrix: { type: "string", default: DEFAULT_MATRIX },
      out: { type: "string", default: DEFAULT_OUT },
      json: { type: "string", default: DEFAULT_JSON_OUT },
      screenshots: { type: "string", default: DEFAULT_SCREENSHOTS },
      "skip-screenshots": { type: "boolean", default: false },
      stage7: { type: "string", default: DEFAULT_STAGE7_OUT },
      "stage7-docs": { type: "string", default: DEFAULT_STAGE7_DOCS },
      "timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
      "poll-ms": { type: "string", default: String(DEFAULT_POLL_MS) },
      submissions: { type: "string" },
    },
    strict: true,
  });
  const baseUrl = values["base-url"];
  if (!baseUrl) usage();
  const timeoutMs = Number(values["timeout-ms"]);
  const pollMs = Number(values["poll-ms"]);
  if (![timeoutMs, pollMs].every((n) => Number.isInteger(n) && n > 0)) usage();
  const matrixPath = path.resolve(values.matrix);
  const matrix = PersonaMatrixSchema.parse(JSON.parse(await readFile(matrixPath, "utf8")));
  const handles = values.personas
    ? values.personas
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : Object.keys(matrix.personas);
  if (handles.length === 0 || handles.some((h) => !(h in matrix.personas))) usage();
  const password = values.password ?? process.env.APP_ACCESS_PASSWORD ?? null;
  const existingSubmissions = parseExistingSubmissions(values.submissions ?? "");
  if (!existingSubmissions || Object.keys(existingSubmissions).some((h) => !handles.includes(h))) {
    usage();
  }

  console.log(`gate:personas 시작 — ${baseUrl}, 페르소나 ${handles.join(", ")}`);
  const summary = await runPersonaGate({
    baseUrl,
    password,
    handles,
    matrixPath,
    screenshotsDir: values["skip-screenshots"] ? null : path.resolve(values.screenshots),
    docsDir: values["skip-screenshots"] ? null : path.resolve(values["stage7-docs"]),
    timeoutMs,
    pollMs,
    existingSubmissions,
    log: (line) => console.log(`  ${line}`),
  });

  for (const r of summary.runs) {
    for (const m of r.comparison?.mismatches ?? []) console.error(`  불일치 ${r.handle}: ${m}`);
    for (const w of r.comparison?.warnings ?? []) console.log(`  경고 ${r.handle}: ${w}`);
    if (r.error) console.error(`  오류 ${r.handle}: ${r.error}`);
  }
  for (const s of summary.screens) {
    if (s.problems.length > 0)
      console.error(`  화면 ${s.name} ${s.viewport}: ${s.problems.join(", ")}`);
  }

  const outPath = path.resolve(values.out);
  const markdown = await prettierFormat(`${renderPersonaReport(matrix, summary)}\n`, {
    ...((await prettierResolveConfig(outPath)) ?? {}),
    parser: "markdown",
  });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, markdown, "utf8");
  const stage7Path = path.resolve(values.stage7);
  const stage7Markdown = await prettierFormat(`${renderStage7Report(matrix, summary)}\n`, {
    ...((await prettierResolveConfig(stage7Path)) ?? {}),
    parser: "markdown",
  });
  await mkdir(path.dirname(stage7Path), { recursive: true });
  await writeFile(stage7Path, stage7Markdown, "utf8");
  const jsonPath = path.resolve(values.json);
  const json = await prettierFormat(JSON.stringify(personaGateJson(summary)), {
    ...((await prettierResolveConfig(jsonPath)) ?? {}),
    parser: "json",
  });
  await writeFile(jsonPath, json, "utf8");
  console.log(
    `gate:personas ${summary.ok ? "OK" : "실패"} — ${(summary.totalMs / 1000 / 60).toFixed(1)}분, 기록 ${path.relative(process.cwd(), outPath)}, 7단계 기록 ${path.relative(process.cwd(), stage7Path)}, 요약 ${path.relative(process.cwd(), jsonPath)}`,
  );
  process.exit(summary.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`gate:personas 오류: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
  });
}
