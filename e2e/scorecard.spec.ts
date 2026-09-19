import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { aggregateScore, findForbiddenReportExpressions } from "@ohmyti/core";
import { sampleRubric } from "@ohmyti/core/fixtures";
import {
  assignmentVersions,
  assignments,
  createServerlessDb,
  evaluations,
  finishEvaluation,
  persistEvaluationResults,
  setSubmissionStatus,
  submissions,
  type DbHandle,
  type NewCriterionResult,
} from "@ohmyti/db";
import { sql } from "drizzle-orm";
import "../scripts/load-env";

/**
 * 면접 스코어카드 저장 E2E (T-707, PRD 14.3의 8절). 채용 리포트 화면의 스코어카드 절에서
 * - 면접관이 척도와 메모를 기입해 저장하면 리포트에 그대로 보인다
 * - 같은 면접관이 다시 저장하면 이전 기록이 이력으로 남는다
 * - 저장된 기록이 Markdown 내보내기에도 실린다
 * - 데스크톱(1440px)·모바일(390px) 레이아웃 (스크린샷)
 * 입력 규칙과 조립은 단위 테스트(`apps/web/lib/scorecards/scorecard.test.ts`)가 확인한다.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_DIR = path.join(repoRoot, "test-results", "t707-screenshots");

let handle: DbHandle;
let assignmentId: string;
let evaluationId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  test.skip(!url, "DATABASE_URL이 없어 스코어카드 E2E를 건너뜁니다");
  handle = createServerlessDb(url!);
  const rubricVersion = `e2e-t707-${randomUUID().slice(0, 8)}`;
  const rubric = { ...sampleRubric(), version: rubricVersion };

  const [assignment] = await handle.db
    .insert(assignments)
    .values({ name: `e2e-t707-${randomUUID().slice(0, 8)}` })
    .returning({ id: assignments.id });
  assignmentId = assignment!.id;
  const [version] = await handle.db
    .insert(assignmentVersions)
    .values({
      assignmentId,
      version: 1,
      title: "주문·재고 API",
      specRef: "artifact://spec",
      specDigest: DIGEST,
      rubric,
      rubricVersion,
      executionContract: {
        startCommand: "npm start",
        portEnv: "PORT",
        healthPath: "/health",
        healthTimeoutMs: 10_000,
        resetPath: "/admin/reset",
        templateName: "order-api-ts",
        nodeVersion: "22",
      },
      harnessVersion: "harness-0",
      status: "APPROVED",
      approvedBy: "e2e",
      approvedAt: new Date(),
    })
    .returning({ id: assignmentVersions.id });

  const [submission] = await handle.db
    .insert(submissions)
    .values({
      assignmentVersionId: version!.id,
      repoUrl: "https://github.com/example/order-api",
      submissionSha: SHA,
    })
    .returning({ id: submissions.id });
  const [evaluation] = await handle.db
    .insert(evaluations)
    .values({
      submissionId: submission!.id,
      assignmentVersionId: version!.id,
      rubricVersion,
      harnessVersion: "harness-0",
      environmentDigest: DIGEST,
      submissionSha: SHA,
    })
    .returning({ id: evaluations.id });
  evaluationId = evaluation!.id;

  // 감점이 없으면 근거가 없어도 된다 (G-02). 이 스펙은 스코어카드만 확인한다
  const criterionResults: (NewCriterionResult & { evaluationId: string })[] = rubric.criteria.map(
    (criterion) => ({
      evaluationId,
      criterionId: criterion.id,
      rubricVersion,
      maxPoints: criterion.maxPoints,
      earnedPoints: criterion.maxPoints,
      verdict: "PASS" as const,
      method: criterion.method,
      evidenceIds: [],
      observation: `${criterion.title} 판정을 저장했습니다.`,
      reviewState: "NOT_REQUIRED" as const,
    }),
  );
  const summary = aggregateScore(criterionResults, rubric);
  await persistEvaluationResults(handle.db, {
    evaluationId,
    executionRecords: [],
    evidences: [],
    criterionResults,
    score: {
      earned: summary.earned,
      min: summary.min,
      max: summary.max,
      pendingPoints: summary.pendingPoints,
      byArea: summary.byArea,
    },
  });
  await finishEvaluation(handle.db, evaluationId, new Date());
  await setSubmissionStatus(handle.db, submission!.id, "COMPLETED");
  await mkdir(SHOT_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (!handle) return;
  if (assignmentId) {
    await handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`delete from submissions where assignment_version_id in (select id from assignment_versions where assignment_id = ${assignmentId})`,
      );
      await tx.execute(sql`delete from assignments where id = ${assignmentId}`);
    });
  }
  await handle.close();
});

test("스코어카드를 저장하면 리포트에 기록으로 보인다 (T-707)", async ({ page }) => {
  await page.goto(`/evaluations/${evaluationId}/report`);
  await expect(page.getByTestId("scorecard-saved-empty")).toBeVisible();

  await page.getByTestId("scorecard-interviewer").fill("김면접");
  await page
    .locator('[data-scorecard-input="REQUIREMENTS"] input[type="radio"][value="3"]')
    .check();
  await page
    .locator('[data-scorecard-input="REQUIREMENTS"] input[type="text"]')
    .fill("요구사항 조건을 스스로 짚었습니다");
  await page.getByTestId("scorecard-final-note").fill("동시성 조건을 한 번 더 확인하면 좋겠습니다");
  await page.getByTestId("scorecard-submit").click();

  await expect(page.getByTestId("scorecard-saved")).toBeVisible();
  const card = page.locator('[data-interviewer="김면접"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("요구사항 이해와 구현 정확성: 3 충족");
  await expect(card).toContainText("동시성 조건을 한 번 더 확인하면 좋겠습니다");
});

test("같은 면접관이 다시 저장하면 이전 기록이 이력으로 남는다 (T-707)", async ({ page }) => {
  await page.goto(`/evaluations/${evaluationId}/report`);
  await page.getByTestId("scorecard-interviewer").fill("김면접");
  await page
    .locator('[data-scorecard-input="REQUIREMENTS"] input[type="radio"][value="4"]')
    .check();
  await page.getByTestId("scorecard-submit").click();
  await expect(page.getByTestId("scorecard-saved")).toBeVisible();

  await page.goto(`/evaluations/${evaluationId}/report`);
  const cards = page.locator('[data-interviewer="김면접"]');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute("data-latest", "false");
  await expect(cards.nth(0)).toContainText("이전 기록");
  await expect(cards.nth(1)).toHaveAttribute("data-latest", "true");
  await expect(cards.nth(1)).toContainText("요구사항 이해와 구현 정확성: 4 탁월");
});

test("저장된 스코어카드가 Markdown 내보내기에 실린다 (T-707)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/evaluations/${evaluationId}/report`);
  await page.getByRole("button", { name: "채용 리포트 Markdown 복사" }).click();
  const md = await page.evaluate<string>("navigator.clipboard.readText()");
  expect(md).toContain("### 저장된 스코어카드");
  expect(md).toContain("#### 김면접");
  expect(md).toContain("요구사항 이해와 구현 정확성: 4 탁월");
  expect(findForbiddenReportExpressions(md)).toEqual([]);
});

test("데스크톱(1440px)·모바일(390px)에서 스코어카드 절이 깨지지 않는다 (T-707)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(`/evaluations/${evaluationId}/report`);
  await expect(page.getByTestId("scorecard-form")).toBeVisible();
  await page.screenshot({
    path: path.join(SHOT_DIR, "t707-scorecard-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/evaluations/${evaluationId}/report`);
  await expect(page.getByTestId("scorecard-form")).toBeVisible();
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: path.join(SHOT_DIR, "t707-scorecard-mobile.png"),
    fullPage: true,
  });
});
