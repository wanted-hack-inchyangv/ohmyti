import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { analyzeFunctionGraph } from "@ohmyti/analysis";
import {
  aggregateScore,
  EvaluationReportSchema,
  FunctionGraphReportResponseSchema,
  RERUN_MAX_ATTEMPTS,
  rerunExecutionDedupeKey,
  RerunStatusReportSchema,
  type SourceLocation,
} from "@ohmyti/core";
import { sampleRubric } from "@ohmyti/core/fixtures";
import { ORDER_API_V1_CASES, runCases, type CaseResult } from "@ohmyti/harness";
import { startFakeOrderApi } from "@ohmyti/harness/test-support";
import {
  assignmentVersions,
  assignments,
  createServerlessDb,
  enqueue,
  evaluations,
  finishEvaluation,
  persistEvaluationResults,
  replaceContextLinks,
  setGitHubSources,
  setSubmissionStatus,
  upsertSubmissionContext,
  submissions,
  type DbHandle,
  type NewCriterionResult,
} from "@ohmyti/db";
import { directoryFiles } from "@ohmyti/runner";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { sql } from "drizzle-orm";
import "../scripts/load-env";
import { stackArtifactRoot } from "../scripts/stack-local";

/**
 * 채점 워크벤치 E2E (T-301·T-302·T-303·T-307). 부록 A 기준 15개와 판정 일부를 DB에 직접 넣고
 * 헤더 값·기준 선택·1280px 가로 스크롤 없음(T-301), FAIL 카드 클릭·필터·영역 소계(T-302),
 * 실패 재생 뷰(T-303)를 실제 페이지에서 확인한다. 점수·영역 소계는 워커와 같은 `aggregateScore`로 만들어 저장한다.
 * R-05의 실행 기록 본문은 결함 샘플 C와 같은 동작(멱등성 없음)의 가짜 order-api에 하네스 케이스를 실제로 돌려
 * 워커(`buildRequirementResults`)가 저장하는 형태로 fs 스토어(`apps/web/.artifacts-e2e`)에 넣는다.
 * 관련 함수 그래프(T-304)는 샘플 A(`samples/order-api/impl-a`)를 `@ohmyti/analysis`로 실제 분석해 R-05 timeline의 요청으로
 * 서브그래프를 만들어 워커와 같은 키(`artifactKeys.functionGraph`)에 넣는다. 코드 근거(T-305)는 그 분석의 `POST /orders`
 * 핸들러 위치·스니펫을 정적 관계 근거로 R-05에 붙여 화면의 스니펫이 샘플 A 파일 줄과 같은지 대조한다.
 * 하단 탭(T-504)은 맥락 연결 두 건(R-05에 연결된 질문 하나, 기준 없는 질문 하나)과 GitHub 보충 조회 결과를 넣어
 * 후속 질문 복사(클립보드)와 연결 기준 클릭 이동, 미평가 영역 나열을 확인한다.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
const R05_CASE_ID = "R-05-idempotent-resend";
/** 가짜 서비스가 응답 헤더에 넣는 비밀값. 하네스가 `[TOKEN]`으로 가려 기록해야 한다 */
const E2E_SECRET = "sk-e2esecretvalue0001";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let handle: DbHandle;
let assignmentId: string;
let evaluationId: string;
let r05RunId: string;
let r05Result: CaseResult;
let store: FsArtifactStore;
let runKeys: string[] = [];
let staticEvidenceId: string;
let staticRelation: { source: SourceLocation; snippet: string };
const QUESTION_R05 = "과제에서 멱등 키를 저장하지 않은 이유는 무엇인가요?";
const QUESTION_FREE = "Kafka 운영에서 겪은 장애를 설명해 주세요";

