import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovedVersionListResponseSchema, CreatedSubmissionResponseSchema } from "@ohmyti/core";
import {
  createTestDatabase,
  getJob,
  getSubmission,
  getSubmissionContext,
  seedEvaluation,
  type TestDatabase,
} from "@ohmyti/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AccessConfig } from "@/lib/auth/config";
import { decideAccess } from "@/lib/auth/guard";
import { isPublicPath } from "@/lib/auth/paths";
import { toApiResult } from "./route";

describe("toApiResult", () => {
  it("성공은 그대로, 폼 오류 코드는 조회 API 봉투의 코드로 옮긴다", () => {
    const ok = {
      ok: true as const,
      data: { submissionId: "s", jobId: "j", resumeRef: null, githubLogin: null },
    };
    expect(toApiResult(ok)).toBe(ok);
    expect(toApiResult({ ok: false, code: "RUBRIC_NOT_APPROVED", message: "m" })).toEqual({
      ok: false,
      code: "RUBRIC_NOT_APPROVED",
      message: "m",
    });
    expect(toApiResult({ ok: false, code: "VERSION_NOT_FOUND", message: "m" })).toMatchObject({
      code: "VERSION_NOT_FOUND",
    });
    // 이력서를 받지 않는 이 API에서는 나올 수 없는 코드는 INVALID_INPUT으로 접는다
    expect(toApiResult({ ok: false, code: "INTERNAL", message: "m" })).toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("접근 보호 (T-008 proxy)", () => {
  const ENABLED: AccessConfig = {
    enabled: true,
    password: "pw",
    secret: "0123456789abcdef0123456789abcdef",
  };

  it("제출 생성·버전 목록 경로는 공개 경로가 아니며 쿠키 없는 요청은 401이다", async () => {
    for (const [pathname, method] of [
      ["/api/submissions", "POST"],
      ["/api/assignment-versions", "GET"],
    ] as const) {
      expect(isPublicPath(pathname)).toBe(false);
      const decision = await decideAccess(
        { pathname, search: "", method, accept: "application/json", sessionToken: undefined },
        ENABLED,
      );
      expect(decision, pathname).toEqual({ kind: "unauthorized" });
    }
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/web] DATABASE_URL_TEST가 없어 submissions API 통합 테스트를 건너뜁니다");
}

describe.skipIf(!hasTestDb)("POST /api/submissions · GET /api/assignment-versions (통합)", () => {
  let tdb: TestDatabase;
  let storeRoot: string;
  let approvedVersionId: string;
  let draftVersionId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    storeRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-web-submissions-api-"));
    approvedVersionId = (await seedEvaluation(tdb.db, `web-t208-${Date.now()}`))
      .assignmentVersionId;
    // 승인된 버전은 트리거가 고정하므로 DRAFT 버전을 새로 만든다
    const [draft] = await tdb.sql<{ id: string }[]>`
      insert into assignment_versions
        (assignment_id, version, status, title, spec_ref, spec_digest, rubric, rubric_version, execution_contract, harness_version)
      select assignment_id, 2, 'DRAFT', 'v2', spec_ref, spec_digest, rubric, ${`draft-${Date.now()}`}, execution_contract, harness_version
      from assignment_versions where id = ${approvedVersionId}
      returning id`;
    draftVersionId = draft!.id;
    // 핸들러는 환경변수로 DB·스토어를 만든다
    process.env.DATABASE_URL = tdb.url;
    process.env.ARTIFACT_STORE = "fs";
    process.env.ARTIFACT_FS_ROOT = storeRoot;
  }, 60_000);

  afterAll(async () => {
    await tdb?.destroy();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  function post(body: unknown, raw = false) {
    return new Request("http://localhost/api/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    });
  }

  it("승인 버전 목록에 시드한 APPROVED 버전만 나온다", async () => {
    const route = await import("../assignment-versions/route");
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = ApprovedVersionListResponseSchema.parse(await res.json());
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.data.some((v) => v.id === approvedVersionId)).toBe(true);
    expect(body.data.some((v) => v.id === draftVersionId)).toBe(false);
  });

  it("JSON 본문으로 제출하면 201과 제출·job ID를 돌려주고 제출은 QUEUED다", async () => {
    const route = await import("./route");
    const res = await route.POST(
      post({
        assignmentVersionId: approvedVersionId,
        repoUrl: "https://github.com/inchyangv/ohmyti-sample-a",
        commitSha: "4BEE62EB",
        githubProfileUrl: "https://github.com/octocat",
      }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = CreatedSubmissionResponseSchema.parse(await res.json());
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.data.resumeRef).toBeNull();
    expect(body.data.githubLogin).toBe("octocat");
    const submission = await getSubmission(tdb.db, body.data.submissionId);
    expect(submission).toMatchObject({
      status: "QUEUED",
      repoUrl: "https://github.com/inchyangv/ohmyti-sample-a",
      repoRef: "4bee62eb",
    });
    const job = await getJob(tdb.db, body.data.jobId);
    expect(job).toMatchObject({ type: "EVALUATE_SUBMISSION", status: "QUEUED" });
    expect(await getSubmissionContext(tdb.db, body.data.submissionId)).toMatchObject({
      resumeRef: null,
      githubLogin: "octocat",
    });
  });

  it("잘못된 본문·URL·SHA는 400 INVALID_INPUT, 승인되지 않은 버전은 409 RUBRIC_NOT_APPROVED다", async () => {
    const route = await import("./route");
    const notJson = await route.POST(post("{not json", true));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ ok: false, code: "INVALID_INPUT" });

    const badUrl = await route.POST(
      post({ assignmentVersionId: approvedVersionId, repoUrl: "https://gitlab.com/a/b" }),
    );
    expect(badUrl.status).toBe(400);
    expect(await badUrl.json()).toMatchObject({ ok: false, code: "INVALID_INPUT" });

    const badSha = await route.POST(
      post({
        assignmentVersionId: approvedVersionId,
        repoUrl: "https://github.com/inchyangv/ohmyti-sample-a",
        commitSha: "main",
      }),
    );
    expect(badSha.status).toBe(400);

    const unknownField = await route.POST(
      post({
        assignmentVersionId: approvedVersionId,
        repoUrl: "https://github.com/inchyangv/ohmyti-sample-a",
        resume: "x",
      }),
    );
    expect(unknownField.status).toBe(400);

    const draft = await route.POST(
      post({
        assignmentVersionId: draftVersionId,
        repoUrl: "https://github.com/inchyangv/ohmyti-sample-a",
      }),
    );
    expect(draft.status).toBe(409);
    expect(await draft.json()).toMatchObject({ ok: false, code: "RUBRIC_NOT_APPROVED" });
  });
});
