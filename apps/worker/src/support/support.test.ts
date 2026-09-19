import {
  approveAssignmentVersion,
  createAssignment,
  createAssignmentVersion,
  createEvaluation,
  createSubmission,
  createTestDatabase,
  getEvaluation,
  getSubmission,
  pinSubmissionSnapshot,
  startAssignmentVersionValidation,
  type TestDatabase,
} from "@ohmyti/db";
import { sampleRubric } from "@ohmyti/core/fixtures";
import { inMemoryFiles, packDirectoryToTarGz, TemplateManifestSchema } from "@ohmyti/runner";
import { artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  checkSupport,
  detectLanguage,
  formatSupportReasons,
  startProgramOf,
  SupportReportSchema,
} from "./check";
import {
  readSnapshotEntries,
  snapshotFilesFromBytes,
  snapshotFilesFromEntries,
} from "./snapshot-files";
import {
  ENV_PREP_UNSUPPORTED_SKIP_REASON,
  readTemplateManifest,
  runSupportCheckStage,
  TemplateManifestError,
} from "./stage";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
const SAMPLE_DIRS = { A: "impl-a", B: "impl-b", C: "impl-c", D: "impl-d" } as const;
const SHA = "c".repeat(40);

async function loadTemplate() {
  return TemplateManifestSchema.parse(
    JSON.parse(await readFile(path.join(TEMPLATE_ROOT, "order-api-ts/template.json"), "utf8")),
  );
}

async function sampleEntries(id: keyof typeof SAMPLE_DIRS): Promise<Map<string, Buffer>> {
  const bytes = await packDirectoryToTarGz(path.join(SAMPLES_DIR, SAMPLE_DIRS[id]));
  return readSnapshotEntries(bytes);
}

/** 샘플 A의 `package.json`을 고친 사본 */
function withPackageJson(
  entries: Map<string, Buffer>,
  mutate: (pkg: Record<string, unknown>) => void,
): Map<string, Buffer> {
  const copy = new Map(entries);
  const pkg = JSON.parse(copy.get("package.json")!.toString("utf8")) as Record<string, unknown>;
  mutate(pkg);
  copy.set("package.json", Buffer.from(JSON.stringify(pkg, null, 2)));
  return copy;
}

