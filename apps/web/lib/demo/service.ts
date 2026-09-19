/**
 * 샘플 체험 (TICKET.md T-505, PRD 7장 데모 데이터 원칙).
 *
 * - `readDemoOverview`: `/demo`의 샘플 카드 4개. 샘플마다 가장 최근에 끝난 평가(`pnpm demo:seed` 또는 성공한 새 실행)를
 *   `저장된 실행 · <시각>`으로 연결한다. 점수는 평가 행에 저장된 값을 부록 C 표기로 옮기기만 한다.
 * - `startDemoRun`: `이 샘플로 새로 실행`. 저장된 샘플 스냅샷(`demo/samples/<id>/`)을 새 제출 키로 복사하고 SHA를 고정한 뒤
 *   평가 job을 넣는다. GitHub를 다시 수집하지 않으며(워커 REPO_CHECK의 스냅샷 재사용 경로), 웹은 스냅샷을 풀거나 실행하지 않는다 (G-05).
 * - `readDemoRunStatus`: 새 실행 화면의 상태. 끝나기 전에는 실행 중으로, 실패·미지원이거나 워커가 작업을 시작하지 않으면
 *   실패 사유와 이전의 저장된 실행 링크를 보인다. 실시간 성공으로 꾸미지 않는다 (PRD 7장).
 */
import { formatStoredScoreDisplay } from "@ohmyti/core";
import {
  assignmentVersions,
  createSubmission,
  DEMO_SAMPLE_IDS,
  enqueueSubmissionEvaluation,
  findLatestEvaluation,
  findSavedDemoEvaluation,
  findSubmissionJob,
  getAssignmentVersion,
  getSubmission,
  hasLiveWorker,
  isDemoSampleId,
  listSavedDemoEvaluations,
  pinSubmissionSnapshot,
  readRubricApproval,
  SubmissionRejectedError,
  upsertSubmissionContext,
  type Database,
  type DemoSampleId,
  type RubricApproval,
  type SavedDemoEvaluation,
} from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { formatSavedAt, savedRunLabel } from "./format";

export { formatSavedAt, savedRunLabel };

export interface DemoDeps {
  db: Database;
  store: ArtifactStore;
}

/** 샘플 설명. 판정 결과를 미리 적지 않고 샘플이 무엇인지만 적는다 (결과는 저장된 실행에서 본다) */
export const DEMO_SAMPLE_INFO: Record<DemoSampleId, { name: string; description: string }> = {
  A: {
    name: "정답 구현 A",
    description: "명세를 모두 구현하고 제출 테스트를 갖춘 기준 구현",
  },
  B: {
    name: "대안 정답 구현 B",
    description: "구조가 다른 올바른 구현. 구조가 달라도 같은 요구사항을 충족하는지 본다",
  },
  C: {
    name: "결함 구현 C",
    description:
      "같은 Idempotency-Key로 다시 보낸 주문에서 재고를 한 번 더 차감하는 결함이 있는 구현",
  },
  D: {
    name: "적대적 샘플 D",
    description: "C와 같은 결함에 README·주석·점수 파일로 채점을 조작하려는 문구를 넣은 샘플",
  },
};

export const DEMO_NOTICE = "준비된 샘플입니다. 결과와 숫자는 실제 실행에서 생성했습니다";

/** 새 실행 job이 이 시간 안에 시작되지 않고 진행 중인 다른 작업도 없으면 워커 응답 없음으로 본다 */
export const DEMO_RUN_START_TIMEOUT_DEFAULT_MS = 30_000;
/** 진행 중인 job의 heartbeat가 이보다 오래되면 살아 있는 워커로 보지 않는다 (`WORKER_STALE_MS` 기본값) */
export const DEMO_WORKER_STALE_MS = 60_000;

export function demoRunStartTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.DEMO_RUN_START_TIMEOUT_MS?.trim();
  if (!raw) return DEMO_RUN_START_TIMEOUT_DEFAULT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1000 ? value : DEMO_RUN_START_TIMEOUT_DEFAULT_MS;
}

/**
 * `DEMO_MODE=true`일 때만 `/demo`와 홈의 `샘플 체험` 링크를 연다(데모 배포용, `docs/deploy.md`).
 * 샘플 평가의 `저장된 실행` 배지는 이 값과 상관없이 항상 표시한다 (G-08)
 */
export function isDemoModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE?.trim().toLowerCase() === "true";
}

export interface SavedRunView {
  evaluationId: string;
  submissionId: string;
  href: string;
  label: string;
  finishedAt: string;
  /** 저장된 점수 필드의 부록 C 표기. 판정 저장 전이면 null */
  scoreDisplay: string | null;
  shortSha: string;
  rubricVersion: string;
}

