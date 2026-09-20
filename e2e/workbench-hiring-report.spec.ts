import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  aggregateScore,
  INTERVIEW_KIT_SCHEMA_VERSION,
  InterviewKitSchema,
  HiringReportResponseSchema,
  ReportProfileSchema,
  findForbiddenReportExpressions,
  type InterviewKit,
  type Verdict,
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
  setAssignmentVersionReportProfile,
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
 * 채용 리포트 화면 E2E (T-706, PRD 14.3). 부록 A의 C(결함) 샘플과 같은 판정을 심고 `/evaluations/<id>/report`에서
 * 다음을 확인한다.
 * - 확인된 결함을 누르면 워크벤치의 그 기준 재생이 열린다
 * - `page.pdf()` 결과가 A4 4쪽 이내이고 1쪽에 점수 표기와 확인된 결함 카드가 들어온다. 페이지 넘김은 카드 단위로 막는다 (T-802)
 * - 데스크톱(1440px)·모바일(390px) 레이아웃 (스크린샷)
 * - 검토 대기·미확정 기준이 화면에 보이고 Markdown 복사에 금지 표현이 없다
 * - 워크벤치 헤더와 제출 상태 화면의 `채용 리포트` 링크
 * LLM 미실행·이력서 없음 상태는 단위 테스트(`app/evaluations/[id]/report/report-document.test.tsx`)가 확인한다.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
const R05_CASE_ID = "R-05-idempotent-resend";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_DIR = path.join(repoRoot, "test-results", "t706-screenshots");
const RESUME_CLAIM = "결제 API에 멱등 처리를 도입했습니다";

/** 부록 A의 C(결함) 샘플 판정 */
const SAMPLE_C_VERDICTS: Record<string, Verdict> = {
  "R-01": "PASS",
  "R-02": "PASS",
  "R-03": "PASS",
  "R-04": "PASS",
  "R-05": "FAIL",
  "R-06": "FAIL",
  "R-07": "FAIL",
  "R-08": "PASS",
  "R-09": "PASS",
  "R-10": "PASS",
  "R-11": "PASS",
  "R-12": "INCONCLUSIVE",
  G1: "INCONCLUSIVE",
  G2: "INCONCLUSIVE",
  G3: "INCONCLUSIVE",
};

let handle: DbHandle;
let assignmentId: string;
let submissionId: string;
let evaluationId: string;
let r05RunId: string;
let store: FsArtifactStore;
let artifactKeyList: string[] = [];

function buildKit(input: { evaluationId: string; runId: string; contextLinkId: string }) {
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
        ],
        source: "LLM",
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
          { name: "이력서 연결", minutes: 5, questionIds: ["RESUME_BRIDGE:1"] },
        ],
      },
    ],
    generation: {
      slotCount: 2,
      templateCount: 0,
      llm: "OK",
      llmReason: null,
      promptVersion: "interview-kit-1",
      model: "deepseek-chat",
      aiReviewId: randomUUID(),
      inputDigest: DIGEST,
      dropped: [],
    },
  }) satisfies InterviewKit;
}

test.beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  test.skip(!url, "DATABASE_URL이 없어 채용 리포트 E2E를 건너뜁니다");
  handle = createServerlessDb(url!);
  const rubricVersion = `e2e-t706-${randomUUID().slice(0, 8)}`;
  const rubric = { ...sampleRubric(), version: rubricVersion };

  const [assignment] = await handle.db
    .insert(assignments)
    .values({ name: `e2e-t706-${randomUUID().slice(0, 8)}` })
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

  // 샘플 과제의 리포트 프로필(T-705)을 붙여 영향 문장이 화면에 보이게 한다
  const profile = ReportProfileSchema.parse(
    JSON.parse(
      await readFile(path.join(repoRoot, "samples/order-api/report-profile.json"), "utf8"),
    ),
  );
  await setAssignmentVersionReportProfile(handle.db, version!.id, {
    ...profile,
    criteria: profile.criteria.filter((c) => rubric.criteria.some((r) => r.id === c.criterionId)),
  });

  const [submission] = await handle.db
    .insert(submissions)
    .values({
      assignmentVersionId: version!.id,
      repoUrl: "https://github.com/example/order-api",
      submissionSha: SHA,
    })
    .returning({ id: submissions.id });
  submissionId = submission!.id;
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
  // 감점된 기준마다 근거가 하나 이상 있어야 한다 (G-02)
  const evidenceIdByCriterion: Record<string, string> = {
    "R-05": randomUUID(),
    "R-06": randomUUID(),
    "R-07": randomUUID(),
  };
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

  const criterionResults: (NewCriterionResult & { evaluationId: string })[] = rubric.criteria.map(
    (criterion) => {
      const verdict = SAMPLE_C_VERDICTS[criterion.id] ?? "PASS";
      const earnedPoints =
        verdict === "PASS" ? criterion.maxPoints : verdict === "INCONCLUSIVE" ? null : 0;
      return {
        evaluationId,
        criterionId: criterion.id,
        rubricVersion,
        maxPoints: criterion.maxPoints,
        earnedPoints,
        verdict,
        method: criterion.method,
        evidenceIds: evidenceIdByCriterion[criterion.id]
          ? [evidenceIdByCriterion[criterion.id]!]
          : [],
        issueId: criterion.id === "R-05" ? `case:${R05_CASE_ID}` : undefined,
        observation:
          criterion.id === "R-05"
            ? "같은 멱등 키로 재전송했을 때 재고가 두 번 차감되었습니다."
            : `${criterion.title} 판정을 저장했습니다.`,
        reviewState: verdict === "INCONCLUSIVE" ? "PENDING" : "NOT_REQUIRED",
      };
    },
  );
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
    evidences: Object.entries(evidenceIdByCriterion).map(([criterionId, id]) => ({
      id,
      evaluationId,
      submissionSha: SHA,
      runId,
      testId: criterionId === "R-05" ? R05_CASE_ID : `${criterionId}-case`,
      artifactRefs: artifactKeyList,
    })),
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
        assignmentObservation: {
          criterionId: "R-05",
          summary: "이번 과제에서는 재전송이 두 번 처리되었습니다",
        },
        followUpQuestion: "그때의 재전송 판단 기준은 무엇이었나요?",
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

