/**
 * STATIC 기준의 구조화된 추가 검사 (TICKET.md T-405, `Criterion.staticChecks`).
 *
 * `DEPENDENCY_DECLARED`: 저장소 루트 `package.json`의 dependencies·devDependencies 키에 패키지 이름이 있는지 본다.
 * JSON을 파싱할 뿐 스크립트를 실행하지 않는다 (G-05). 판정 조건 문장은 해석하지 않는다 (G-06).
 * 근거는 `package.json`의 해당 키가 있는 라인(없으면 파일 앞부분)이다.
 */
import type { SourceLocation, StaticCheck } from "@ohmyti/core";
import type { SubmissionFiles } from "@ohmyti/runner";

export const PACKAGE_MANIFEST_PATH = "package.json";
/** 근거 스니펫 상한 */
const SNIPPET_MAX_LINES = 40;

export interface PackageManifest {
  /** 파일이 없으면 null */
  path: string | null;
  /** JSON 파싱 실패 사유 */
  parseError: string | null;
  /** dependencies·devDependencies에 선언된 이름 → 선언 라인(1부터, 못 찾으면 null) */
  declared: Map<string, number | null>;
  lines: string[];
}

export async function readPackageManifest(files: SubmissionFiles): Promise<PackageManifest> {
  const text = await files.readText(PACKAGE_MANIFEST_PATH);
  if (text === null) {
    return { path: null, parseError: null, declared: new Map(), lines: [] };
  }
  const lines = text.split(/\r?\n/);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      path: PACKAGE_MANIFEST_PATH,
      parseError: (error as Error).message,
      declared: new Map(),
      lines,
    };
  }
  const declared = new Map<string, number | null>();
  const record = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const name of Object.keys(value)) {
      if (declared.has(name)) continue;
      const needle = JSON.stringify(name) + ":";
      const index = lines.findIndex((line) => line.replace(/\s+/g, "").startsWith(needle));
      declared.set(name, index >= 0 ? index + 1 : null);
    }
  };
  if (parsed && typeof parsed === "object") {
    const pkg = parsed as Record<string, unknown>;
    record(pkg.dependencies);
    record(pkg.devDependencies);
  }
  return { path: PACKAGE_MANIFEST_PATH, parseError: null, declared, lines };
}

export interface StaticCheckOutcome {
  check: StaticCheck;
  pass: boolean;
  /** 관측 문장 (데이터에서 만든 템플릿) */
  observation: string;
  line: number | null;
}

export interface StaticChecksResult {
  pass: boolean;
  outcomes: StaticCheckOutcome[];
  /** 근거 위치. package.json이 없으면 null */
  source: SourceLocation | null;
  snippet: string | null;
}

export function evaluateStaticChecks(
  checks: readonly StaticCheck[],
  manifest: PackageManifest,
): StaticChecksResult {
  const outcomes = checks.map((check): StaticCheckOutcome => {
    const name = check.packageName;
    if (manifest.path === null) {
      return {
        check,
        pass: false,
        line: null,
        observation: `${PACKAGE_MANIFEST_PATH} 없음: ${name} 선언을 확인할 수 없음`,
      };
    }
    if (manifest.parseError !== null) {
      return {
        check,
        pass: false,
        line: null,
        observation: `${PACKAGE_MANIFEST_PATH}를 JSON으로 읽을 수 없음: ${name} 선언을 확인할 수 없음`,
      };
    }
    if (!manifest.declared.has(name)) {
      return {
        check,
        pass: false,
        line: null,
        observation: `${PACKAGE_MANIFEST_PATH}에 의존성 ${name} 선언 없음`,
      };
    }
    const line = manifest.declared.get(name) ?? null;
    return {
      check,
      pass: true,
      line,
      observation: `${PACKAGE_MANIFEST_PATH}에 의존성 ${name} 선언${line ? ` (${line}행)` : ""}`,
    };
  });
  let source: SourceLocation | null = null;
  let snippet: string | null = null;
  if (manifest.path !== null) {
    const found = outcomes.map((o) => o.line).filter((n): n is number => n !== null);
    const lineCount = Math.max(manifest.lines.length, 1);
    let startLine = found.length > 0 ? Math.min(...found) : 1;
    let endLine = found.length > 0 ? Math.max(...found) : Math.min(lineCount, SNIPPET_MAX_LINES);
    if (endLine - startLine + 1 > SNIPPET_MAX_LINES) endLine = startLine + SNIPPET_MAX_LINES - 1;
    startLine = Math.min(startLine, lineCount);
    endLine = Math.max(startLine, Math.min(endLine, lineCount));
    source = { path: manifest.path, startLine, endLine };
    snippet = manifest.lines.slice(startLine - 1, endLine).join("\n");
  }
  return { pass: outcomes.every((o) => o.pass), outcomes, source, snippet };
}