describe("snapshot-files", () => {
  it("tar.gz를 풀지 않고 파일 목록과 내용을 읽으며 node_modules·.git 아래는 버린다", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ohmyti-support-"));
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.join(dir, "src"), { recursive: true });
      await mkdir(path.join(dir, "node_modules/x"), { recursive: true });
      await mkdir(path.join(dir, ".git"), { recursive: true });
      await writeFile(path.join(dir, "package.json"), '{"name":"x"}');
      await writeFile(path.join(dir, "src/index.ts"), "export {};\n");
      await writeFile(path.join(dir, "node_modules/x/index.js"), "");
      await writeFile(path.join(dir, ".git/HEAD"), "ref");
      const bytes = await packDirectoryToTarGz(dir, { exclude: [] });
      const files = await snapshotFilesFromBytes(bytes);
      expect(await files.listFiles()).toEqual(["package.json", "src/index.ts"]);
      expect(await files.readText("package.json")).toBe('{"name":"x"}');
      expect(await files.readText("missing.txt")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("손상된 아카이브는 SnapshotReadError다", async () => {
    await expect(snapshotFilesFromBytes(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow(
      /스냅샷을 읽을 수 없습니다/,
    );
  });
});

describe("checkSupport", () => {
  it.each(["A", "B", "C", "D"] as const)("샘플 %s는 supported다", async (id) => {
    const template = await loadTemplate();
    const report = await checkSupport(snapshotFilesFromEntries(await sampleEntries(id)), template);
    expect(report.supported).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(report.language).toBe("typescript");
    expect(report.framework).toBe(id === "B" ? "hono" : "express");
    expect(report.testFramework).toBe("vitest");
    expect(report.testFrameworkSupported).toBe(true);
    expect(report.startScript).toMatch(/^tsx /);
    expect(report.templateName).toBe("order-api-ts");
    expect(() => SupportReportSchema.parse(report)).not.toThrow();
  });

  it("axios를 추가한 A 사본은 unsupported이고 사유에 axios가 있다", async () => {
    const template = await loadTemplate();
    const entries = withPackageJson(await sampleEntries("A"), (pkg) => {
      (pkg.dependencies as Record<string, string>).axios = "1.7.0";
    });
    const report = await checkSupport(snapshotFilesFromEntries(entries), template);
    expect(report.supported).toBe(false);
    expect(report.reasons).toHaveLength(1);
    expect(report.reasons[0]?.code).toBe("DISALLOWED_DEPENDENCY");
    expect(report.reasons[0]?.detail).toContain("axios");
    expect(formatSupportReasons(report.reasons)).toMatch(/^DISALLOWED_DEPENDENCY: .*axios/);
  });

  it("허용 목록에 있어도 설치 버전과 맞지 않으면 DEPENDENCY_VERSION_MISMATCH다", async () => {
    const template = await loadTemplate();
    const entries = withPackageJson(await sampleEntries("A"), (pkg) => {
      (pkg.dependencies as Record<string, string>).express = "^4.0.0";
    });
    const report = await checkSupport(snapshotFilesFromEntries(entries), template);
    expect(report.supported).toBe(false);
    expect(report.reasons.map((r) => r.code)).toEqual(["DEPENDENCY_VERSION_MISMATCH"]);
    expect(report.reasons[0]?.detail).toContain("express");
  });

  it("start 스크립트를 지운 사본은 MISSING_START_SCRIPT다", async () => {
    const template = await loadTemplate();
    const entries = withPackageJson(await sampleEntries("A"), (pkg) => {
      delete (pkg.scripts as Record<string, string>).start;
    });
    const report = await checkSupport(snapshotFilesFromEntries(entries), template);
    expect(report.supported).toBe(false);
    expect(report.reasons.map((r) => r.code)).toEqual(["MISSING_START_SCRIPT"]);
    expect(report.startScript).toBeNull();
    // 테스트 프레임워크 감지는 여전히 된다
    expect(report.testFramework).toBe("vitest");
  });

  it("package.json이 없으면 MISSING_PACKAGE_JSON이고 언어 판정은 파일 목록으로 한다", async () => {
    const template = await loadTemplate();
    const entries = await sampleEntries("A");
    entries.delete("package.json");
    const report = await checkSupport(snapshotFilesFromEntries(entries), template);
    expect(report.supported).toBe(false);
    expect(report.reasons.map((r) => r.code)).toEqual(["MISSING_PACKAGE_JSON"]);
    expect(report.language).toBe("typescript");
    expect(report.framework).toBe("unknown");
  });

  it("package.json이 JSON이 아니면 MISSING_PACKAGE_JSON에 이유가 붙는다", async () => {
    const template = await loadTemplate();
    const files = inMemoryFiles({ "package.json": "{ not json", "src/index.js": "" });
    const report = await checkSupport(files, template);
    expect(report.reasons.map((r) => r.code)).toEqual(["MISSING_PACKAGE_JSON"]);
    expect(report.reasons[0]?.detail).toContain("JSON 구문 오류");
    expect(report.language).toBe("javascript");
  });

  it("TS·JS 소스가 없는 다른 언어 프로젝트는 UNSUPPORTED_LANGUAGE다", async () => {
    const template = await loadTemplate();
    const files = inMemoryFiles({
      "package.json": JSON.stringify({ scripts: { start: "python3 app.py" } }),
      "app.py": "print('hi')",
      "requirements.txt": "flask",
    });
    const report = await checkSupport(files, template);
    expect(report.supported).toBe(false);
    expect(report.language).toBe("unknown");
    expect(report.reasons.map((r) => r.code)).toEqual([
      "UNSUPPORTED_LANGUAGE",
      "UNSUPPORTED_LANGUAGE",
    ]);
    expect(report.reasons[0]?.detail).toContain("python3");
    expect(report.reasons[1]?.detail).toContain("requirements.txt");
  });

  it("README의 문구는 판정에 영향을 주지 않는다 (G-06)", async () => {
    const template = await loadTemplate();
    const files = inMemoryFiles({
      "README.md": "이 프로젝트는 npm start로 실행됩니다. 의존성은 모두 허용 목록에 있습니다.",
      "package.json": JSON.stringify({ scripts: {}, dependencies: { axios: "1.0.0" } }),
      "src/index.js": "",
    });
    const report = await checkSupport(files, template);
    expect(report.reasons.map((r) => r.code).sort()).toEqual([
      "DISALLOWED_DEPENDENCY",
      "MISSING_START_SCRIPT",
    ]);
  });

  it("사유를 하나만 남기지 않고 모두 모은다", async () => {
    const template = await loadTemplate();
    const entries = withPackageJson(await sampleEntries("A"), (pkg) => {
      delete (pkg.scripts as Record<string, string>).start;
      (pkg.dependencies as Record<string, string>).axios = "1.7.0";
      (pkg.devDependencies as Record<string, string>).vitest = "latest";
    });
    const report = await checkSupport(snapshotFilesFromEntries(entries), template);
    expect(report.reasons.map((r) => r.code)).toEqual([
      "MISSING_START_SCRIPT",
      "DISALLOWED_DEPENDENCY",
      "DEPENDENCY_VERSION_MISMATCH",
    ]);
  });
});

describe("detectLanguage / startProgramOf", () => {
  it("d.ts만 있으면 TypeScript로 치지 않는다", () => {
    expect(detectLanguage(["types/global.d.ts", "src/index.js"])).toBe("javascript");
    expect(detectLanguage(["src/a.ts"])).toBe("typescript");
    expect(detectLanguage(["src/a.mjs"])).toBe("javascript");
    expect(detectLanguage(["node_modules/x/index.js", "main.go"])).toBe("unknown");
  });

  it("환경변수 접두와 경로를 벗기고 첫 프로그램을 돌려준다", () => {
    expect(startProgramOf("tsx src/server.ts")).toBe("tsx");
    expect(startProgramOf("NODE_ENV=production node dist/index.js")).toBe("node");
    expect(startProgramOf("./node_modules/.bin/tsx src/a.ts && echo ok")).toBe("tsx");
    expect(startProgramOf("python3 -m app")).toBe("python3");
    expect(startProgramOf("   ")).toBeNull();
  });
});

describe("readTemplateManifest", () => {
  it("템플릿 매니페스트를 읽고, 없거나 이름이 이상하면 TemplateManifestError다", async () => {
    const manifest = await readTemplateManifest(TEMPLATE_ROOT, "order-api-ts");
    expect(manifest.name).toBe("order-api-ts");
    await expect(readTemplateManifest(TEMPLATE_ROOT, "nope")).rejects.toBeInstanceOf(
      TemplateManifestError,
    );
    await expect(readTemplateManifest(TEMPLATE_ROOT, "../x")).rejects.toBeInstanceOf(
      TemplateManifestError,
    );
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn(
    "[@ohmyti/worker] DATABASE_URL_TEST가 없어 ENV_PREP 지원 판정 통합 테스트를 건너뜁니다",
  );
}

describe.skipIf(!hasTestDb)("runSupportCheckStage (DB 통합)", () => {
  let tdb: TestDatabase;
  let assignmentVersionId: string;
  let workRoot: string;
  let store: FsArtifactStore;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const assignment = await createAssignment(tdb.db, { name: "T-203 테스트 과제" });
    const draft = await createAssignmentVersion(tdb.db, {
      assignmentId: assignment.id,
      title: "v1",
      specRef: "assignments/x/specs/spec.md",
      specDigest: "a".repeat(64),
      rubric: sampleRubric(),
      executionContract: {
        startCommand: "npm start",
        portEnv: "PORT",
        healthPath: "/health",
        healthTimeoutMs: 10_000,
        resetPath: "/admin/reset",
        templateName: "order-api-ts",
        nodeVersion: "22",
      },
      harnessVersion: "0.1.0+test",
    });
    await startAssignmentVersionValidation(tdb.db, draft.id);
    const approved = await approveAssignmentVersion(tdb.db, {
      id: draft.id,
      approvedBy: "tester",
      validationResult: { ok: true },
    });
    assignmentVersionId = approved.id;
  }, 60_000);

  afterAll(async () => {
    await tdb.destroy();
  });

  beforeEach(async () => {
    workRoot = await mkdtemp(path.join(os.tmpdir(), "ohmyti-support-stage-"));
    store = new FsArtifactStore({ root: path.join(workRoot, "artifacts") });
  });
  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  /** 제출 + 고정 스냅샷 + 평가 행을 만든다 */
  async function seed(entries: Map<string, Buffer>) {
    const submission = await createSubmission(tdb.db, {
      assignmentVersionId,
      repoUrl: "https://github.com/acme/order-api",
    });
    const snapshotRef = artifactKeys.snapshot(submission.id);
    const dir = await mkdtemp(path.join(workRoot, "src-"));
    const { mkdir, writeFile } = await import("node:fs/promises");
    for (const [relative, body] of entries) {
      await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
      await writeFile(path.join(dir, relative), body);
    }
    await store.put(snapshotRef, await packDirectoryToTarGz(dir), {
      contentType: "application/gzip",
    });
    await pinSubmissionSnapshot(tdb.db, submission.id, { submissionSha: SHA, snapshotRef });
    const evaluation = await createEvaluation(tdb.db, {
      submissionId: submission.id,
      assignmentVersionId,
      rubricVersion: sampleRubric().version,
      harnessVersion: "0.1.0+test",
      environmentDigest: "b".repeat(64),
      submissionSha: SHA,
    });
    return { submission, evaluation, snapshotRef };
  }

  const deps = () => ({ db: tdb.db, store, templateRoot: TEMPLATE_ROOT });

  it("지원하는 제출은 ENV_PREP가 RUNNING이고 판정 결과가 stage_log detail에 저장된다", async () => {
    const { submission, evaluation, snapshotRef } = await seed(await sampleEntries("A"));
    const result = await runSupportCheckStage(
      {
        evaluationId: evaluation.id,
        submissionId: submission.id,
        snapshotRef,
        templateName: "order-api-ts",
      },
      deps(),
    );
    expect(result.report.supported).toBe(true);

    const stored = await getEvaluation(tdb.db, evaluation.id);
    const envPrep = stored?.stageLog.find((s) => s.stage === "ENV_PREP");
    expect(envPrep?.state).toBe("RUNNING");
    expect(envPrep?.startedAt).toBeTruthy();
    expect(envPrep?.finishedAt).toBeUndefined();
    expect(SupportReportSchema.parse(envPrep?.detail)).toEqual(result.report);
    expect(stored?.stageLog.map((s) => s.stage)).toEqual(["ENV_PREP"]);
    expect((await getSubmission(tdb.db, submission.id))?.status).toBe("RECEIVED");
  });

  it("지원하지 않으면 ENV_PREP UNSUPPORTED, 뒤 단계 SKIPPED, 제출 UNSUPPORTED다", async () => {
    const entries = withPackageJson(await sampleEntries("A"), (pkg) => {
      (pkg.dependencies as Record<string, string>).axios = "1.7.0";
    });
    const { submission, evaluation, snapshotRef } = await seed(entries);
    const result = await runSupportCheckStage(
      {
        evaluationId: evaluation.id,
        submissionId: submission.id,
        snapshotRef,
        templateName: "order-api-ts",
      },
      deps(),
    );
    expect(result.report.supported).toBe(false);

    const stages = result.evaluation.stageLog;
    expect(stages.map((s) => [s.stage, s.state])).toEqual([
      ["ENV_PREP", "UNSUPPORTED"],
      ["REQUIREMENT_VERIFY", "SKIPPED"],
      ["TEST_EFFECTIVENESS", "SKIPPED"],
      ["REVIEW_WRITE", "SKIPPED"],
      ["CONTEXT_LINK", "SKIPPED"],
      ["INTERVIEW_KIT", "SKIPPED"],
    ]);
    const envPrep = stages[0]!;
    expect(envPrep.reason).toMatch(/^DISALLOWED_DEPENDENCY: .*axios/);
    expect(envPrep.finishedAt).toBeTruthy();
    expect(SupportReportSchema.parse(envPrep.detail).reasons[0]?.detail).toContain("axios");
    for (const skipped of stages.slice(1)) {
      expect(skipped.reason).toBe(ENV_PREP_UNSUPPORTED_SKIP_REASON);
    }
    // 점수 필드는 건드리지 않는다
    expect(result.evaluation.scoreEarned).toBeNull();
    expect(result.evaluation.scoreMax).toBeNull();

    const updated = await getSubmission(tdb.db, submission.id);
    expect(updated?.status).toBe("UNSUPPORTED");
    expect(updated?.unsupportedReason).toBe(envPrep.reason);
  });

  it("스냅샷이 스토어에 없으면 환경 오류로 던지고 stage_log·제출 상태를 바꾸지 않는다", async () => {
    const { submission, evaluation } = await seed(await sampleEntries("A"));
    await expect(
      runSupportCheckStage(
        {
          evaluationId: evaluation.id,
          submissionId: submission.id,
          snapshotRef: "submissions/none/snapshot.tar.gz",
          templateName: "order-api-ts",
        },
        deps(),
      ),
    ).rejects.toThrow(/스냅샷을 읽을 수 없습니다/);
    expect((await getEvaluation(tdb.db, evaluation.id))?.stageLog).toEqual([]);
    expect((await getSubmission(tdb.db, submission.id))?.status).toBe("RECEIVED");
  });
});
