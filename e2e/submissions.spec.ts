import { expect, test, type Page } from "@playwright/test";
import {
  createServerlessDb,
  seedEvaluation,
  setSubmissionStatus,
  updateEvaluationStage,
  type DbHandle,
} from "@ohmyti/db";
import { sql } from "drizzle-orm";
import "../scripts/load-env";

/**
 * 제출·분석 화면 E2E (T-206). dev 서버와 같은 `DATABASE_URL`에 직접 행을 넣어 종료 상태 화면을 검증한다.
 * 워커는 띄우지 않으므로 새 제출은 QUEUED에 머문다. 워커까지 포함한 흐름은 T-208 게이트가 검증한다.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
let handle: DbHandle;
const createdAssignmentIds: string[] = [];

test.beforeAll(() => {
  const url = process.env.DATABASE_URL;
  test.skip(!url, "DATABASE_URL이 없어 제출 E2E를 건너뜁니다");
  handle = createServerlessDb(url!);
});

test.afterAll(async () => {
  if (!handle) return;
  for (const id of createdAssignmentIds) {
    // evaluations → assignment_versions는 restrict이므로 제출(→ 평가 cascade)을 먼저 지운다
    await handle.db.execute(
      sql`delete from submissions where assignment_version_id in (select id from assignment_versions where assignment_id = ${id})`,
    );
    await handle.db.execute(sql`delete from assignments where id = ${id}`);
  }
  await handle.close();
});

async function seed(label: string) {
  const seeded = await seedEvaluation(handle.db, `e2e-t206-${label}-${Date.now()}`);
  createdAssignmentIds.push(seeded.assignmentId);
  return seeded;
}

async function runStage(evaluationId: string, stage: Parameters<typeof updateEvaluationStage>[2]) {
  await updateEvaluationStage(handle.db, evaluationId, stage, { state: "RUNNING" });
}

/** 지정한 시간 동안 상태 폴링 요청 수를 센다 */
async function countStatusRequests(page: Page, ms: number): Promise<number> {
  let count = 0;
  const listener = (request: { url(): string }) => {
    if (/\/api\/submissions\/[^/]+\/status/.test(request.url())) count += 1;
  };
  page.on("request", listener);
  await page.waitForTimeout(ms);
  page.off("request", listener);
  return count;
}

test("잘못된 저장소 URL은 서버 요청 없이 클라이언트에서 거부된다", async ({ page }) => {
  await seed("form");
  await page.goto("/submissions/new");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("제출");

  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await page.getByLabel("과제 저장소 URL").fill("https://gitlab.com/octocat/order-api");
  await page.getByLabel("커밋 SHA (선택)").fill("main");
  await page.getByRole("button", { name: "분석 및 채점" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "github.com 저장소만 지원" }),
  ).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "7~40자 16진수" })).toBeVisible();
  expect(posts).toHaveLength(0);
});

test("이력서·GitHub 없이 제출하면 상태 화면으로 이동하고 6단계가 대기로 보이며 폴링이 시작된다", async ({
  page,
}) => {
  const seeded = await seed("submit");
  await page.goto("/submissions/new");
  await page.getByLabel("채용 과제").selectOption(seeded.assignmentVersionId);
  await page.getByLabel("과제 저장소 URL").fill("https://github.com/octocat/order-api");
  await page.getByRole("button", { name: "분석 및 채점" }).click();

  await page.waitForURL(/\/submissions\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("submission-status-badge")).toHaveText("대기열");
  await expect(page.getByTestId("polling-indicator")).toBeVisible();
  const items = page.locator('[data-testid="stage-list"] > li');
  await expect(items).toHaveCount(6);
  await expect(items.nth(0)).toContainText("저장소 확인");
  await expect(items.nth(5)).toContainText("맥락 연결");
  await expect(page.locator('[data-state="PENDING"]')).toHaveCount(6);
  await expect(page.getByText("이력서 없음")).toBeVisible();
  await expect(page.getByText("GitHub 미제공")).toBeVisible();
  await expect(page.locator("progress, [role=progressbar]")).toHaveCount(0);
  expect(await page.locator("main").innerText()).not.toMatch(/\d+\s?%/);

  const polls = await countStatusRequests(page, 7_000);
  expect(polls).toBeGreaterThanOrEqual(1);
});

