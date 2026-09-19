/**
 * 제출·분석 화면 (TICKET.md T-206, PRD 6장 ②). 서버 액션(`actions.ts`)과 상태 API가 이 함수들을 부른다.
 *
 * - `createSubmissionWithContext`: 제출 생성 → 이력서 PDF 저장(추출은 T-501) → `submission_context` → job enqueue.
 *   이력서·GitHub 없이도 제출과 채점이 진행된다 (PRD 3장).
 * - `readSubmissionStatus`: 제출 행 + 최신 평가의 `stage_log`를 화면용 뷰로 만든다. 단계 표시는 `stage_log`만 쓴다.
 *   진행률은 계산하지 않는다 (PRD 6장 ②: 임의 진행률을 꾸미지 않는다).
 * - `retrySubmission`: 환경 장애로 FAILED인 제출을 같은 입력(고정된 SHA 포함)으로 새 제출을 만들어 다시 큐에 넣는다.
 *   FAILED는 종료 상태라 같은 행을 되돌리지 않는다 (부록 B).
 *
 * - `saveManualResumeText`: 텍스트를 추출하지 못한 이력서(IMAGE_ONLY 등)에 사람이 직접 입력한 텍스트를 MANUAL로 저장한다 (T-501).
 * - `requestDeletion`: 검토자 이름을 받아 삭제를 요청한다(T-506). 제출은 곧바로 DELETED가 되고 진행 중 job은 취소되며,
 *   워커의 `DELETE_SUBMISSION` job이 아티팩트와 행을 지운다. `readDeletionNotice`는 삭제된 제출 URL의 "삭제됨" 안내 근거다.
 *
 * 이력서 원본과 GitHub 로그인은 `submission_context`에만 쓴다. 채점 입력에는 넣지 않는다 (G-10).
 * 상태 뷰에는 이력서 본문을 넣지 않고 상태·사유·글자 수만 넣는다.
 */
import { z } from "zod";
import {
  EVALUATION_STAGE_ORDER,
  InvalidRepoUrlError,
  isCommitShaInput,
  parseGitHubProfileUrl,
  parseGitHubRepoUrl,
  type EvaluationStage,
  type EvaluationStageRecord,
  type FailureKind,
  type ResumeTextStatus,
  type StageState,
  type SubmissionStatus,
} from "@ohmyti/core";
import {
  createSubmission,
  enqueueSubmissionEvaluation,
  findLatestEvaluation,
  findSubmissionDeletion,
  getAssignment,
  getAssignmentVersion,
  getSubmission,
  getSubmissionContext,
  listAssignments,
  requestSubmissionDeletion,
  setResumeText,
  SubmissionRejectedError,
  upsertSubmissionContext,
  type SubmissionContextRow,
  type Database,
  type SubmissionRow,
} from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import { formatVersionLabel, type ActionResult } from "@/lib/assignments/service";
import { MAX_MANUAL_RESUME_CHARS } from "./resume-text";

export interface SubmissionDeps {
  db: Database;
  store: ArtifactStore;
}

/** 이력서 PDF 크기 상한 (10 MiB). `next.config.ts`의 서버 액션 본문 상한이 이보다 커야 한다 */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const PDF_MAGIC = "%PDF-";

export type SubmissionErrorCode =
  | "INVALID_INPUT"
  | "VERSION_NOT_FOUND"
  | "RUBRIC_NOT_APPROVED"
  | "SUBMISSION_NOT_FOUND"
  | "NOT_RETRYABLE"
  | "RESUME_TEXT_NOT_EDITABLE"
  | "INTERNAL";

export type SubmissionActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: SubmissionErrorCode; message: string; details?: unknown };

