/**
 * 이력서 PDF 텍스트 추출 (TICKET.md T-501). CONTEXT_LINK 단계의 첫 작업이다.
 *
 * - `extractResumeText`: PDF 바이트 → EXTRACTED(본문) | IMAGE_ONLY(텍스트 층 없음) | NONE(추출 불가 + 사유).
 *   크기(5 MiB)·페이지(20쪽) 상한을 넘으면 파싱하지 않고 사유만 남긴다. OCR은 하지 않는다 (G-09).
 * - `runResumeExtraction`: `submission_context.resume_ref` → ArtifactStore → 추출 → `resume_text`·`resume_text_status` 기록.
 *   사람이 입력한 MANUAL과 이미 추출한 EXTRACTED는 덮어쓰지 않는다(재시도 멱등). 오류는 던지지 않고 사유로 기록한다.
 *   이력서는 선택 입력이므로 추출 실패가 채점을 막으면 안 된다.
 *
 * 반환값·사유에는 본문을 넣지 않는다. 호출자는 요약(`ResumeExtractionSummary`)만 로그에 남긴다.
 * 이 모듈은 채점 입력을 만들지 않는다. 추출 텍스트는 `submission_context`에만 저장된다 (G-10).
 */
import type { ResumeTextStatus } from "@ohmyti/core";
import { getSubmissionContext, setResumeText, type Database } from "@ohmyti/db";
import type { ArtifactStore } from "@ohmyti/storage";
import { extractText, getDocumentProxy } from "unpdf";

export const RESUME_EXTRACTION_LIMITS = {
  /** 추출을 시도하는 원본 크기 상한 (5 MiB). 업로드 상한(10 MiB)보다 작다 */
  maxBytes: 5 * 1024 * 1024,
  /** 추출을 시도하는 페이지 수 상한 */
  maxPages: 20,
  /** 공백을 뺀 글자 수가 이보다 적으면 텍스트 층이 없는 문서(IMAGE_ONLY)로 본다 */
  minTextChars: 40,
  /** 저장하는 본문 길이 상한 (글자). 넘는 부분은 자른다 */
  maxTextChars: 100_000,
  /** 파싱·추출 벽시계 상한 */
  timeoutMs: 30_000,
} as const;

export type ResumeExtractionLimits = { [K in keyof typeof RESUME_EXTRACTION_LIMITS]: number };

export type ResumeExtractionCode =
  | "RESUME_NOT_PDF"
  | "RESUME_TOO_LARGE"
  | "RESUME_TOO_MANY_PAGES"
  | "RESUME_PARSE_FAILED"
  | "RESUME_EXTRACT_TIMEOUT"
  | "RESUME_TEXT_NOT_FOUND"
  | "RESUME_MISSING"
  | "RESUME_READ_FAILED";

export type ResumeExtraction =
  | { status: "EXTRACTED"; text: string; pageCount: number; truncated: boolean }
  | { status: "IMAGE_ONLY"; code: "RESUME_TEXT_NOT_FOUND"; reason: string; pageCount: number }
  | { status: "NONE"; code: ResumeExtractionCode; reason: string; pageCount: number | null };

const PDF_MAGIC = "%PDF-";

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function none(
  code: ResumeExtractionCode,
  message: string,
  pageCount: number | null = null,
): ResumeExtraction {
  return { status: "NONE", code, reason: `${code}: ${message}`, pageCount };
}

