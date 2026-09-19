/**
 * R-11(README, STATIC) 정적 검사 (TICKET.md T-205).
 *
 * 저장소 루트의 README가 존재하고 비어 있지 않은지, 본문에 시작 명령(실행 계약 `startCommand` 또는 동등한
 * `npm start`류 명령)과 포트 환경변수(실행 계약 `portEnv`)가 언급되는지를 정규식으로만 본다.
 * README 본문은 데이터다 (G-06): 어떤 문장도 해석하지 않고 판정에 영향을 주지 않는다. 근거는 파일 경로·라인이다.
 */
import type { SourceLocation } from "@ohmyti/core";
import type { SubmissionFiles } from "@ohmyti/runner";

/** 루트에서 README로 인정하는 파일 이름 (소문자 비교, 앞선 것 우선) */
export const README_FILE_NAMES: readonly string[] = [
  "readme.md",
  "readme.markdown",
  "readme.txt",
  "readme",
];

/** 근거 스니펫 상한 */
export const README_SNIPPET_MAX_LINES = 40;
export const README_SNIPPET_MAX_CHARS = 4000;
/** observation에 남기는 일치 라인 번호 수 상한 */
const MAX_MATCH_LINES = 5;

export interface ReadmeMention {
  found: boolean;
  /** 일치한 라인 번호(1부터), 최대 `MAX_MATCH_LINES`개 */
  lines: number[];
}

export interface ReadmeCheck {
  /** 찾은 README 경로. 없으면 null */
  path: string | null;
  exists: boolean;
  nonEmpty: boolean;
  lineCount: number;
  startCommand: ReadmeMention;
  port: ReadmeMention;
  /** 존재 + 비어 있지 않음 + 시작 명령 언급 + 포트 언급 */
  pass: boolean;
  /** 근거 위치. README가 없으면 null */
  source: SourceLocation | null;
  /** `source` 범위의 원문 (상한 적용). README가 없으면 null */
  snippet: string | null;
}

export interface ReadmeCheckContract {
  startCommand: string;
  portEnv: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 시작 명령으로 인정하는 패턴. 계약의 `startCommand`를 첫 번째로 둔다 */
export function startCommandPatterns(startCommand: string): RegExp[] {
  const literal = startCommand.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return [
    new RegExp(`(^|[^\\w-])${literal}(?![\\w-])`),
    /(^|[^\w-])(npm|pnpm|yarn|bun)\s+(run\s+)?start(?![\w-])/,
    /(^|[^\w-])node\s+[\w./-]+\.[cm]?js(?![\w-])/,
    /(^|[^\w-])(npx\s+)?tsx\s+[\w./-]+\.[cm]?ts(?![\w-])/,
  ];
}

export function portPattern(portEnv: string): RegExp {
  return new RegExp(`(^|[^\\w])${escapeRegExp(portEnv)}(?![\\w])`);
}

function mention(lines: readonly string[], patterns: readonly RegExp[]): ReadmeMention {
  const matched: number[] = [];
  lines.forEach((line, index) => {
    if (matched.length >= MAX_MATCH_LINES) return;
    if (patterns.some((pattern) => pattern.test(line))) matched.push(index + 1);
  });
  return { found: matched.length > 0, lines: matched };
}

/** 루트의 README 파일 경로 (우선순위 순). 없으면 null */
export function findReadmePath(paths: readonly string[]): string | null {
  const rootFiles = new Map<string, string>();
  for (const p of paths) {
    if (p.includes("/")) continue;
    const lower = p.toLowerCase();
    if (!rootFiles.has(lower)) rootFiles.set(lower, p);
  }
  for (const name of README_FILE_NAMES) {
    const found = rootFiles.get(name);
    if (found !== undefined) return found;
  }
  return null;
}

export async function checkReadme(
  files: SubmissionFiles,
  contract: ReadmeCheckContract,
): Promise<ReadmeCheck> {
  const path = findReadmePath(await files.listFiles());
  const missing: ReadmeMention = { found: false, lines: [] };
  if (path === null) {
    return {
      path: null,
      exists: false,
      nonEmpty: false,
      lineCount: 0,
      startCommand: missing,
      port: missing,
      pass: false,
      source: null,
      snippet: null,
    };
  }
  const text = (await files.readText(path)) ?? "";
  const lines = text.split(/\r?\n/);
  const lineCount = lines.length;
  const nonEmpty = text.trim().length > 0;
  const startCommand = nonEmpty
    ? mention(lines, startCommandPatterns(contract.startCommand))
    : missing;
  const port = nonEmpty ? mention(lines, [portPattern(contract.portEnv)]) : missing;

  // 근거 범위: 두 언급이 모두 있으면 첫 일치 라인 사이, 아니면 파일 앞부분
  const anchors = [...startCommand.lines.slice(0, 1), ...port.lines.slice(0, 1)];
  let startLine = 1;
  let endLine = Math.min(lineCount, README_SNIPPET_MAX_LINES);
  if (anchors.length > 0) {
    startLine = Math.min(...anchors);
    endLine = Math.max(...anchors);
    if (endLine - startLine + 1 > README_SNIPPET_MAX_LINES) {
      endLine = startLine + README_SNIPPET_MAX_LINES - 1;
    }
  }
  endLine = Math.max(startLine, Math.min(endLine, Math.max(lineCount, 1)));
  let snippet = lines.slice(startLine - 1, endLine).join("\n");
  if (snippet.length > README_SNIPPET_MAX_CHARS) {
    snippet = `${snippet.slice(0, README_SNIPPET_MAX_CHARS)}\n…(잘림)`;
  }
  return {
    path,
    exists: true,
    nonEmpty,
    lineCount,
    startCommand,
    port,
    pass: nonEmpty && startCommand.found && port.found,
    source: { path, startLine, endLine },
    snippet,
  };
}

/** 데이터에서 만든 관측 문장 (interpretation이 아니다) */
export function describeReadmeCheck(check: ReadmeCheck, contract: ReadmeCheckContract): string {
  if (!check.exists) return "저장소 루트에 README 파일이 없음";
  const parts = [`${check.path} 존재 (${check.lineCount}줄)`];
  if (!check.nonEmpty) {
    parts.push("본문이 비어 있음");
    return parts.join(" · ");
  }
  parts.push(
    check.startCommand.found
      ? `시작 명령 언급: ${check.startCommand.lines.map((n) => `${n}행`).join(", ")}`
      : `시작 명령(\`${contract.startCommand}\` 또는 동등한 명령) 언급 없음`,
  );
  parts.push(
    check.port.found
      ? `${contract.portEnv} 언급: ${check.port.lines.map((n) => `${n}행`).join(", ")}`
      : `${contract.portEnv} 환경변수 언급 없음`,
  );
  return parts.join(" · ");
}
