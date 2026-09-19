import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { sampleRubricDraftOutput } from "@ohmyti/core/fixtures";
import {
  createAssignment,
  createAssignmentVersion,
  createServerlessDb,
  getAssignmentVersion,
  listValidationSamples,
  validationSamples,
  type DbHandle,
} from "@ohmyti/db";
import { FsArtifactStore } from "@ohmyti/storage";
import { sql } from "drizzle-orm";
import "../scripts/load-env";
import { seedSampleAssignment } from "../scripts/db-seed-sample";
import { SAMPLE_DIR } from "../scripts/samples-check";
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
 * 과제 설정 화면 E2E (T-406, PRD 6장 ①). 로컬 전체 스택(web + worker + PostgreSQL)에서
 * 1) 새 과제: 명세 입력 → `AI 초안 생성`(워커의 Fake LLM) → 표 채움 + `AI 초안 · 미승인` + validateRubric 통과 표시 →
 *    라이브러리 이름을 판정 조건에 넣고 저장하면 서버가 거부 → 고쳐서 저장하면 DRAFT v1 화면
 * 2) 검증 → 승인: 검증 샘플(A/B/C/D, 사람 검토 서명 있음)이 붙은 DRAFT 버전에서 `검증 실행` → 워커가 샘플을 실제로 채점 →
 *    결과 표 → 승인자 이름 → `기준 승인` → 읽기 전용(편집 컨트롤 없음) → `새 버전 만들기`
 * 를 브라우저로 끝까지 확인한다.
 *
 * 워커는 이 스펙이 `LLM_PROVIDER=fake` + 응답 파일로 직접 띄운다. 이미 떠 있는 워커(`pnpm stack:local`)를 재사용하면
 * LLM 제공자를 알 수 없으므로 AI 초안 시나리오는 건너뛴다.
 */

/** 검증 job(샘플 4개 × 하네스·제출 테스트·mutation)이 끝나기를 기다리는 상한. 로컬 러너 기준 약 20~70초 */
const VALIDATION_TIMEOUT_MS = 8 * 60_000;
const OUT_DIR = path.join(repoRoot, "test-results", "assignment-setup");
const WORKER_LOG = path.join(OUT_DIR, "worker.log");
const FAKE_LLM_FILE = path.join(OUT_DIR, "llm-fake-responses.json");
const MARKER = randomBytes(3).toString("hex");

let handle: DbHandle;
let worker: ManagedProcess | null = null;
let workerReused = false;
let seeded: Awaited<ReturnType<typeof seedSampleAssignment>>;
const createdAssignmentIds: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(3 * 60_000);
  const url = process.env.DATABASE_URL;
  test.skip(!url, "DATABASE_URL이 없어 과제 설정 E2E를 건너뜁니다");
  handle = createServerlessDb(url!);
  const store = new FsArtifactStore({ root: stackArtifactRoot() });
  mkdirSync(OUT_DIR, { recursive: true });

  // 현재 하네스로 승인된 샘플 과제와 검증 샘플 스냅샷(E2E 스토어)을 준비한다 (멱등)
  seeded = await seedSampleAssignment({ db: handle.db, store });
  expect(seeded.status).toBe("APPROVED");
  expect(seeded.samples).toHaveLength(4);

  // Fake LLM 응답: AI 초안은 부록 A 기준, mutation 위치 탐색은 후보 없음(휴리스틱 결과만 쓴다)
  await writeFile(
    FAKE_LLM_FILE,
    JSON.stringify({
      RUBRIC_DRAFT: { output: sampleRubricDraftOutput() },
      MUTATION_TARGETS: { output: { candidates: [] } },
    }),
  );

  const ports = stackPorts();
  if (await isHttpUp(workerHealthUrl(ports))) {
    workerReused = true;
  } else {
    const log = createWriteStream(WORKER_LOG, { flags: "a" });
    worker = await startWorker({
      ports,
      output: log,
      env: { ...process.env, LLM_PROVIDER: "fake", LLM_FAKE_RESPONSES_FILE: FAKE_LLM_FILE },
    });
  }
});

