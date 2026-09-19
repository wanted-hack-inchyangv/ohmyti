import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateRubric } from "@ohmyti/core";
import { sampleRubric } from "@ohmyti/core/fixtures";
import {
  approveAssignmentVersion,
  claimJob,
  completeRubricDraft,
  createTestDatabase,
  failRubricDraft,
  getAssignment,
  getRubricDraft,
  markRubricDraftRunning,
  startAssignmentVersionValidation,
  validationSamples,
  type TestDatabase,
} from "@ohmyti/db";
import { artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_CONTRACT_FORM,
  EMPTY_EXTRAS,
  contractToForm,
  editorToRubric,
  emptyRow,
  formToContract,
  formatExtras,
  markdownBlocks,
  rubricToExtras,
  rubricToRows,
  totalPoints,
} from "./editor";
import {
  readNewAssignmentOptions,
  readRubricDraft,
  readVersionSetup,
  requestRubricDraft,
  saveDraftVersion,
  saveNewAssignment,
  type AssignmentDeps,
} from "./service";

const contract = formToContract(DEFAULT_CONTRACT_FORM);
if (!contract.ok) throw new Error("기본 실행 계약이 올바르지 않습니다");
const executionContract = contract.contract;

function sampleEditor() {
  const rubric = sampleRubric();
  return { rows: rubricToRows(rubric), extrasJson: formatExtras(rubricToExtras(rubric)) };
}

