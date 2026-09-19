import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  aggregateScore,
  INTERVIEW_KIT_SCHEMA_VERSION,
  InterviewKitSchema,
  InterviewKitReportResponseSchema,
  type InterviewKit,
} from "@ohmyti/core";
import { sampleRubric } from "@ohmyti/core/fixtures";
import { ORDER_API_V1_CASES, runCases, type CaseResult } from "@ohmyti/harness";
import { startFakeOrderApi } from "@ohmyti/harness/test-support";
import {
  assignmentVersions,
  assignments,
  createServerlessDb,
  evaluations,
  finishEvaluation,
  persistEvaluationResults,
  replaceContextLinks,
  setSubmissionStatus,
  submissions,
  upsertSubmissionContext,
  type DbHandle,
  type NewCriterionResult,
} from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { sql } from "drizzle-orm";
import "../scripts/load-env";
import { stackArtifactRoot } from "../scripts/stack-local";

/**
 * 인터뷰 키트 화면 E2E (T-704, PRD 14.2). 워커의 INTERVIEW_KIT 단계(T-702)가 저장하는 형태 그대로의 키트 아티팩트와
 * R-05 실패의 실행 기록을 넣고, 하단 탭 `인터뷰 키트`에서 다음을 확인한다.
 * - 실패 디브리핑 카드의 근거를 누르면 그 기준의 재생이 열린다
 * - 45분·60분 진행안의 구간 합이 각각 45·60분 이내다
 * - Markdown 복사 결과에 필수 질문·꼬리 질문·신호·고정 SHA 근거 URL이 들어 있다
 * - 인쇄용 보기(`/evaluations/<id>/interview-kit`)를 PDF로 만들고 데스크톱·모바일 화면을 스크린샷으로 남긴다
 * - 키트가 없는 평가는 이전 후속 질문 목록으로 보인다
 * 키트 없는 평가의 후속 질문 목록·복사는 `e2e/workbench.spec.ts`(T-504)가 함께 확인한다.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
const R05_CASE_ID = "R-05-idempotent-resend";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_DIR = path.join(repoRoot, "test-results", "t704-screenshots");
const RESUME_CLAIM = "Designed idempotent payment endpoints";
/** 브라우저에서 질문 카드를 고르는 선택자 (인쇄용 보기 / 워크벤치 탭) */
const PRINT_CARD = '[data-testid="interview-kit-print"] .kit-card';
const TAB_CARD = '[data-testid="interview-kit"] .kit-card';

let handle: DbHandle;
let assignmentId: string;
let evaluationId: string;
let r05RunId: string;
let store: FsArtifactStore;
let artifactKeyList: string[] = [];

