/**
 * 변형의 텍스트 편집과 unified diff (TICKET.md T-402).
 *
 * 변형은 ts-morph의 노드 조작이 아니라 원문 위치 기반 텍스트 편집으로 만든다. 그래야 diff가 바뀐 줄만 담고,
 * 같은 스냅샷·같은 변형이면 바이트 단위로 같은 결과(= 같은 `patchDigest`)가 나온다.
 */
import { createHash } from "node:crypto";
import { Node } from "ts-morph";

export interface TextEdit {
  /** 원문 기준 시작 오프셋 (포함) */
  start: number;
  /** 원문 기준 끝 오프셋 (제외) */
  end: number;
  text: string;
}

/** 편집을 뒤에서부터 적용한다. 겹치는 편집은 프로그래밍 오류다 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of sorted) {
    if (edit.end > lastStart || edit.start > edit.end || edit.start < 0 || edit.end > text.length) {
      throw new Error(`텍스트 편집 범위가 올바르지 않습니다: ${edit.start}-${edit.end}`);
    }
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    lastStart = edit.start;
  }
  return out;
}

/** 노드(앞쪽 주석 제외)를 다른 텍스트로 바꾼다 */
export function replaceNodeEdit(node: Node, text: string): TextEdit {
  return { start: node.getStart(), end: node.getEnd(), text };
}

/**
 * 문장을 지운다. 문장이 줄 전체를 차지하면 그 줄들을 통째로 지우고(앞쪽 주석은 남긴다),
 * 블록이 아닌 자리(`if (c) stmt;`)의 문장은 빈 블록 `{}`로 바꿔 문법을 유지한다.
 */
export function removeStatementEdit(statement: Node): TextEdit {
  const parent = statement.getParent();
  const inList =
    parent !== undefined &&
    (Node.isBlock(parent) ||
      Node.isSourceFile(parent) ||
      Node.isCaseClause(parent) ||
      Node.isDefaultClause(parent) ||
      Node.isModuleBlock(parent));
  if (!inList) return replaceNodeEdit(statement, "{}");
  const full = statement.getSourceFile().getFullText();
  const start = statement.getStart();
  const end = statement.getEnd();
  const lineStart = full.lastIndexOf("\n", start - 1) + 1;
  const newline = full.indexOf("\n", end);
  const lineEnd = newline === -1 ? full.length : newline + 1;
  const before = full.slice(lineStart, start);
  const after = full.slice(end, newline === -1 ? full.length : newline);
  if (before.trim() === "" && after.trim() === "") {
    return { start: lineStart, end: lineEnd, text: "" };
  }
  return { start, end, text: "" };
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

export interface UnifiedDiff {
  /** 빈 문자열이면 변경 없음 */
  text: string;
  /** 지운 줄 + 추가한 줄 수 */
  changedLines: number;
}

/**
 * 파일 하나의 unified diff. 공통 앞부분·뒷부분 줄을 뺀 나머지를 한 덩어리(hunk)로 보인다.
 * 변형은 연속된 한 구간만 바꾸므로 한 덩어리로 충분하고, 결과가 입력에만 의존한다.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): UnifiedDiff {
  if (before === after) return { text: "", changedLines: 0 };
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  const hunkStart = Math.max(0, prefix - context);
  const aEnd = Math.min(a.length, a.length - suffix + context);
  const bEnd = Math.min(b.length, b.length - suffix + context);
  const aCount = aEnd - hunkStart;
  const bCount = bEnd - hunkStart;
  const range = (start: number, count: number) => `${count === 0 ? start : start + 1},${count}`;
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${range(hunkStart, aCount)} +${range(hunkStart, bCount)} @@`,
    ...a.slice(hunkStart, prefix).map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...a.slice(a.length - suffix, aEnd).map((line) => ` ${line}`),
  ];
  // 줄바꿈만 다른 경우(파일 끝 개행 추가·삭제)도 빈 diff가 되지 않게 표시한다
  if (removed.length === 0 && added.length === 0) {
    lines.push("\\ 파일 끝 줄바꿈만 다름");
  }
  return { text: `${lines.join("\n")}\n`, changedLines: removed.length + added.length };
}

/** diff 본문의 sha256 hex. 같은 스냅샷에 같은 변형을 적용하면 같다 */
export function patchDigestOf(diffText: string): string {
  return createHash("sha256").update(diffText, "utf8").digest("hex");
}
