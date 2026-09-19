import { RUBRIC_VERSION_PATTERN } from "@ohmyti/core";
import { sampleRubric } from "@ohmyti/core/fixtures";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as assignmentsModule from "./assignments";
import {
  AssignmentError,
  approveAssignmentVersion,
  computeRubricVersion,
  createAssignment,
  createAssignmentVersion,
  createSubmission,
  deleteAssignmentWithoutVersions,
  getAssignmentVersion,
  getAssignmentVersionByNumber,
  listAssignments,
  listKnownHarnessVersions,
  updateDraftAssignmentVersion,
  rejectAssignmentVersionValidation,
  retireAssignmentVersion,
  rubricContentDigest,
  setAssignmentVersionReportProfile,
  specDigestOf,
  startAssignmentVersionValidation,
  SubmissionRejectedError,
  type AssignmentVersionRow,
} from "./assignments";
import { assignmentVersions, submissions } from "./schema";
import { DIGEST, minimalContract } from "./test-fixtures";
import { createTestDatabase, type TestDatabase } from "./testing";

async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "쿼리가 실패해야 합니다").toBeInstanceOf(Error);
  const err = caught as Error & { cause?: unknown };
  const cause = err.cause instanceof Error ? err.cause.message : "";
  expect(`${err.message}\n${cause}`).toMatch(pattern);
}

describe("computeRubricVersion", () => {
  it("v<n>-<sha256 앞 8자> 형식이다", () => {
    const version = computeRubricVersion(sampleRubric(), 1);
    expect(version).toMatch(RUBRIC_VERSION_PATTERN);
    expect(version.slice(3)).toBe(rubricContentDigest(sampleRubric()).slice(0, 8));
  });

  it("rubric 내용이 1바이트만 달라도 값이 달라진다", () => {
    const base = sampleRubric();
    const changed = structuredClone(base);
    const first = changed.criteria[0];
    if (!first) throw new Error("샘플 rubric에 기준이 없습니다");
    first.condition = `${first.condition}.`;
    expect(computeRubricVersion(changed, 1)).not.toBe(computeRubricVersion(base, 1));
  });

  it("rubric의 version 필드와 키 순서는 값에 영향을 주지 않는다", () => {
    const base = sampleRubric();
    const renamed = { ...base, version: "다른-이름" };
    const { independentReasons, ...rest } = base;
    const reordered = JSON.parse(JSON.stringify({ independentReasons, ...rest })) as typeof base;
    expect(computeRubricVersion(renamed, 2)).toBe(computeRubricVersion(base, 2));
    expect(computeRubricVersion(reordered, 2)).toBe(computeRubricVersion(base, 2));
    expect(computeRubricVersion(base, 2)).not.toBe(computeRubricVersion(base, 1));
  });

  it("specDigestOf는 sha256 hex다", () => {
    expect(specDigestOf("# 명세")).toMatch(/^[0-9a-f]{64}$/);
    expect(specDigestOf("# 명세")).not.toBe(specDigestOf("# 명세 "));
  });
});