test.beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  test.skip(!url, "DATABASE_URL이 없어 워크벤치 E2E를 건너뜁니다");
  handle = createServerlessDb(url!);
  // 워커마다 beforeAll이 따로 돌므로(fullyParallel) 밀리초가 겹쳐도 유일하도록 uuid를 쓴다
  const rubricVersion = `e2e-t301-${randomUUID().slice(0, 8)}`;
  const rubric = { ...sampleRubric(), version: rubricVersion };

  const [assignment] = await handle.db
    .insert(assignments)
    .values({ name: "e2e-t301" })
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

  // R-05 케이스를 결함 구현(멱등성 없음)에 실제로 돌려 기록 본문을 만든다
  const api = await startFakeOrderApi({
    idempotency: false,
    extraHeader: ["x-debug-token", E2E_SECRET],
  });
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
  // dev 서버가 읽는 fs 스토어와 같은 루트 (Playwright 설정·`stack-local`과 같은 계산)
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
  runKeys = Object.keys(bodies).map(key);
  for (const [part, body] of Object.entries(bodies)) {
    await store.put(key(part), JSON.stringify(body), {
      contentType: ARTIFACT_CONTENT_TYPES.runRecord,
    });
  }
  // 관련 함수 그래프 (T-304): 샘플 A 코드를 R-05 timeline 요청으로 분석해 워커와 같은 키에 저장한다
  const { analysis, handlerSnippets } = await analyzeFunctionGraph({
    files: directoryFiles(path.join(repoRoot, "samples/order-api/impl-a")),
    cases: [
      {
        caseId: R05_CASE_ID,
        requests: r05Result.timeline.map((entry) => ({
          method: entry.request.method,
          path: entry.request.path,
          isSetup: entry.kind === "reset",
        })),
      },
    ],
  });
  expect(analysis.status).toBe("ok");
  const graphKey = artifactKeys.functionGraph(evaluationId);
  await store.put(graphKey, JSON.stringify(analysis), {
    contentType: ARTIFACT_CONTENT_TYPES.functionGraph,
  });
  runKeys.push(graphKey);
  // 코드 근거 (T-305): 워커(`buildRequirementResults`)처럼 R-05 루트 라우트 `POST /orders`의 핸들러 위치를 정적 관계 근거로 붙인다
  if (analysis.status !== "ok") throw new Error("샘플 A 분석 실패");
  const postOrders = analysis.routes.find((r) => r.method === "POST" && r.path === "/orders")!;
  staticEvidenceId = randomUUID();
  staticRelation = {
    source: postOrders.handler.location,
    snippet: handlerSnippets.get(postOrders.handler.id)!,
  };
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
      evidenceIds: [evidenceId, staticEvidenceId],
      issueId: `case:${R05_CASE_ID}`,
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
  // 워커(`scoreFieldsOf`)와 같은 저장 값: 결과가 없는 기준은 검토 대기 배점으로 누적된다
  const summary = aggregateScore(criterionResults, rubric);
  const scoreFields = {
    earned: summary.earned,
    min: summary.min,
    max: summary.max,
    pendingPoints: summary.pendingPoints,
    byArea: summary.byArea,
  };
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
        artifactRefs: [...runKeys, "logs/service/stdout.txt"],
      },
      {
        id: staticEvidenceId,
        evaluationId,
        submissionSha: SHA,
        kind: "STATIC_RELATION",
        runId,
        testId: R05_CASE_ID,
        source: staticRelation.source,
        snippet: staticRelation.snippet,
        artifactRefs: [graphKey],
      },
    ],
    criterionResults,
    score: scoreFields,
  });
  await finishEvaluation(handle.db, evaluationId, new Date());
  await setSubmissionStatus(handle.db, submission!.id, "COMPLETED");
  // 하단 탭 (T-504): 워커의 맥락 연결 단계(T-503)가 저장하는 형태 그대로 넣는다
  await upsertSubmissionContext(handle.db, submission!.id, {
    resumeRef: `submissions/${submission!.id}/resume.pdf`,
    githubLogin: "octo",
  });
  await setGitHubSources(handle.db, submission!.id, {
    status: "COLLECTED",
    reason: null,
    login: "octo",
    collectedAt: new Date().toISOString(),
    selection: "KEYWORD_OVERLAP",
    candidateCount: 4,
    candidateListTruncated: false,
    repos: [
      {
        fullName: "octo/payments",
        url: "https://github.com/octo/payments",
        description: "idempotent payment API",
        language: "TypeScript",
        topics: [],
        pushedAt: null,
        matchedKeywords: ["idempotent", "payment"],
        relevanceScore: 2,
        readme: "# payments",
        readmeTruncated: false,
        languages: [{ name: "TypeScript", bytes: 1000 }],
        topLevelFiles: [{ name: "src", type: "dir" }],
        commits: [],
        mergedPulls: [],
        missing: [],
      },
    ],
    requestCount: 6,
    requestLimit: 30,
  });
  await replaceContextLinks(handle.db, {
    submissionId: submission!.id,
    evaluationId,
    links: [
      {
        claim: "Designed idempotent payment endpoints",
        claimSource: "RESUME",
        status: "EVIDENCE_FOUND",
        githubEvidence: [
          {
            repo: "octo/payments",
            url: "https://github.com/octo/payments",
            summary: "멱등 키 저장소",
          },
        ],
        assignmentObservation: { criterionId: "R-05", summary: "재전송 시 재고가 두 번 차감됨" },
        followUpQuestion: QUESTION_R05,
      },
      {
        claim: "Operated Kafka clusters",
        claimSource: "RESUME",
        status: "NO_DATA",
        followUpQuestion: QUESTION_FREE,
      },
    ],
  });
});