describe("과제 설정 편집 모델 (T-406)", () => {
  it("rubric → 표·추가 규칙 → rubric 왕복이 같은 내용이고 validateRubric을 통과한다", () => {
    const { rows, extrasJson } = sampleEditor();
    const result = editorToRubric(rows, extrasJson);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues).toEqual([]);
    const { version: _a, ...expected } = sampleRubric();
    const { version: _b, ...actual } = result.rubric;
    expect(actual).toEqual(expected);
    expect(totalPoints(rows)).toBe(100);
  });

  it("라이브러리 이름을 필수 조건으로 넣으면 validateRubric 오류(FORBIDDEN_LIBRARY_TERM)가 보인다", () => {
    const { rows, extrasJson } = sampleEditor();
    rows[0] = { ...rows[0]!, condition: "Express 라우터로 POST /orders를 구현한다" };
    const result = editorToRubric(rows, extrasJson);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "FORBIDDEN_LIBRARY_TERM", ref: "R-01" }),
    ]);
  });

  it("형식 오류(배점·필수 칸·JSON)는 ok: false이고 사유를 모두 모은다", () => {
    const { rows } = sampleEditor();
    rows[0] = { ...rows[0]!, maxPoints: "8.5" };
    rows[1] = { ...rows[1]!, title: " ", condition: "" };
    const result = editorToRubric(rows, "{ groups: ");
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual([
      "INVALID_POINTS",
      "MISSING_TITLE",
      "MISSING_CONDITION",
      "EXTRAS_JSON",
    ]);
    expect(editorToRubric([], formatExtras(EMPTY_EXTRAS)).issues[0]!.code).toBe("NO_CRITERIA");
  });

  it("배점 합계가 100이 아니면 TOTAL_POINTS_MISMATCH, 정적 검사가 없는 기준을 가리키면 오류다", () => {
    const { rows, extrasJson } = sampleEditor();
    const extra = [
      ...rows,
      { ...emptyRow(rows.length), title: "추가", condition: "추가 조건", maxPoints: "5" },
    ];
    expect(totalPoints(extra)).toBe(105);
    expect(editorToRubric(extra, extrasJson).issues.map((i) => i.code)).toEqual([
      "TOTAL_POINTS_MISMATCH",
    ]);
    const extras = {
      ...rubricToExtras(sampleRubric()),
      staticChecks: { "R-99": [{ kind: "DEPENDENCY_DECLARED", packageName: "left-pad" }] },
    };
    expect(editorToRubric(rows, JSON.stringify(extras)).issues.map((i) => i.code)).toEqual([
      "STATIC_CHECK_UNKNOWN_CRITERION",
    ]);
  });

  it("실행 계약 폼 ↔ 계약, 잘못된 값은 칸 이름과 함께 알린다", () => {
    expect(contractToForm(executionContract)).toEqual(DEFAULT_CONTRACT_FORM);
    const bad = formToContract({
      ...DEFAULT_CONTRACT_FORM,
      healthPath: "health",
      healthTimeoutMs: "abc",
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.map((i) => i.message).join(" ")).toContain("헬스 경로");
    expect(bad.issues.map((i) => i.message).join(" ")).toContain("헬스 대기(ms)");
    const noReset = formToContract({ ...DEFAULT_CONTRACT_FORM, resetPath: "" });
    expect(noReset.ok && "resetPath" in noReset.contract).toBe(false);
  });

  it("명세 미리보기는 제목·목록·코드·문단 블록으로 나누고 HTML을 만들지 않는다", () => {
    expect(
      markdownBlocks(
        "# 제목\n\n본문 첫 줄\n둘째 줄\n- 하나\n- 둘\n```\n<script>x</script>\n```\n## 소제목",
      ),
    ).toEqual([
      { kind: "heading", level: 1, text: "제목" },
      { kind: "paragraph", text: "본문 첫 줄 둘째 줄" },
      { kind: "list", items: ["하나", "둘"] },
      { kind: "code", text: "<script>x</script>" },
      { kind: "heading", level: 2, text: "소제목" },
    ]);
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

describe.skipIf(!hasTestDb)("과제 설정 서비스 (통합, T-406)", () => {
  let tdb: TestDatabase;
  let storeRoot: string;
  let deps: AssignmentDeps;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storeRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-web-setup-"));
    deps = { db: tdb.db, store: new FsArtifactStore({ root: storeRoot }) };
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  function markedRubric(marker: string) {
    const rubric = sampleRubric();
    rubric.criteria[0]!.title = `${rubric.criteria[0]!.title} [${marker}]`;
    return rubric;
  }

  async function saveNew(marker: string, rubric = markedRubric(marker)) {
    return saveNewAssignment(deps, {
      name: `과제 ${marker}`,
      title: "v1",
      specMarkdown: `# 명세 ${marker}\n`,
      executionContract,
      rubric,
      harnessVersion: "0.1.0+test",
    });
  }

  it("AI 초안 요청: 명세를 내용 주소 키로 저장하고 rubric_drafts 행 + DRAFT_RUBRIC job을 만든다. 상태는 폴링으로 읽는다", async () => {
    const requested = await requestRubricDraft(deps, { specMarkdown: "# 주문 API\n" });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    const row = (await getRubricDraft(tdb.db, requested.data.draftId))!;
    expect(row.specRef).toBe(artifactKeys.rubricDraftSpec(row.specDigest));
    expect(await deps.store.exists(row.specRef)).toBe(true);
    const job = await claimJob(tdb.db, { workerId: "t", types: ["DRAFT_RUBRIC"] });
    expect(job?.payload).toEqual({ rubricDraftId: row.id });

    const queued = await readRubricDraft(deps, row.id);
    expect(queued.ok && queued.data.status).toBe("QUEUED");

    // 워커가 채운 결과를 화면이 그대로 받는다 (규칙 위반 초안도 오류 목록과 함께)
    await markRubricDraftRunning(tdb.db, row.id);
    const rubric = sampleRubric();
    await completeRubricDraft(tdb.db, {
      id: row.id,
      rubric,
      validationErrors: [],
      notes: ["메모"],
      droppedMutationIds: [],
      aiReviewId: null,
      model: "fake-model",
      promptVersion: "rubric-draft@v1+00000000",
    });
    const done = await readRubricDraft(deps, row.id);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.data).toMatchObject({
      status: "SUCCEEDED",
      rubric,
      validationErrors: [],
      notes: ["메모"],
      failure: null,
    });

    const failedReq = await requestRubricDraft(deps, { specMarkdown: "# 다른 명세\n" });
    if (!failedReq.ok) throw new Error(failedReq.message);
    await failRubricDraft(tdb.db, {
      id: failedReq.data.draftId,
      code: "LLM_NOT_CONFIGURED",
      message: "LLM 미실행: 키 없음",
    });
    const failed = await readRubricDraft(deps, failedReq.data.draftId);
    expect(failed.ok && failed.data.failure).toEqual({
      code: "LLM_NOT_CONFIGURED",
      message: "LLM 미실행: 키 없음",
    });
  });

  it("AI 초안 요청 입력 검사: 빈 명세·없는 과제·잘못된 ID", async () => {
    const empty = await requestRubricDraft(deps, { specMarkdown: "  " });
    expect(empty.ok ? null : empty.code).toBe("INVALID_INPUT");
    const missing = await requestRubricDraft(deps, {
      specMarkdown: "# x",
      assignmentId: "00000000-0000-4000-8000-000000000000",
    });
    expect(missing.ok ? null : missing.code).toBe("ASSIGNMENT_NOT_FOUND");
    const badId = await readRubricDraft(deps, "nope");
    expect(badId.ok ? null : badId.code).toBe("INVALID_INPUT");
  });

  it("새 과제 저장: 과제 + DRAFT v1. 라이브러리 이름 판정 조건은 validateRubric이 거부하고 빈 과제를 남기지 않는다", async () => {
    const saved = await saveNew("새 과제");
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.version).toMatchObject({ version: 1, status: "DRAFT" });

    const bad = markedRubric("라이브러리");
    bad.criteria[0]!.condition = "express 사용";
    const rejected = await saveNew("라이브러리", bad);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("RUBRIC_INVALID");
    expect(rejected.details).toEqual([
      expect.objectContaining({ code: "FORBIDDEN_LIBRARY_TERM", ref: "R-01" }),
    ]);
    expect(validateRubric(bad).ok).toBe(false);

    // 같은 내용의 v1이 이미 있으면 버전 생성이 실패하고, 먼저 만든 과제는 지운다
    const duplicate = await saveNew("새 과제");
    expect(duplicate.ok ? null : duplicate.code).toBe("RUBRIC_VERSION_EXISTS");
    const options = await readNewAssignmentOptions(deps);
    expect(options.harnessVersions).toEqual(["0.1.0+test"]);
  });

  it("DRAFT 저장은 rubricVersion을 다시 계산하고 검증 결과를 지운다. 승인된 버전은 저장이 거부된다", async () => {
    const saved = await saveNew("초안 저장");
    if (!saved.ok) throw new Error(saved.message);
    const { assignment, version } = saved.data;
    const rubric = markedRubric("초안 저장 2");
    const updated = await saveDraftVersion(deps, {
      assignmentVersionId: version.id,
      title: "v1 수정",
      specMarkdown: "# 고친 명세\n",
      executionContract,
      rubric,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.version).toBe(1);
    expect(updated.data.title).toBe("v1 수정");
    expect(updated.data.rubricVersion).not.toBe(version.rubricVersion);
    expect(updated.data.rubricVersion).toMatch(/^v1-[0-9a-f]{8}$/);
    expect(updated.data.rubric.version).toBe(updated.data.rubricVersion);
    expect(updated.data.specRef).toBe(
      artifactKeys.assignmentSpec(assignment.id, updated.data.specDigest),
    );

    const forbidden = {
      ...rubric,
      criteria: rubric.criteria.map((c, i) =>
        i === 0 ? { ...c, condition: "fastify 플러그인" } : c,
      ),
    };
    const rejected = await saveDraftVersion(deps, {
      assignmentVersionId: version.id,
      title: "v1",
      specMarkdown: "# 명세\n",
      executionContract,
      rubric: forbidden,
    });
    expect(rejected.ok ? null : rejected.code).toBe("RUBRIC_INVALID");

    await startAssignmentVersionValidation(tdb.db, version.id);
    await approveAssignmentVersion(tdb.db, {
      id: version.id,
      approvedBy: "tester",
      validationResult: null,
    });
    const locked = await saveDraftVersion(deps, {
      assignmentVersionId: version.id,
      title: "v1",
      specMarkdown: "# 명세\n",
      executionContract,
      rubric: markedRubric("승인 뒤"),
    });
    expect(locked.ok ? null : locked.code).toBe("INVALID_TRANSITION");
    expect(await getAssignment(tdb.db, assignment.id)).not.toBeNull();
  });

  it("버전 화면 데이터: 명세 원문·샘플·승인 차단 사유(승인자 제외)·버전 목록", async () => {
    const saved = await saveNew("화면");
    if (!saved.ok) throw new Error(saved.message);
    const { assignment, version } = saved.data;
    await tdb.db.insert(validationSamples).values({
      assignmentVersionId: version.id,
      name: "A",
      kind: "CORRECT",
      snapshotRef: `assignments/${assignment.id}/versions/1/samples/A/snapshot.tar.gz`,
      submissionSha: "0123456789abcdef0123456789abcdef01234567",
      expected: { criteria: {} },
      humanReviewedBy: "리뷰어",
    });
    const setup = await readVersionSetup(deps, assignment.id, 1);
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.data.specMarkdown).toBe("# 명세 화면\n");
    expect(setup.data.samples).toEqual([
      expect.objectContaining({ name: "A", kind: "CORRECT", humanReviewedBy: "리뷰어" }),
    ]);
    expect(setup.data.blockers.map((b) => b.code)).toEqual([
      "NOT_VALIDATING",
      "VALIDATION_MISSING",
    ]);
    expect(setup.data.validation).toBeNull();
    expect(setup.data.validationJob).toBeNull();
    expect(setup.data.versions).toEqual([{ version: 1, status: "DRAFT" }]);

    const missing = await readVersionSetup(deps, assignment.id, 9);
    expect(missing.ok ? null : missing.code).toBe("VERSION_NOT_FOUND");
    const invalid = await readVersionSetup(deps, "x", 1);
    expect(invalid.ok ? null : invalid.code).toBe("INVALID_INPUT");
  });
});