function savedRunView(saved: SavedDemoEvaluation): SavedRunView {
  const score =
    saved.scoreEarned !== null &&
    saved.scoreMin !== null &&
    saved.scoreMax !== null &&
    saved.pendingPoints !== null
      ? formatStoredScoreDisplay({
          earned: saved.scoreEarned,
          min: saved.scoreMin,
          max: saved.scoreMax,
          pendingPoints: saved.pendingPoints,
        })
      : null;
  return {
    evaluationId: saved.evaluationId,
    submissionId: saved.submissionId,
    href: `/evaluations/${saved.evaluationId}`,
    label: savedRunLabel(saved.finishedAt),
    finishedAt: saved.finishedAt.toISOString(),
    scoreDisplay: score,
    shortSha: saved.submissionSha.slice(0, 12),
    rubricVersion: saved.rubricVersion,
  };
}

export interface ApprovalBadgeView {
  /** 저장된 검증 결과가 통과이고 승인된(또는 승인 뒤 RETIRED) 버전이면 true */
  validated: boolean;
  label: string;
  /** 승인자·시각·검증 출처 (배지 title) */
  detail: string;
  /** 시드 승인이라 사람의 샘플 검토 서명이 비어 있다 */
  pendingHumanReview: boolean;
}

/** 헤더 배지. 버전 행에 기록된 승인·검증 결과만 옮긴다 (T-405) */
export function approvalBadgeView(approval: RubricApproval | null): ApprovalBadgeView {
  if (!approval) {
    return {
      validated: false,
      label: "사전 검증 기록 없음",
      detail: "과제 버전을 찾을 수 없습니다",
      pendingHumanReview: false,
    };
  }
  const approved =
    (approval.status === "APPROVED" || approval.status === "RETIRED") && approval.approvedAt;
  if (!approved || !approval.validated) {
    return {
      validated: false,
      label: "사전 검증 기록 없음",
      detail: `v${approval.version} ${approval.status}: 통과한 채점기 사전 검증 결과가 없습니다`,
      pendingHumanReview: false,
    };
  }
  const source =
    approval.validationSource === "PHASE1_GATE"
      ? "1단계 게이트(샘플 A/B/C/D 판별)"
      : "채점기 사전 검증(샘플 A/B/C/D 판별)";
  return {
    validated: true,
    label: "채점기 사전 검증 완료",
    detail: [
      `v${approval.version} · ${source} 통과`,
      approval.validatedAt ? `검증 ${formatSavedAt(approval.validatedAt)}` : null,
      `승인 ${approval.approvedBy ?? "?"} · ${formatSavedAt(approval.approvedAt!)}`,
      `샘플 검토 ${approval.samplesReviewed}/${approval.samplesTotal}`,
    ]
      .filter(Boolean)
      .join(" · "),
    pendingHumanReview: approval.bootstrapPendingReview,
  };
}

export async function readApprovalBadge(
  deps: Pick<DemoDeps, "db">,
  assignmentVersionId: string,
): Promise<ApprovalBadgeView> {
  return approvalBadgeView(await readRubricApproval(deps.db, assignmentVersionId));
}

export interface DemoSampleCardView {
  id: DemoSampleId;
  name: string;
  description: string;
  saved: SavedRunView | null;
}

export interface DemoOverview {
  notice: string;
  samples: DemoSampleCardView[];
  /** 저장된 실행이 쓴 기준 버전의 승인 배지 (저장된 실행이 없으면 null) */
  approval: ApprovalBadgeView | null;
}

export async function readDemoOverview(deps: Pick<DemoDeps, "db">): Promise<DemoOverview> {
  const saved = await listSavedDemoEvaluations(deps.db);
  const samples = DEMO_SAMPLE_IDS.map((id) => {
    const item = saved.get(id);
    return {
      id,
      ...DEMO_SAMPLE_INFO[id],
      saved: item ? savedRunView(item) : null,
    };
  });
  const latest = [...saved.values()].sort(
    (a, b) => b.finishedAt.getTime() - a.finishedAt.getTime(),
  )[0];
  return {
    notice: DEMO_NOTICE,
    samples,
    approval: latest ? await readApprovalBadge(deps, latest.assignmentVersionId) : null,
  };
}

// ── 새 실행 ─────────────────────────────────────────────────────────────────────

export type DemoErrorCode =
  | "INVALID_INPUT"
  | "NO_SAVED_RUN"
  | "NO_APPROVED_VERSION"
  | "SNAPSHOT_MISSING"
  | "RUBRIC_NOT_APPROVED"
  | "VERSION_NOT_FOUND"
  | "RUN_NOT_FOUND";

export type DemoResult<T> =
  { ok: true; data: T } | { ok: false; code: DemoErrorCode; message: string };

const StoredManifestSchema = z.looseObject({ submissionSha: z.string().regex(/^[0-9a-f]{40}$/) });