test("조회 API와 리포트 화면의 점수 표기가 같은 저장값에서 나온다 (T-706)", async ({
  request,
  page,
}) => {
  // 화면을 먼저 열어 개발 서버가 라우트를 컴파일하게 한다
  await page.goto(`/evaluations/${evaluationId}/report`);
  const res = await request.get(`/api/evaluations/${evaluationId}/hiring-report`);
  expect(res.status()).toBe(200);
  const body = HiringReportResponseSchema.parse(await res.json());
  if (!body.ok) throw new Error("채용 리포트 응답이 ok가 아닙니다");
  await expect(page.getByTestId("report-score")).toHaveText(body.data.summary.score!.display);
  await expect(page.getByTestId("report-disclaimer")).toContainText("채용 결정은 사람이 합니다");
  // 검토 대기와 미확정 기준이 각각 보인다 (G-14)
  await expect(page.getByTestId("report-pending-review")).toContainText("R-12");
  await expect(page.getByTestId("report-inconclusive")).toContainText("G1");
  // 인터뷰 키트 질문은 슬롯 ID가 아니라 번호와 주 질문 문장으로 보인다
  await expect(page.getByTestId("report-guide")).toContainText("Q1");
  await expect(page.getByTestId("report-guide")).toContainText("R-05 재생 기록을 함께 보겠습니다.");
  await expect(page.getByTestId("report-guide")).not.toContainText("FAILURE_DEBRIEF:R-05");
});

test("확인된 결함을 누르면 워크벤치의 그 기준 재생이 열린다 (T-706)", async ({ page }) => {
  await page.goto(`/evaluations/${evaluationId}/report`);
  const defect = page.getByTestId("report-defects").locator('[data-observation="R-05"]');
  await expect(defect).toBeVisible();
  // 프로필의 영향 문장이 관측 문장과 함께 보인다
  await expect(defect.getByTestId("report-impact")).toContainText("영향:");
  await defect.locator('[data-report-ref="EXECUTION_RECORD"] a').click();
  await expect(page).toHaveURL(new RegExp(`criterion=R-05&run=${r05RunId}`));
  await expect(page.getByTestId("replay-criterion")).toHaveText("R-05");
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-selected-run", r05RunId);
});