test.afterAll(async () => {
  if (!handle) return;
  for (const k of runKeys) await store.delete(k);
  if (assignmentId) {
    // execution_records는 불변(restrict FK + 트리거)이라 같은 트랜잭션에서 삭제 허용 설정을 켠 뒤 지운다 (T-506 경로)
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ohmyti.allow_execution_record_delete = 'on'`);
      await tx.execute(
        sql`delete from jobs where type = 'RERUN_EXECUTION' and payload ->> 'evaluationId' = ${evaluationId}`,
      );
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

test("헤더 값이 리포트 API 응답과 같고 ?criterion=R-05로 열면 R-05가 선택된다", async ({
  page,
}) => {
  const api = await page.request.get(`/api/evaluations/${evaluationId}`);
  expect(api.status()).toBe(200);
  const body = (await api.json()) as {
    ok: true;
    data: {
      score: { display: string; pendingPoints: number };
      evaluation: { rubricVersion: string };
    };
  };

  await page.goto(`/evaluations/${evaluationId}?criterion=R-05`);
  await expect(page.getByTestId("score-display")).toHaveText(body.data.score.display);
  await expect(page.getByTestId("pending-badge")).toHaveText(
    `${body.data.score.pendingPoints}점 검토 대기`,
  );
  await expect(page.getByTestId("header-sha").locator("code")).toHaveText(SHA.slice(0, 12));
  await expect(page.getByTestId("header-rubric-version").locator("code")).toHaveText(
    body.data.evaluation.rubricVersion,
  );
  await expect(page.getByTestId("sample-badge")).toHaveCount(0);

  await expect(page.getByTestId("workbench")).toHaveAttribute("data-selected-criterion", "R-05");
  await expect(page.locator('[data-criterion="R-05"]')).toHaveAttribute("data-selected", "true");
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
  await expect(page.getByTestId("replay-criterion")).toHaveText("R-05");
  await expect(page.locator("[data-criterion]")).toHaveCount(15);

  // 기준 링크로 선택을 바꾸면 URL과 선택 상태가 함께 바뀐다
  await page.locator('[data-criterion="R-12"] a').click();
  await expect(page).toHaveURL(/criterion=R-12/);
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-selected-criterion", "R-12");

  // 하단 탭(T-504): 이력서 연결 탭이 저장된 연결을 보인다
  await page.locator('[data-tab="resume"]').click();
  await expect(page).toHaveURL(/tab=resume/);
  await expect(page.getByTestId("tab-panel-resume").locator("[data-claim-id]")).toHaveCount(2);
});

test("하단 탭: 후속 질문 복사, 연결 기준 클릭 이동, 미평가 영역 나열 (T-504)", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/evaluations/${evaluationId}?tab=questions`);
  const panel = page.getByTestId("tab-panel-questions");
  await expect(panel.locator('[data-question-group="R-05"]')).toContainText(QUESTION_R05);
  await expect(panel.locator('[data-question-group="none"]')).toContainText(QUESTION_FREE);

  const r05Question = panel.locator('[data-question-group="R-05"] [data-question]');
  await r05Question.getByRole("button", { name: "후속 질문 복사" }).click();
  await expect(r05Question.locator("[data-copy-state]")).toHaveText("복사됨");
  expect(await page.evaluate<string>("navigator.clipboard.readText()")).toBe(QUESTION_R05);

  await panel.getByRole("button", { name: "후속 질문 전체 복사" }).click();
  expect(await page.evaluate<string>("navigator.clipboard.readText()")).toBe(
    `${QUESTION_R05}\n${QUESTION_FREE}`,
  );

  // 이력서 연결 탭: 상태 칩은 두 연결의 상태와 같고, 연결 기준을 누르면 탭을 유지한 채 중앙 패널이 R-05로 간다
  await page.locator('[data-tab="resume"]').click();
  const resume = page.getByTestId("tab-panel-resume");
  await expect(resume.locator("[data-context-status]")).toHaveCount(2);
  await expect(resume.locator('[data-context-status="EVIDENCE_FOUND"]')).toHaveText("근거 있음");
  await expect(resume.locator('[data-context-status="NO_DATA"]')).toHaveText("자료 없음");
  await resume.locator('[data-claim-criterion="R-05"]').click();
  await expect(page).toHaveURL(/criterion=R-05&tab=resume/);
  await expect(page.getByTestId("replay-criterion")).toHaveText("R-05");

  // GitHub 근거 탭: 선정 사유·링크
  await page.locator('[data-tab="github"]').click();
  const github = page.getByTestId("tab-panel-github");
  await expect(github.locator('[data-repo="octo/payments"]')).toContainText(
    "이력서·JD 키워드와 겹침: idempotent, payment",
  );

  // 미평가 영역 탭: 판정이 저장되지 않은 기준과 INCONCLUSIVE(R-12)가 모두 나온다 (R-01 PASS·R-05 FAIL 제외 13개)
  await page.locator('[data-tab="unevaluated"]').click();
  const unevaluated = page.getByTestId("tab-panel-unevaluated");
  await expect(unevaluated.locator("[data-unevaluated-criterion]")).toHaveCount(13);
  await expect(unevaluated.locator('[data-unevaluated-criterion="R-12"]')).toContainText("미확정");
  await expect(unevaluated.locator('[data-unevaluated-criterion="R-01"]')).toHaveCount(0);
  await expect(unevaluated.getByTestId("unevaluated-context")).toContainText(
    "자료 없음: Operated Kafka clusters",
  );
});