/** 저장된 실행과 같은 과제의 현재 승인 버전 */
async function currentApprovedVersionId(
  db: Database,
  savedVersionId: string,
): Promise<string | null> {
  const saved = await getAssignmentVersion(db, savedVersionId);
  if (!saved) return null;
  const [row] = await db
    .select({ id: assignmentVersions.id })
    .from(assignmentVersions)
    .where(
      and(
        eq(assignmentVersions.assignmentId, saved.assignmentId),
        eq(assignmentVersions.status, "APPROVED"),
      ),
    )
    .orderBy(desc(assignmentVersions.version))
    .limit(1);
  return row?.id ?? null;
}

export interface StartedDemoRun {
  submissionId: string;
  jobId: string;
  sampleId: DemoSampleId;
}

/**
 * 저장된 샘플 스냅샷으로 새 제출을 만든다. 스냅샷·manifest·예시 이력서를 새 제출 키로 복사하고 SHA를 고정한 뒤 job을 넣는다.
 * 저장된 실행이 없으면(아직 `pnpm demo:seed` 전) 거절한다.
 */
export async function startDemoRun(
  deps: DemoDeps,
  rawSampleId: unknown,
): Promise<DemoResult<StartedDemoRun>> {
  if (!isDemoSampleId(rawSampleId)) {
    return { ok: false, code: "INVALID_INPUT", message: "샘플 ID는 A·B·C·D 중 하나입니다" };
  }
  const sampleId = rawSampleId;
  const { db, store } = deps;
  const saved = await findSavedDemoEvaluation(db, sampleId);
  if (!saved) {
    return {
      ok: false,
      code: "NO_SAVED_RUN",
      message: `샘플 ${sampleId}의 저장된 실행이 없습니다. 먼저 pnpm demo:seed로 저장된 실행을 만드세요`,
    };
  }
  const versionId = await currentApprovedVersionId(db, saved.assignmentVersionId);
  if (!versionId) {
    return {
      ok: false,
      code: "NO_APPROVED_VERSION",
      message: "샘플 과제에 승인된 기준 버전이 없습니다",
    };
  }
  const manifest = await store.get(artifactKeys.demoSampleManifest(sampleId));
  const snapshot = await store.get(artifactKeys.demoSampleSnapshot(sampleId));
  const parsed = manifest
    ? StoredManifestSchema.safeParse(JSON.parse(Buffer.from(manifest.body).toString("utf8")))
    : null;
  if (!manifest || !snapshot || !parsed?.success) {
    return {
      ok: false,
      code: "SNAPSHOT_MISSING",
      message: `샘플 ${sampleId}의 저장된 스냅샷이 스토어에 없습니다. pnpm demo:seed가 만든 스냅샷이 필요합니다`,
    };
  }
  let submission;
  try {
    submission = await createSubmission(db, {
      assignmentVersionId: versionId,
      repoUrl: saved.repoUrl,
      repoRef: parsed.data.submissionSha,
      demoSampleId: sampleId,
    });
  } catch (error) {
    if (error instanceof SubmissionRejectedError) {
      return { ok: false, code: error.reason, message: error.message };
    }
    throw error;
  }
  const snapshotRef = artifactKeys.snapshot(submission.id);
  await store.put(snapshotRef, snapshot.body, { contentType: ARTIFACT_CONTENT_TYPES.snapshot });
  await store.put(artifactKeys.snapshotManifest(submission.id), manifest.body, {
    contentType: ARTIFACT_CONTENT_TYPES.snapshotManifest,
  });
  await pinSubmissionSnapshot(db, submission.id, {
    submissionSha: parsed.data.submissionSha,
    snapshotRef,
  });
  const resume = await store.get(artifactKeys.demoResume());
  let resumeRef: string | null = null;
  if (resume) {
    resumeRef = artifactKeys.resume(submission.id);
    await store.put(resumeRef, resume.body, { contentType: ARTIFACT_CONTENT_TYPES.resume });
  }
  await upsertSubmissionContext(db, submission.id, { resumeRef, githubLogin: null });
  const job = await enqueueSubmissionEvaluation(db, submission.id);
  return { ok: true, data: { submissionId: submission.id, jobId: job.id, sampleId } };
}

export type DemoRunPhase = "WAITING" | "RUNNING" | "SUCCEEDED" | "FAILED";

export interface DemoRunStatusView {
  submissionId: string;
  sampleId: DemoSampleId;
  sampleName: string;
  phase: DemoRunPhase;
  /** 사람이 읽을 상태 문장. 진행률이 아니다 */
  message: string;
  /** 실패 사유 (FAILED일 때) */
  failureReason: string | null;
  submissionStatus: string;
  jobStatus: string | null;
  /** 지금 진행 중인 단계 (stage_log RUNNING) */
  runningStage: string | null;
  createdAt: string;
  /** 새 실행이 끝나 저장된 평가 (SUCCEEDED) */
  evaluationHref: string | null;
  /** 이전의 저장된 실행 (이 새 실행은 제외) */
  saved: SavedRunView | null;
  /** 폴링을 멈춰도 되는 상태 */
  terminal: boolean;
}

