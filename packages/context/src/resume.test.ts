import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createTestDatabase,
  getSubmissionContext,
  seedEvaluation,
  setResumeText,
  upsertSubmissionContext,
  type TestDatabase,
} from "@ohmyti/db";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, FsArtifactStore } from "@ohmyti/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractResumeText,
  normalizeResumeText,
  RESUME_EXTRACTION_LIMITS,
  runResumeExtraction,
} from "./resume";
import { buildImageOnlyPdf, buildTextPdf, sampleResumeLines } from "./testing/pdf";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");
const MARKER = "RESUME-MARKER-7f3a9c";

/** 커밋한 픽스처 파일. 빌더를 바꾸면 `fixtures/README.md`의 명령으로 다시 만든다 */
async function fixture(name: "resume-text.pdf" | "resume-scanned.pdf"): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(FIXTURES, name)));
}

describe("resume 픽스처", () => {
  it("커밋한 PDF 픽스처가 빌더 출력과 바이트 단위로 같다", async () => {
    expect(Buffer.from(await fixture("resume-text.pdf"))).toEqual(
      Buffer.from(buildTextPdf([sampleResumeLines()])),
    );
    expect(Buffer.from(await fixture("resume-scanned.pdf"))).toEqual(
      Buffer.from(buildImageOnlyPdf(1)),
    );
  });
});

describe("extractResumeText (resume)", () => {
  it("텍스트 PDF 픽스처는 EXTRACTED이고 본문을 돌려준다", async () => {
    const result = await extractResumeText(await fixture("resume-text.pdf"));
    expect(result.status).toBe("EXTRACTED");
    if (result.status !== "EXTRACTED") return;
    expect(result.pageCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(normalizeResumeText(sampleResumeLines().join("\n")));
  });

  it("여러 페이지의 본문을 순서대로 합친다", async () => {
    const result = await extractResumeText(
      buildTextPdf([sampleResumeLines(MARKER), ["Projects", "- Inventory service"]]),
    );
    expect(result).toMatchObject({ status: "EXTRACTED", pageCount: 2 });
    if (result.status !== "EXTRACTED") return;
    expect(result.text).toContain(MARKER);
    expect(result.text.indexOf("Skills")).toBeLessThan(result.text.indexOf("Projects"));
  });

  it("스캔 PDF 픽스처는 IMAGE_ONLY이고 본문 없이 사유만 남긴다 (OCR 없음)", async () => {
    const result = await extractResumeText(await fixture("resume-scanned.pdf"));
    expect(result).toEqual({
      status: "IMAGE_ONLY",
      code: "RESUME_TEXT_NOT_FOUND",
      reason:
        "RESUME_TEXT_NOT_FOUND: PDF에 텍스트 층이 없습니다 (스캔·이미지 문서). OCR은 하지 않습니다",
      pageCount: 1,
    });
    expect(result).not.toHaveProperty("text");
  });

  it("글자가 임계값보다 적으면 IMAGE_ONLY다", async () => {
    const result = await extractResumeText(buildTextPdf([["Page 1"]]));
    expect(result.status).toBe("IMAGE_ONLY");
  });

  it("OCR 의존성이 없다", async () => {
    const manifest = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/tesseract|ocr|canvas/i)]),
    );
    expect(manifest.dependencies.unpdf).toBe("1.8.1");
  });

  it("5 MiB를 넘으면 파싱하지 않고 사유를 남긴다", async () => {
    const big = new Uint8Array(RESUME_EXTRACTION_LIMITS.maxBytes + 1);
    big.set(Buffer.from("%PDF-1.4\n"));
    expect(await extractResumeText(big)).toEqual({
      status: "NONE",
      code: "RESUME_TOO_LARGE",
      reason: "RESUME_TOO_LARGE: 이력서 PDF가 5.0 MiB를 넘어 추출하지 않았습니다 (5.0 MiB)",
      pageCount: null,
    });
  });

  it("20쪽까지는 추출하고 21쪽이면 사유를 남긴다", async () => {
    const pages = (n: number) =>
      Array.from({ length: n }, (_, i) => [`Page ${i + 1} ${sampleResumeLines()[3]}`]);
    expect(await extractResumeText(buildTextPdf(pages(20)))).toMatchObject({
      status: "EXTRACTED",
      pageCount: 20,
    });
    expect(await extractResumeText(buildTextPdf(pages(21)))).toEqual({
      status: "NONE",
      code: "RESUME_TOO_MANY_PAGES",
      reason: "RESUME_TOO_MANY_PAGES: 이력서가 20쪽을 넘어 추출하지 않았습니다 (21쪽)",
      pageCount: 21,
    });
  });

  it("PDF가 아니거나 깨진 파일은 NONE과 사유다", async () => {
    expect(await extractResumeText(new Uint8Array(Buffer.from("hello")))).toMatchObject({
      status: "NONE",
      code: "RESUME_NOT_PDF",
    });
    expect(
      await extractResumeText(new Uint8Array(Buffer.from("%PDF-1.4\nnot a pdf"))),
    ).toMatchObject({ status: "NONE", code: "RESUME_PARSE_FAILED" });
  });

  it("본문 상한을 넘으면 자르고 truncated를 표시한다", async () => {
    const result = await extractResumeText(await fixture("resume-text.pdf"), {
      ...RESUME_EXTRACTION_LIMITS,
      maxTextChars: 50,
    });
    expect(result).toMatchObject({ status: "EXTRACTED", truncated: true });
    if (result.status === "EXTRACTED") expect(result.text).toHaveLength(50);
  });

  it("추출이 제한 시간을 넘으면 TIMEOUT 사유다", async () => {
    const result = await extractResumeText(
      await fixture("resume-text.pdf"),
      { ...RESUME_EXTRACTION_LIMITS, timeoutMs: 20 },
      { loadPdf: () => new Promise(() => {}) },
    );
    expect(result).toEqual({
      status: "NONE",
      code: "RESUME_EXTRACT_TIMEOUT",
      reason: "RESUME_EXTRACT_TIMEOUT: 텍스트 추출이 20ms 안에 끝나지 않았습니다",
      pageCount: null,
    });
  });

  it("normalizeResumeText는 제어 문자·연속 공백·빈 줄 반복을 정리한다", () => {
    expect(normalizeResumeText("  a\u0000b \t c \r\n\r\n\r\n\n d\u00a0\u00a0e  ")).toBe(
      "ab c\n\nd e",
    );
  });
});

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);