test("FAIL 카드 클릭 한 번으로 URL과 중앙 패널이 갱신되고, 필터 개수·영역 소계가 API 값과 같다 (T-302)", async ({
  page,
}) => {
  const api = await page.request.get(`/api/evaluations/${evaluationId}`);
  const body = (await api.json()) as {
    ok: true;
    data: {
      score: {
        earned: number;
        min: number;
        max: number;
        pendingPoints: number;
        display: string;
        byArea: Array<{
          area: string;
          earned: number;
          min: number;
          max: number;
          pendingPoints: number;
          total: number;
        }>;
      };
      criterionResults: Array<{ criterionId: string; verdict: string }>;
      rubric: { criteria: Array<{ id: string }> };
    };
  };
  const { score, criterionResults, rubric } = body.data;

  await page.goto(`/evaluations/${evaluationId}`);
  await expect(page.getByTestId("replay-empty")).toContainText("기준을 선택하세요");
  await expect(page.locator("[data-selected='true']")).toHaveCount(0);

  // FAIL 카드(R-05) 클릭 한 번 → URL·왼쪽 선택·중앙 패널 제목·오른쪽 패널 제목이 함께 바뀐다
  await page.locator('[data-criterion="R-05"] a').click();
  await expect(page).toHaveURL(/\?criterion=R-05$/);
  await expect(page.locator('[data-criterion="R-05"]')).toHaveAttribute("data-selected", "true");
  await expect(page.locator('[data-selected="true"]')).toHaveCount(1);
  await expect(page.getByTestId("replay-criterion")).toHaveText("R-05");
  await expect(page.getByTestId("run-body")).toHaveAttribute("data-run-id", r05RunId);
  // 오른쪽 근거 패널(T-306)도 같은 기준의 관측을 보인다
  await expect(page.locator('[data-panel="evidence"]')).toHaveAttribute(
    "data-evidence-status",
    "ok",
  );
  await expect(page.getByTestId("observation")).toHaveText("재전송 시 재고가 두 번 차감됨");

  // 필터 개수 = verdict 분포 (미확정 = INCONCLUSIVE + 판정 없음)
  const failCount = criterionResults.filter((r) => r.verdict === "FAIL").length;
  const inconclusiveCount =
    criterionResults.filter((r) => r.verdict === "INCONCLUSIVE").length +
    (rubric.criteria.length - criterionResults.length);
  await expect(page.locator('[data-filter="all"]')).toHaveAttribute(
    "data-count",
    String(rubric.criteria.length),
  );
  await expect(page.locator('[data-filter="fail"]')).toHaveAttribute(
    "data-count",
    String(failCount),
  );
  await expect(page.locator('[data-filter="inconclusive"]')).toHaveAttribute(
    "data-count",
    String(inconclusiveCount),
  );
  expect(failCount).toBe(1);
  expect(inconclusiveCount).toBe(13);

  // 실패만 필터: 카드 1개, 선택 유지, URL에 filter=fail
  await page.locator('[data-filter="fail"]').click();
  await expect(page).toHaveURL(/criterion=R-05&filter=fail$/);
  await expect(page.locator("[data-criterion]")).toHaveCount(failCount);
  await expect(page.locator('[data-criterion="R-05"]')).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("area-empty-DESIGN")).toBeVisible();
  await page.locator('[data-filter="inconclusive"]').click();
  await expect(page.locator("[data-criterion]")).toHaveCount(inconclusiveCount);
  await page.locator('[data-filter="all"]').click();
  await expect(page).toHaveURL(/\?criterion=R-05$/);
  await expect(page.locator("[data-criterion]")).toHaveCount(15);

  // 영역 소계는 API의 score.byArea 그대로이고 합이 헤더 점수와 같다
  expect(score.byArea).toHaveLength(5);
  let earned = 0;
  let pending = 0;
  for (const area of score.byArea) {
    const subtotal = page.getByTestId(`subtotal-${area.area}`);
    await expect(subtotal).toHaveAttribute("data-earned", String(area.earned));
    await expect(subtotal).toHaveAttribute("data-pending", String(area.pendingPoints));
    await expect(subtotal).toHaveAttribute("data-total", String(area.total));
    await expect(subtotal).toHaveText(
      area.pendingPoints === 0
        ? `${area.earned}/${area.total}`
        : `${area.min}~${area.max}/${area.total}`,
    );
    earned += area.earned;
    pending += area.pendingPoints;
  }
  expect(earned).toBe(score.earned);
  expect(pending).toBe(score.pendingPoints);
  await expect(page.getByTestId("score-display")).toHaveText(score.display);

  // 테스트 실효성 그룹은 결과가 없어 판정 없음 · ?/5
  const effectiveness = page.getByTestId("effectiveness");
  await expect(effectiveness.locator("[data-group]")).toHaveCount(3);
  await expect(effectiveness.getByTestId("group-points").first()).toHaveText("?/5");

  // 키보드: 첫 카드에 포커스 후 ↓ 두 번이면 세 번째 카드 링크(R-05)에 포커스, Enter로 선택
  await page.goto(`/evaluations/${evaluationId}`);
  await page.locator('[data-criterion-link="R-01"]').focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('[data-criterion-link="R-05"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\?criterion=R-05$/);
  await expect(page.getByTestId("replay-criterion")).toHaveText("R-05");
});