function reasonOf(parts: Array<string | null | undefined>): string {
  return (
    parts.filter((p): p is string => Boolean(p && p.trim())).join(" · ") ||
    "사유가 기록되지 않았습니다"
  );
}

export async function readDemoRunStatus(
  deps: Pick<DemoDeps, "db">,
  submissionId: string,
  options: { now?: Date; startTimeoutMs?: number } = {},
): Promise<DemoResult<DemoRunStatusView>> {
  if (!z.uuid().safeParse(submissionId).success) {
    return { ok: false, code: "INVALID_INPUT", message: "제출 ID 형식이 올바르지 않습니다" };
  }
  const { db } = deps;
  const submission = await getSubmission(db, submissionId);
  if (!submission || !isDemoSampleId(submission.demoSampleId) || submission.deletedAt) {
    return {
      ok: false,
      code: "RUN_NOT_FOUND",
      message: `샘플 새 실행을 찾을 수 없습니다: ${submissionId}`,
    };
  }
  const sampleId = submission.demoSampleId;
  const now = options.now ?? new Date();
  const startTimeoutMs = options.startTimeoutMs ?? demoRunStartTimeoutMs();
  const [job, evaluation, saved] = await Promise.all([
    findSubmissionJob(db, submissionId),
    findLatestEvaluation(db, submissionId),
    findSavedDemoEvaluation(db, sampleId, { excludeSubmissionId: submissionId }),
  ]);
  const savedView = saved ? savedRunView(saved) : null;
  const runningStage = evaluation?.stageLog.find((r) => r.state === "RUNNING")?.stage ?? null;
  const failedStage = evaluation?.stageLog.find((r) => r.state === "FAILED");

  let phase: DemoRunPhase;
  let message: string;
  let failureReason: string | null = null;
  let evaluationHref: string | null = null;
  switch (submission.status) {
    case "COMPLETED":
      phase = "SUCCEEDED";
      message = "새 실행이 끝났습니다. 결과는 이 실행에서 저장된 값입니다";
      evaluationHref = evaluation ? `/evaluations/${evaluation.id}` : null;
      break;
    case "FAILED":
      phase = "FAILED";
      message = "새 실행이 실패했습니다";
      failureReason = reasonOf([
        failedStage ? `${failedStage.stage}: ${failedStage.reason ?? "실패"}` : null,
        job?.lastError,
      ]);
      break;
    case "UNSUPPORTED":
      phase = "FAILED";
      message = "새 실행이 지원하지 않는 입력으로 끝났습니다";
      failureReason = reasonOf([submission.unsupportedReason]);
      break;
    case "DELETED":
      return {
        ok: false,
        code: "RUN_NOT_FOUND",
        message: `샘플 새 실행을 찾을 수 없습니다: ${submissionId}`,
      };
    default: {
      const waitedMs = now.getTime() - (job?.createdAt ?? submission.createdAt).getTime();
      const queued = !job || job.status === "QUEUED";
      if (job && (job.status === "FAILED" || job.status === "CANCELLED")) {
        phase = "FAILED";
        message = "새 실행 작업이 끝나지 못했습니다";
        failureReason = reasonOf([`job ${job.status}`, job.lastError]);
      } else if (
        queued &&
        waitedMs > startTimeoutMs &&
        !(await hasLiveWorker(db, DEMO_WORKER_STALE_MS, now))
      ) {
        phase = "FAILED";
        message = "새 실행을 시작하지 못했습니다";
        failureReason = `워커가 ${Math.round(startTimeoutMs / 1000)}초 안에 작업을 가져가지 않았고 진행 중인 다른 작업도 없습니다 (워커 응답 없음). 작업은 대기열에 남아 있어 워커가 돌아오면 실행됩니다`;
      } else if (queued) {
        phase = "WAITING";
        message = "워커가 작업을 가져가기를 기다리는 중입니다";
      } else {
        phase = "RUNNING";
        message = "실행 중입니다. 끝나기 전의 값은 보여 주지 않습니다";
      }
    }
  }
  return {
    ok: true,
    data: {
      submissionId,
      sampleId,
      sampleName: DEMO_SAMPLE_INFO[sampleId].name,
      phase,
      message,
      failureReason,
      submissionStatus: submission.status,
      jobStatus: job?.status ?? null,
      runningStage,
      createdAt: submission.createdAt.toISOString(),
      evaluationHref,
      saved: savedView,
      terminal:
        phase === "SUCCEEDED" ||
        (phase === "FAILED" && submission.status !== "QUEUED" && submission.status !== "RECEIVED"),
    },
  };
}
