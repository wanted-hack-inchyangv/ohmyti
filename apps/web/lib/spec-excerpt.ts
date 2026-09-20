/**
 * 과제 명세 원문의 화면 발췌 (TICKET.md T-901·T-903).
 *
 * `/demo`의 과제 요약과 채점 요청 폼의 과제 요약 패널이 같은 규칙을 쓴다. 문장을 만들지 않고 원문의 한 문단을 옮긴다 (G-09).
 * `## 1. 과제 개요`처럼 개요를 뜻하는 제목 아래 문단을 먼저 찾고, 없으면 제목·표·목록·인용·코드 블록이 아닌 첫 문단을 쓴다.
 */
const OVERVIEW_HEADING = /^#{1,6}\s*(?:\d+(?:\.\d+)*\.?\s*)?(?:과제\s*)?개요\s*$/;

function isProse(block: string): boolean {
  return block.length > 0 && !/^[#|>\-*]|^```|^\d+\.\s/.test(block);
}

function oneLine(block: string, maxChars: number): string {
  const text = block.replace(/\s*\n\s*/g, " ");
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

export function specExcerpt(markdown: string | null, maxChars = 320): string | null {
  if (!markdown) return null;
  const blocks = markdown.split(/\n{2,}/).map((block) => block.trim());
  const headingIndex = blocks.findIndex((block) => OVERVIEW_HEADING.test(block));
  if (headingIndex >= 0) {
    const after = blocks.slice(headingIndex + 1).find(isProse);
    if (after) return oneLine(after, maxChars);
  }
  const first = blocks.find(isProse);
  return first ? oneLine(first, maxChars) : null;
}