test("1280px 이상에서 가로 스크롤이 없다", async ({ page }) => {
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/evaluations/${evaluationId}?criterion=R-05&tab=github`);
    await expect(page.getByTestId("workbench")).toBeVisible();
    // 루트 tsconfig에 DOM lib가 없어 브라우저 식은 문자열로 넘긴다
    const overflow = await page.evaluate<{
      scrollWidth: number;
      clientWidth: number;
      bodyScrollWidth: number;
    }>(
      "({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, bodyScrollWidth: document.body.scrollWidth })",
    );
    expect(overflow.scrollWidth, `viewport ${width}`).toBeLessThanOrEqual(overflow.clientWidth);
    expect(overflow.bodyScrollWidth, `viewport ${width}`).toBeLessThanOrEqual(overflow.clientWidth);
  }
});

test("없는 평가는 404 화면이다", async ({ page }) => {
  const response = await page.goto(`/evaluations/${randomUUID()}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("평가를 찾을 수 없습니다");
});

test("C의 R-05 실패 재생: stateAfter 재고 2 → 1 → 0, 기대 1·실제 0이 runs API 값과 같다 (T-303)", async ({
  page,
}) => {
  const api = await page.request.get(`/api/evaluations/${evaluationId}/runs/${r05RunId}`);
  expect(api.status()).toBe(200);
  const body = (await api.json()) as {
    ok: true;
    data: {
      runId: string;
      record: { startedAt: string };
      expected: { expected: Record<string, unknown> };
      actual: { actual: Record<string, unknown>; checks: Array<{ name: string; ok: boolean }> };
      timeline: Array<{
        seq: number;
        kind: string;
        request: { method: string; path: string };
        response: { status: number } | null;
        elapsedMs: number;
        stateAfter?: { stock: number };
      }>;
    };
  };
  const run = body.data;

  await page.goto(`/evaluations/${evaluationId}?criterion=R-05`);
  // ?run=이 없어도 기준의 첫 기록(원본)이 선택된다
  await expect(page.getByTestId("workbench")).toHaveAttribute("data-selected-run", r05RunId);
  const runList = page.getByTestId("run-list");
  await expect(runList.locator("[data-run]")).toHaveCount(1);
  await expect(runList.locator(`[data-run="${r05RunId}"]`)).toHaveAttribute(
    "data-origin",
    "original",
  );
  await expect(runList.getByText("원본")).toBeVisible();
  await expect(page.getByTestId("stored-run-badge")).toContainText("저장된 실행 · ");
  await expect(page.getByTestId("observed-label")).toHaveText("관측");

  // 타임라인: 항목 수·순서·status가 API와 같다
  const rows = page.locator("[data-timeline-row]");
  await expect(rows).toHaveCount(run.timeline.length);
  for (const [i, entry] of run.timeline.entries()) {
    await expect(rows.nth(i)).toHaveAttribute("data-timeline-row", String(entry.seq));
    await expect(rows.nth(i)).toHaveAttribute("data-kind", entry.kind);
    await expect(rows.nth(i)).toHaveAttribute("data-status", String(entry.response!.status));
    await expect(rows.nth(i)).toContainText(`${entry.request.method} ${entry.request.path}`);
    await expect(rows.nth(i)).toContainText(`${entry.elapsedMs} ms`);
  }
  // stateAfter 열: 재고 2 → 1 → 0 (API의 관측 스텝 값과 같다)
  const observed = run.timeline.filter((e) => e.kind === "observeState");
  expect(observed.map((e) => e.stateAfter!.stock)).toEqual([2, 1, 0]);
  const stateCells = page.locator('[data-testid="timeline-state-after"][data-has-state="true"]');
  await expect(stateCells).toHaveCount(observed.length);
  for (const [i, entry] of observed.entries()) {
    await expect(stateCells.nth(i)).toContainText(`stock: ${entry.stateAfter!.stock}`);
  }

  // 기대/실제: p1After.stock 기대 1, 실제 0, 실패. 실패 검사 수 = API의 ok=false 수
  const failedRow = page.locator('[data-check="p1After.stock"]');
  await expect(failedRow).toHaveAttribute("data-ok", "false");
  await expect(failedRow.getByTestId("check-expected")).toHaveText("1");
  await expect(failedRow.getByTestId("check-actual")).toHaveText("0");
  expect(run.expected.expected["p1After.stock"]).toBe(1);
  expect(run.actual.actual["p1After.stock"]).toBe(0);
  const failed = run.actual.checks.filter((c) => !c.ok);
  await expect(page.locator('[data-check][data-ok="false"]')).toHaveCount(failed.length);
  await expect(page.locator("[data-check]")).toHaveCount(run.actual.checks.length);
  await expect(page.getByTestId("expected-json")).toHaveText(JSON.stringify(run.expected, null, 2));
  await expect(page.getByTestId("actual-json")).toHaveText(JSON.stringify(run.actual, null, 2));

  // 행을 펼치면 요청·응답 본문이 보이고, 가짜 서비스가 넣은 비밀값은 마스킹된 채로만 있다
  await rows.nth(4).locator("summary").click();
  await expect(rows.nth(4).getByTestId("timeline-request")).toContainText("idempotency-key");
  await expect(rows.nth(4).getByTestId("timeline-response")).toContainText("x-debug-token");
  const content = await page.content();
  expect(content).not.toContain(E2E_SECRET);
  expect(content).toContain("[TOKEN]");
  expect(JSON.stringify(run)).not.toContain(E2E_SECRET);
});