/** 줄 끝 공백·연속 공백·빈 줄 반복을 정리한다. NUL 같은 제어 문자는 지운다 */
export function normalizeResumeText(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

class ExtractTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new ExtractTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ExtractResumeTextOptions {
  /** 테스트용. 기본은 unpdf `getDocumentProxy` */
  loadPdf?: typeof getDocumentProxy;
}

/** PDF 바이트에서 텍스트를 추출한다. 던지지 않는다 */
export async function extractResumeText(
  bytes: Uint8Array,
  limits: ResumeExtractionLimits = RESUME_EXTRACTION_LIMITS,
  options: ExtractResumeTextOptions = {},
): Promise<ResumeExtraction> {
  const loadPdf = options.loadPdf ?? getDocumentProxy;
  if (bytes.byteLength > limits.maxBytes) {
    return none(
      "RESUME_TOO_LARGE",
      `이력서 PDF가 ${mib(limits.maxBytes)}를 넘어 추출하지 않았습니다 (${mib(bytes.byteLength)})`,
    );
  }
  if (Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString("latin1") !== PDF_MAGIC) {
    return none("RESUME_NOT_PDF", "PDF 서명(%PDF-)이 없습니다");
  }

  // pdf.js는 넘긴 버퍼를 워커로 옮기며 분리(detach)할 수 있으므로 사본을 넘긴다
  const data = new Uint8Array(bytes);
  let destroy = () => {};
  try {
    return await withTimeout(
      (async (): Promise<ResumeExtraction> => {
        const pdf = await loadPdf(data, { verbosity: 0 });
        destroy = () => void pdf.loadingTask.destroy();
        try {
          const pageCount = pdf.numPages;
          if (pageCount > limits.maxPages) {
            return none(
              "RESUME_TOO_MANY_PAGES",
              `이력서가 ${limits.maxPages}쪽을 넘어 추출하지 않았습니다 (${pageCount}쪽)`,
              pageCount,
            );
          }
          const { text } = await extractText(pdf, { mergePages: true });
          const normalized = normalizeResumeText(text);
          if (normalized.replace(/\s/g, "").length < limits.minTextChars) {
            return {
              status: "IMAGE_ONLY",
              code: "RESUME_TEXT_NOT_FOUND",
              reason:
                "RESUME_TEXT_NOT_FOUND: PDF에 텍스트 층이 없습니다 (스캔·이미지 문서). OCR은 하지 않습니다",
              pageCount,
            };
          }
          const truncated = normalized.length > limits.maxTextChars;
          return {
            status: "EXTRACTED",
            text: truncated ? normalized.slice(0, limits.maxTextChars) : normalized,
            pageCount,
            truncated,
          };
        } finally {
          await pdf.loadingTask.destroy();
        }
      })(),
      limits.timeoutMs,
      () => destroy(),
    );
  } catch (error) {
    if (error instanceof ExtractTimeoutError) {
      return none(
        "RESUME_EXTRACT_TIMEOUT",
        `텍스트 추출이 ${limits.timeoutMs}ms 안에 끝나지 않았습니다`,
      );
    }
    // pdf.js 오류 메시지에는 본문이 없지만, 사유는 오류 이름만 남긴다
    const name = error instanceof Error ? error.name : "Error";
    return none("RESUME_PARSE_FAILED", `PDF를 읽지 못했습니다 (${name})`);
  }
}

/** 로그·단계 기록에 남기는 요약. 본문은 없다 */
export interface ResumeExtractionSummary {
  status: ResumeTextStatus;
  /** 이번 호출에서 한 일 */
  action: "NO_RESUME" | "KEPT" | "EXTRACTED" | "IMAGE_ONLY" | "FAILED";
  reason: string | null;
  pageCount: number | null;
  /** 저장한 본문 글자 수 */
  chars: number | null;
  truncated?: boolean;
}

export interface ResumeExtractionDeps {
  db: Database;
  store: ArtifactStore;
  limits?: ResumeExtractionLimits;
}

/**
 * 제출의 이력서 원본을 읽어 텍스트와 상태를 기록한다. 던지지 않는다 (DB 오류는 예외).
 * 맥락 행이나 이력서가 없으면 아무것도 쓰지 않고 NONE을 돌려준다.
 */
export async function runResumeExtraction(
  deps: ResumeExtractionDeps,
  submissionId: string,
): Promise<ResumeExtractionSummary> {
  const context = await getSubmissionContext(deps.db, submissionId);
  if (!context?.resumeRef) {
    return { status: "NONE", action: "NO_RESUME", reason: null, pageCount: null, chars: null };
  }
  if (context.resumeTextStatus === "MANUAL" || context.resumeTextStatus === "EXTRACTED") {
    return {
      status: context.resumeTextStatus,
      action: "KEPT",
      reason: context.resumeTextReason,
      pageCount: null,
      chars: context.resumeText?.length ?? null,
    };
  }

  let extraction: ResumeExtraction;
  try {
    const object = await deps.store.get(context.resumeRef);
    extraction = object
      ? await extractResumeText(object.body, deps.limits)
      : none("RESUME_MISSING", "이력서 원본이 저장소에 없습니다");
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    extraction = none("RESUME_READ_FAILED", `이력서 원본을 읽지 못했습니다 (${name})`);
  }

  if (extraction.status === "EXTRACTED") {
    await setResumeText(deps.db, submissionId, {
      status: "EXTRACTED",
      text: extraction.text,
      reason: null,
    });
    return {
      status: "EXTRACTED",
      action: "EXTRACTED",
      reason: null,
      pageCount: extraction.pageCount,
      chars: extraction.text.length,
      truncated: extraction.truncated,
    };
  }
  await setResumeText(deps.db, submissionId, {
    status: extraction.status,
    text: null,
    reason: extraction.reason,
  });
  return {
    status: extraction.status,
    action: extraction.status === "IMAGE_ONLY" ? "IMAGE_ONLY" : "FAILED",
    reason: extraction.reason,
    pageCount: extraction.pageCount,
    chars: null,
  };
}