describe.skipIf(!hasTestDb)("runResumeExtraction (resume, DB 통합)", () => {
  let tdb: TestDatabase;
  let store: FsArtifactStore;
  let root: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    root = await mkdtemp(path.join(os.tmpdir(), "ohmyti-resume-"));
    store = new FsArtifactStore({ root });
  });

  afterAll(async () => {
    await tdb?.destroy();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function submissionWithResume(pdf: Uint8Array | null): Promise<string> {
    const { submissionId } = await seedEvaluation(tdb.db);
    let resumeRef: string | null = null;
    if (pdf) {
      resumeRef = artifactKeys.resume(submissionId);
      await store.put(resumeRef, pdf, { contentType: ARTIFACT_CONTENT_TYPES.resume });
    }
    await upsertSubmissionContext(tdb.db, submissionId, { resumeRef });
    return submissionId;
  }

  it("텍스트 PDF는 EXTRACTED로 본문이 저장되고, 요약에는 본문이 없다", async () => {
    const id = await submissionWithResume(buildTextPdf([sampleResumeLines(MARKER)]));
    const summary = await runResumeExtraction({ db: tdb.db, store }, id);
    expect(summary).toMatchObject({ status: "EXTRACTED", action: "EXTRACTED", pageCount: 1 });
    expect(JSON.stringify(summary)).not.toContain(MARKER);
    const context = await getSubmissionContext(tdb.db, id);
    expect(context).toMatchObject({ resumeTextStatus: "EXTRACTED", resumeTextReason: null });
    expect(context?.resumeText).toContain(MARKER);
    expect(summary.chars).toBe(context?.resumeText?.length);
  });

  it("스캔 PDF는 IMAGE_ONLY로 본문 없이 사유가 저장된다", async () => {
    const id = await submissionWithResume(await fixture("resume-scanned.pdf"));
    const summary = await runResumeExtraction({ db: tdb.db, store }, id);
    expect(summary).toMatchObject({ status: "IMAGE_ONLY", action: "IMAGE_ONLY" });
    expect(await getSubmissionContext(tdb.db, id)).toMatchObject({
      resumeTextStatus: "IMAGE_ONLY",
      resumeText: null,
    });
    expect((await getSubmissionContext(tdb.db, id))?.resumeTextReason).toMatch(
      /^RESUME_TEXT_NOT_FOUND:/,
    );
  });

  it("사람이 입력한 MANUAL과 이미 추출한 EXTRACTED는 다시 추출하지 않는다", async () => {
    const id = await submissionWithResume(await fixture("resume-scanned.pdf"));
    await setResumeText(tdb.db, id, { status: "MANUAL", text: "직접 입력한 경력", reason: null });
    expect(await runResumeExtraction({ db: tdb.db, store }, id)).toMatchObject({
      status: "MANUAL",
      action: "KEPT",
    });
    expect((await getSubmissionContext(tdb.db, id))?.resumeText).toBe("직접 입력한 경력");

    const extracted = await submissionWithResume(await fixture("resume-text.pdf"));
    await runResumeExtraction({ db: tdb.db, store }, extracted);
    await store.delete(artifactKeys.resume(extracted));
    expect(await runResumeExtraction({ db: tdb.db, store }, extracted)).toMatchObject({
      status: "EXTRACTED",
      action: "KEPT",
    });
  });

  it("이력서가 없으면 아무것도 쓰지 않고, 원본이 사라졌으면 NONE과 사유다", async () => {
    const none = await submissionWithResume(null);
    expect(await runResumeExtraction({ db: tdb.db, store }, none)).toEqual({
      status: "NONE",
      action: "NO_RESUME",
      reason: null,
      pageCount: null,
      chars: null,
    });
    expect(await getSubmissionContext(tdb.db, none)).toMatchObject({
      resumeTextStatus: "NONE",
      resumeTextReason: null,
    });

    const missing = await submissionWithResume(await fixture("resume-text.pdf"));
    await store.delete(artifactKeys.resume(missing));
    expect(await runResumeExtraction({ db: tdb.db, store }, missing)).toMatchObject({
      status: "NONE",
      action: "FAILED",
      reason: "RESUME_MISSING: 이력서 원본이 저장소에 없습니다",
    });
  });
});