/** 워커가 저장하는 형태의 키트. 실패 디브리핑·테스트 설계·이력서 연결 세 질문과 45분·60분 진행안을 담는다 */
function buildKit(input: {
  evaluationId: string;
  runId: string;
  contextLinkId: string;
}): InterviewKit {
  return InterviewKitSchema.parse({
    schemaVersion: INTERVIEW_KIT_SCHEMA_VERSION,
    evaluationId: input.evaluationId,
    questions: [
      {
        id: "FAILURE_DEBRIEF:R-05",
        kind: "FAILURE_DEBRIEF",
        competency: "DEBUGGING",
        priority: "MUST",
        minutes: 8,
        question:
          "R-05 재생 기록을 함께 보겠습니다. 같은 멱등 키로 재전송했을 때 재고가 두 번 줄어든 지점을 짚어 주시겠어요?",
        intent: "관측된 실패에서 근거를 따라 원인 코드까지 범위를 좁히는지 확인합니다.",
        probes: [
          "재전송 요청이 처음 요청과 같은 키인지는 어디에서 판단하나요?",
          "저장과 차감의 순서를 어떤 기준으로 정하셨나요?",
        ],
        positiveSignals: [
          "재생 기록의 요청 순서를 짚어 가며 원인 구간을 좁힌다.",
          "재현 조건을 스스로 다시 만들어 설명한다.",
        ],
        concernSignals: [
          "기록을 보지 않고 일반론으로만 답한다.",
          "원인을 환경 탓으로 돌리고 코드 경로를 말하지 못한다.",
        ],
        refs: [
          { kind: "CRITERION", criterionId: "R-05" },
          { kind: "EXECUTION_RECORD", runId: input.runId, criterionId: "R-05" },
          { kind: "SOURCE", location: { path: "src/http/routes.ts", startLine: 25, endLine: 28 } },
        ],
        source: "LLM",
      },
      {
        id: "TEST_DESIGN:G1",
        kind: "TEST_DESIGN",
        competency: "TESTING",
        priority: "SHOULD",
        minutes: 6,
        question: "경계 입력을 다루는 테스트를 지금 하나 더 쓴다면 어떤 것을 먼저 쓰시겠어요?",
        intent: "결함을 실제로 잡는 테스트를 설계하는 기준이 있는지 확인합니다.",
        probes: [
          "그 테스트가 실패하려면 구현이 어떻게 달라져야 하나요?",
          "지금 테스트에서 빠졌다고 보는 구간은 어디인가요?",
        ],
        positiveSignals: [
          "잡으려는 결함을 먼저 말하고 테스트를 설계한다.",
          "기존 테스트의 빈틈을 스스로 짚는다.",
        ],
        concernSignals: [
          "커버리지 수치로만 충분하다고 답한다.",
          "테스트가 무엇을 막는지 설명하지 못한다.",
        ],
        refs: [{ kind: "CRITERION", criterionId: "G1" }],
        source: "TEMPLATE",
      },
      {
        id: "RESUME_BRIDGE:1",
        kind: "RESUME_BRIDGE",
        competency: "DATA_INTEGRITY",
        priority: "SHOULD",
        minutes: 5,
        question: "이력서에 적으신 멱등 결제 엔드포인트에서는 재전송을 어떤 기준으로 구분하셨나요?",
        intent: "이력서 경험의 조건과 이번 과제의 조건 차이를 확인합니다.",
        probes: ["그때의 트래픽 조건은 어땠나요?", "같은 응답인지는 어떻게 확인하셨나요?"],
        positiveSignals: [
          "두 구현의 조건 차이를 스스로 구분한다.",
          "확인 방법을 구체적으로 설명한다.",
        ],
        concernSignals: ["경험과 과제를 같은 조건으로 뭉뚱그린다.", "확인 방법을 말하지 못한다."],
        refs: [{ kind: "CONTEXT_LINK", contextLinkId: input.contextLinkId }],
        source: "LLM",
      },
    ],
    plans: [
      {
        durationMinutes: 45,
        segments: [
          { name: "도입", minutes: 5, questionIds: [] },
          { name: "실패 디브리핑", minutes: 8, questionIds: ["FAILURE_DEBRIEF:R-05"] },
          { name: "테스트 설계", minutes: 6, questionIds: ["TEST_DESIGN:G1"] },
          { name: "지원자 질문", minutes: 5, questionIds: [] },
        ],
      },
      {
        durationMinutes: 60,
        segments: [
          { name: "도입", minutes: 5, questionIds: [] },
          { name: "실패 디브리핑", minutes: 8, questionIds: ["FAILURE_DEBRIEF:R-05"] },
          { name: "테스트 설계", minutes: 6, questionIds: ["TEST_DESIGN:G1"] },
          { name: "이력서 연결", minutes: 5, questionIds: ["RESUME_BRIDGE:1"] },
          { name: "지원자 질문", minutes: 5, questionIds: [] },
        ],
      },
    ],
    generation: {
      slotCount: 3,
      templateCount: 1,
      llm: "OK",
      llmReason: null,
      promptVersion: "interview-kit-1",
      model: "deepseek-chat",
      aiReviewId: randomUUID(),
      inputDigest: DIGEST,
      dropped: [
        {
          index: 1,
          slotId: "TEST_DESIGN:G1",
          reason: "LINT_VIOLATION",
          rules: ["COMPOUND_QUESTION"],
        },
      ],
    },
  });
}