test("이력서 PDF와 GitHub 프로필을 함께 제출하면 맥락 정보가 표시된다", async ({ page }) => {
  const seeded = await seed("resume");
  await page.goto("/submissions/new");
  await page.getByLabel("채용 과제").selectOption(seeded.assignmentVersionId);
  await page.getByLabel("이력서 (PDF, 선택)").setInputFiles({
    name: "resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%e2e resume\n"),
  });
  await page.getByLabel("GitHub 프로필 URL (선택)").fill("https://github.com/octocat");
  await page.getByLabel("과제 저장소 URL").fill("https://github.com/octocat/order-api");
  await page.getByLabel("커밋 SHA (선택)").fill(SHA.toUpperCase());
  await page.getByRole("button", { name: "분석 및 채점" }).click();
  await page.waitForURL(/\/submissions\/[0-9a-f-]{36}$/);
  await expect(page.getByText("이력서 있음")).toBeVisible();
  await expect(page.getByText("@octocat")).toBeVisible();
  await expect(page.getByText(`@ ${SHA}`)).toBeVisible();
});

test("완료된 제출은 새로고침해도 상태가 유지되고 폴링 요청이 없다", async ({ page }) => {
  const seeded = await seed("completed");
  for (const stage of ["REPO_CHECK", "ENV_PREP", "REQUIREMENT_VERIFY"] as const) {
    await runStage(seeded.evaluationId, stage);
    await updateEvaluationStage(handle.db, seeded.evaluationId, stage, {
      state: "DONE",
      detail:
        stage === "REPO_CHECK"
          ? { submissionSha: SHA, fileCount: 7, totalBytes: 2048 }
          : stage === "REQUIREMENT_VERIFY"
            ? { results: { score: { display: "70~80/100 · 10점 검토 대기" } } }
            : { framework: "express", language: "typescript" },
    });
  }
  for (const stage of ["TEST_EFFECTIVENESS", "REVIEW_WRITE", "CONTEXT_LINK"] as const) {
    await updateEvaluationStage(handle.db, seeded.evaluationId, stage, {
      state: "SKIPPED",
      reason: "not_implemented",
    });
  }
  await handle.db.execute(
    sql`update evaluations set finished_at = now() where id = ${seeded.evaluationId}`,
  );
  await setSubmissionStatus(handle.db, seeded.submissionId, "COMPLETED");

  await page.goto(`/submissions/${seeded.submissionId}`);
  await expect(page.getByTestId("submission-status-badge")).toHaveText("완료");
  await expect(page.getByTestId("report-link")).toHaveAttribute(
    "href",
    `/api/evaluations/${seeded.evaluationId}`,
  );
  await expect(page.getByTestId("workbench-link")).toHaveAttribute(
    "href",
    `/evaluations/${seeded.evaluationId}`,
  );
  await expect(page.locator('[data-state="DONE"]')).toHaveCount(3);
  await expect(page.locator('[data-state="SKIPPED"]')).toHaveCount(3);
  await expect(page.getByText("점수 70~80/100 · 10점 검토 대기")).toBeVisible();
  await expect(page.getByTestId("polling-indicator")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("submission-status-badge")).toHaveText("완료");
  await expect(page.getByTestId("submission-status")).toHaveAttribute("data-terminal", "true");
  expect(await countStatusRequests(page, 7_000)).toBe(0);
});

