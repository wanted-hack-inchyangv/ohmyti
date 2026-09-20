import {
  evaluateSubmissionDedupeKey,
  isBootstrapApprovalPendingReview,
  ValidationResultSchema,
  type AssignmentVersionStatus,
} from "@ohmyti/core";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "./client";
import type { JobRow } from "./queue";
import {
  assignmentVersions,
  evaluations,
  jobs,
  submissionContext,
  submissions,
  validationSamples,
} from "./schema";

/**
 * 샘플 체험 (TICKET.md T-505, PRD 7장 데모 데이터 원칙).
 *
 * - `listSavedDemoEvaluations`: 샘플(A·B·C·D)마다 가장 최근에 끝난 평가. `/demo`가 `저장된 실행 · <시각>`으로 보여 준다.
 *   완료(COMPLETED)된 제출의 끝난 평가만 저장된 실행이다. 실패·진행 중인 새 실행은 저장된 실행이 아니다.
 * - `findSubmissionJob`·`hasLiveWorker`: 새 실행 화면이 "워커가 작업을 시작하지 않았다"를 판단할 근거.
 * - `readRubricApproval`: 헤더의 `채점기 사전 검증 완료` 배지. 버전 행에 기록된 승인·검증 결과만 옮긴다.
 */

export const DEMO_SAMPLE_IDS = ["A", "B", "C", "D"] as const;
export type DemoSampleId = (typeof DEMO_SAMPLE_IDS)[number];

export function isDemoSampleId(value: unknown): value is DemoSampleId {
  return typeof value === "string" && (DEMO_SAMPLE_IDS as readonly string[]).includes(value);
}

export interface SavedDemoEvaluation {
  demoSampleId: DemoSampleId;
  evaluationId: string;
  submissionId: string;
  assignmentVersionId: string;
  rubricVersion: string;
  submissionSha: string;
  repoUrl: string;
  finishedAt: Date;
  scoreEarned: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  pendingPoints: number | null;
}

const savedColumns = {
  demoSampleId: submissions.demoSampleId,
  evaluationId: evaluations.id,
  submissionId: submissions.id,
  assignmentVersionId: evaluations.assignmentVersionId,
  rubricVersion: evaluations.rubricVersion,
  submissionSha: evaluations.submissionSha,
  repoUrl: submissions.repoUrl,
  finishedAt: evaluations.finishedAt,
  scoreEarned: evaluations.scoreEarned,
  scoreMin: evaluations.scoreMin,
  scoreMax: evaluations.scoreMax,
  pendingPoints: evaluations.pendingPoints,
};

const savedConditions = [
  isNotNull(submissions.demoSampleId),
  eq(submissions.status, "COMPLETED"),
  isNull(submissions.deletedAt),
  isNotNull(evaluations.finishedAt),
];

type SavedRow = { [K in keyof typeof savedColumns]: unknown };

function toSaved(row: SavedRow): SavedDemoEvaluation | null {
  if (!isDemoSampleId(row.demoSampleId) || !(row.finishedAt instanceof Date)) return null;
  return {
    ...(row as Omit<SavedDemoEvaluation, "demoSampleId" | "finishedAt">),
    demoSampleId: row.demoSampleId,
    finishedAt: row.finishedAt,
  };
}

/** 샘플마다 가장 최근에 끝난 평가 (완료된 제출만). 없는 샘플은 맵에 없다 */
export async function listSavedDemoEvaluations(
  db: Database,
): Promise<Map<DemoSampleId, SavedDemoEvaluation>> {
  const rows = await db
    .selectDistinctOn([submissions.demoSampleId], savedColumns)
    .from(evaluations)
    .innerJoin(submissions, eq(evaluations.submissionId, submissions.id))
    .where(and(...savedConditions))
    .orderBy(submissions.demoSampleId, desc(evaluations.finishedAt), desc(evaluations.id));
  const out = new Map<DemoSampleId, SavedDemoEvaluation>();
  for (const row of rows) {
    const saved = toSaved(row);
    if (saved) out.set(saved.demoSampleId, saved);
  }
  return out;
}

/** 한 샘플의 가장 최근 저장된 실행. `excludeSubmissionId`(지금 보고 있는 새 실행)는 뺀다 */
export async function findSavedDemoEvaluation(
  db: Database,
  demoSampleId: DemoSampleId,
  options: { excludeSubmissionId?: string | undefined } = {},
): Promise<SavedDemoEvaluation | null> {
  const conditions = [...savedConditions, eq(submissions.demoSampleId, demoSampleId)];
  if (options.excludeSubmissionId) {
    conditions.push(sql`${submissions.id} <> ${options.excludeSubmissionId}`);
  }
  const [row] = await db
    .select(savedColumns)
    .from(evaluations)
    .innerJoin(submissions, eq(evaluations.submissionId, submissions.id))
    .where(and(...conditions))
    .orderBy(desc(evaluations.finishedAt), desc(evaluations.id))
    .limit(1);
  return row ? toSaved(row) : null;
}

/** 페르소나 진입점(T-905)이 찾는 저장된 실행 */
export interface PersonaEvaluation {
  evaluationId: string;
  submissionId: string;
  submissionSha: string;
  finishedAt: Date;
}

