import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { aggregateScore } from "@ohmyti/core";
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
 * 사람 검토 E2E (T-306). 부록 A rubric에 R-01 PASS·R-05 FAIL·R-12 INCONCLUSIVE를 심고 실제 페이지에서
 * 모달로 OVERRIDE·APPROVE_DESIGN을 실행해 헤더 점수·검토 대기 배점·이력이 리포트 API 값과 함께 갱신되는지 본다.
 * 워크벤치 E2E(`workbench.spec.ts`)의 필터 개수 검사가 점수 변경에 흔들리지 않도록 평가를 따로 만든다.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
let handle: DbHandle;
let assignmentId: string;
let evaluationId: string;

interface ReportBody {
  ok: true;
  data: {
    score: { display: string; earned: number; pendingPoints: number };
    criterionResults: Array<{
      criterionId: string;
      earnedPoints: number | null;
      verdict: string;
      reviewState: string;
      evidenceIds: string[];
    }>;
    evidences: Array<{ id: string; kind?: string }>;
    reviewEvents: Array<{
      criterionId: string;
      kind: string;
      reviewer: string;
      reason: string;
      previous: { earnedPoints: number | null };
      next: { earnedPoints: number | null };
      createdAt: string;
    }>;
  };
}

test.beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  test.skip(!url, "DATABASE_URL이 없어 검토 E2E를 건너뜁니다");
  handle = createServerlessDb(url!);
  const rubricVersion = `e2e-t306-${randomUUID().slice(0, 8)}`;
  const rubric = { ...sampleRubric(), version: rubricVersion };

  const [assignment] = await handle.db
    .insert(assignments)
    .values({ name: "e2e-t306" })
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

  const evidenceId = randomUUID();
  const criterionResults: (NewCriterionResult & { evaluationId: string })[] = [
    {
      evaluationId,
      criterionId: "R-01",
      rubricVersion,
      maxPoints: 8,
      earnedPoints: 8,
      verdict: "PASS",
      method: "EXECUTION",
      evidenceIds: [],
      observation: "정상 주문 통과",
      reviewState: "NOT_REQUIRED",
    },
    {
      evaluationId,
      criterionId: "R-05",
      rubricVersion,
      maxPoints: 14,
      earnedPoints: 0,
      verdict: "FAIL",
      method: "EXECUTION",
      evidenceIds: [evidenceId],
      issueId: "case:R-05-idempotent-resend",
      observation: "재전송 시 재고가 두 번 차감됨",
      reviewState: "NOT_REQUIRED",
    },
    {
      evaluationId,
      criterionId: "R-12",
      rubricVersion,
      maxPoints: 10,
      earnedPoints: null,
      verdict: "INCONCLUSIVE",
      method: "HUMAN_REVIEW",
      evidenceIds: [],
      observation: "사람 검토 대기",
      reviewState: "PENDING",
    },
  ];
  const summary = aggregateScore(criterionResults, rubric);
  await persistEvaluationResults(handle.db, {
    evaluationId,
    executionRecords: [],
    evidences: [
      {
        id: evidenceId,
        evaluationId,
        submissionSha: SHA,
        testId: "R-05-idempotent-resend",
        artifactRefs: [],
      },
    ],
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
});

test.afterAll(async () => {
  if (!handle) return;
  if (assignmentId) {
    // review_events·evidences·criterion_results는 평가 삭제 cascade로 함께 지워진다
    await handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`delete from submissions where assignment_version_id in (select id from assignment_versions where assignment_id = ${assignmentId})`,
      );
      await tx.execute(sql`delete from assignments where id = ${assignmentId}`);
    });
  }
  await handle.close();
});