test("미지원 제출은 사유 코드와 상세를 그대로 보여 주고 재시도 버튼이 없다", async ({ page }) => {
  const seeded = await seed("unsupported");
  await runStage(seeded.evaluationId, "REPO_CHECK");
  await updateEvaluationStage(handle.db, seeded.evaluationId, "REPO_CHECK", { state: "DONE" });
  await runStage(seeded.evaluationId, "ENV_PREP");
  await updateEvaluationStage(handle.db, seeded.evaluationId, "ENV_PREP", {
    state: "UNSUPPORTED",
    reason: "DISALLOWED_DEPENDENCY: fastify@5.0.0",
    detail: {
      supported: false,
      reasons: [
        { code: "DISALLOWED_DEPENDENCY", detail: "fastify@5.0.0은 템플릿 허용 목록에 없습니다" },
      ],
    },
  });
  await handle.db.execute(
    sql`update submissions set status = 'UNSUPPORTED', unsupported_reason = ${"DISALLOWED_DEPENDENCY: fastify@5.0.0은 템플릿 허용 목록에 없습니다"} where id = ${seeded.submissionId}`,
  );

  await page.goto(`/submissions/${seeded.submissionId}`);
  await expect(page.getByTestId("submission-status-badge")).toHaveText("미지원");
  await expect(page.getByText("DISALLOWED_DEPENDENCY").first()).toBeVisible();
  await expect(page.getByText("fastify@5.0.0은 템플릿 허용 목록에 없습니다").first()).toBeVisible();
  await expect(page.locator('[data-stage="ENV_PREP"][data-state="UNSUPPORTED"]')).toHaveCount(1);
  await expect(page.getByTestId("retry-button")).toHaveCount(0);
  expect(await countStatusRequests(page, 4_000)).toBe(0);
});

test("비공개 저장소는 평가 없이 UNSUPPORTED이며 서버가 기록한 사유가 보인다", async ({ page }) => {
  const seeded = await seed("private");
  // 워커(T-202)는 저장소를 받지 못하면 평가 행을 만들지 않고 제출만 UNSUPPORTED로 바꾼다
  await handle.db.execute(sql`delete from evaluations where id = ${seeded.evaluationId}`);
  await handle.db.execute(
    sql`update submissions set status = 'UNSUPPORTED', unsupported_reason = ${"REPO_NOT_ACCESSIBLE: 저장소를 찾을 수 없거나 비공개입니다 (GitHub 404): octocat/private-api"} where id = ${seeded.submissionId}`,
  );
  await page.goto(`/submissions/${seeded.submissionId}`);
  await expect(page.getByTestId("submission-status-badge")).toHaveText("미지원");
  await expect(page.getByText("REPO_NOT_ACCESSIBLE")).toBeVisible();
  await expect(page.getByText("octocat/private-api")).toBeVisible();
  await expect(page.getByText("평가 기록이 없습니다")).toBeVisible();
  await expect(page.locator('[data-state="PENDING"]')).toHaveCount(6);
  await expect(page.getByTestId("retry-button")).toHaveCount(0);
});

