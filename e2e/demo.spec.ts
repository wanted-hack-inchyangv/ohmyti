import { expect, test } from "@playwright/test";
import { createServerlessDb, jobs, submissions, type DbHandle } from "@ohmyti/db";
import { eq, inArray } from "drizzle-orm";
import "../scripts/load-env";

/**
 * 샘플 체험 E2E (T-505). `pnpm demo:seed`가 만든 저장된 실행을 전제로 한다(`pnpm demo:seed && pnpm e2e -- demo`).
 *
 * - `/demo`의 안내 문구·샘플 카드 4개·`저장된 실행 · <시각>` 배지·`채점기 사전 검증 완료` 배지 (PRD 7장 데모 데이터 원칙).
 * - 워크벤치 헤더가 같은 배지를 보인다.
 * - 워커 없이(chromium 프로젝트는 워커를 띄우지 않는다) `이 샘플로 새로 실행`을 누르면 실패 상태와 이전의 저장된 실행
 *   링크가 보이고, 실시간 성공으로 표시하지 않는다. 대기 시간 상한은 Playwright 웹 서버의 `DEMO_RUN_START_TIMEOUT_MS`(5초)다.
 */

const SAVED_LABEL = /^저장된 실행 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST$/;
const NOTICE = "준비된 샘플입니다. 결과와 숫자는 실제 실행에서 생성했습니다";

let handle: DbHandle;
const createdSubmissionIds: string[] = [];

test.beforeAll(() => {
  const url = process.env.DATABASE_URL;
  test.skip(!url, "DATABASE_URL이 없어 샘플 체험 E2E를 건너뜁니다");
  handle = createServerlessDb(url!);
});

test.afterAll(async () => {
  if (!handle) return;
  if (createdSubmissionIds.length > 0) {
    // 새 실행 job이 뒤이어 도는 stack 프로젝트 워커에 잡히지 않게 취소하고, 평가가 없는 제출을 지운다
    for (const id of createdSubmissionIds) {
      await handle.db
        .update(jobs)
        .set({ status: "CANCELLED" })
        .where(eq(jobs.dedupeKey, `EVALUATE_SUBMISSION:${id}`));
    }
    await handle.db.delete(submissions).where(inArray(submissions.id, createdSubmissionIds));
  }
  await handle.close();
});

test("샘플 체험: 안내 문구와 샘플 4개의 저장된 실행 배지", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByTestId("demo-notice")).toHaveText(NOTICE);
  await expect(page.getByTestId("approval-badge")).toContainText("채점기 사전 검증 완료");
  await expect(page.getByTestId("approval-badge")).toHaveAttribute("data-validated", "true");
  for (const id of ["A", "B", "C", "D"]) {
    const card = page.getByTestId(`demo-sample-${id}`);
    await expect(card).toBeVisible();
    // 저장된 실행이 없으면 `pnpm demo:seed`를 먼저 돌려야 한다
    await expect(card.getByTestId(`demo-saved-badge-${id}`)).toHaveText(SAVED_LABEL);
    await expect(card.getByTestId(`demo-saved-link-${id}`)).toHaveAttribute(
      "href",
      /^\/evaluations\/[0-9a-f-]{36}$/,
    );
    await expect(card.getByTestId(`demo-run-${id}`)).toBeEnabled();
  }
  // 홍보 수치나 실시간 표현을 쓰지 않는다 (G-16, PRD 7장)
  await expect(page.locator("body")).not.toContainText(/실시간|정확도|%\s*절감/);
});

test("샘플 체험: 워크벤치 헤더가 저장된 실행과 사전 검증 배지를 보인다", async ({ page }) => {
  await page.goto("/demo");
  const badge = await page.getByTestId("demo-saved-badge-C").innerText();
  await page.getByTestId("demo-saved-link-C").click();
  await expect(page.getByTestId("workbench")).toBeVisible();
  await expect(page.getByTestId("sample-badge")).toHaveText(badge);
  await expect(page.getByTestId("approval-badge")).toContainText("채점기 사전 검증 완료");
  await expect(page.getByTestId("score-display")).toBeVisible();
});

test("샘플 체험: 워커가 없으면 새 실행은 실패 상태와 저장된 실행 링크를 보인다", async ({
  page,
}) => {
  await page.goto("/demo");
  const savedHref = await page.getByTestId("demo-saved-link-C").getAttribute("href");
  await page.getByTestId("demo-run-C").click();
  await page.waitForURL(/\/demo\/runs\/[0-9a-f-]{36}$/);
  const submissionId = page.url().split("/").pop()!;
  createdSubmissionIds.push(submissionId);

  const status = page.getByTestId("demo-run-status");
  // 처음에는 대기 중이며 결과를 보이지 않는다
  await expect(status).toHaveAttribute("data-phase", /WAITING|FAILED/);
  await expect(page.getByTestId("demo-run-result-link")).toHaveCount(0);

  // 워커 응답 없음 판단(5초) 뒤 폴링(3초)이 실패 상태를 가져온다
  await expect(status).toHaveAttribute("data-phase", "FAILED", { timeout: 30_000 });
  await expect(page.getByTestId("demo-run-phase")).toHaveText("새 실행 실패");
  await expect(page.getByTestId("demo-run-failure")).toContainText("워커 응답 없음");
  await expect(page.getByTestId("demo-run-result-link")).toHaveCount(0);
  await expect(page.getByText("새 실행 완료")).toHaveCount(0);

  const saved = page.getByTestId("demo-run-saved-link");
  await expect(saved).toHaveAttribute("href", savedHref!);
  await expect(saved).toContainText("저장된 실행 · ");
  await expect(page.getByTestId("demo-run-saved")).toContainText("이번 실행의 결과가 아닙니다");

  // 새 제출은 저장된 스냅샷으로 SHA가 고정돼 있다 (GitHub 재수집 없음)
  const [row] = await handle.db.select().from(submissions).where(eq(submissions.id, submissionId));
  expect(row?.demoSampleId).toBe("C");
  expect(row?.isSample).toBe(true);
  expect(row?.submissionSha).toMatch(/^[0-9a-f]{40}$/);
  expect(row?.status).toBe("QUEUED");

  // 저장된 실행 링크는 이전 평가의 워크벤치로 간다
  await saved.click();
  await expect(page.getByTestId("workbench")).toBeVisible();
  await expect(page.getByTestId("sample-badge")).toHaveText(SAVED_LABEL);
});
