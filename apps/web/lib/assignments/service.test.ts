import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sampleRubric } from "@ohmyti/core/fixtures";
import {
  approveAssignmentVersion,
  createTestDatabase,
  startAssignmentVersionValidation,
  type TestDatabase,
} from "@ohmyti/db";
import { FsArtifactStore } from "@ohmyti/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as actions from "./actions";
import {
  ASSIGNMENT_VERSION_STATUS_LABEL,
  approveVersion,
  createVersionDraftFrom,
  readApprovalBlockers,
  requestVersionValidation,
  formatVersionLabel,
  readAssignmentList,
  readAssignmentVersion,
  registerAssignment,
  registerAssignmentVersion,
  submitToAssignmentVersion,
  type AssignmentDeps,
} from "./service";

const contract = {
  startCommand: "npm start",
  portEnv: "PORT",
  healthPath: "/health",
  healthTimeoutMs: 10_000,
  resetPath: "/admin/reset",
  templateName: "order-api-ts",
  nodeVersion: "22",
};

describe("formatVersionLabel", () => {
  it("과제명 · v<n> · 상태 형식이다", () => {
    expect(formatVersionLabel("주문·재고 API", { version: 1, status: "APPROVED" })).toBe(
      "주문·재고 API · v1 · 승인됨",
    );
    expect(formatVersionLabel("과제", { version: 3, status: "DRAFT" })).toBe("과제 · v3 · 초안");
    expect(ASSIGNMENT_VERSION_STATUS_LABEL).toEqual({
      DRAFT: "초안",
      VALIDATING: "검증 중",
      APPROVED: "승인됨",
      RETIRED: "폐기됨",
    });
  });
});