test("환경 장애로 실패한 제출에만 재시도 버튼이 있고, 재시도는 새 제출 화면으로 간다", async ({
  page,
}) => {
  const env = await seed("envfail");
  await runStage(env.evaluationId, "REPO_CHECK");
  await updateEvaluationStage(handle.db, env.evaluationId, "REPO_CHECK", {
    state: "FAILED",
    reason: "ENVIRONMENT: GitHub API 503",
    detail: { failureKind: "ENVIRONMENT" },
  });
  await setSubmissionStatus(handle.db, env.submissionId, "FAILED");

  await page.goto(`/submissions/${env.submissionId}`);
  await expect(page.getByTestId("submission-status-badge")).toHaveText("실패");
  await expect(page.getByText("환경 장애로 채점을 끝내지 못했습니다")).toBeVisible();
  await page.getByTestId("retry-button").click();
  await page.waitForURL(
    (url) =>
      /\/submissions\/[0-9a-f-]{36}$/.test(url.pathname) &&
      !url.pathname.includes(env.submissionId),
  );
  await expect(page.getByTestId("submission-status-badge")).toHaveText("대기열");
  await expect(page.getByText(`@ ${SHA}`)).toBeVisible();

  const sub = await seed("subfail");
  for (const stage of ["REPO_CHECK", "ENV_PREP"] as const) {
    await runStage(sub.evaluationId, stage);
    await updateEvaluationStage(handle.db, sub.evaluationId, stage, { state: "DONE" });
  }
  await runStage(sub.evaluationId, "REQUIREMENT_VERIFY");
  await updateEvaluationStage(handle.db, sub.evaluationId, "REQUIREMENT_VERIFY", {
    state: "FAILED",
    reason: "SUBMISSION: 서비스가 10초 안에 /health를 주지 못했습니다",
    detail: { failureKind: "SUBMISSION" },
  });
  await setSubmissionStatus(handle.db, sub.submissionId, "FAILED");
  await page.goto(`/submissions/${sub.submissionId}`);
  await expect(page.getByTestId("submission-status-badge")).toHaveText("실패");
  await expect(page.getByText("제출 코드 탓으로 채점이 실패했습니다")).toBeVisible();
  await expect(page.getByText("제출 코드 오류")).toBeVisible();
  await expect(page.getByTestId("retry-button")).toHaveCount(0);
});

test("없는 제출은 404 화면이다", async ({ page }) => {
  const response = await page.goto("/submissions/00000000-0000-4000-8000-000000000000");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("제출을 찾을 수 없습니다");
});

test("텍스트를 추출하지 못한 이력서는 안내와 입력란이 보이고, 입력하면 MANUAL로 저장된다 (T-501)", async ({
  page,
}) => {
  const seeded = await seed("resume-image-only");
  const reason =
    "RESUME_TEXT_NOT_FOUND: PDF에 텍스트 층이 없습니다 (스캔·이미지 문서). OCR은 하지 않습니다";
  await handle.db.execute(
    sql`insert into submission_context (submission_id, resume_ref, resume_text_status, resume_text_reason)
        values (${seeded.submissionId}, ${`submissions/${seeded.submissionId}/resume.pdf`}, 'IMAGE_ONLY', ${reason})`,
  );
  await setSubmissionStatus(handle.db, seeded.submissionId, "COMPLETED");

  await page.goto(`/submissions/${seeded.submissionId}`);
  const panel = page.getByTestId("resume-text-panel");
  await expect(panel).toHaveAttribute("data-status", "IMAGE_ONLY");
  await expect(page.getByTestId("resume-image-only-notice")).toContainText(
    "텍스트를 추출할 수 없습니다. 텍스트를 직접 입력하세요",
  );
  await expect(page.getByTestId("resume-text-reason")).toHaveText(reason);
  const textarea = page.getByTestId("manual-resume-text");
  await expect(textarea).toBeVisible();
  await expect(page.getByTestId("manual-resume-save")).toBeDisabled();

  await textarea.fill("백엔드 개발자\n주문 API 3년");
  await page.getByTestId("manual-resume-save").click();
  await expect(page.getByTestId("manual-resume-saved")).toHaveText("저장했습니다");
  await expect(panel).toHaveAttribute("data-status", "MANUAL");
  await expect(panel).toContainText("17자");

  const rows = (await handle.db.execute(
    sql`select resume_text_status, resume_text from submission_context where submission_id = ${seeded.submissionId}`,
  )) as unknown as Array<{ resume_text_status: string; resume_text: string }>;
  expect(rows[0]).toEqual({
    resume_text_status: "MANUAL",
    resume_text: "백엔드 개발자\n주문 API 3년",
  });

  await page.reload();
  await expect(panel).toHaveAttribute("data-status", "MANUAL");
  await expect(page.getByTestId("resume-image-only-notice")).toHaveCount(0);
});
