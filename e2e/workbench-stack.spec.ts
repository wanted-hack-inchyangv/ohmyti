import { createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, request as playwrightRequest, test, type Page } from "@playwright/test";
import {
  EvaluationReportSchema,
  RunRecordReportSchema,
  SubmissionSummarySchema,
  type EvaluationReport,
} from "@ohmyti/core";
import { createServerlessDb, type DbHandle } from "@ohmyti/db";
import { artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { sql } from "drizzle-orm";
import "../scripts/load-env";
import { seedSampleAssignment } from "../scripts/db-seed-sample";
import { SampleReposSchema, DEFAULT_REPOS } from "../scripts/gate-phase2";
import { ExpectedMatrixSchema, SAMPLE_DIR } from "../scripts/samples-check";
import {
  isHttpUp,
  repoRoot,
  stackArtifactRoot,
  stackPorts,
  startWorker,
  workerHealthUrl,
  type ManagedProcess,
} from "../scripts/stack-local";

/**
 * 3단계 게이트 E2E (T-308): 로컬 전체 스택(web + worker + PostgreSQL)에서 결함 샘플 C를 실제로 제출·채점한 뒤
 * "감점 클릭 → 근거 확인 → 재실행 → 사람 수정" 흐름을 브라우저로 검증한다. 다른 스펙과 달리 판정을 DB에 직접 넣지 않고
 * 워커가 만든 결과만 쓴다(G-07·G-08). 단계마다 스크린샷을 남겨 CI 아티팩트로 올린다.
 *
 * 워커: `E2E_WORKER_PORT`(기본 4320)의 `/healthz`가 응답하면(`pnpm stack:local`) 재사용하고, 아니면 `stack-local`의
 * 설정으로 직접 띄운 뒤 끝나면 내린다. 웹은 Playwright `webServer`(또는 재사용한 dev 서버)다.
 * 제출 입력은 공개 저장소 `sample-repos.json`의 C(SHA 고정)이므로 GitHub 접근이 필요하다.
 */

const R05_CASE_ID = "R-05-idempotent-resend";
/** 제출 → COMPLETED까지 기다리는 상한. 로컬 러너 기준 약 60~90초 */
const EVALUATION_TIMEOUT_MS = 8 * 60_000;
/** 재실행 → 새 기록까지 기다리는 상한 */
const RERUN_TIMEOUT_MS = 4 * 60_000;
const SHOT_DIR = path.join(repoRoot, "test-results", "phase3-screenshots");
const WORKER_LOG = path.join(repoRoot, "test-results", "stack-worker.log");

let handle: DbHandle;
let store: FsArtifactStore;
let worker: ManagedProcess | null = null;
let workerReused = false;
let submissionId: string;
let evaluationId: string;
let sampleSha: string;
let sampleRepoUrl: string;
let expectedDisplay: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(EVALUATION_TIMEOUT_MS + 3 * 60_000);
  const url = process.env.DATABASE_URL;
  test.skip(!url, "DATABASE_URL이 없어 전체 스택 E2E를 건너뜁니다");
  handle = createServerlessDb(url!);
  // beforeAll에서는 테스트 범위 fixture(`request`)를 쓸 수 없어 직접 만든다
  const request = await playwrightRequest.newContext({
    baseURL: test.info().project.use.baseURL!,
  });
  store = new FsArtifactStore({ root: stackArtifactRoot() });
  mkdirSync(SHOT_DIR, { recursive: true });

  // 현재 하네스 버전의 샘플 과제를 승인한다 (멱등). 워커는 하네스 버전이 다른 과제 버전을 거절한다
  const seeded = await seedSampleAssignment({ db: handle.db, store });
  expect(seeded.status).toBe("APPROVED");

  const repos = SampleReposSchema.parse(JSON.parse(await readFile(DEFAULT_REPOS, "utf8")));
  sampleRepoUrl = repos.samples.C.url;
  sampleSha = repos.samples.C.sha;
  const matrix = ExpectedMatrixSchema.parse(
    JSON.parse(await readFile(path.join(SAMPLE_DIR, "expected-matrix.json"), "utf8")),
  );
  const sampleC = matrix.samples.find((s) => s.id === "C")!;
  // T-403·T-404 뒤로 워커는 TEST_EFFECTIVENESS 단계를 실행하므로(MUTATION_STAGE_ENABLED 기본 true) R-12만 검토 대기다
  expectedDisplay = sampleC.scoreDisplay.beforeHumanReview;
  expect(sampleC.criteria["R-05"]).toMatchObject({ verdict: "FAIL", earnedPoints: 0 });

  // 워커: 이미 떠 있으면 재사용, 아니면 직접 띄운다
  const ports = stackPorts();
  if (await isHttpUp(workerHealthUrl(ports))) {
    workerReused = true;
  } else {
    mkdirSync(path.dirname(WORKER_LOG), { recursive: true });
    const log = createWriteStream(WORKER_LOG, { flags: "a" });
    worker = await startWorker({ ports, output: log });
  }

  // 샘플 C를 실제 입력 경로(공개 저장소 URL + 고정 SHA)로 제출하고 종료 상태까지 폴링한다
  const created = await request.post("/api/submissions", {
    data: {
      assignmentVersionId: seeded.assignmentVersionId,
      repoUrl: sampleRepoUrl,
      commitSha: sampleSha,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const createdBody = (await created.json()) as { data: { submissionId: string } };
  submissionId = createdBody.data.submissionId;

  const deadline = Date.now() + EVALUATION_TIMEOUT_MS;
  for (;;) {
    const res = await request.get(`/api/submissions/${submissionId}`);
    expect(res.status()).toBe(200);
    const summary = SubmissionSummarySchema.parse(((await res.json()) as { data: unknown }).data);
    if (summary.terminal) {
      expect(summary.status, `unsupportedReason=${summary.unsupportedReason}`).toBe("COMPLETED");
      evaluationId = summary.latestEvaluation!.id;
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `제출 ${submissionId}이(가) ${EVALUATION_TIMEOUT_MS}ms 안에 끝나지 않았습니다`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  await request.dispose();
});

test.afterAll(async () => {
  if (worker) await worker.stop();
  if (!handle) return;
  if (evaluationId) {
    await store.deletePrefix(artifactKeys.evaluationPrefix(evaluationId));
  }
  if (submissionId) {
    await store.deletePrefix(artifactKeys.submissionPrefix(submissionId));
    // execution_records는 불변(restrict FK + 트리거)이라 같은 트랜잭션에서 삭제 허용 설정을 켠 뒤 지운다 (T-506 경로)
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ohmyti.allow_execution_record_delete = 'on'`);
      await tx.execute(
        sql`delete from jobs where (type = 'RERUN_EXECUTION' and payload ->> 'evaluationId' in (select id::text from evaluations where submission_id = ${submissionId}))
          or (type = 'EVALUATE_SUBMISSION' and payload ->> 'submissionId' = ${submissionId})`,
      );
      // mutation_experiments는 execution_records를 restrict로 참조하므로 기록보다 먼저 지운다 (T-403)
      await tx.execute(
        sql`delete from mutation_experiments where evaluation_id in (select id from evaluations where submission_id = ${submissionId})`,
      );
      await tx.execute(
        sql`delete from evidences where evaluation_id in (select id from evaluations where submission_id = ${submissionId})`,
      );
      await tx.execute(
        sql`delete from execution_records where evaluation_id in (select id from evaluations where submission_id = ${submissionId})`,
      );
      await tx.execute(sql`delete from submissions where id = ${submissionId}`);
    });
  }
  await handle.close();
});

async function report(page: Page): Promise<EvaluationReport> {
  const res = await page.request.get(`/api/evaluations/${evaluationId}`);
  expect(res.status()).toBe(200);
  return EvaluationReportSchema.parse(((await res.json()) as { data: unknown }).data);
}

/** 단계 스크린샷: 파일로 남기고(CI 아티팩트) 리포트에도 붙인다 */
async function shot(page: Page, name: string): Promise<void> {
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await test.info().attach(name, { path: file, contentType: "image/png" });
}

test("C 평가 열기: 워커가 저장한 점수·SHA가 헤더에 그대로 보인다", async ({ page }) => {
  test.info().annotations.push({
    type: "stack",
    description: workerReused ? "worker reused (stack:local)" : "worker spawned by spec",
  });
  const data = await report(page);
  expect(data.submission.status).toBe("COMPLETED");
  expect(data.evaluation.submissionSha).toBe(sampleSha);
  expect(data.score?.display).toBe(expectedDisplay);
  const r05 = data.criterionResults.find((r) => r.criterionId === "R-05")!;
  expect(r05).toMatchObject({ verdict: "FAIL", earnedPoints: 0 });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/evaluations/${evaluationId}`);
  await expect(page.getByTestId("score-display")).toHaveText(data.score!.display);
  await expect(page.getByTestId("pending-badge")).toHaveText(
    `${data.score!.pendingPoints}점 검토 대기`,
  );
  await expect(page.getByTestId("header-sha").locator("code")).toHaveText(sampleSha.slice(0, 12));
  await expect(page.getByTestId("sample-badge")).toHaveCount(0);
  await expect(page.locator('[data-criterion="R-05"]')).toHaveAttribute("data-verdict", "FAIL");
  await shot(page, "01-evaluation-open");
});

test("R-05 실패 카드 클릭 → 중앙에 기대 1·실제 0, 재고 2 → 1 → 0 (워커 기록 그대로)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`/evaluations/${evaluationId}`);
  await page.locator('[data-criterion="R-05"] a').click();
  await expect(page).toHaveURL(/criterion=R-05/);
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-selected-criterion", "R-05");
  await expect(page.getByTestId("replay-criterion")).toHaveText("R-05");

  const runId = await page.getByTestId("workbench").getAttribute("data-selected-run");
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  const res = await page.request.get(`/api/evaluations/${evaluationId}/runs/${runId}`);
  expect(res.status()).toBe(200);
  const run = RunRecordReportSchema.parse(((await res.json()) as { data: unknown }).data);
  expect(run.record.kind).not.toBe("RERUN");
  expect(run.evidences.some((e) => e.testId === R05_CASE_ID)).toBe(true);
  const expected = run.expected as { expected: Record<string, unknown> };
  const actual = run.actual as { actual: Record<string, unknown> };
  expect(expected.expected["p1After.stock"]).toBe(1);
  expect(actual.actual["p1After.stock"]).toBe(0);

  const failedRow = page.locator('[data-check="p1After.stock"]');
  await expect(failedRow).toHaveAttribute("data-ok", "false");
  await expect(failedRow.getByTestId("check-expected")).toHaveText("1");
  await expect(failedRow.getByTestId("check-actual")).toHaveText("0");
  const stateCells = page.locator('[data-testid="timeline-state-after"][data-has-state="true"]');
  await expect(stateCells).toHaveCount(3);
  await expect(stateCells.nth(0)).toContainText("stock: 2");
  await expect(stateCells.nth(1)).toContainText("stock: 1");
  await expect(stateCells.nth(2)).toContainText("stock: 0");
  await expect(page.getByTestId("run-list").locator("[data-run]")).toHaveCount(1);
  await shot(page, "02-r05-replay");
});

test("코드 탭: 핸들러 위치 스니펫이 리포트 근거와 같고 GitHub 링크는 고정 SHA만 쓴다", async ({
  page,
}) => {
  const data = await report(page);
  const r05 = data.criterionResults.find((r) => r.criterionId === "R-05")!;
  const relation = data.evidences.find(
    (e) => r05.evidenceIds.includes(e.id) && e.kind === "STATIC_RELATION",
  );
  expect(relation, "워커가 R-05에 정적 관계 근거(핸들러 위치)를 붙여야 한다").toBeDefined();
  const source = relation!.source!;
  expect(source.path).toBe("src/http/routes.ts");

  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(`/evaluations/${evaluationId}?criterion=R-05&pane=code`);
  const panel = page.getByTestId("code-evidence");
  await expect(panel).toHaveAttribute("data-code-status", "ok");
  await expect(panel).toHaveAttribute("data-pinned-sha", sampleSha);
  const item = page.locator(
    `[data-testid="code-evidence-item"][data-evidence-id="${relation!.id}"]`,
  );
  await expect(item).toHaveAttribute("data-evidence-label", "정적 관계");
  await expect(item).toHaveAttribute(
    "data-source",
    `${source.path}:${source.startLine}-${source.endLine}`,
  );
  const snippetLines = relation!.snippet!.split(/\r?\n/);
  const lineEls = item.locator("[data-line]");
  await expect(lineEls).toHaveCount(snippetLines.length);
  for (let i = 0; i < snippetLines.length; i += 1) {
    await expect(lineEls.nth(i)).toHaveAttribute("data-line", String(source.startLine + i));
    expect(await lineEls.nth(i).locator("span").nth(1).textContent()).toBe(snippetLines[i]);
  }
  const links = page.locator('[data-testid="github-link"]');
  const linkCount = await links.count();
  expect(linkCount).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < linkCount; i += 1) {
    const href = (await links.nth(i).getAttribute("href")) ?? "";
    expect(href.startsWith(`${sampleRepoUrl}/blob/${sampleSha}/`)).toBe(true);
    expect(href).toMatch(/#L\d+-L\d+$/);
  }
  expect(await page.content()).not.toMatch(/blob\/HEAD|blob\/main|\/tree\//);
  await shot(page, "03-code-evidence");
});

test("재실행: 워커가 새 기록을 만들고 원본 기록은 그대로다", async ({ page }) => {
  test.setTimeout(RERUN_TIMEOUT_MS + 60_000);
  const before = await report(page);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`/evaluations/${evaluationId}?criterion=R-05`);
  const button = page.getByTestId("rerun-button");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId("rerun-status")).toHaveAttribute(
    "data-rerun-status",
    /queued|running/,
  );
  await shot(page, "04-rerun-queued");

  // 폴링이 job 완료를 감지해 페이지를 다시 그리면 기록 목록에 재실행 기록이 나타난다
  const rerunRow = page.locator('[data-run][data-origin="rerun"]');
  await expect(rerunRow).toHaveCount(1, { timeout: RERUN_TIMEOUT_MS });
  await expect(page.getByTestId("run-list").locator("[data-run]")).toHaveCount(2);

  const after = await report(page);
  expect(after.executionRecords).toHaveLength(before.executionRecords.length + 1);
  const originalIds = new Set(before.executionRecords.map((r) => r.id));
  expect(after.executionRecords.filter((r) => originalIds.has(r.id))).toEqual(
    before.executionRecords,
  );
  const rerun = after.executionRecords.find((r) => !originalIds.has(r.id))!;
  expect(rerun.kind).toBe("RERUN");
  expect(after.score).toEqual(before.score);
  expect(after.criterionResults.map((r) => [r.criterionId, r.earnedPoints, r.verdict])).toEqual(
    before.criterionResults.map((r) => [r.criterionId, r.earnedPoints, r.verdict]),
  );

  // 재실행 기록을 열면 원본과 같은 actual(재고 0)과 비교 배지가 보인다
  await rerunRow.locator("a").first().click();
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-selected-run", rerun.id);
  await expect(page.getByTestId("rerun-comparison")).toHaveAttribute("data-outcome", "same");
  await expect(page.locator('[data-check="p1After.stock"]').getByTestId("check-actual")).toHaveText(
    "0",
  );
  await shot(page, "05-rerun-record");
});

test("R-12 설계 점수 승인: 헤더 점수가 API 값으로 갱신되고 검토 대기 배점이 10 준다", async ({
  page,
}) => {
  const before = await report(page);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`/evaluations/${evaluationId}?criterion=R-12`);
  await expect(page.getByTestId("pending-badge")).toHaveText(
    `${before.score!.pendingPoints}점 검토 대기`,
  );
  await page.getByTestId("review-action-APPROVE_DESIGN").click();
  const dialog = page.getByTestId("review-dialog");
  await expect(dialog).toHaveAttribute("data-review-kind", "APPROVE_DESIGN");
  const boxes = dialog.locator('input[name="satisfied"]');
  await expect(boxes).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) await boxes.nth(i).check();
  await dialog.locator('input[name="reviewer"]').fill("phase3-gate@example.com");
  await shot(page, "06-approve-design-dialog");
  await page.getByTestId("review-submit").click();
  await expect(page.getByTestId("review-dialog")).toHaveCount(0);
  await expect(page.getByTestId("review-result")).toContainText("설계 점수 확정 저장됨");

  const after = await report(page);
  expect(after.score!.pendingPoints).toBe(before.score!.pendingPoints - 10);
  expect(after.score!.earned).toBe(before.score!.earned + 10);
  await expect(page.getByTestId("score-display")).toHaveText(after.score!.display);
  await expect(page.getByTestId("pending-badge")).toHaveText(
    `${after.score!.pendingPoints}점 검토 대기`,
  );
  const r12 = after.criterionResults.find((r) => r.criterionId === "R-12")!;
  expect(r12).toMatchObject({ earnedPoints: 10, verdict: "PASS", reviewState: "CONFIRMED" });
  expect(after.reviewEvents.find((e) => e.criterionId === "R-12")).toMatchObject({
    kind: "APPROVE_DESIGN",
    reviewer: "phase3-gate@example.com",
    previous: { earnedPoints: null },
    next: { earnedPoints: 10 },
  });
  await shot(page, "07-header-after-approve");
});