describe("서버 액션 목록", () => {
  it("승인된 버전을 갱신하는 액션이 없고(저장은 DRAFT만, T-406), 승인은 검증 게이트를 거치는 액션 하나뿐이다 (T-405)", () => {
    const names = Object.keys(actions).sort();
    expect(names).toEqual([
      "approvalBlockersAction",
      "approveVersionAction",
      "createAssignmentAction",
      "createAssignmentVersionAction",
      "createSubmissionAction",
      "createVersionDraftFromAction",
      "getAssignmentVersionAction",
      "getRubricDraftAction",
      "listAssignmentsAction",
      "requestRubricDraftAction",
      "requestValidationAction",
      "saveDraftVersionAction",
      "saveNewAssignmentAction",
    ]);
    expect(names.some((n) => /update|edit|modify|patch/i.test(n))).toBe(false);
    expect(names.filter((n) => /approve/i.test(n))).toEqual(["approveVersionAction"]);
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/web] DATABASE_URL_TEST가 없어 assignments 통합 테스트를 건너뜁니다");
}

describe.skipIf(!hasTestDb)("assignments 서비스 (통합)", () => {
  let tdb: TestDatabase;
  let storeRoot: string;
  let deps: AssignmentDeps;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storeRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-web-assignments-"));
    deps = { db: tdb.db, store: new FsArtifactStore({ root: storeRoot }) };
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  function markedRubric(marker: string) {
    const rubric = sampleRubric();
    rubric.criteria[0]!.condition = `${rubric.criteria[0]!.condition} [${marker}]`;
    return rubric;
  }

  async function draft(marker: string) {
    const assignment = await registerAssignment(deps, { name: `과제 ${marker}` });
    if (!assignment.ok) throw new Error(assignment.message);
    const version = await registerAssignmentVersion(deps, {
      assignmentId: assignment.data.id,
      title: "v1",
      specMarkdown: `# 명세 ${marker}\n`,
      executionContract: contract,
      rubric: markedRubric(marker),
      harnessVersion: "0.1.0+test",
    });
    if (!version.ok) throw new Error(version.message);
    return { assignment: assignment.data, version: version.data };
  }

  it("검증 요청은 VALIDATING + VALIDATE_RUBRIC job이고, 검증 결과·샘플 검토·승인자 없이는 승인이 거부된다 (T-405)", async () => {
    const { version } = await draft("검증 게이트");
    const requested = await requestVersionValidation(deps, version.id);
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(requested.data.version.status).toBe("VALIDATING");
    expect(requested.data.job.created).toBe(true);
    // 결과가 나오기 전 다시 요청하면 같은 job을 돌려준다
    const again = await requestVersionValidation(deps, version.id);
    expect(again.ok && again.data.job).toEqual({ id: requested.data.job.id, created: false });

    const blockers = await readApprovalBlockers(deps, {
      assignmentVersionId: version.id,
      approvedBy: "",
    });
    expect(blockers.ok && blockers.data.map((b) => b.code)).toEqual([
      "VALIDATION_MISSING",
      "SAMPLES_MISSING",
      "APPROVER_MISSING",
    ]);
    const approved = await approveVersion(deps, {
      assignmentVersionId: version.id,
      approvedBy: "담당자",
    });
    expect(approved).toMatchObject({ ok: false, code: "APPROVAL_BLOCKED" });
    expect((await readAssignmentVersion(deps, version.id)).ok).toBe(true);

    // 승인되지 않은 버전은 새 DRAFT의 원본이 될 수 있다 (명세·계약 복사)
    const copy = await createVersionDraftFrom(deps, {
      sourceVersionId: version.id,
      rubric: markedRubric("검증 게이트 v2"),
    });
    expect(copy.ok && [copy.data.status, copy.data.version, copy.data.specRef]).toEqual([
      "DRAFT",
      2,
      version.specRef,
    ]);
  });

  it("과제와 DRAFT 버전을 만들고 명세 원문을 스토어에 넣는다", async () => {
    const { assignment, version } = await draft("생성");
    expect(version.status).toBe("DRAFT");
    expect(version.specRef).toBe(`assignments/${assignment.id}/specs/${version.specDigest}.md`);
    const spec = await deps.store.get(version.specRef);
    expect(spec?.contentType).toBe("text/markdown");
    expect(Buffer.from(spec!.body).toString("utf8")).toBe("# 명세 생성\n");

    const view = await readAssignmentVersion(deps, version.id);
    expect(view.ok && view.data.label).toBe("과제 생성 · v1 · 초안");
  });

  it("입력 검증: 빈 이름·잘못된 URL·잘못된 rubric은 코드와 사유를 돌려준다", async () => {
    expect(await registerAssignment(deps, { name: "  " })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(
      await submitToAssignmentVersion(deps, { assignmentVersionId: "x", repoUrl: "ftp://x" }),
    ).toMatchObject({ ok: false, code: "INVALID_INPUT" });

    const { assignment } = await draft("검증");
    const invalidRubric = markedRubric("검증-깨짐");
    invalidRubric.criteria[0]!.maxPoints += 1;
    const result = await registerAssignmentVersion(deps, {
      assignmentId: assignment.id,
      title: "v2",
      specMarkdown: "# x",
      executionContract: contract,
      rubric: invalidRubric,
      harnessVersion: "h",
    });
    expect(result).toMatchObject({ ok: false, code: "RUBRIC_INVALID" });
    expect(result.ok === false && Array.isArray(result.details)).toBe(true);

    expect(
      await registerAssignmentVersion(deps, {
        assignmentId: "00000000-0000-0000-0000-000000000000",
        title: "v1",
        specMarkdown: "# x",
        executionContract: contract,
        rubric: markedRubric("없는 과제"),
        harnessVersion: "h",
      }),
    ).toMatchObject({ ok: false, code: "ASSIGNMENT_NOT_FOUND" });
  });

  it("DRAFT 버전에 제출하면 RUBRIC_NOT_APPROVED로 거부하고, 승인 후에는 받는다", async () => {
    const { version } = await draft("제출");
    const rejected = await submitToAssignmentVersion(deps, {
      assignmentVersionId: version.id,
      repoUrl: "https://github.com/example/repo",
    });
    expect(rejected).toMatchObject({
      ok: false,
      code: "RUBRIC_NOT_APPROVED",
      details: { assignmentVersionId: version.id, status: "DRAFT" },
    });
    expect(rejected.ok === false && rejected.message).toContain("승인되지 않은");

    await startAssignmentVersionValidation(tdb.db, version.id);
    await approveAssignmentVersion(tdb.db, {
      id: version.id,
      approvedBy: "tester",
      validationResult: { ok: true },
    });
    const accepted = await submitToAssignmentVersion(deps, {
      assignmentVersionId: version.id,
      repoUrl: "https://github.com/example/repo",
      repoRef: "main",
    });
    expect(accepted.ok && accepted.data.status).toBe("RECEIVED");
  });

  it("rubric JSON을 1바이트만 바꿔도 rubric_version이 달라진다", async () => {
    const { assignment, version: first } = await draft("바이트");
    const changed = markedRubric("바이트");
    changed.criteria[0]!.condition = `${changed.criteria[0]!.condition}.`;
    const second = await registerAssignmentVersion(deps, {
      assignmentId: assignment.id,
      title: "v2",
      specMarkdown: "# 명세 바이트\n",
      executionContract: contract,
      rubric: changed,
      harnessVersion: "0.1.0+test",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.version).toBe(2);
    expect(second.data.rubricVersion.slice(3)).not.toBe(first.rubricVersion.slice(3));
  });

  it("목록은 과제별 버전 요약을 돌려준다", async () => {
    const { assignment, version } = await draft("목록");
    const items = await readAssignmentList(deps);
    const item = items.find((i) => i.id === assignment.id);
    expect(item?.versions.map((v) => v.rubricVersion)).toEqual([version.rubricVersion]);
    expect(formatVersionLabel(item!.name, item!.versions[0]!)).toBe("과제 목록 · v1 · 초안");
  });
});