describe("승인된 버전을 갱신하는 함수가 없다", () => {
  it("공개 함수 목록에 update·modify·edit 이름이 없고 전이 함수만 상태를 바꾼다", () => {
    const names = Object.keys(assignmentsModule).filter(
      (name) => typeof (assignmentsModule as Record<string, unknown>)[name] === "function",
    );
    // 내용을 고치는 함수는 DRAFT 전용 `updateDraftAssignmentVersion`(T-406 과제 설정 저장) 하나뿐이다.
    // DRAFT가 아니면 거부하는 것은 아래 통합 테스트와 DB 트리거가 확인한다.
    // `setAssignmentVersionReportProfile`(T-705)은 예외다: rubric·명세·실행 계약이 아니라 채용 리포트의 표시용 자료
    // (기준별 역량 보정·영향 문장)만 바꾸며 rubricVersion 해시와 점수·판정에 영향이 없다 (아래 통합 테스트가 확인한다)
    const contentMutators = ["updateDraftAssignmentVersion", "setAssignmentVersionReportProfile"];
    expect(
      names.filter((n) => /update|modify|edit|patch|set/i.test(n) && !contentMutators.includes(n)),
    ).toEqual([]);
    expect(names.sort()).toEqual(
      [
        "AssignmentError",
        "SubmissionRejectedError",
        "approveAssignmentVersion",
        "computeRubricVersion",
        "createAssignment",
        "createAssignmentVersion",
        "createSubmission",
        "deleteAssignmentWithoutVersions",
        "getAssignment",
        "getAssignmentVersion",
        "getAssignmentVersionByNumber",
        "getAssignmentVersionByRubricVersion",
        "listAssignmentVersions",
        "listAssignments",
        "listKnownHarnessVersions",
        "rejectAssignmentVersionValidation",
        "retireAssignmentVersion",
        "rubricContentDigest",
        "setAssignmentVersionReportProfile",
        "specDigestOf",
        "startAssignmentVersionValidation",
        "updateDraftAssignmentVersion",
      ].sort(),
    );
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/db] DATABASE_URL_TEST가 없어 assignments 통합 테스트를 건너뜁니다");
}

describe.skipIf(!hasTestDb)("assignments (통합)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
  });

  /** rubric_version은 전역 유일이므로 테스트마다 판정 조건에 표식을 넣어 내용을 다르게 한다 */
  function markedRubric(marker: string) {
    const rubric = sampleRubric();
    const first = rubric.criteria[0];
    if (!first) throw new Error("샘플 rubric에 기준이 없습니다");
    first.condition = `${first.condition} [${marker}]`;
    return rubric;
  }

  async function draftVersion(name = "과제", marker = name): Promise<AssignmentVersionRow> {
    const assignment = await createAssignment(tdb.db, { name });
    return createAssignmentVersion(tdb.db, {
      assignmentId: assignment.id,
      title: `${name} v1`,
      specRef: "assignments/x/versions/1/spec.md",
      specDigest: DIGEST,
      rubric: markedRubric(marker),
      executionContract: minimalContract(),
      harnessVersion: "0.1.0+test",
    });
  }

  it("updateDraftAssignmentVersion: DRAFT만 고치고 rubricVersion을 다시 계산하며 검증 결과를 지운다. DRAFT가 아니면 거부한다 (T-406)", async () => {
    const draft = await draftVersion("초안 수정");
    await tdb.db
      .update(assignmentVersions)
      .set({ validationResult: { stale: true } })
      .where(eq(assignmentVersions.id, draft.id));
    const rubric = markedRubric("초안 수정 2");
    const updated = await updateDraftAssignmentVersion(tdb.db, {
      id: draft.id,
      title: "고친 제목",
      specRef: draft.specRef,
      specDigest: draft.specDigest,
      rubric,
      executionContract: minimalContract(),
    });
    expect(updated.version).toBe(1);
    expect(updated.title).toBe("고친 제목");
    expect(updated.rubricVersion).toBe(computeRubricVersion(rubric, 1));
    expect(updated.rubric.version).toBe(updated.rubricVersion);
    expect(updated.validationResult).toBeNull();

    const bad = markedRubric("초안 수정 3");
    bad.criteria[0]!.condition = "koa 미들웨어";
    await expect(
      updateDraftAssignmentVersion(tdb.db, { ...updated, id: draft.id, rubric: bad }),
    ).rejects.toMatchObject({ code: "RUBRIC_INVALID" });

    await startAssignmentVersionValidation(tdb.db, draft.id);
    await expect(
      updateDraftAssignmentVersion(tdb.db, {
        ...updated,
        id: draft.id,
        rubric: markedRubric("검증 중"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await approveAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "tester",
      validationResult: null,
    });
    await expect(
      updateDraftAssignmentVersion(tdb.db, {
        ...updated,
        id: draft.id,
        rubric: markedRubric("승인 뒤"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await getAssignmentVersion(tdb.db, draft.id))!.rubricVersion).toBe(
      updated.rubricVersion,
    );
  });

  it("버전 없는 과제만 지우고, 번호로 버전을 찾는다 (T-406)", async () => {
    const empty = await createAssignment(tdb.db, { name: "빈 과제" });
    expect(await deleteAssignmentWithoutVersions(tdb.db, empty.id)).toBe(true);
    const draft = await draftVersion("버전 있는 과제");
    expect(await deleteAssignmentWithoutVersions(tdb.db, draft.assignmentId)).toBe(false);
    expect((await getAssignmentVersionByNumber(tdb.db, draft.assignmentId, 1))?.id).toBe(draft.id);
    expect(await getAssignmentVersionByNumber(tdb.db, draft.assignmentId, 2)).toBeNull();
    expect(await listKnownHarnessVersions(tdb.db)).toContain("0.1.0+test");
  });

  async function approvedVersion(name: string): Promise<AssignmentVersionRow> {
    const draft = await draftVersion(name);
    await startAssignmentVersionValidation(tdb.db, draft.id);
    return approveAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "tester",
      validationResult: { ok: true },
    });
  }

  it("버전 생성은 DRAFT이고 rubricVersion과 저장된 rubric.version이 같다", async () => {
    const version = await draftVersion("생성");
    expect(version.status).toBe("DRAFT");
    expect(version.version).toBe(1);
    expect(version.rubricVersion).toBe(computeRubricVersion(markedRubric("생성"), 1));
    expect(version.rubric.version).toBe(version.rubricVersion);
    expect(version.approvedAt).toBeNull();
  });

  it("같은 과제에 두 번째 버전을 만들면 번호가 2이고 내용이 같아도 rubricVersion이 다르다", async () => {
    const first = await draftVersion("두 번째");
    const second = await createAssignmentVersion(tdb.db, {
      assignmentId: first.assignmentId,
      title: "v2",
      specRef: "assignments/x/versions/2/spec.md",
      specDigest: DIGEST,
      rubric: markedRubric("두 번째"),
      executionContract: minimalContract(),
      harnessVersion: "0.1.0+test",
    });
    expect(second.version).toBe(2);
    expect(second.rubricVersion).not.toBe(first.rubricVersion);
    expect(second.rubricVersion.startsWith("v2-")).toBe(true);
  });

  it("유효하지 않은 rubric은 RUBRIC_INVALID로 거부한다", async () => {
    const assignment = await createAssignment(tdb.db, { name: "잘못된 기준" });
    const rubric = sampleRubric();
    const first = rubric.criteria[0];
    if (!first) throw new Error("샘플 rubric에 기준이 없습니다");
    first.maxPoints += 1;
    await expect(
      createAssignmentVersion(tdb.db, {
        assignmentId: assignment.id,
        title: "v1",
        specRef: "s",
        specDigest: DIGEST,
        rubric,
        executionContract: minimalContract(),
        harnessVersion: "h",
      }),
    ).rejects.toMatchObject({ name: "AssignmentError", code: "RUBRIC_INVALID" });
  });

  it("DRAFT 버전에 제출을 만들면 RUBRIC_NOT_APPROVED다 (함수 검사 + DB 트리거)", async () => {
    const draft = await draftVersion("초안 제출");
    let caught: unknown;
    try {
      await createSubmission(tdb.db, {
        assignmentVersionId: draft.id,
        repoUrl: "https://github.com/example/repo",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SubmissionRejectedError);
    expect((caught as SubmissionRejectedError).reason).toBe("RUBRIC_NOT_APPROVED");
    expect((caught as SubmissionRejectedError).versionStatus).toBe("DRAFT");

    // 함수를 우회한 직접 INSERT도 트리거가 막는다
    await expectDbError(
      tdb.db.insert(submissions).values({
        assignmentVersionId: draft.id,
        repoUrl: "https://github.com/example/repo",
      }),
      /RUBRIC_NOT_APPROVED/,
    );
    const rows = await tdb.db
      .select()
      .from(submissions)
      .where(eq(submissions.assignmentVersionId, draft.id));
    expect(rows).toHaveLength(0);
  });

  it("VALIDATING·RETIRED 버전에도 제출을 만들 수 없고 APPROVED에는 만들 수 있다", async () => {
    const validating = await draftVersion("검증 중");
    await startAssignmentVersionValidation(tdb.db, validating.id);
    await expect(
      createSubmission(tdb.db, { assignmentVersionId: validating.id, repoUrl: "https://x.test" }),
    ).rejects.toMatchObject({ reason: "RUBRIC_NOT_APPROVED", versionStatus: "VALIDATING" });

    const approved = await approvedVersion("승인됨");
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId: approved.id,
      repoUrl: "https://github.com/example/repo",
      repoRef: "main",
    });
    expect(submission.status).toBe("RECEIVED");

    await retireAssignmentVersion(tdb.db, approved.id);
    await expect(
      createSubmission(tdb.db, { assignmentVersionId: approved.id, repoUrl: "https://x.test" }),
    ).rejects.toMatchObject({ reason: "RUBRIC_NOT_APPROVED", versionStatus: "RETIRED" });
  });

  it("없는 버전에 제출하면 VERSION_NOT_FOUND다", async () => {
    await expect(
      createSubmission(tdb.db, {
        assignmentVersionId: "00000000-0000-0000-0000-000000000000",
        repoUrl: "https://x.test",
      }),
    ).rejects.toMatchObject({ reason: "VERSION_NOT_FOUND" });
  });

  it("상태 전이는 부록 B 순서만 허용한다", async () => {
    const draft = await draftVersion("전이");
    await expect(
      approveAssignmentVersion(tdb.db, { id: draft.id, approvedBy: "t", validationResult: {} }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const validating = await startAssignmentVersionValidation(tdb.db, draft.id);
    expect(validating.status).toBe("VALIDATING");
    const back = await rejectAssignmentVersionValidation(tdb.db, {
      id: draft.id,
      validationResult: { ok: false },
    });
    expect(back.status).toBe("DRAFT");
    expect(back.validationResult).toEqual({ ok: false });

    await startAssignmentVersionValidation(tdb.db, draft.id);
    const approved = await approveAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "reviewer",
      validationResult: { ok: true },
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedBy).toBe("reviewer");
    expect(approved.approvedAt).toBeInstanceOf(Date);

    await expect(startAssignmentVersionValidation(tdb.db, draft.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    await expect(
      startAssignmentVersionValidation(tdb.db, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
  });

  it("DB 트리거가 APPROVED 행의 rubric·계약·명세·rubric_version 변경을 막는다", async () => {
    const approved = await approvedVersion("불변");
    const changedRubric = structuredClone(approved.rubric);
    const first = changedRubric.criteria[0];
    if (!first) throw new Error("기준이 없습니다");
    first.condition = "바뀐 조건";

    const attempts: Partial<typeof assignmentVersions.$inferInsert>[] = [
      { rubric: changedRubric },
      { rubricVersion: "v9-deadbeef" },
      { executionContract: { ...approved.executionContract, startCommand: "node x.js" } },
      { specRef: "other" },
      { specDigest: "b".repeat(64) },
      { harnessVersion: "0.9.0+x" },
      { validationResult: { tampered: true } },
      { approvedBy: "someone-else" },
      { title: "다른 제목" },
      { status: "DRAFT" },
      { status: "VALIDATING" },
    ];
    for (const patch of attempts) {
      await expectDbError(
        tdb.db.update(assignmentVersions).set(patch).where(eq(assignmentVersions.id, approved.id)),
        /assignment_versions_immutable_when_approved|immutable|not allowed/,
      );
    }
    const after = await getAssignmentVersion(tdb.db, approved.id);
    expect(after?.rubric).toEqual(approved.rubric);
    expect(after?.rubricVersion).toBe(approved.rubricVersion);
    expect(after?.status).toBe("APPROVED");

    // 허용되는 변경: APPROVED → RETIRED
    const retired = await retireAssignmentVersion(tdb.db, approved.id);
    expect(retired.status).toBe("RETIRED");
    expect(retired.retiredAt).toBeInstanceOf(Date);
    await expectDbError(
      tdb.db
        .update(assignmentVersions)
        .set({ status: "APPROVED" })
        .where(eq(assignmentVersions.id, approved.id)),
      /assignment_versions_immutable_when_approved|not allowed/,
    );
  });

  it("승인된 버전에도 채용 리포트 프로필을 넣을 수 있고 rubric과 rubricVersion은 그대로다 (T-705)", async () => {
    const approved = await approvedVersion("리포트 프로필");
    const profile = {
      profileVersion: 1,
      criteria: [
        { criterionId: "R-01", competency: "DATA_INTEGRITY" as const, impact: "영향 문장" },
      ],
    };
    const updated = await setAssignmentVersionReportProfile(tdb.db, approved.id, profile);
    expect(updated?.reportProfile).toEqual(profile);
    expect(updated?.rubric).toEqual(approved.rubric);
    expect(updated?.rubricVersion).toBe(approved.rubricVersion);
    expect(updated?.status).toBe("APPROVED");

    // 형식이 맞지 않는 프로필은 저장하지 않는다
    await expect(
      setAssignmentVersionReportProfile(tdb.db, approved.id, {
        profileVersion: 1,
        criteria: [{ criterionId: "R-01" }, { criterionId: "R-01" }],
      }),
    ).rejects.toThrow();

    expect(await setAssignmentVersionReportProfile(tdb.db, approved.id, null)).toMatchObject({
      reportProfile: null,
    });
  });

  it("DRAFT 행은 트리거의 제한을 받지 않는다", async () => {
    const draft = await draftVersion("초안 수정");
    const [row] = await tdb.db
      .update(assignmentVersions)
      .set({ title: "고친 제목" })
      .where(eq(assignmentVersions.id, draft.id))
      .returning();
    expect(row?.title).toBe("고친 제목");
  });

  it("listAssignments는 과제별 버전을 번호 내림차순으로 싣는다", async () => {
    const first = await draftVersion("목록");
    await createAssignmentVersion(tdb.db, {
      assignmentId: first.assignmentId,
      title: "v2",
      specRef: "s2",
      specDigest: DIGEST,
      rubric: markedRubric("목록"),
      executionContract: minimalContract(),
      harnessVersion: "h",
    });
    const empty = await createAssignment(tdb.db, { name: "버전 없는 과제" });

    const items = await listAssignments(tdb.db);
    const listed = items.find((i) => i.id === first.assignmentId);
    expect(listed?.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(listed?.versions[1]?.rubricVersion).toBe(first.rubricVersion);
    expect(items.find((i) => i.id === empty.id)?.versions).toEqual([]);
  });

  it("같은 내용·같은 번호의 rubric은 다른 과제에서도 RUBRIC_VERSION_EXISTS다", async () => {
    await draftVersion("중복 A", "중복");
    let caught: unknown;
    try {
      await draftVersion("중복 B", "중복");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AssignmentError);
    expect((caught as AssignmentError).code).toBe("RUBRIC_VERSION_EXISTS");
  });
});