test("재생은 네트워크를 차단해도 저장된 순서대로 강조하고, 재실행 버튼과 문구가 구분된다 (T-303)", async ({
  page,
}) => {
  await page.goto(`/evaluations/${evaluationId}?criterion=R-05`);
  const button = page.getByTestId("replay-button");
  await expect(button).toBeEnabled();
  await expect(page.getByTestId("rerun-button")).toHaveText("재실행");
  await expect(page.getByTestId("rerun-controls")).toContainText(
    "같은 조건으로 새 실행 기록을 만듭니다",
  );
  await expect(button).toHaveText("재생");

  // 페이지가 다 그려진 뒤 모든 네트워크 요청을 막는다
  const requests: string[] = [];
  await page.route("**/*", (route) => {
    requests.push(route.request().url());
    void route.abort();
  });
  await button.click();
  await expect(button).toHaveAttribute("data-playing", "true");
  await expect(button).toHaveText("재생 중지");
  const rowCount = await page.locator("[data-replay-seq]").count();
  // 첫 줄부터 차례로 활성화된다 (한 줄에 하나만)
  await expect(page.locator('[data-replay-seq="0"]')).toHaveAttribute("data-active", "true");
  await expect(page.locator('[data-active="true"]')).toHaveCount(1);
  await expect(page.locator('[data-replay-seq="1"]')).toHaveAttribute("data-active", "true", {
    timeout: 3000,
  });
  await expect(page.locator('[data-active="true"]')).toHaveCount(1);
  // 끝나면 활성 표시가 사라지고 버튼이 되돌아온다 (줄 수 × 0.7초 + 1.4초)
  await expect(page.locator('[data-active="true"]')).toHaveCount(0, {
    timeout: rowCount * 700 + 5000,
  });
  await expect(button).toHaveAttribute("data-playing", "false");
  expect(requests, "재생 중 네트워크 요청이 없어야 한다").toEqual([]);
});