/** 폼 입력. 파일은 별도 인자(`ResumeUpload`)로 받는다 */
export const SubmissionFormSchema = z.strictObject({
  assignmentVersionId: z.uuid("과제를 선택하세요"),
  repoUrl: z
    .string()
    .trim()
    .min(1, "과제 저장소 URL을 입력하세요")
    .superRefine((value, ctx) => {
      try {
        parseGitHubRepoUrl(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message:
            error instanceof InvalidRepoUrlError ? error.message : "저장소 URL이 올바르지 않습니다",
        });
      }
    }),
  /** 커밋 SHA (7~40자 hex). 비우면 입력 시점의 기본 브랜치 HEAD를 고정한다 */
  commitSha: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || isCommitShaInput(value),
      "커밋 SHA는 7~40자 16진수여야 합니다",
    )
    .transform((value) => value.toLowerCase())
    .optional(),
  githubProfileUrl: z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      if (value === "") return;
      try {
        parseGitHubProfileUrl(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message:
            error instanceof InvalidRepoUrlError
              ? error.message
              : "GitHub 프로필 URL이 올바르지 않습니다",
        });
      }
    })
    .optional(),
});
export type SubmissionFormInput = z.input<typeof SubmissionFormSchema>;

export interface ResumeUpload {
  bytes: Uint8Array;
  fileName: string;
}

export function invalidInput(error: z.ZodError): SubmissionActionResult<never> {
  return {
    ok: false,
    code: "INVALID_INPUT",
    message: error.issues.map((i) => `${i.path.join(".") || "입력"}: ${i.message}`).join("; "),
    details: error.issues,
  };
}

/** PDF 서명(`%PDF-`)과 크기만 검사한다. 텍스트 추출은 T-501 */
export function validateResume(upload: ResumeUpload): SubmissionActionResult<ResumeUpload> {
  if (upload.bytes.byteLength === 0) {
    return { ok: false, code: "INVALID_INPUT", message: "이력서 파일이 비어 있습니다" };
  }
  if (upload.bytes.byteLength > MAX_RESUME_BYTES) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: `이력서 PDF는 ${MAX_RESUME_BYTES / (1024 * 1024)} MiB 이하여야 합니다`,
    };
  }
  const head = new TextDecoder("latin1").decode(upload.bytes.subarray(0, PDF_MAGIC.length));
  if (head !== PDF_MAGIC) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "이력서는 PDF 파일만 받습니다 (파일 서명이 PDF가 아닙니다)",
    };
  }
  return { ok: true, data: upload };
}

export interface CreatedSubmission {
  submissionId: string;
  jobId: string;
  resumeRef: string | null;
  githubLogin: string | null;
}

/**
 * 제출을 만들고 평가 job을 넣는다. 저장소 수집·SHA 고정은 워커(T-202)가 한다.
 * 버전이 APPROVED가 아니면 `RUBRIC_NOT_APPROVED`(함수 검사 + DB 트리거).
 */
export async function createSubmissionWithContext(
  deps: SubmissionDeps,
  rawInput: unknown,
  resume: ResumeUpload | null,
): Promise<SubmissionActionResult<CreatedSubmission>> {
  const parsed = SubmissionFormSchema.safeParse(rawInput);
  if (!parsed.success) return invalidInput(parsed.error);
  const input = parsed.data;
  if (resume) {
    const checked = validateResume(resume);
    if (!checked.ok) return checked;
  }
  const githubLogin = input.githubProfileUrl
    ? parseGitHubProfileUrl(input.githubProfileUrl).login
    : null;

  let submission: SubmissionRow;
  try {
    submission = await createSubmission(deps.db, {
      assignmentVersionId: input.assignmentVersionId,
      repoUrl: input.repoUrl,
      repoRef: input.commitSha ? input.commitSha : undefined,
    });
  } catch (error) {
    if (error instanceof SubmissionRejectedError) {
      return {
        ok: false,
        code: error.reason,
        message: error.message,
        details: { assignmentVersionId: error.assignmentVersionId, status: error.versionStatus },
      };
    }
    throw error;
  }

  let resumeRef: string | null = null;
  if (resume) {
    resumeRef = artifactKeys.resume(submission.id);
    await deps.store.put(resumeRef, resume.bytes, {
      contentType: ARTIFACT_CONTENT_TYPES.resume,
      maxBytes: MAX_RESUME_BYTES,
    });
  }
  await upsertSubmissionContext(deps.db, submission.id, { resumeRef, githubLogin });
  const enqueued = await enqueueSubmissionEvaluation(deps.db, submission.id);
  return {
    ok: true,
    data: { submissionId: submission.id, jobId: enqueued.id, resumeRef, githubLogin },
  };
}

