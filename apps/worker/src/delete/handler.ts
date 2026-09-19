/**
 * `DELETE_SUBMISSION` job 핸들러 (TICKET.md T-506). payload는 `DeleteSubmissionPayloadSchema`(`@ohmyti/core`)로 검증한다.
 *
 * 순서: 진행 중 job 취소 → 취소된 job을 실행하던 워커가 러너를 정리하고 빠져나오기를 기다림 → 아티팩트 접두사
 * (`submissions/<id>/`, `evaluations/<id>/`) 삭제와 재확인 → 관련 행 삭제 + `deletion_log` (`@ohmyti/db` `deleteSubmissionRows`).
 * 아티팩트를 행보다 먼저 지운다. 중간에 실패해 재시도하면 행에 남은 참조로 같은 범위를 다시 계산한다.
 */
import { DeleteSubmissionPayloadSchema } from "@ohmyti/core";
import {
  cancelSubmissionJobs,
  deleteSubmissionRows,
  getSubmission,
  listUnacknowledgedCancelledJobs,
  readSubmissionArtifactScope,
  type DeleteRowsResult,
  type DeletionArtifacts,
} from "@ohmyti/db";
import { artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import type { Logger } from "../logger";
import {
  NonRetryableJobError,
  type HandlerRegistry,
  type JobContext,
  type JobHandler,
} from "../registry";

export interface DeleteSubmissionHandlerDeps {
  /**
   * 취소된 job의 워커가 빠져나오기를 기다리는 최대 시간(ms). 살아 있는 워커는 heartbeat 주기(stale/3) 안에 취소를 알아채므로
   * 기본은 `WORKER_STALE_MS`다. 이 시간이 지나도 응답이 없으면 그 워커는 죽은 것으로 보고 진행한다
   */
  cancelWaitMs: number;
  /** 확인 폴링 간격. 기본 250ms */
  pollIntervalMs?: number | undefined;
  /** 접두사를 지운 뒤 비었는지 다시 확인하는 횟수와 간격 (Vercel Blob `list`의 최종적 일관성) */
  verifyAttempts?: number | undefined;
  verifyDelayMs?: number | undefined;
}

export const DELETE_HANDLER_DEFAULTS = {
  pollIntervalMs: 250,
  verifyAttempts: 5,
  verifyDelayMs: 500,
} as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDeleteSubmissionHandler(deps: DeleteSubmissionHandlerDeps): JobHandler {
  return async (job, ctx) => {
    const payload = DeleteSubmissionPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new NonRetryableJobError(
        `DELETE_SUBMISSION payload가 올바르지 않습니다: ${payload.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const result = await runSubmissionDeletion(payload.data, ctx, deps);
    if (result.kind === "ALREADY_DELETED") {
      ctx.logger.info({ logId: result.logId }, "이미 삭제된 제출입니다");
    }
  };
}

export async function runSubmissionDeletion(
  input: { submissionId: string; requestedBy: string },
  ctx: Pick<JobContext, "db" | "store" | "logger" | "heartbeat">,
  deps: DeleteSubmissionHandlerDeps,
): Promise<DeleteRowsResult> {
  const { db, store } = ctx;
  const logger = ctx.logger.child({ submissionId: input.submissionId });
  const submission = await getSubmission(db, input.submissionId);
  if (submission && !submission.deletedAt) {
    throw new NonRetryableJobError(
      `제출 ${input.submissionId}에 삭제 요청이 없습니다. 삭제는 제출 화면의 삭제 요청으로만 시작합니다`,
    );
  }

  // 1. 진행 중 job 취소 (web이 요청 시점에 이미 했지만 그 뒤에 들어온 job이 있을 수 있다)
  const cancelledJobIds = submission ? await cancelSubmissionJobs(db, input.submissionId) : [];
  if (cancelledJobIds.length > 0) logger.info({ cancelledJobIds }, "진행 중 job을 취소했습니다");

  // 2. 취소된 job을 실행하던 워커가 러너 환경을 정리하고 빠져나오기를 기다린다
  if (submission) await waitForCancelledJobs(input.submissionId, ctx, deps, logger);

  // 3. 아티팩트
  const scope = submission ? await readSubmissionArtifactScope(db, input.submissionId) : null;
  let artifacts: DeletionArtifacts = { prefixes: [], deletedObjects: 0, keptSharedRefs: [] };
  if (scope) {
    artifacts = await deleteArtifacts(store, input.submissionId, scope, deps, logger);
    await ctx.heartbeat();
  }

  // 4. 행 삭제 + deletion_log
  const result = await deleteSubmissionRows(db, {
    submissionId: input.submissionId,
    requestedBy: input.requestedBy,
    artifacts,
    cancelledJobIds,
  });
  if (result.kind === "DELETED") {
    logger.info(
      { logId: result.logId, counts: result.removed.counts, artifacts: result.removed.artifacts },
      "제출을 삭제했습니다",
    );
  }
  return result;
}

async function waitForCancelledJobs(
  submissionId: string,
  ctx: Pick<JobContext, "db" | "heartbeat">,
  deps: DeleteSubmissionHandlerDeps,
  logger: Logger,
): Promise<void> {
  const poll = deps.pollIntervalMs ?? DELETE_HANDLER_DEFAULTS.pollIntervalMs;
  const deadline = Date.now() + deps.cancelWaitMs;
  let pending = await listUnacknowledgedCancelledJobs(ctx.db, submissionId);
  if (pending.length > 0) {
    logger.info(
      { jobs: pending.map((j) => ({ id: j.id, lockedBy: j.lockedBy })) },
      "취소된 job의 러너 정리를 기다립니다",
    );
  }
  while (pending.length > 0 && Date.now() < deadline) {
    await sleep(poll);
    await ctx.heartbeat();
    pending = await listUnacknowledgedCancelledJobs(ctx.db, submissionId);
  }
  if (pending.length > 0) {
    logger.warn(
      { jobs: pending.map((j) => ({ id: j.id, lockedBy: j.lockedBy })), waitMs: deps.cancelWaitMs },
      "취소된 job의 워커가 응답하지 않습니다. 워커가 사라진 것으로 보고 삭제를 계속합니다",
    );
  }
}

async function deleteArtifacts(
  store: ArtifactStore,
  submissionId: string,
  scope: { evaluationIds: string[]; referencedRefs: string[] },
  deps: DeleteSubmissionHandlerDeps,
  logger: Logger,
): Promise<DeletionArtifacts> {
  const prefixes = [
    artifactKeys.submissionPrefix(submissionId),
    ...scope.evaluationIds.map((id) => artifactKeys.evaluationPrefix(id)),
  ];
  const attempts = deps.verifyAttempts ?? DELETE_HANDLER_DEFAULTS.verifyAttempts;
  const delay = deps.verifyDelayMs ?? DELETE_HANDLER_DEFAULTS.verifyDelayMs;
  let deletedObjects = 0;
  for (const prefix of prefixes) {
    deletedObjects += await store.deletePrefix(prefix);
    // 다시 지워 보아 0이면 비었다. Blob 목록이 늦게 반영되면 남은 객체가 보이므로 몇 번 더 지운다
    let remaining = -1;
    for (let i = 0; i < attempts && remaining !== 0; i += 1) {
      if (i > 0) await sleep(delay);
      remaining = await store.deletePrefix(prefix);
      deletedObjects += remaining;
    }
    if (remaining !== 0) {
      throw new Error(
        `ENVIRONMENT: 아티팩트 접두사 ${prefix}를 ${attempts}번 다시 확인했지만 비지 않았습니다`,
      );
    }
  }
  // 이 제출의 접두사 밖 참조(샘플 스냅샷 등)는 다른 제출과 공유하므로 지우지 않고 기록만 한다
  const keptSharedRefs = scope.referencedRefs.filter(
    (ref) => !prefixes.some((prefix) => ref.startsWith(prefix)),
  );
  logger.info({ prefixes, deletedObjects, keptSharedRefs }, "아티팩트를 지웠습니다");
  return { prefixes, deletedObjects, keptSharedRefs };
}

export function registerDeleteSubmission(
  registry: HandlerRegistry,
  deps: DeleteSubmissionHandlerDeps,
): HandlerRegistry {
  return registry.register("DELETE_SUBMISSION", createDeleteSubmissionHandler(deps));
}