test("재실행: 워커가 처리하기 전엔 `대기 중`, job이 FAILED(ENVIRONMENT)면 `재실행 실패`와 원본 링크가 보이고 기록은 그대로다 (T-307)", async ({
  page,
  request,
}) => {
  // 이 테스트 파일은 워커를 띄우지 않지만, `pnpm stack:local`의 워커가 같은 DB를 볼 수 있다(T-308). 워커가 잡지 못하도록
  // 같은 dedupeKey의 job을 `run_after`가 먼 미래인 상태로 먼저 넣어 둔다. 화면의 `재실행` 클릭은 이 활성 job을
  // 그대로 돌려받으므로(`created: false`) 워커 유무와 관계없이 `대기 중`이 된다.
  await page.goto(`/evaluations/${evaluationId}?criterion=R-05`);
  const readReport = async () =>
    EvaluationReportSchema.parse(
      ((await (await request.get(`/api/evaluations/${evaluationId}`)).json()) as { data: unknown })
        .data,
    );
  const before = await readReport();
  const held = await enqueue(handle.db, {
    type: "RERUN_EXECUTION",
    payload: { evaluationId, caseId: R05_CASE_ID },
    dedupeKey: rerunExecutionDedupeKey(evaluationId, R05_CASE_ID),
    runAfter: new Date(Date.now() + 60 * 60 * 1000),
    maxAttempts: RERUN_MAX_ATTEMPTS,
  });
  expect(held.created).toBe(true);
  const rerunButton = page.getByTestId("rerun-button");
  await expect(rerunButton).toBeEnabled();
  await expect(rerunButton).toHaveAttribute("data-rerun-enabled", "true");
  await rerunButton.click();
  const status = page.getByTestId("rerun-status");
  await expect(status).toHaveAttribute("data-rerun-status", "queued");
  await expect(page.getByTestId("rerun-status-label")).toHaveText("대기 중");
  await expect(rerunButton).toBeDisabled();
  await expect(page.getByTestId("rerun-message")).toContainText(
    "이미 같은 케이스의 재실행이 진행 중입니다",
  );

  // 상태 API와 DB의 job이 같다 (버튼이 새 job을 만들지 않았다)
  const statusResponse = await request.get(`/api/evaluations/${evaluationId}/reruns`);
  expect(statusResponse.status()).toBe(200);
  const statusBody = RerunStatusReportSchema.parse(
    ((await statusResponse.json()) as { data: unknown }).data,
  );
  expect(statusBody.used).toBe(1);
  expect(statusBody.jobs).toHaveLength(1);
  const job = statusBody.jobs[0]!;
  expect(job).toMatchObject({ id: held.id, caseId: R05_CASE_ID, status: "QUEUED", attempts: 0 });
  const jobId = await status.getAttribute("data-rerun-job");
  expect(jobId).toBe(job.id);

  // 새로고침해도(폴링 중) 대기 중이다. 같은 케이스를 다시 요청해도 job은 하나다
  await page.reload();
  await expect(page.getByTestId("rerun-status")).toHaveAttribute("data-rerun-status", "queued");
  await expect(page.getByTestId("rerun-button")).toBeDisabled();

  // 워커가 환경 장애로 job을 FAILED로 닫은 상황을 만든다 (워커 `failJob`이 남기는 형태의 last_error)
  await handle.db.execute(
    sql`update jobs set status = 'FAILED', attempts = 2, last_error = 'RunnerEnvironmentError: 템플릿 node_modules를 열 수 없습니다', updated_at = now() where id = ${job.id}::uuid`,
  );
  // 폴링(2초 간격)이 실패를 감지해 화면을 갱신한다
  await expect(page.getByTestId("rerun-status")).toHaveAttribute("data-rerun-status", "failed", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("rerun-status-label")).toHaveText("재실행 실패");
  await expect(page.getByTestId("rerun-failure-reason")).toContainText(
    "RunnerEnvironmentError: 템플릿 node_modules를 열 수 없습니다",
  );
  const originalLink = page.getByTestId("rerun-original-link");
  await expect(originalLink).toHaveText("원본 기록 열기");
  await expect(originalLink).toHaveAttribute(
    "href",
    `/evaluations/${evaluationId}?criterion=R-05&run=${r05RunId}`,
  );
  await expect(page.getByTestId("rerun-controls")).not.toContainText("재실행 완료");
  // 실패한 뒤에는 다시 요청할 수 있다
  await expect(page.getByTestId("rerun-button")).toBeEnabled();

  // 기록·근거·판정은 바뀌지 않았다 (G-03)
  const after = await readReport();
  expect(after.executionRecords).toEqual(before.executionRecords);
  expect(after.evidences).toEqual(before.evidences);
  expect(after.criterionResults).toEqual(before.criterionResults);
  expect(after.score).toEqual(before.score);
  await expect(page.locator("[data-run]")).toHaveCount(1);
});

test("관련 함수 그래프: 노드 12개 이하, 관측 노드가 graph API·timeline과 같고, 노드 클릭이 코드 근거 위치로 간다 (T-304)", async ({
  page,
  request,
}) => {
  const res = await request.get(`/api/evaluations/${evaluationId}/graph`);
  expect(res.status()).toBe(200);
  const body = FunctionGraphReportResponseSchema.parse(await res.json());
  expect(body.ok).toBe(true);
  if (!body.ok || body.data.analysis.status !== "ok") throw new Error("그래프 분석 결과가 없다");
  const sub = body.data.analysis.cases.find((c) => c.caseId === R05_CASE_ID)!;
  expect(sub.nodes.length).toBeLessThanOrEqual(12);

  await page.goto(`/evaluations/${evaluationId}?criterion=R-05&pane=graph`);
  const panel = page.getByTestId("graph-panel");
  await expect(panel).toHaveAttribute("data-graph-status", "ok");
  await expect(panel).toHaveAttribute("data-graph-case", R05_CASE_ID);
  const svgNodes = page.locator('[data-testid="graph-nodes"] a[data-node-id]');
  await expect(svgNodes).toHaveCount(sub.nodes.length);
  expect(sub.nodes.length).toBeLessThanOrEqual(12);

  // 관측 노드 = timeline에 등장한 요청이 매치된 라우트의 핸들러 (API 값과 화면이 같다)
  const observedLocator = page.locator(
    '[data-testid="graph-nodes"] a[data-node-status="observed"]',
  );
  const observedIds: string[] = [];
  for (const el of await observedLocator.all()) {
    observedIds.push((await el.getAttribute("data-node-id")) ?? "");
  }
  observedIds.sort();
  expect(observedIds).toEqual(
    sub.nodes
      .filter((n) => n.observed)
      .map((n) => n.id)
      .sort(),
  );
  const matches = (pattern: string, actual: string) => {
    const p = pattern.split("/").filter(Boolean);
    const a = actual.split("?")[0]!.split("/").filter(Boolean);
    return p.length === a.length && p.every((seg, i) => seg.startsWith(":") || seg === a[i]);
  };
  const appeared = (route: { method: string; path: string }) =>
    r05Result.timeline.some(
      (e) => e.request.method === route.method && matches(route.path, e.request.path),
    );
  for (const node of sub.nodes) {
    if (node.route) expect(node.observed, node.name).toBe(appeared(node.route));
    else expect(node.observed, node.name).toBe(false);
  }
  // 범례와 문구
  await expect(page.getByTestId("graph-legend")).toContainText("관측됨");
  await expect(page.getByTestId("graph-legend")).toContainText("정적");
  expect(await page.content()).not.toContain("실행 경로");

  if (process.env.E2E_SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.screenshot({
      path: path.join(process.env.E2E_SCREENSHOT_DIR, "t304-graph.png"),
      fullPage: true,
    });
  }

  // 노드 클릭 → 코드 근거 탭 + ?source=
  const post = sub.nodes.find((n) => n.name === "POST /orders")!;
  await page.locator(`[data-testid="graph-nodes"] a[data-node-id="${post.id}"]`).click();
  await expect(page).toHaveURL(/source=src%2Fhttp%2Froutes\.ts%3A25-28/);
  expect(new URL(page.url()).searchParams.get("pane")).toBeNull();
  await expect(page.locator('[data-pane="code"]')).toHaveAttribute("aria-selected", "true");
});