/**
 * 저장소 URL과 GitHub 프로필 로그인이 모두 같은 가장 최근 성공 실행 (T-905).
 * 평가 ID를 문서·화면에 하드코딩하지 않으려고 DB에서 찾는다. 완료된 제출의 끝난 평가만 센다.
 */
export async function findEvaluationByRepoAndProfile(
  db: Database,
  input: { repoUrl: string; githubLogin: string },
): Promise<PersonaEvaluation | null> {
  const [row] = await db
    .select({
      evaluationId: evaluations.id,
      submissionId: submissions.id,
      submissionSha: evaluations.submissionSha,
      finishedAt: evaluations.finishedAt,
    })
    .from(evaluations)
    .innerJoin(submissions, eq(evaluations.submissionId, submissions.id))
    .innerJoin(submissionContext, eq(submissionContext.submissionId, submissions.id))
    .where(
      and(
        eq(submissions.status, "COMPLETED"),
        isNull(submissions.deletedAt),
        isNotNull(evaluations.finishedAt),
        sql`lower(${submissions.repoUrl}) = lower(${input.repoUrl})`,
        sql`lower(${submissionContext.githubLogin}) = lower(${input.githubLogin})`,
      ),
    )
    .orderBy(desc(evaluations.finishedAt), desc(evaluations.id))
    .limit(1);
  if (!row || !(row.finishedAt instanceof Date)) return null;
  return { ...row, finishedAt: row.finishedAt };
}

/** 제출의 가장 최근 `EVALUATE_SUBMISSION` job */
export async function findSubmissionJob(
  db: Database,
  submissionId: string,
): Promise<JobRow | null> {
  const [row] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.dedupeKey, evaluateSubmissionDedupeKey(submissionId)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * 최근 `withinMs` 안에 진행 신호(heartbeat)를 남긴 RUNNING job이 있으면 true. 워커는 job을 처리하는 동안에만
 * 신호를 남기므로, 이것이 false라고 워커가 꺼져 있다고 단정할 수는 없다(쉬고 있을 수도 있다). 새 실행 화면은
 * "대기 중인데 다른 작업도 진행되지 않는다"는 관측으로만 쓴다
 */
export async function hasLiveWorker(
  db: Database,
  withinMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - withinMs);
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "RUNNING"), gt(jobs.heartbeatAt, since)))
    .limit(1);
  return Boolean(row);
}

/** 채점기 사전 검증 기록의 출처. 부트스트랩 시드는 1단계 게이트(`docs/gates/phase1.json`) 결과로 승인한다 */
export type RubricValidationSource = "RUBRIC_VALIDATION" | "PHASE1_GATE";

export interface RubricApproval {
  assignmentVersionId: string;
  version: number;
  status: AssignmentVersionStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  /** 저장된 검증 결과가 통과였는가. 결과가 없거나 형식을 모르면 false */
  validated: boolean;
  validationSource: RubricValidationSource | null;
  /** 검증 결과가 끝난 시각 (결과에 기록된 값) */
  validatedAt: string | null;
  samplesTotal: number;
  samplesReviewed: number;
  /** 시드 승인이고 사람의 샘플 검토 서명이 비어 있다 (T-405 `부트스트랩 승인 · 샘플 검토 대기`) */
  bootstrapPendingReview: boolean;
}

function validationOf(value: unknown): {
  validated: boolean;
  source: RubricValidationSource | null;
  at: string | null;
} {
  const parsed = ValidationResultSchema.safeParse(value);
  if (parsed.success) {
    return { validated: parsed.data.pass, source: "RUBRIC_VALIDATION", at: parsed.data.finishedAt };
  }
  if (typeof value === "object" && value !== null) {
    const gate = value as { gate?: unknown; ok?: unknown; finishedAt?: unknown };
    if (gate.gate === "phase1") {
      return {
        validated: gate.ok === true,
        source: "PHASE1_GATE",
        at: typeof gate.finishedAt === "string" ? gate.finishedAt : null,
      };
    }
  }
  return { validated: false, source: null, at: null };
}

export async function readRubricApproval(
  db: Database,
  assignmentVersionId: string,
): Promise<RubricApproval | null> {
  const [version] = await db
    .select()
    .from(assignmentVersions)
    .where(eq(assignmentVersions.id, assignmentVersionId))
    .limit(1);
  if (!version) return null;
  const samples = await db
    .select({ humanReviewedBy: validationSamples.humanReviewedBy })
    .from(validationSamples)
    .where(eq(validationSamples.assignmentVersionId, assignmentVersionId));
  const validation = validationOf(version.validationResult);
  return {
    assignmentVersionId,
    version: version.version,
    status: version.status,
    approvedBy: version.approvedBy,
    approvedAt: version.approvedAt,
    validated: validation.validated,
    validationSource: validation.source,
    validatedAt: validation.at,
    samplesTotal: samples.length,
    samplesReviewed: samples.filter((s) => s.humanReviewedBy?.trim()).length,
    bootstrapPendingReview: isBootstrapApprovalPendingReview(version, samples),
  };
}
