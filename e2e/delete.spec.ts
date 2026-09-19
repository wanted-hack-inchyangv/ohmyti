import { expect, test } from "@playwright/test";
import {
  createServerlessDb,
  deleteSubmissionRows,
  jobs,
  seedEvaluation,
  setSubmissionStatus,
  type DbHandle,
} from "@ohmyti/db";
import { eq, sql } from "drizzle-orm";
import "../scripts/load-env";

/**
 * 제출 삭제 E2E (T-506). 워커 없이 도는 chromium 프로젝트에서 화면 흐름을 본다: 삭제 버튼 → 모달에서 검토자 이름 입력 →
 * 요청하면 같은 URL이 404와 "삭제된 제출입니다"(삭제 중)를 보인다. 워커가 행을 지운 뒤(`deleteSubmissionRows`로 대신한다)에도
 * 404와 "삭제됨"이다. 아티팩트·실행 중 job 정리는 `apps/worker/src/delete/delete.test.ts`가 검증한다.
 */

let handle: DbHandle;
const createdAssignmentIds: string[] = [];

test.beforeAll(() => {
  const url = process.env.DATABASE_URL;
  test.skip(!url, "DATABASE_URL이 없어 제출 삭제 E2E를 건너뜁니다");
  handle = createServerlessDb(url!);
});

test.afterAll(async () => {
  if (!handle) return;
  for (const id of createdAssignmentIds) {
    await handle.db.execute(
      sql`delete from submissions where assignment_version_id in (select id from assignment_versions where assignment_id = ${id})`,
    );
    await handle.db.execute(sql`delete from assignments where id = ${id}`);
  }
  await handle.close();
});

test("제출 삭제: 검토자 이름을 입력해야 삭제되고, 삭제된 제출 URL은 404와 '삭제됨' 안내를 보인다", async ({
  page,
  request,
}) => {
  const seeded = await seedEvaluation(handle.db, `e2e-t506-${Date.now()}`);
  createdAssignmentIds.push(seeded.assignmentId);
  await setSubmissionStatus(handle.db, seeded.submissionId, "COMPLETED");
  const url = `/submissions/${seeded.submissionId}`;

  const first = await page.goto(url);
  expect(first?.status()).toBe(200);
  await page.getByTestId("delete-submission-button").click();
  const dialog = page.getByTestId("delete-submission-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("되돌릴 수 없습니다");
  // 이름을 넣기 전에는 삭제할 수 없다
  await expect(page.getByTestId("delete-confirm-button")).toBeDisabled();
  // 취소하면 아무것도 바뀌지 않는다
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("submission-status")).toBeVisible();

  await page.getByTestId("delete-submission-button").click();
  await page.getByTestId("delete-reviewer-input").fill("김검토");
  await page.getByTestId("delete-confirm-button").click();

  // 같은 URL이 삭제 안내로 바뀐다 (워커가 없으므로 아직 지우는 중)
  const deleted = page.getByTestId("submission-deleted");
  await expect(deleted).toBeVisible();
  await expect(deleted).toHaveAttribute("data-state", "PENDING");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("삭제된 제출입니다");

  const pending = await page.goto(url);
  expect(pending?.status()).toBe(404);
  await expect(deleted).toContainText("삭제를 요청했습니다");

  // 삭제 job이 들어갔다. 뒤이어 도는 stack 워커가 잡지 않도록 이 테스트가 행 삭제를 대신 하고 job을 닫는다
  const [job] = await handle.db
    .select()
    .from(jobs)
    .where(eq(jobs.dedupeKey, `DELETE_SUBMISSION:${seeded.submissionId}`));
  expect(job?.type).toBe("DELETE_SUBMISSION");
  expect(job?.payload).toEqual({ submissionId: seeded.submissionId, requestedBy: "김검토" });
  await deleteSubmissionRows(handle.db, {
    submissionId: seeded.submissionId,
    requestedBy: "김검토",
    artifacts: { prefixes: [], deletedObjects: 0, keptSharedRefs: [] },
    cancelledJobIds: [],
  });
  await handle.db.update(jobs).set({ status: "CANCELLED" }).where(eq(jobs.id, job!.id));

  const done = await page.goto(url);
  expect(done?.status()).toBe(404);
  await expect(deleted).toHaveAttribute("data-state", "DONE");
  await expect(deleted).toContainText("모두 지웠습니다");
  await expect(page.locator("body")).not.toContainText("김검토");

  // 상태 API도 404이며 삭제된 제출임을 알린다
  const api = await request.get(`/api/submissions/${seeded.submissionId}/status`);
  expect(api.status()).toBe(404);
  expect(await api.json()).toMatchObject({
    ok: false,
    code: "SUBMISSION_NOT_FOUND",
    message: expect.stringContaining("삭제된 제출입니다"),
  });

  // 원래 없던 제출은 "삭제됨"이 아니라 일반 안내다
  const missing = await page.goto("/submissions/00000000-0000-4000-8000-00000000beef");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("제출을 찾을 수 없습니다");
});