test.afterAll(async () => {
  if (worker) await worker.stop();
  if (!handle) return;
  for (const assignmentId of createdAssignmentIds) {
    // 검증 실행이 만든 제출·평가·기록까지 지운다. execution_records는 불변(restrict FK + 트리거)이라 삭제 허용을 켠다
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ohmyti.allow_execution_record_delete = 'on'`);
      const versions = sql`(select id from assignment_versions where assignment_id = ${assignmentId})`;
      const subs = sql`(select id from submissions where assignment_version_id in ${versions})`;
      const evals = sql`(select id from evaluations where assignment_version_id in ${versions})`;
      await tx.execute(
        sql`delete from jobs where payload ->> 'assignmentVersionId' in (select id::text from assignment_versions where assignment_id = ${assignmentId})
          or payload ->> 'submissionId' in (select id::text from submissions where assignment_version_id in ${versions})
          or payload ->> 'rubricDraftId' in (select id::text from rubric_drafts where assignment_id = ${assignmentId})`,
      );
      await tx.execute(sql`delete from mutation_experiments where evaluation_id in ${evals}`);
      await tx.execute(sql`delete from evidences where evaluation_id in ${evals}`);
      await tx.execute(sql`delete from execution_records where evaluation_id in ${evals}`);
      await tx.execute(sql`delete from evaluations where assignment_version_id in ${versions}`);
      await tx.execute(sql`delete from submissions where id in ${subs}`);
      await tx.execute(sql`delete from assignments where id = ${assignmentId}`);
    });
  }
  await handle.close();
});

async function shot(page: Page, name: string): Promise<void> {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await test.info().attach(name, { path: file, contentType: "image/png" });
}

/** `/assignments/<id>/versions/<n>` URL에서 과제 ID를 꺼내 정리 목록에 넣는다 */
function trackAssignment(url: string): string {
  const match = /\/assignments\/([0-9a-f-]{36})\/versions\/(\d+)/.exec(url);
  expect(match, url).not.toBeNull();
  if (!createdAssignmentIds.includes(match![1]!)) createdAssignmentIds.push(match![1]!);
  return match![1]!;
}

test("새 과제: AI 초안이 표를 채우고 validateRubric 결과를 보이며, 라이브러리 이름 판정 조건은 저장이 거부된다", async ({
  page,
}) => {
  test.skip(workerReused, "재사용한 워커는 Fake LLM이 아닐 수 있어 AI 초안 시나리오를 건너뜁니다");
  test.setTimeout(3 * 60_000);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/assignments");
  await page.getByRole("link", { name: "새 과제" }).click();
  await expect(page).toHaveURL(/\/assignments\/new$/);

  const spec = await readFile(path.join(SAMPLE_DIR, "SPEC.md"), "utf8");
  await page.locator('input[name="name"]').fill(`E2E 과제 설정 ${MARKER}`);
  await page.getByLabel("과제 명세").fill(spec);
  await expect(page.locator('select[name="harnessVersion"]')).toHaveValue(seeded.harnessVersion);

  // AI 초안 생성 → 워커(Fake LLM)가 초안을 채운다
  await page.getByRole("button", { name: "AI 초안 생성" }).click();
  await expect(page.getByTestId("ai-draft-badge")).toHaveText("AI 초안 · 미승인", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("ai-draft-info")).toHaveAttribute("data-draft-valid", "true");
  await expect(page.getByTestId("ai-draft-info")).toContainText(
    "초안이 validateRubric()을 통과했습니다",
  );
  await expect(page.getByTestId("points-total")).toHaveText("합계 100/100");
  await expect(page.locator('[data-testid="rubric-editor"] tbody tr')).toHaveCount(15);
  await expect(page.getByLabel("1행 ID", { exact: true })).toHaveValue("R-01");
  await expect(page.getByTestId("rubric-valid")).toBeVisible();
  await shot(page, "01-ai-draft");

  // 판정 조건에 라이브러리 이름 → 화면 경고 + 서버가 validateRubric으로 거부
  const condition = page.getByLabel("1행 판정 조건", { exact: true });
  await condition.fill("express 라우터로 POST /orders를 구현하고 201을 돌려준다");
  await expect(page.locator('[data-issue-code="FORBIDDEN_LIBRARY_TERM"]')).toHaveCount(1);
  await page.getByRole("button", { name: "과제 저장" }).click();
  await expect(page.getByText("서버가 저장을 거부했습니다")).toBeVisible();
  await expect(page.locator('[data-issue-code="FORBIDDEN_LIBRARY_TERM"]')).toHaveCount(2);
  await expect(page).toHaveURL(/\/assignments\/new$/);
  await shot(page, "02-forbidden-library-rejected");

  // 고쳐서 저장 → DRAFT v1 화면
  await condition.fill(`정상 주문 201, 응답 스키마, 재고 차감 [${MARKER}]`);
  await expect(page.getByTestId("rubric-valid")).toBeVisible();
  await page.getByRole("button", { name: "과제 저장" }).click();
  await expect(page).toHaveURL(/\/assignments\/[0-9a-f-]{36}\/versions\/1$/, { timeout: 30_000 });
  trackAssignment(page.url());
  await expect(page.getByTestId("version-status")).toHaveAttribute("data-status", "DRAFT");
  await expect(page.getByTestId("assignment-editor")).toHaveAttribute("data-mode", "draft");
  await expect(page.getByLabel("1행 판정 조건", { exact: true })).toHaveValue(
    `정상 주문 201, 응답 스키마, 재고 차감 [${MARKER}]`,
  );
  // 새 과제에는 검증 샘플이 없어 검증을 시작할 수 없다
  await expect(page.getByTestId("samples-empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "검증 실행" })).toBeDisabled();
  await shot(page, "03-draft-saved");
});

test("검증 → 승인: 샘플 채점 결과 표가 나오고, 승인된 버전은 읽기 전용이며 새 버전으로만 고친다", async ({
  page,
}) => {
  test.setTimeout(VALIDATION_TIMEOUT_MS + 2 * 60_000);
  // 시드 샘플 과제의 명세·계약·기준·검증 샘플을 새 과제의 DRAFT로 복사한다. 샘플 검토 서명은 E2E 픽스처로 채운다
  // (실제 서명은 T-101 사람 확인). 기준 내용은 전역 유일(rubric_version)이라 제목에 표식을 붙인다
  const source = (await getAssignmentVersion(handle.db, seeded.assignmentVersionId))!;
  const assignment = await createAssignment(handle.db, { name: `E2E 검증·승인 ${MARKER}` });
  createdAssignmentIds.push(assignment.id);
  const rubric = structuredClone(source.rubric);
  rubric.criteria[0] = {
    ...rubric.criteria[0]!,
    title: `${rubric.criteria[0]!.title} [${MARKER}]`,
  };
  const draft = await createAssignmentVersion(handle.db, {
    assignmentId: assignment.id,
    title: "E2E 검증 버전",
    specRef: source.specRef,
    specDigest: source.specDigest,
    rubric,
    executionContract: source.executionContract,
    harnessVersion: source.harnessVersion,
  });
  const samples = await listValidationSamples(handle.db, source.id);
  await handle.db.insert(validationSamples).values(
    samples.map((s) => ({
      assignmentVersionId: draft.id,
      name: s.name,
      kind: s.kind,
      snapshotRef: s.snapshotRef,
      submissionSha: s.submissionSha,
      expected: s.expected,
      humanReviewedBy: "e2e-reviewer",
      humanReviewedAt: new Date(),
    })),
  );

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`/assignments/${assignment.id}/versions/1`);
  await expect(page.getByTestId("version-status")).toHaveAttribute("data-status", "DRAFT");
  await expect(page.locator("[data-testid=validation-samples] tbody tr")).toHaveCount(4);
  await expect(page.getByTestId("validation-samples")).toContainText("e2e-reviewer");

  // 검증 실행 → 워커가 샘플 4개를 채점 → 결과 표
  await page.getByRole("button", { name: "검증 실행" }).click();
  await expect(page.getByTestId("version-status")).toHaveAttribute("data-status", "VALIDATING");
  await expect(page.getByTestId("validation-status")).toContainText("검증 중");
  await shot(page, "04-validating");
  await expect(page.getByTestId("validation-checks")).toBeVisible({
    timeout: VALIDATION_TIMEOUT_MS,
  });
  const mismatchTable = page.getByTestId("validation-mismatches");
  if (await mismatchTable.count()) {
    throw new Error(`검증 불일치: ${await mismatchTable.innerText()}`);
  }
  for (const check of ["정답 통과", "대안 통과", "결함 탐지", "적대 샘플 동일"]) {
    await expect(page.locator(`[data-check-row="${check}"]`)).toHaveAttribute(
      "data-sample-status",
      "MATCH",
    );
  }
  await expect(page.getByTestId("validation-controls")).toHaveAttribute("data-phase", "passed");

  // 승인: 이름 없이는 비활성 + 사유, 이름을 넣으면 승인
  const approve = page.getByRole("button", { name: "기준 승인" });
  await expect(approve).toBeDisabled();
  await expect(page.locator('[data-blocker="APPROVER_MISSING"]')).toBeVisible();
  await expect(page.locator("[data-blocker]")).toHaveCount(1);
  await shot(page, "05-validation-passed");
  await page.locator('input[name="approvedBy"]').fill("E2E 승인자");
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByTestId("version-status")).toHaveAttribute("data-status", "APPROVED", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("approval-info")).toContainText("E2E 승인자 승인");

  // 승인된 버전: 편집 컨트롤 없음. 버튼은 `새 버전 만들기` 하나뿐이다
  await expect(page.getByTestId("assignment-editor")).toHaveCount(0);
  await expect(page.getByTestId("validation-controls")).toHaveCount(0);
  await expect(page.getByTestId("version-readonly")).toBeVisible();
  await expect(page.locator("main input, main textarea, main select")).toHaveCount(0);
  await expect(page.locator("main button")).toHaveText(["새 버전 만들기"]);
  await expect(page.getByTestId("validation-checks")).toBeVisible();
  await shot(page, "06-approved-readonly");

  // 새 버전 만들기 → v2 DRAFT (기준·샘플 복사, 편집 가능)
  await page.getByRole("button", { name: "새 버전 만들기" }).click();
  await expect(page).toHaveURL(new RegExp(`/assignments/${assignment.id}/versions/2$`), {
    timeout: 30_000,
  });
  await expect(page.getByTestId("version-status")).toHaveAttribute("data-status", "DRAFT");
  await expect(page.getByTestId("assignment-editor")).toBeVisible();
  await expect(page.locator("[data-testid=validation-samples] tbody tr")).toHaveCount(4);
  await expect(page.getByLabel("1행 요구사항", { exact: true })).toHaveValue(
    new RegExp(`\\[${MARKER}\\]$`),
  );
  await shot(page, "07-new-version-draft");

  const approved = (await getAssignmentVersion(handle.db, draft.id))!;
  expect(approved).toMatchObject({ status: "APPROVED", approvedBy: "E2E 승인자" });
});