test("PDF가 A4 4쪽 이내이고 1쪽에 점수 표기와 확인된 결함 카드가 들어온다 (T-706·T-802)", async ({
  page,
}) => {
  await page.goto(`/evaluations/${evaluationId}/report`);
  await expect(page.getByTestId("hiring-report")).toBeVisible();

  const pdfPath = path.join(SHOT_DIR, "t706-hiring-report.pdf");
  await page.pdf({
    path: pdfPath,
    format: "A4",
    printBackground: true,
    margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" },
  });
  const pdf = await readFile(pdfPath);
  const pageCount = countPdfPages(pdf.toString("latin1"));
  expect(pageCount).toBeGreaterThan(0);
  expect(pageCount).toBeLessThanOrEqual(4);

  // 인쇄 미디어에서 1쪽에 점수 표기와 확인된 결함 카드가 들어오고, 페이지 넘김은 절이 아니라 카드 단위로 막는다 (T-802)
  await page.emulateMedia({ media: "print" });
  const A4_CONTENT_PX = ((297 - 28) / 25.4) * 96;
  const layout = await page.evaluate<{
    score: number;
    defect: number;
    sections: string[];
    cards: string[];
    cardHeights: number[];
  }>(
    `(() => {
      const top = document.documentElement.getBoundingClientRect().top;
      const bottom = (el) => el.getBoundingClientRect().bottom - top;
      const cards = Array.from(document.querySelectorAll('.report-card'));
      return {
        score: bottom(document.querySelector('[data-testid="report-score"]')),
        defect: bottom(document.querySelector('[data-testid="report-defects"] .report-card')),
        sections: Array.from(document.querySelectorAll('.report-section')).map((el) => getComputedStyle(el).breakInside),
        cards: cards.map((el) => getComputedStyle(el).breakInside),
        cardHeights: cards.map((el) => el.getBoundingClientRect().height),
      };
    })()`,
  );
  expect(layout.score).toBeLessThan(A4_CONTENT_PX);
  expect(layout.defect).toBeLessThan(A4_CONTENT_PX);
  expect(layout.sections).toHaveLength(9);
  for (const value of layout.sections) expect(value).toBe("auto");
  expect(layout.cards.length).toBeGreaterThan(0);
  for (const value of layout.cards) expect(value).toBe("avoid");
  // `break-inside: avoid`는 한 쪽보다 높은 카드에는 듣지 않으므로 카드가 A4 한 쪽 안에 들어가는지도 확인한다
  for (const height of layout.cardHeights) expect(height).toBeLessThan(A4_CONTENT_PX);

  // 인쇄물의 핵심 관측 카드는 줄인 근거만 싣는다: 기준 1 + 재생 1 + 코드 위치 최대 2 (T-802)
  const printRefs = await page.evaluate<{ kinds: string[]; condition: number }>(
    `(() => {
      const card = document.querySelector('[data-testid="report-defects"] .report-card');
      const condition = card.querySelector('[data-testid="report-condition"]');
      return {
        kinds: Array.from(card.querySelectorAll('[data-testid="report-print-refs"] [data-print-ref]')).map((el) => el.getAttribute('data-print-ref')),
        condition: condition ? condition.getBoundingClientRect().height : 0,
      };
    })()`,
  );
  expect(printRefs.kinds.length).toBeGreaterThan(0);
  expect(printRefs.kinds.length).toBeLessThanOrEqual(4);
  expect(printRefs.kinds.filter((kind) => kind === "SOURCE").length).toBeLessThanOrEqual(2);
  expect(printRefs.condition).toBe(0);
  // 인쇄물에는 사이트 머리글과 화면 전용 안내가 빠지고 근거 주소가 글자로 남는다
  const hiddenInPrint = await page.evaluate<number[]>(
    `[document.querySelector('[data-testid="site-header"]'), document.querySelector('[data-print-hide]')].map((el) => el ? el.getBoundingClientRect().height : -1)`,
  );
  for (const height of hiddenInPrint) expect(height).toBe(0);

  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.screenshot({
    path: path.join(SHOT_DIR, "t706-hiring-report-print.png"),
    fullPage: true,
  });
});

test("데스크톱(1440px)·모바일(390px)에서 문서가 깨지지 않는다 (T-706)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(`/evaluations/${evaluationId}/report`);
  await expect(page.getByTestId("hiring-report")).toBeVisible();
  await page.screenshot({
    path: path.join(SHOT_DIR, "t706-hiring-report-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/evaluations/${evaluationId}/report`);
  await expect(page.getByTestId("hiring-report")).toBeVisible();
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: path.join(SHOT_DIR, "t706-hiring-report-mobile.png"),
    fullPage: true,
  });
});

test("Markdown 복사 결과에 아홉 개 절이 있고 금지 표현이 없다 (T-706)", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/evaluations/${evaluationId}/report`);
  await page.getByRole("button", { name: "채용 리포트 Markdown 복사" }).click();
  const md = await page.evaluate<string>("navigator.clipboard.readText()");
  expect(md).toContain("# 채용 리포트 · 주문·재고 API");
  for (const heading of [
    "## 1. 한눈 요약",
    "## 2. 핵심 관측",
    "## 3. 역량별 관측",
    "## 4. 요구사항별 결과",
    "## 5. 이력서 주장과 근거",
    "## 6. 면접 안내 (필수 질문)",
    "## 7. 평가 범위와 한계",
    "## 8. 면접관 스코어카드 (사람이 기입합니다)",
    "## 9. 감사 정보",
  ]) {
    expect(md).toContain(heading);
  }
  expect(md).toContain("Q1. [실패 디브리핑");
  expect(findForbiddenReportExpressions(md)).toEqual([]);
});

test("워크벤치 헤더와 제출 상태 화면에 채용 리포트 링크가 있다 (T-706)", async ({ page }) => {
  await page.goto(`/evaluations/${evaluationId}`);
  await page.getByTestId("hiring-report-link").click();
  await expect(page).toHaveURL(new RegExp(`/evaluations/${evaluationId}/report$`));

  await page.goto(`/submissions/${submissionId}`);
  await page.getByTestId("hiring-report-link").click();
  await expect(page).toHaveURL(new RegExp(`/evaluations/${evaluationId}/report$`));
});

/** PDF 쪽 수. 페이지 트리의 `/Count`를 먼저 보고, 없으면 `/Type /Page` 객체를 센다 */
function countPdfPages(pdf: string): number {
  const count = /\/Type\s*\/Pages[\s\S]{0,400}?\/Count\s+(\d+)/.exec(pdf);
  if (count) return Number(count[1]);
  return (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}