// ── 상태 뷰 ─────────────────────────────────────────────────────────────────────

/** PRD 6장 ②의 단계 이름 */
export const STAGE_LABEL: Record<EvaluationStage, string> = {
  REPO_CHECK: "저장소 확인",
  ENV_PREP: "실행 준비",
  REQUIREMENT_VERIFY: "요구사항 검증",
  TEST_EFFECTIVENESS: "테스트 실효성",
  REVIEW_WRITE: "리뷰 작성",
  CONTEXT_LINK: "맥락 연결",
};

export const STAGE_STATE_LABEL: Record<StageState, string> = {
  PENDING: "대기",
  RUNNING: "진행 중",
  DONE: "완료",
  SKIPPED: "건너뜀",
  FAILED: "실패",
  UNSUPPORTED: "미지원",
};

export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  RECEIVED: "접수됨",
  QUEUED: "대기열",
  RUNNING: "채점 중",
  COMPLETED: "완료",
  FAILED: "실패",
  UNSUPPORTED: "미지원",
  DELETED: "삭제됨",
};

/** 폴링을 멈추는 제출 상태 */
export const TERMINAL_SUBMISSION_STATUSES: ReadonlySet<SubmissionStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "UNSUPPORTED",
  "DELETED",
]);

export function isTerminalSubmissionStatus(status: SubmissionStatus): boolean {
  return TERMINAL_SUBMISSION_STATUSES.has(status);
}

export interface UnsupportedReasonView {
  code: string;
  detail: string;
}

/** `<CODE>: <detail>; <CODE>: <detail>` 형식(T-202·T-203)을 코드와 상세로 나눈다. 형식이 아니면 코드 없이 원문 */
export function parseUnsupportedReason(reason: string | null | undefined): UnsupportedReasonView[] {
  if (!reason) return [];
  return reason
    .split(/;\s+(?=[A-Z][A-Z0-9_]+:\s)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const match = /^([A-Z][A-Z0-9_]+):\s*(.*)$/s.exec(part);
      return match ? { code: match[1]!, detail: match[2]! } : { code: "", detail: part };
    });
}

export interface StageView {
  stage: EvaluationStage;
  label: string;
  state: StageState;
  stateLabel: string;
  startedAt: string | null;
  finishedAt: string | null;
  reason: string | null;
  /** 완료된 단계의 결과 요약 (사람이 읽을 한 줄). 진행률이 아니다 */
  summary: string | null;
  /** FAILED 단계의 실패 종류 (`detail.failureKind`). 기록이 없으면 null */
  failureKind: FailureKind | null;
  /** UNSUPPORTED 단계가 남긴 사유 목록 (`detail.reasons`) */
  unsupportedReasons: UnsupportedReasonView[];
}

const FAILURE_KINDS: ReadonlySet<string> = new Set([
  "NONE",
  "ASSERTION",
  "SUBMISSION",
  "ENVIRONMENT",
  "TIMEOUT",
]);

function failureKindOf(detail: Record<string, unknown> | undefined): FailureKind | null {
  const value = detail?.["failureKind"];
  return typeof value === "string" && FAILURE_KINDS.has(value) ? (value as FailureKind) : null;
}

function unsupportedReasonsOf(
  detail: Record<string, unknown> | undefined,
): UnsupportedReasonView[] {
  const reasons = detail?.["reasons"];
  if (!Array.isArray(reasons)) return [];
  return reasons.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const { code, detail: text } = item as { code?: unknown; detail?: unknown };
    if (typeof code !== "string" || typeof text !== "string") return [];
    return [{ code, detail: text }];
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): string {
  return typeof value === "number" ? String(value) : "?";
}