async function report(page: Page): Promise<ReportBody["data"]> {
  const res = await page.request.get(`/api/evaluations/${evaluationId}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as ReportBody).data;
}

test("OVERRIDE: 사유 없음·max 초과는 모달에서 거부되고, 저장하면 헤더 점수와 이력이 API 값으로 갱신된다", async ({
  page,
}) => {
  const before = await report(page);
  await page.goto(`/evaluations/${evaluationId}?criterion=R-05`);
  await expect(page.getByTestId("score-display")).toHaveText(before.score.display);
  await expect(page.getByTestId("review-history-empty")).toBeVisible();

  await page.getByTestId("review-action-OVERRIDE").click();
  const dialog = page.getByTestId("review-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-review-kind", "OVERRIDE");

  // 사유 없음 + max 초과: 저장되지 않는다
  await dialog.locator('input[name="reviewer"]').fill("reviewer@example.com");
  await dialog.locator('input[name="earnedPoints"]').fill("15");
  await page.getByTestId("review-submit").click();
  await expect(page.getByTestId("error-reason")).toHaveText("사유를 입력하세요");
  await expect(page.getByTestId("error-earnedPoints")).toHaveText(
    "점수는 배점(14) 이하여야 합니다",
  );
  expect((await report(page)).reviewEvents).toHaveLength(0);

  // 음수도 거부
  await dialog.locator('input[name="earnedPoints"]').fill("-1");
  await page.getByTestId("review-submit").click();
  await expect(page.getByTestId("error-earnedPoints")).toHaveText("점수는 음수일 수 없습니다");

  // 올바른 입력: 저장 후 헤더·이력 갱신
  await dialog.locator('textarea[name="reason"]').fill("재현 결과를 검토했고 정상 동작으로 판단");
  await dialog.locator('input[name="earnedPoints"]').fill("14");
  await page.getByTestId("review-submit").click();
  await expect(page.getByTestId("review-result")).toContainText("점수 수정 저장됨");
  await expect(page.getByTestId("review-dialog")).toHaveCount(0);

  const after = await report(page);
  expect(after.score.earned).toBe(before.score.earned + 14);
  expect(after.score.pendingPoints).toBe(before.score.pendingPoints);
  await expect(page.getByTestId("score-display")).toHaveText(after.score.display);
  expect(after.reviewEvents).toHaveLength(1);
  expect(after.reviewEvents[0]).toMatchObject({
    criterionId: "R-05",
    kind: "OVERRIDE",
    reviewer: "reviewer@example.com",
    reason: "재현 결과를 검토했고 정상 동작으로 판단",
    previous: { earnedPoints: 0 },
    next: { earnedPoints: 14 },
  });
  const r05 = after.criterionResults.find((r) => r.criterionId === "R-05")!;
  expect(r05).toMatchObject({ earnedPoints: 14, verdict: "PASS", reviewState: "CONFIRMED" });

  const events = page.getByTestId("review-event");
  await expect(events).toHaveCount(1);
  await expect(events.first()).toHaveAttribute("data-review-kind", "OVERRIDE");
  await expect(events.first().getByTestId("review-change")).toContainText("0/14 → 14/14");
  await expect(events.first().getByTestId("review-reason")).toHaveText(
    "재현 결과를 검토했고 정상 동작으로 판단",
  );
  // 이력에는 삭제 버튼이 없다
  await expect(page.getByTestId("review-history").locator("button")).toHaveCount(0);

  // 같은 기준을 한 번 더 수정하면 두 이벤트가 시간순으로 남는다
  await page.getByTestId("review-action-OVERRIDE").click();
  const second = page.getByTestId("review-dialog");
  await second.locator('input[name="reviewer"]').fill("other@example.com");
  await second.locator('input[name="earnedPoints"]').fill("7");
  await second.locator('textarea[name="reason"]').fill("재검토: 절반만 인정");
  await page.getByTestId("review-submit").click();
  await expect(page.getByTestId("review-dialog")).toHaveCount(0);
  await expect(page.getByTestId("review-event")).toHaveCount(2);
  const twice = await report(page);
  const r05Events = twice.reviewEvents.filter((e) => e.criterionId === "R-05");
  expect(r05Events.map((e) => e.next.earnedPoints)).toEqual([14, 7]);
  expect(r05Events[0]!.createdAt <= r05Events[1]!.createdAt).toBe(true);
  await expect(page.getByTestId("score-display")).toHaveText(twice.score.display);
  expect(twice.score.earned).toBe(before.score.earned + 7);
});

test("R-12 APPROVE_DESIGN: 검토 대기 배점이 10 줄고 확정 점수가 그만큼 는다", async ({ page }) => {
  const before = await report(page);
  await page.goto(`/evaluations/${evaluationId}?criterion=R-12`);
  await expect(page.getByTestId("pending-badge")).toHaveText(
    `${before.score.pendingPoints}점 검토 대기`,
  );

  await page.getByTestId("review-action-APPROVE_DESIGN").click();
  const dialog = page.getByTestId("review-dialog");
  await expect(dialog).toHaveAttribute("data-review-kind", "APPROVE_DESIGN");
  const boxes = dialog.locator('input[name="satisfied"]');
  await expect(boxes).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) await boxes.nth(i).check();
  await expect(dialog.getByTestId("sub-criteria")).toContainText("합계 10/10");
  await dialog.locator('input[name="reviewer"]').fill("reviewer@example.com");
  await page.getByTestId("review-submit").click();
  await expect(page.getByTestId("review-dialog")).toHaveCount(0);
  await expect(page.getByTestId("review-result")).toContainText("설계 점수 확정 저장됨");

  const after = await report(page);
  expect(after.score.pendingPoints).toBe(before.score.pendingPoints - 10);
  expect(after.score.earned).toBe(before.score.earned + 10);
  await expect(page.getByTestId("score-display")).toHaveText(after.score.display);
  await expect(page.getByTestId("pending-badge")).toHaveText(
    `${after.score.pendingPoints}점 검토 대기`,
  );
  const r12 = after.criterionResults.find((r) => r.criterionId === "R-12")!;
  expect(r12).toMatchObject({ earnedPoints: 10, verdict: "PASS", reviewState: "CONFIRMED" });
  await expect(page.locator('[data-panel="evidence"] [data-review-state="CONFIRMED"]')).toHaveCount(
    1,
  );
  const approve = after.reviewEvents.find((e) => e.criterionId === "R-12")!;
  expect(approve).toMatchObject({
    kind: "APPROVE_DESIGN",
    previous: { earnedPoints: null },
    next: { earnedPoints: 10 },
  });
});