test("코드 근거: 스니펫이 스냅샷 파일 줄과 같고 링크는 고정 SHA만 쓰며, 위치 없는 기준은 빈 상태다 (T-305)", async ({
  page,
  request,
}) => {
  // 리포트 API의 근거 값 그대로인지 대조한다
  const res = await request.get(`/api/evaluations/${evaluationId}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    ok: true;
    data: {
      evidences: Array<{ id: string; kind?: string; source?: SourceLocation; snippet?: string }>;
    };
  };
  const apiEvidence = body.data.evidences.find((e) => e.id === staticEvidenceId)!;
  expect(apiEvidence.kind).toBe("STATIC_RELATION");
  expect(apiEvidence.source).toEqual(staticRelation.source);
  expect(apiEvidence.snippet).toBe(staticRelation.snippet);

  await page.goto(`/evaluations/${evaluationId}?criterion=R-05`);
  const panel = page.getByTestId("code-evidence");
  await expect(panel).toHaveAttribute("data-code-status", "ok");
  await expect(panel).toHaveAttribute("data-pinned-sha", SHA);
  const item = page.locator(
    `[data-testid="code-evidence-item"][data-evidence-id="${staticEvidenceId}"]`,
  );
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute("data-evidence-label", "정적 관계");
  await expect(item).toHaveAttribute(
    "data-source",
    `${staticRelation.source.path}:${staticRelation.source.startLine}-${staticRelation.source.endLine}`,
  );

  // 표시된 스니펫 = 스냅샷 파일(샘플 A)의 해당 라인
  const { path: file, startLine, endLine } = staticRelation.source;
  const fileLines = (await readFile(path.join(repoRoot, "samples/order-api/impl-a", file), "utf8"))
    .split(/\r?\n/)
    .slice(startLine - 1, endLine);
  const lineEls = item.locator("[data-line]");
  await expect(lineEls).toHaveCount(fileLines.length);
  for (let i = 0; i < fileLines.length; i += 1) {
    const el = lineEls.nth(i);
    await expect(el).toHaveAttribute("data-line", String(startLine + i));
    expect(await el.locator("span").nth(1).textContent()).toBe(fileLines[i]);
  }

  // GitHub 링크: pinned SHA + 경로 + 라인. HEAD·브랜치 없음
  const links = page.locator('[data-testid="github-link"]');
  await expect(links).toHaveCount(1);
  const href = (await links.first().getAttribute("href")) ?? "";
  expect(href).toBe(
    `https://github.com/example/order-api/blob/${SHA}/${file}#L${startLine}-L${endLine}`,
  );
  const html = await page.content();
  expect(html).not.toMatch(/blob\/HEAD|blob\/main|\/tree\//);

  // 그래프 노드 클릭으로 온 `?source=`가 근거 범위와 같으면 그 항목이 선택·강조된다
  await page.goto(
    `/evaluations/${evaluationId}?criterion=R-05&source=${encodeURIComponent(`${file}:${startLine}-${endLine}`)}`,
  );
  await expect(item).toHaveAttribute("data-selected", "true");
  await expect(item.locator('[data-highlight="true"]')).toHaveCount(fileLines.length);
  await expect(page.getByTestId("code-evidence-standalone")).toHaveCount(0);

  if (process.env.E2E_SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.screenshot({
      path: path.join(process.env.E2E_SCREENSHOT_DIR, "t305-code-evidence.png"),
      fullPage: true,
    });
  }

  // 코드 위치가 없는 기준(R-01: 근거 없음)은 빈 상태이며 오류가 없다
  await page.goto(`/evaluations/${evaluationId}?criterion=R-01`);
  await expect(page.getByTestId("code-evidence")).toHaveAttribute(
    "data-code-status",
    "no-location",
  );
  await expect(page.getByTestId("code-evidence-empty")).toContainText(
    "코드 위치 미확정 · 라우트 분석 결과 없음",
  );
  await expect(page.locator('[data-testid="code-evidence-item"]')).toHaveCount(0);
});