/** 완료·실패한 단계의 `detail`에서 결과 요약 한 줄을 만든다. 계산·추정 없이 기록된 값만 옮긴다 */
export function summarizeStage(record: EvaluationStageRecord): string | null {
  const detail = record.detail;
  if (!detail) return null;
  const parts: string[] = [];
  switch (record.stage) {
    case "REPO_CHECK": {
      const sha = detail["submissionSha"];
      if (typeof sha === "string") parts.push(`SHA ${sha.slice(0, 12)}`);
      if (typeof detail["fileCount"] === "number") parts.push(`파일 ${detail["fileCount"]}개`);
      if (typeof detail["totalBytes"] === "number") parts.push(formatBytes(detail["totalBytes"]));
      if (detail["reused"] === true) parts.push("스냅샷 재사용");
      break;
    }
    case "ENV_PREP": {
      if (typeof detail["framework"] === "string") parts.push(`프레임워크 ${detail["framework"]}`);
      if (typeof detail["language"] === "string") parts.push(`언어 ${detail["language"]}`);
      if (typeof detail["testFramework"] === "string") {
        parts.push(`테스트 ${detail["testFramework"]}`);
      }
      const sandbox = asObject(detail["sandbox"]);
      if (sandbox && typeof sandbox["kind"] === "string") parts.push(`러너 ${sandbox["kind"]}`);
      break;
    }
    case "REQUIREMENT_VERIFY": {
      const startup = asObject(detail["startup"]);
      if (startup && typeof startup["outcome"] === "string") {
        parts.push(`기동 ${startup["outcome"]}`);
      }
      const harness = asObject(detail["harness"]);
      const summary = harness ? asObject(harness["summary"]) : null;
      if (summary) {
        parts.push(
          `하네스 통과 ${num(summary["pass"])}/${num(summary["total"])} (실패 ${num(summary["fail"])}, 미확정 ${num(summary["inconclusive"])})`,
        );
      }
      const tests = asObject(detail["tests"]);
      if (tests && typeof tests["status"] === "string") {
        const counts =
          typeof tests["total"] === "number"
            ? ` ${num(tests["passed"])}/${num(tests["total"])}`
            : "";
        parts.push(`제출 테스트 ${tests["status"]}${counts}`);
      }
      const results = asObject(detail["results"]);
      const score = results ? asObject(results["score"]) : null;
      if (score && typeof score["display"] === "string") parts.push(`점수 ${score["display"]}`);
      break;
    }
    default: {
      if (typeof detail["ticket"] === "string") parts.push(`${detail["ticket"]}에서 구현`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** `stage_log`만으로 6단계 뷰를 만든다. 기록이 없는 단계는 PENDING */
export function buildStageViews(stageLog: readonly EvaluationStageRecord[]): StageView[] {
  return EVALUATION_STAGE_ORDER.map((stage) => {
    const record = stageLog.find((r) => r.stage === stage) ?? { stage, state: "PENDING" as const };
    return {
      stage,
      label: STAGE_LABEL[stage],
      state: record.state,
      stateLabel: STAGE_STATE_LABEL[record.state],
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      reason: record.reason ?? null,
      summary: record.state === "DONE" || record.state === "FAILED" ? summarizeStage(record) : null,
      failureKind: record.state === "FAILED" ? failureKindOf(record.detail) : null,
      unsupportedReasons: record.state === "UNSUPPORTED" ? unsupportedReasonsOf(record.detail) : [],
    };
  });
}

/** 환경 장애(ENVIRONMENT·TIMEOUT, G-11)로만 실패했으면 재시도할 수 있다 */
export function isEnvironmentFailure(stageLog: readonly EvaluationStageRecord[]): boolean {
  const failed = stageLog.filter((r) => r.state === "FAILED");
  if (failed.length === 0) return false;
  return failed.every((r) => {
    const kind = failureKindOf(r.detail);
    return kind === "ENVIRONMENT" || kind === "TIMEOUT";
  });
}

export interface SubmissionStatusView {
  submission: {
    id: string;
    status: SubmissionStatus;
    statusLabel: string;
    repoUrl: string;
    repoRef: string | null;
    submissionSha: string | null;
    unsupportedReasons: UnsupportedReasonView[];
    isSample: boolean;
    createdAt: string;
    assignmentLabel: string | null;
  };
  context: { hasResume: boolean; githubLogin: string | null; resumeText: ResumeTextView };
  evaluation: { id: string; createdAt: string; finishedAt: string | null } | null;
  stages: StageView[];
  /** 폴링을 멈춰야 하는 상태 */
  terminal: boolean;
  /** FAILED이고 환경 장애로만 실패했을 때만 true */
  retryable: boolean;
  /** 평가가 없는데 FAILED면 평가 생성 전(등록 오류·환경 장애)에 끝난 것이다 */
  failureKind: FailureKind | null;
}

/** 이력서 텍스트 상태 (T-501). 본문은 담지 않는다 */
export interface ResumeTextView {
  status: ResumeTextStatus;
  /** 추출하지 못한 사유 (`RESUME_TEXT_NOT_FOUND: …` 등) */
  reason: string | null;
  /** 저장된 본문의 글자 수 */
  chars: number | null;
  /** 직접 입력란을 보여 줄지. 이력서가 있는데 텍스트를 얻지 못했거나 사람이 입력한 경우 */
  manualInputAllowed: boolean;
}

function manualInputAllowed(context: SubmissionContextRow | null): boolean {
  if (!context?.resumeRef) return false;
  const status = context.resumeTextStatus;
  return (
    status === "IMAGE_ONLY" ||
    status === "MANUAL" ||
    (status === "NONE" && !!context.resumeTextReason)
  );
}

export function resumeTextViewOf(context: SubmissionContextRow | null): ResumeTextView {
  return {
    status: context?.resumeTextStatus ?? "NONE",
    reason: context?.resumeTextReason ?? null,
    chars: context?.resumeText?.length ?? null,
    manualInputAllowed: manualInputAllowed(context),
  };
}

export async function readSubmissionStatus(
  deps: Pick<SubmissionDeps, "db">,
  submissionId: string,
): Promise<SubmissionActionResult<SubmissionStatusView>> {
  if (!z.uuid().safeParse(submissionId).success) {
    return { ok: false, code: "INVALID_INPUT", message: "제출 ID 형식이 올바르지 않습니다" };
  }
  const submission = await getSubmission(deps.db, submissionId);
  if (!submission || submission.status === "DELETED" || submission.deletedAt) {
    const deletion = await readDeletionNotice(deps, submissionId);
    return {
      ok: false,
      code: "SUBMISSION_NOT_FOUND",
      message: deletion
        ? `삭제된 제출입니다: ${submissionId}`
        : `제출을 찾을 수 없습니다: ${submissionId}`,
    };
  }
  const [evaluation, context, version] = await Promise.all([
    findLatestEvaluation(deps.db, submissionId),
    getSubmissionContext(deps.db, submissionId),
    getAssignmentVersion(deps.db, submission.assignmentVersionId),
  ]);
  const assignment = version ? await getAssignment(deps.db, version.assignmentId) : null;
  const stageLog = evaluation?.stageLog ?? [];
  const stages = buildStageViews(stageLog);
  const failedStage = stages.find((s) => s.state === "FAILED");
  const retryable =
    submission.status === "FAILED" && (evaluation === null || isEnvironmentFailure(stageLog));

  return {
    ok: true,
    data: {
      submission: {
        id: submission.id,
        status: submission.status,
        statusLabel: SUBMISSION_STATUS_LABEL[submission.status],
        repoUrl: submission.repoUrl,
        repoRef: submission.repoRef,
        submissionSha: submission.submissionSha,
        unsupportedReasons: parseUnsupportedReason(submission.unsupportedReason),
        isSample: submission.isSample,
        createdAt: submission.createdAt.toISOString(),
        assignmentLabel:
          assignment && version ? formatVersionLabel(assignment.name, version) : null,
      },
      context: {
        hasResume: Boolean(context?.resumeRef),
        githubLogin: context?.githubLogin ?? null,
        resumeText: resumeTextViewOf(context),
      },
      evaluation: evaluation
        ? {
            id: evaluation.id,
            createdAt: evaluation.createdAt.toISOString(),
            finishedAt: evaluation.finishedAt?.toISOString() ?? null,
          }
        : null,
      stages,
      terminal: isTerminalSubmissionStatus(submission.status),
      retryable,
      failureKind: failedStage?.failureKind ?? null,
    },
  };
}

/**
 * 환경 장애로 FAILED인 제출을 같은 입력으로 다시 제출한다. 고정된 SHA가 있으면 그 SHA를 `repoRef`로 두어
 * 같은 코드를 평가한다. 이력서 원본은 새 키로 복사하고 GitHub 로그인은 그대로 옮긴다.
 */
export async function retrySubmission(
  deps: SubmissionDeps,
  submissionId: string,
): Promise<SubmissionActionResult<CreatedSubmission>> {
  const status = await readSubmissionStatus(deps, submissionId);
  if (!status.ok) return status;
  if (!status.data.retryable) {
    return {
      ok: false,
      code: "NOT_RETRYABLE",
      message:
        status.data.submission.status === "FAILED"
          ? "제출 코드 탓으로 실패한 제출은 재시도하지 않습니다. 코드를 고쳐 새로 제출하세요"
          : `상태 ${status.data.submission.statusLabel}인 제출은 재시도할 수 없습니다`,
    };
  }
  const original = (await getSubmission(deps.db, submissionId))!;
  const context = await getSubmissionContext(deps.db, submissionId);

  let created: SubmissionRow;
  try {
    created = await createSubmission(deps.db, {
      assignmentVersionId: original.assignmentVersionId,
      repoUrl: original.repoUrl,
      repoRef: original.submissionSha ?? original.repoRef ?? undefined,
      isSample: original.isSample,
    });
  } catch (error) {
    if (error instanceof SubmissionRejectedError) {
      return { ok: false, code: error.reason, message: error.message };
    }
    throw error;
  }

  let resumeRef: string | null = null;
  if (context?.resumeRef) {
    const object = await deps.store.get(context.resumeRef);
    if (object) {
      resumeRef = artifactKeys.resume(created.id);
      await deps.store.put(resumeRef, object.body, {
        contentType: ARTIFACT_CONTENT_TYPES.resume,
        maxBytes: MAX_RESUME_BYTES,
      });
    }
  }
  const githubLogin = context?.githubLogin ?? null;
  await upsertSubmissionContext(deps.db, created.id, { resumeRef, githubLogin });
  // 사람이 직접 입력한 이력서 텍스트는 원본 PDF에서 다시 얻을 수 없으므로 함께 옮긴다 (T-501)
  if (resumeRef && context?.resumeTextStatus === "MANUAL" && context.resumeText) {
    await setResumeText(deps.db, created.id, {
      status: "MANUAL",
      text: context.resumeText,
      reason: null,
    });
  }
  const enqueued = await enqueueSubmissionEvaluation(deps.db, created.id);
  return {
    ok: true,
    data: { submissionId: created.id, jobId: enqueued.id, resumeRef, githubLogin },
  };
}

// ── 이력서 텍스트 직접 입력 (T-501) ─────────────────────────────────────────────

const ManualResumeTextSchema = z.strictObject({
  submissionId: z.uuid({ error: "제출 ID 형식이 올바르지 않습니다" }),
  text: z
    .string()
    .transform((value) => value.replace(/\r\n?/g, "\n").trim())
    .pipe(
      z
        .string()
        .min(1, { error: "이력서 텍스트를 입력하세요" })
        .max(MAX_MANUAL_RESUME_CHARS, {
          error: `이력서 텍스트는 ${MAX_MANUAL_RESUME_CHARS.toLocaleString("ko-KR")}자까지 입력할 수 있습니다`,
        }),
    ),
});

/**
 * 텍스트를 추출하지 못한 이력서에 사람이 입력한 텍스트를 MANUAL로 저장한다. 이력서 원본이 없거나 이미 추출된
 * 제출은 거절한다. 입력 텍스트는 로그에 남기지 않고 응답에도 넣지 않는다.
 */
export async function saveManualResumeText(
  deps: Pick<SubmissionDeps, "db">,
  input: { submissionId: string; text: string },
): Promise<SubmissionActionResult<ResumeTextView>> {
  const parsed = ManualResumeTextSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { submissionId, text } = parsed.data;
  const submission = await getSubmission(deps.db, submissionId);
  if (!submission || submission.status === "DELETED" || submission.deletedAt) {
    return {
      ok: false,
      code: "SUBMISSION_NOT_FOUND",
      message: `제출을 찾을 수 없습니다: ${submissionId}`,
    };
  }
  const context = await getSubmissionContext(deps.db, submissionId);
  if (!manualInputAllowed(context)) {
    return {
      ok: false,
      code: "RESUME_TEXT_NOT_EDITABLE",
      message: context?.resumeRef
        ? "이력서 텍스트를 이미 추출했거나 아직 추출 전입니다. 추출하지 못한 이력서만 직접 입력할 수 있습니다"
        : "이력서가 없는 제출입니다",
    };
  }
  const saved = await setResumeText(deps.db, submissionId, {
    status: "MANUAL",
    text,
    reason: null,
  });
  return { ok: true, data: resumeTextViewOf(saved) };
}

// ── 폼 옵션 ─────────────────────────────────────────────────────────────────────

export interface ApprovedVersionOption {
  id: string;
  label: string;
  assignmentName: string;
  version: number;
  rubricVersion: string;
}

/** 제출 폼의 과제 선택지. 승인된 버전만 (T-201) */
export async function listApprovedVersionOptions(
  deps: Pick<SubmissionDeps, "db">,
): Promise<ApprovedVersionOption[]> {
  const items = await listAssignments(deps.db);
  return items.flatMap((item) =>
    item.versions
      .filter((version) => version.status === "APPROVED")
      .map((version) => ({
        id: version.id,
        label: formatVersionLabel(item.name, version),
        assignmentName: item.name,
        version: version.version,
        rubricVersion: version.rubricVersion,
      })),
  );
}

export type { ActionResult };

/** 삭제된 제출 URL이 보일 안내 (T-506). 삭제 요청 뒤 워커가 지우는 중이면 PENDING, 다 지웠으면 DONE */
export interface DeletionNotice {
  state: "PENDING" | "DONE";
  /** 삭제 요청 시각(PENDING) 또는 삭제 완료 시각(DONE), ISO 문자열 */
  at: string;
}

export async function readDeletionNotice(
  deps: Pick<SubmissionDeps, "db">,
  submissionId: string,
): Promise<DeletionNotice | null> {
  if (!z.uuid().safeParse(submissionId).success) return null;
  const deletion = await findSubmissionDeletion(deps.db, submissionId);
  if (!deletion) return null;
  return deletion.state === "PENDING"
    ? { state: "PENDING", at: deletion.requestedAt.toISOString() }
    : { state: "DONE", at: deletion.deletedAt.toISOString() };
}

/** 삭제 안내의 시각 표기: `2026-09-19 15:04 KST` */
export function formatDeletionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} KST`;
}

export const DeletionRequestSchema = z.strictObject({
  submissionId: z.uuid({ error: "제출 ID 형식이 올바르지 않습니다" }),
  reviewerName: z
    .string()
    .trim()
    .min(1, { error: "삭제를 확인할 검토자 이름을 입력하세요" })
    .max(100, { error: "검토자 이름은 100자 이하여야 합니다" }),
});

export interface DeletionRequested {
  submissionId: string;
  /** 워커가 아티팩트와 행을 지울 `DELETE_SUBMISSION` job */
  jobId: string;
}

/**
 * 제출 삭제 요청 (T-506). 제출을 DELETED로 바꾸고 진행 중 job을 취소한 뒤 삭제 job을 넣는다. 이미 요청된 제출이면
 * 삭제 job만 다시 넣는다(앞선 job이 실패했을 때). 실제 삭제는 워커가 하므로 web은 아무것도 지우지 않는다.
 */
export async function requestDeletion(
  deps: Pick<SubmissionDeps, "db">,
  input: { submissionId: string; reviewerName: string },
): Promise<SubmissionActionResult<DeletionRequested>> {
  const parsed = DeletionRequestSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error);
  const { submissionId, reviewerName } = parsed.data;
  const result = await requestSubmissionDeletion(deps.db, {
    submissionId,
    requestedBy: reviewerName,
  });
  switch (result.kind) {
    case "REQUESTED":
    case "ALREADY_REQUESTED":
      return { ok: true, data: { submissionId, jobId: result.jobId } };
    case "ALREADY_DELETED":
      return {
        ok: false,
        code: "SUBMISSION_NOT_FOUND",
        message: `이미 삭제된 제출입니다: ${submissionId}`,
      };
    case "NOT_FOUND":
      return {
        ok: false,
        code: "SUBMISSION_NOT_FOUND",
        message: `제출을 찾을 수 없습니다: ${submissionId}`,
      };
  }
}
