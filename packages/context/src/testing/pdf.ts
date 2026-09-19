/**
 * 테스트용 PDF 픽스처 빌더 (T-501). 외부 도구 없이 결정적인 바이트를 만든다.
 *
 * - `buildTextPdf`: Helvetica로 쓴 텍스트 페이지. 문자는 Latin-1 범위만 쓴다.
 * - `buildImageOnlyPdf`: 페이지마다 회색 이미지 하나만 있고 텍스트 층이 없다 (스캔 문서 모사).
 */

type PageSpec = { kind: "text"; lines: readonly string[] } | { kind: "image" };

function escapePdfString(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\xff]/g, "?");
}

function textContent(lines: readonly string[]): string {
  const body = lines.map((line, i) => `${i === 0 ? "" : "T* "}(${escapePdfString(line)}) Tj`);
  return ["BT", "/F1 11 Tf", "14 TL", "72 740 Td", ...body, "ET"].join("\n");
}

const IMAGE_SIZE = 16;

function imagePixels(): Buffer {
  const pixels = Buffer.alloc(IMAGE_SIZE * IMAGE_SIZE);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 37) % 256;
  return pixels;
}

function buildPdf(pages: readonly PageSpec[]): Uint8Array {
  if (pages.length === 0) throw new Error("페이지가 하나 이상 필요합니다");
  // 1: Catalog, 2: Pages, 3: Font, 4: Image, 5..: 페이지마다 (Page, Contents)
  const objects: Array<string | Buffer> = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  const pixels = imagePixels();
  objects[4] = Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${IMAGE_SIZE} /Height ${IMAGE_SIZE} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`,
      "latin1",
    ),
    pixels,
    Buffer.from("\nendstream", "latin1"),
  ]);
  pages.forEach((page, i) => {
    const pageId = pageIds[i]!;
    const content =
      page.kind === "text" ? textContent(page.lines) : "q 468 0 0 648 72 72 cm /Im1 Do Q";
    const resources =
      page.kind === "text" ? "<< /Font << /F1 3 0 R >> >>" : "<< /XObject << /Im1 4 0 R >> >>";
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${pageId + 1} 0 R >>`;
    const stream = Buffer.from(content, "latin1");
    objects[pageId + 1] = Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "latin1"),
      stream,
      Buffer.from("\nendstream", "latin1"),
    ]);
  });

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    const body = objects[id]!;
    const chunk = Buffer.concat([
      Buffer.from(`${id} 0 obj\n`, "latin1"),
      typeof body === "string" ? Buffer.from(body, "latin1") : body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    offsets[id] = offset;
    chunks.push(chunk);
    offset += chunk.length;
  }
  const size = objects.length;
  const xref = [
    "xref",
    `0 ${size}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${size} /Root 1 0 R >>`,
    "startxref",
    String(offset),
    "%%EOF",
    "",
  ].join("\n");
  chunks.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

/** 텍스트 이력서 PDF. `pages`의 원소 하나가 한 페이지의 줄 목록이다 */
export function buildTextPdf(pages: ReadonlyArray<readonly string[]>): Uint8Array {
  return buildPdf(pages.map((lines) => ({ kind: "text", lines })));
}

/** 텍스트 층이 없는 이미지 PDF (스캔 문서) */
export function buildImageOnlyPdf(pageCount = 1): Uint8Array {
  return buildPdf(Array.from({ length: pageCount }, () => ({ kind: "image" as const })));
}

/** 샘플 이력서 본문 (가상 인물). `marker`를 넣으면 경력 줄에 섞는다 */
export function sampleResumeLines(marker?: string): string[] {
  return [
    "Jane Example - Backend Engineer",
    "Email: jane@example.com  Phone: 010-0000-0000",
    "Experience",
    "- 2022-2025 Example Commerce: built an order API in TypeScript and Express",
    `- Designed idempotent payment endpoints with PostgreSQL${marker ? ` ${marker}` : ""}`,
    "- Wrote Vitest integration tests and reduced flaky tests",
    "Skills: TypeScript, Node.js, PostgreSQL, Docker",
  ];
}