test.beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  test.skip(!url, "DATABASE_URL이 없어 인터뷰 키트 E2E를 건너뜁니다");
  handle = createServerlessDb(url!);
  const rubricVersion = `e2e-t704-${randomUUID().slice(0, 8)}`;
  const rubric = { ...sampleRubric(), version: rubricVersion };

  const [assignment] = await handle.db
    .insert(assignments)
    .values({ name: `e2e-t704-${randomUUID().slice(0, 8)}` })
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

  const runId = randomUUID();
  r05RunId = runId;
  const evidenceId = randomUUID();
  const key = (part: string) => `evaluations/${evaluationId}/runs/${runId}/${part}.json`;

  // R-05 케이스를 결함 구현(멱등성 없음)에 실제로 돌려 재생 화면이 읽을 기록 본문을 만든다
  const api = await startFakeOrderApi({ idempotency: false });
  let r05Result: CaseResult;
  try {
    [r05Result] = (await runCases(ORDER_API_V1_CASES, {
      baseUrl: api.baseUrl,
      timeoutMs: 5000,
      caseIds: [R05_CASE_ID],
    })) as [CaseResult];
  } finally {
    await api.close();
  }
  expect(r05Result.verdict).toBe("FAIL");
  store = new FsArtifactStore({ root: stackArtifactRoot() });
  const bodies: Record<string, unknown> = {
    input: {
      kind: "HARNESS_CASE",
      caseId: R05_CASE_ID,
      criterionIds: r05Result.criterionIds,
      caseSet: "order-api-v1",
      harnessVersion: "harness-0",
      requestTimeoutMs: 5000,
      resetPath: "/admin/reset",
      definition: null,
    },
    expected: {
      caseId: R05_CASE_ID,
      expected: r05Result.expected,
      checks: r05Result.checks.map((c) => ({ name: c.name, expected: c.expected })),
    },
    actual: {
      caseId: R05_CASE_ID,
      verdict: r05Result.verdict,
      failureKind: r05Result.failureKind,
      reason: r05Result.reason ?? null,
      actual: r05Result.actual,
      checks: r05Result.checks,
    },
    timeline: r05Result.timeline,
  };
  artifactKeyList = Object.keys(bodies).map(key);
  for (const [part, body] of Object.entries(bodies)) {
    await store.put(key(part), JSON.stringify(body), {
      contentType: ARTIFACT_CONTENT_TYPES.runRecord,
    });
  }

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
      issueId: `case:${R05_CASE_ID}`,
      observation: "재전송 시 재고가 두 번 차감됨",
      reviewState: "NOT_REQUIRED",
    },
  ];
  const summary = aggregateScore(criterionResults, rubric);
  await persistEvaluationResults(handle.db, {
    evaluationId,
    executionRecords: [
      {
        id: runId,
        evaluationId,
        kind: "HARNESS",
        submissionSha: SHA,
        rubricVersion,
        harnessVersion: "harness-0",
        environmentDigest: DIGEST,
        inputRef: key("input"),
        expectedRef: key("expected"),
        actualRef: key("actual"),
        exitCode: null,
        failureKind: r05Result.failureKind,
        startedAt: r05Result.startedAt,
        finishedAt: r05Result.finishedAt,
      },
    ],
    evidences: [
      {
        id: evidenceId,
        evaluationId,
        submissionSha: SHA,
        runId,
        testId: R05_CASE_ID,
        artifactRefs: artifactKeyList,
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
  await upsertSubmissionContext(handle.db, submission!.id, {
    resumeRef: `submissions/${submission!.id}/resume.pdf`,
    githubLogin: "octo",
  });
  const links = await replaceContextLinks(handle.db, {
    submissionId: submission!.id,
    evaluationId,
    links: [
      {
        claim: RESUME_CLAIM,
        claimSource: "RESUME",
        status: "EVIDENCE_FOUND",
        assignmentObservation: { criterionId: "R-05", summary: "재전송 시 재고가 두 번 차감됨" },
        followUpQuestion:
          "이력서에 적으신 멱등 결제 엔드포인트에서는 재전송을 어떤 기준으로 구분하셨나요?",
      },
    ],
  });
  const kitKey = artifactKeys.interviewKit(evaluationId);
  await store.put(
    kitKey,
    JSON.stringify(buildKit({ evaluationId, runId, contextLinkId: links[0]!.id })),
    { contentType: ARTIFACT_CONTENT_TYPES.interviewKit },
  );
  artifactKeyList.push(kitKey);
  await mkdir(SHOT_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (!handle) return;
  for (const k of artifactKeyList) await store.delete(k);
  if (assignmentId) {
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ohmyti.allow_execution_record_delete = 'on'`);
      await tx.execute(sql`delete from evidences where evaluation_id = ${evaluationId}`);
      await tx.execute(sql`delete from execution_records where evaluation_id = ${evaluationId}`);
      await tx.execute(
        sql`delete from submissions where assignment_version_id in (select id from assignment_versions where assignment_id = ${assignmentId})`,
      );
      await tx.execute(sql`delete from assignments where id = ${assignmentId}`);
    });
  }
  await handle.close();
});

test("조회 API가 저장된 키트를 그대로 돌려주고, 없는 평가는 404다 (T-704)", async ({ request }) => {
  const res = await request.get(`/api/evaluations/${evaluationId}/interview-kit`);
  expect(res.status()).toBe(200);
  const body = InterviewKitReportResponseSchema.parse(await res.json());
  expect(body.ok).toBe(true);
  if (!body.ok) throw new Error("키트 응답이 ok가 아닙니다");
  expect(body.data.kit.questions.map((q) => q.id)).toEqual([
    "FAILURE_DEBRIEF:R-05",
    "TEST_DESIGN:G1",
    "RESUME_BRIDGE:1",
  ]);
  // 키트에는 점수·판정이 없다 (G-01)
  expect(JSON.stringify(body.data)).not.toMatch(/earnedPoints|verdict|PASS|FAIL"/);

  const missing = await request.get(`/api/evaluations/${randomUUID()}/interview-kit`);
  expect(missing.status()).toBe(404);
});

test("실패 디브리핑 카드의 근거를 누르면 그 기준의 재생이 열린다 (T-704)", async ({ page }) => {
  await page.goto(`/evaluations/${evaluationId}?tab=questions`);
  const panel = page.getByTestId("tab-panel-questions");
  await expect(panel.getByTestId("interview-kit")).toBeVisible();
  await expect(page.getByRole("tab", { name: "인터뷰 키트" })).toHaveAttribute(
    "data-tab",
    "questions",
  );

  const card = panel.locator('[data-kit-question="FAILURE_DEBRIEF:R-05"]');
  await expect(card).toHaveAttribute("data-priority", "MUST");
  await expect(card.getByTestId("kit-competency")).toHaveText("원인 분석");
  await expect(card.getByTestId("kit-minutes")).toHaveText("8분");
  await expect(card.getByTestId("kit-probes").locator("li")).toHaveCount(2);
  await expect(card.getByTestId("kit-positive").locator("li")).toHaveCount(2);
  await expect(card.getByTestId("kit-concern").locator("li")).toHaveCount(2);
  // 기본 질문 표시와 검사 안내 (G-14)
  await expect(
    panel.locator('[data-kit-question="TEST_DESIGN:G1"]').getByTestId("kit-template-badge"),
  ).toHaveText("기본 질문");
  await expect(panel.getByTestId("kit-template-notice")).toContainText("기본 질문으로 바꿨습니다");
  await expect(panel.getByTestId("kit-resume-quote-notice")).toContainText("이력서의 인용");

  // 근거의 재생 링크를 누르면 그 기준의 재생이 열린다
  await card.locator('[data-kit-ref="EXECUTION_RECORD"] a').click();
  await expect(page).toHaveURL(new RegExp(`criterion=R-05&run=${r05RunId}`));
  await expect(page.getByTestId("replay-criterion")).toHaveText("R-05");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-selected-run", r05RunId);
});

test("45분·60분 진행안의 구간 합이 각각 45·60분 이내이고 전환된다 (T-704)", async ({ page }) => {
  await page.goto(`/evaluations/${evaluationId}?tab=questions`);
  const plan = page.getByTestId("kit-plan");
  await expect(plan.getByTestId("kit-plan-total")).toHaveText("구간 합 24분 / 45분");

  const sumOf = async (duration: number) => {
    const segments = plan.locator(`ol[data-plan="${duration}"] [data-plan-segment]`);
    let sum = 0;
    for (const segment of await segments.all()) {
      sum += Number(await segment.getAttribute("data-minutes"));
    }
    return sum;
  };
  expect(await sumOf(45)).toBe(24);
  expect(await sumOf(45)).toBeLessThanOrEqual(45);

  await plan.locator('[data-plan-duration="60"]').click();
  await expect(plan.locator('[data-plan-duration="60"]')).toHaveAttribute("aria-pressed", "true");
  await expect(plan.getByTestId("kit-plan-total")).toHaveText("구간 합 29분 / 60분");
  expect(await sumOf(60)).toBe(29);
  expect(await sumOf(60)).toBeLessThanOrEqual(60);

  // 진행안의 질문을 누르면 그 카드로 이동한다
  await plan.locator('a[href="#kit-q-RESUME_BRIDGE-1"]').click();
  await expect(page.locator("#kit-q-RESUME_BRIDGE-1")).toBeVisible();
});

test("Markdown 복사 결과에 필수 질문·꼬리 질문·신호·고정 SHA 근거 URL이 들어 있다 (T-704)", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/evaluations/${evaluationId}?tab=questions`);
  await page.getByRole("button", { name: "인터뷰 키트 Markdown 복사" }).click();
  const md = await page.evaluate<string>("navigator.clipboard.readText()");
  expect(md).toContain("# 인터뷰 키트 · 주문·재고 API");
  expect(md).toContain("## 필수 질문");
  expect(md).toContain("R-05 재생 기록을 함께 보겠습니다.");
  expect(md).toContain("**꼬리 질문**");
  expect(md).toContain("**좋은 답변의 신호**");
  expect(md).toContain("**우려 신호**");
  expect(md).toContain(
    `https://github.com/example/order-api/blob/${SHA}/src/http/routes.ts#L25-L28`,
  );
  expect(md).toContain(`/evaluations/${evaluationId}?criterion=R-05&run=${r05RunId}`);
  expect(md).not.toMatch(/blob\/HEAD|blob\/main/);
  expect(md).toContain("## 45분 진행안 (구간 합 24분)");
  expect(md).toContain("## 60분 진행안 (구간 합 29분)");
  expect(md).toContain("## 평가 척도 (역량별 4단계, 면접관 기입)");
});

test("인쇄용 보기를 PDF로 만들면 질문 카드가 페이지 경계에서 잘리지 않는다 (T-704)", async ({
  page,
}) => {
  await page.goto(`/evaluations/${evaluationId}?tab=questions`);
  await page.getByTestId("kit-print-link").click();
  await expect(page).toHaveURL(new RegExp(`/evaluations/${evaluationId}/interview-kit$`));
  const print = page.getByTestId("interview-kit-print");
  await expect(print).toHaveAttribute("data-kit-state", "ok");
  await expect(print.locator("[data-kit-question]")).toHaveCount(3);
  // 진행안 두 개가 모두 펼쳐져 있고 평가 척도도 접힘 없이 보인다
  await expect(print.getByTestId("kit-print-plan")).toHaveCount(2);
  await expect(print.getByTestId("kit-print-anchors")).toBeVisible();
  // 인쇄물에는 근거 주소를 글자로 적는다
  await expect(print.locator('[data-kit-ref="SOURCE"]')).toContainText(
    `https://github.com/example/order-api/blob/${SHA}/src/http/routes.ts#L25-L28`,
  );

  // 인쇄 미디어에서 질문 카드는 페이지 경계에서 쪼개지지 않는다
  await page.emulateMedia({ media: "print" });
  const breaks = await page.evaluate<string[]>(
    `Array.from(document.querySelectorAll('${PRINT_CARD}')).map((el) => getComputedStyle(el).breakInside)`,
  );
  expect(breaks.length).toBe(3);
  for (const value of breaks) expect(value).toBe("avoid");
  // A4 세로(14mm 여백)에서 카드 하나가 한 페이지 안에 들어간다
  const A4_CONTENT_PX = ((297 - 28) / 25.4) * 96;
  const heights = await page.evaluate<number[]>(
    `Array.from(document.querySelectorAll('${PRINT_CARD}')).map((el) => el.getBoundingClientRect().height)`,
  );
  for (const height of heights) expect(height).toBeLessThan(A4_CONTENT_PX);

  // `page.pdf()`는 print 미디어로 그린다. 사이트 머리글과 인쇄 안내는 빠지고 카드는 페이지 경계에서 잘리지 않는다
  await page.pdf({
    path: path.join(SHOT_DIR, "t704-interview-kit-print.pdf"),
    format: "A4",
    printBackground: true,
    margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" },
  });
  const hiddenInPrint = await page.evaluate<number[]>(
    `[document.querySelector('[data-testid="site-header"]'), document.querySelector('[data-print-hide]')].map((el) => el ? el.getBoundingClientRect().height : -1)`,
  );
  for (const height of hiddenInPrint) expect(height).toBe(0);
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.screenshot({
    path: path.join(SHOT_DIR, "t704-interview-kit-print.png"),
    fullPage: true,
  });
});

test("데스크톱·모바일(390px)에서 카드가 깨지지 않는다 (T-704)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(`/evaluations/${evaluationId}?tab=questions`);
  await expect(page.getByTestId("interview-kit")).toBeVisible();
  await page.screenshot({
    path: path.join(SHOT_DIR, "t704-interview-kit-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/evaluations/${evaluationId}?tab=questions`);
  const kit = page.getByTestId("interview-kit");
  await expect(kit).toBeVisible();
  // 가로 스크롤이 생기지 않는다
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const cardWidths = await page.evaluate<number[]>(
    `Array.from(document.querySelectorAll('${TAB_CARD}')).map((el) => el.getBoundingClientRect().width)`,
  );
  for (const width of cardWidths) expect(width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: path.join(SHOT_DIR, "t704-interview-kit-mobile.png"),
    fullPage: true,
  });
});

test("키트가 없는 평가는 사유와 함께 이전 후속 질문 목록을 보인다 (T-704)", async ({ page }) => {
  const kitKey = artifactKeys.interviewKit(evaluationId);
  const saved = await store.get(kitKey);
  if (!saved) throw new Error("키트 아티팩트가 없습니다");
  await store.delete(kitKey);
  try {
    await page.goto(`/evaluations/${evaluationId}?tab=questions`);
    const panel = page.getByTestId("tab-panel-questions");
    await expect(panel.getByTestId("kit-missing")).toContainText("인터뷰 키트가 없는 평가");
    await expect(panel.locator('[data-question-group="R-05"]')).toContainText(
      "이력서에 적으신 멱등 결제 엔드포인트",
    );
    // 인쇄용 보기도 사유를 보인다
    await page.goto(`/evaluations/${evaluationId}/interview-kit`);
    await expect(page.getByTestId("interview-kit-print")).toHaveAttribute(
      "data-kit-state",
      "missing",
    );
    await expect(page.getByTestId("kit-print-missing")).toContainText("인터뷰 키트가 없는 평가");
  } finally {
    await store.put(kitKey, saved.body, { contentType: ARTIFACT_CONTENT_TYPES.interviewKit });
  }
});
