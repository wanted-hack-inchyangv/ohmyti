/**
 * 설계 평가용 결정적 코드 신호 추출 (TICKET.md T-605). 제출물의 AST만 읽는다. 코드를 실행하지 않고 타입 검사도 하지 않는다.
 *
 * - 파일은 메모리 파일 시스템의 ts-morph 프로젝트로 연다(임시 디렉터리·`node_modules` 없음). 제출물의 tsconfig는 컴파일 옵션으로
 *   쓰지 않고 `strict` 값만 읽는다.
 * - 테스트 파일(`test/`·`tests/`·`__tests__/`·`spec/`·`e2e/` 아래이거나 `.test.`·`.spec.` 파일)은 약한 단언 비율에만 쓰고,
 *   나머지 신호는 테스트를 뺀 소스에서 센다.
 * - 중복 블록: 문장 목록(파일 최상위·블록·case 절)에서 연속 문장 `DUPLICATE_WINDOW`(3)개의 창을 정규화 문자열로 비교한다.
 *   정규화는 AST 노드 종류를 그대로 두고 식별자 이름과 리터럴 값을 지운다(속성 이름 `x.id`의 `id`와 객체 리터럴 키는 남긴다).
 *   창 하나의 노드 수가 `DUPLICATE_MIN_NODES`(30) 미만이거나 import·export 선언이 들어 있으면 비교하지 않는다(짧은 대입·조회 후
 *   404 두 줄 같은 관용구 제외). 같은 모양이 이어지는 창은 한 묶음으로 합친다.
 * - 모든 결과는 경로·라인 순으로 결정적이다. 해석(좋다·나쁘다)과 임계값은 두지 않는다.
 */
import {
  DESIGN_SIGNALS_ANALYZER_VERSION,
  MAX_DUPLICATE_GROUPS,
  MAX_SIGNAL_LOCATIONS,
  type DesignSignals,
  type DesignSignalsOk,
  type DuplicateBlockGroup,
  type SourceLocation,
} from "@ohmyti/core";
import { Node, Project, SyntaxKind, ts, type SourceFile } from "ts-morph";
import {
  isSourcePath,
  PROJECT_LIMIT_DEFAULTS,
  type AnalysisFiles,
  type ProjectLimits,
} from "./project";

/** 중복 비교 창 하나의 최소 AST 노드 수 */
export const DUPLICATE_MIN_NODES = 30;
/** 중복 비교 창의 문장 수 */
export const DUPLICATE_WINDOW = 3;

const TEST_DIR_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "e2e"]);

/** 테스트 파일 여부 (경로 규칙만 본다) */
export function isTestPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s))) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
}

const FUNCTION_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

const WEAK_MATCHERS = new Set(["toBeTruthy", "toBeFalsy", "toBeDefined"]);
const WEAK_WHEN_NEGATED = new Set(["toBeNull", "toBeUndefined"]);
const RANGE_MATCHERS = new Set([
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
]);
const EXPECT_MODIFIERS = new Set(["not", "resolves", "rejects"]);

function lineLocation(path: string, node: Node): SourceLocation {
  return { path, startLine: node.getStartLineNumber(), endLine: node.getEndLineNumber() };
}

function pointLocation(path: string, node: Node): SourceLocation {
  const line = node.getStartLineNumber();
  return { path, startLine: line, endLine: line };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r?\n/);
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

class LocatedCounter {
  count = 0;
  readonly locations: SourceLocation[] = [];
  add(location: SourceLocation): void {
    this.count += 1;
    if (this.locations.length < MAX_SIGNAL_LOCATIONS) this.locations.push(location);
  }
  toJSON(): { count: number; locations: SourceLocation[] } {
    return { count: this.count, locations: this.locations };
  }
}

function clipName(name: string): string {
  const oneLine = name.replace(/\s+/g, " ").trim();
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 59)}…`;
}

/** 함수 이름: 선언 이름 → 대입된 변수·속성 이름 → 호출 인자면 `<호출 대상> 콜백` → `(익명 함수)` */
export function functionNameOf(node: Node): string {
  if (Node.isConstructorDeclaration(node)) {
    const cls = node.getParent();
    return `${Node.isClassDeclaration(cls) ? (cls.getName() ?? "(익명 클래스)") : "(클래스)"}.constructor`;
  }
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isFunctionExpression(node)
  ) {
    const name = node.getName();
    if (name) return clipName(name);
  }
  const parent = node.getParent();
  if (parent) {
    if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)) {
      return clipName(parent.getName());
    }
    if (Node.isPropertyDeclaration(parent)) return clipName(parent.getName());
    if (Node.isCallExpression(parent)) {
      const callee = parent.getExpression().getText();
      return clipName(`${callee.length <= 40 ? callee : "(호출)"} 콜백`);
    }
  }
  return "(익명 함수)";
}

/** 식별자 이름과 리터럴 값을 지운 AST 모양 문자열과 노드 수 */
function normalizeNode(node: ts.Node): { text: string; nodes: number } {
  let nodes = 0;
  const visit = (n: ts.Node): string => {
    nodes += 1;
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
      const parent = n.parent;
      const keepName =
        (parent !== undefined &&
          (ts.isPropertyAccessExpression(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isMethodDeclaration(parent)) &&
          parent.name === n) ||
        (parent !== undefined && ts.isShorthandPropertyAssignment(parent));
      return keepName ? `.${n.text}` : "$";
    }
    if (
      ts.isStringLiteral(n) ||
      ts.isNumericLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isRegularExpressionLiteral(n) ||
      ts.isBigIntLiteral(n) ||
      ts.isTemplateLiteralToken(n)
    ) {
      return String(n.kind);
    }
    const children: string[] = [];
    n.forEachChild((child) => {
      children.push(visit(child));
    });
    return children.length === 0 ? String(n.kind) : `${n.kind}(${children.join(",")})`;
  };
  const text = visit(node);
  return { text, nodes };
}

interface StatementList {
  path: string;
  statements: ts.Statement[];
  /** 문장별 정규화 결과. import·export 선언은 `nodes: -1`(비교 제외) */
  normalized: Array<{ text: string; nodes: number }>;
}

function statementLists(path: string, sourceFile: SourceFile): StatementList[] {
  const lists: StatementList[] = [];
  const push = (statements: readonly ts.Statement[]) => {
    if (statements.length < DUPLICATE_WINDOW) return;
    lists.push({
      path,
      statements: [...statements],
      normalized: statements.map((s) =>
        ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s) || ts.isExportDeclaration(s)
          ? { text: "", nodes: -1 }
          : normalizeNode(s),
      ),
    });
  };
  const visit = (n: ts.Node) => {
    if (ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n)) push(n.statements);
    else if (ts.isCaseClause(n) || ts.isDefaultClause(n)) push(n.statements);
    n.forEachChild(visit);
  };
  visit(sourceFile.compilerNode);
  return lists;
}

function statementLocation(
  list: StatementList,
  sourceFile: ts.SourceFile,
  start: number,
  length: number,
): SourceLocation {
  const first = list.statements[start]!;
  const last = list.statements[start + length - 1]!;
  return {
    path: list.path,
    startLine: sourceFile.getLineAndCharacterOfPosition(first.getStart(sourceFile)).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(last.getEnd()).line + 1,
  };
}

/**
 * 같은 모양의 연속 문장 블록 묶음. 창(`DUPLICATE_WINDOW`개 문장)마다 모양 문자열로 모은 뒤, 모든 위치에서 다음 문장의 모양이
 * 같은 동안 블록을 늘려 하나로 센다. 한 문장 목록 안에서 겹치는 위치는 하나만 센다.
 */
export function findDuplicateBlocks(
  lists: ReadonlyArray<StatementList & { sourceFile: ts.SourceFile }>,
): { count: number; groups: DuplicateBlockGroup[] } {
  interface Occurrence {
    list: number;
    index: number;
  }
  const byShape = new Map<string, Occurrence[]>();
  lists.forEach((list, listIndex) => {
    for (let index = 0; index + DUPLICATE_WINDOW <= list.statements.length; index += 1) {
      const parts = list.normalized.slice(index, index + DUPLICATE_WINDOW);
      if (parts.some((p) => p.nodes < 0)) continue;
      const nodes = parts.reduce((sum, p) => sum + p.nodes, 0);
      if (nodes < DUPLICATE_MIN_NODES) continue;
      const shape = parts.map((p) => p.text).join("\n");
      const occurrences = byShape.get(shape) ?? [];
      occurrences.push({ list: listIndex, index });
      byShape.set(shape, occurrences);
    }
  });
  // 겹치지 않는 위치만 남긴다 (같은 목록에서 앞 위치와 창이 겹치면 버린다)
  const groups: Occurrence[][] = [];
  for (const occurrences of byShape.values()) {
    const kept: Occurrence[] = [];
    for (const occ of occurrences) {
      const previous = kept[kept.length - 1];
      if (previous && previous.list === occ.list && occ.index - previous.index < DUPLICATE_WINDOW) {
        continue;
      }
      kept.push(occ);
    }
    if (kept.length >= 2) groups.push(kept);
  }
  // 앞쪽 위치부터 시작 창으로 삼고, 모든 위치에서 다음 문장의 모양이 같은 동안 블록을 늘린다.
  // 늘어난 블록 안쪽에서 시작하는 창 묶음은 이미 센 블록의 일부이므로 건너뛴다
  groups.sort((a, b) => a[0]!.list - b[0]!.list || a[0]!.index - b[0]!.index);
  const key = (o: Occurrence) => `${o.list}:${o.index}`;
  const covered = new Set<string>();
  const results: Array<{ statements: number; locations: SourceLocation[] }> = [];
  for (const g of groups) {
    if (g.every((o) => covered.has(key(o)))) continue;
    let length = DUPLICATE_WINDOW;
    for (;;) {
      const next = g.map((o) => lists[o.list]!.normalized[o.index + length]);
      const first = next[0];
      const sameShape =
        first !== undefined &&
        first.nodes >= 0 &&
        next.every((n) => n !== undefined && n.text === first.text);
      // 같은 목록 안의 다음 위치와 겹치면 멈춘다
      const overlaps = g.some((o, i) => {
        const following = g[i + 1];
        return following?.list === o.list && o.index + length >= following.index;
      });
      if (!sameShape || overlaps) break;
      length += 1;
    }
    for (const o of g) {
      for (let k = 1; k <= length - DUPLICATE_WINDOW; k += 1) {
        covered.add(key({ list: o.list, index: o.index + k }));
      }
    }
    results.push({
      statements: length,
      locations: g.map((o) => {
        const list = lists[o.list]!;
        return statementLocation(list, list.sourceFile, o.index, length);
      }),
    });
  }
  const compare = (a: SourceLocation, b: SourceLocation) =>
    a.path === b.path ? a.startLine - b.startLine : a.path < b.path ? -1 : 1;
  for (const r of results) r.locations.sort(compare);
  results.sort((a, b) => compare(a.locations[0]!, b.locations[0]!));
  return {
    count: results.length,
    groups: results.slice(0, MAX_DUPLICATE_GROUPS).map((r) => ({
      statements: r.statements,
      locations: r.locations.slice(0, MAX_SIGNAL_LOCATIONS),
    })),
  };
}

/** `while (flag)`·`while (!this.locked)`처럼 식별자·속성 접근(부정 포함)이 조건인지 */
function isFlagCondition(expression: Node): boolean {
  let current = expression;
  while (Node.isParenthesizedExpression(current)) current = current.getExpression();
  if (
    Node.isPrefixUnaryExpression(current) &&
    current.getOperatorToken() === SyntaxKind.ExclamationToken
  ) {
    return isFlagCondition(current.getOperand());
  }
  return Node.isIdentifier(current) || Node.isPropertyAccessExpression(current);
}

/** 반복문 본문에 (중첩 함수 밖의) `await`가 있는지 */
function bodyAwaits(body: Node): boolean {
  let found = false;
  const visit = (n: Node) => {
    if (found) return;
    if (Node.isAwaitExpression(n)) {
      found = true;
      return;
    }
    if (FUNCTION_KINDS.has(n.getKind())) return;
    n.forEachChild(visit);
  };
  visit(body);
  return found;
}

/** `expect(...)` 단언 호출이면 matcher 이름과 부정 여부. 아니면 null */
function expectMatcherOf(call: Node): { name: string; negated: boolean } | null {
  if (!Node.isCallExpression(call)) return null;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const name = callee.getName();
  let object: Node = callee.getExpression();
  let negated = false;
  while (Node.isPropertyAccessExpression(object) && EXPECT_MODIFIERS.has(object.getName())) {
    if (object.getName() === "not") negated = !negated;
    object = object.getExpression();
  }
  if (!Node.isCallExpression(object)) return null;
  const root = object.getExpression();
  const rootText = root.getText();
  if (rootText !== "expect" && rootText !== "expect.soft") return null;
  return { name, negated };
}

function isStatusRangeLiteral(node: Node | undefined): boolean {
  if (!node || !Node.isNumericLiteral(node)) return false;
  const value = node.getLiteralValue();
  return value >= 100 && value <= 599;
}

export interface ExtractDesignSignalsInput {
  files: AnalysisFiles;
  limits?: Partial<ProjectLimits> | undefined;
}

function unavailable(reason: string): DesignSignals {
  return { status: "unavailable", analyzerVersion: DESIGN_SIGNALS_ANALYZER_VERSION, reason };
}

/** 루트 tsconfig의 `compilerOptions.strict`. 파싱할 수 없으면 null */
export function tsconfigStrictOf(text: string): boolean | null {
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", text);
  if (parsed.error || !parsed.config || typeof parsed.config !== "object") return null;
  const config = parsed.config as { compilerOptions?: { strict?: unknown }; extends?: unknown };
  const strict = config.compilerOptions?.strict;
  if (typeof strict === "boolean") return strict;
  // strict를 적지 않았으면 TypeScript 기본값(false)이다. 다른 설정을 상속하면 알 수 없다
  return config.extends === undefined ? false : null;
}

export async function extractDesignSignals(
  input: ExtractDesignSignalsInput,
): Promise<DesignSignals> {
  const limits: ProjectLimits = { ...PROJECT_LIMIT_DEFAULTS, ...(input.limits ?? {}) };
  const allPaths = await input.files.listFiles();
  const sourcePaths = allPaths
    .filter((p) => isSourcePath(p) && !p.split("/").includes("node_modules"))
    .sort();
  if (sourcePaths.length > limits.maxFiles) {
    return unavailable(
      `소스 파일이 ${sourcePaths.length}개로 상한 ${limits.maxFiles}개를 넘습니다`,
    );
  }
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, noEmit: true },
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  const files: Array<{ path: string; text: string; test: boolean; sourceFile: SourceFile }> = [];
  let totalBytes = 0;
  for (const path of sourcePaths) {
    const text = await input.files.readText(path);
    if (text === null) continue;
    totalBytes += Buffer.byteLength(text, "utf8");
    if (totalBytes > limits.maxBytes) {
      return unavailable(`소스 파일 총 크기가 상한 ${limits.maxBytes}바이트를 넘습니다`);
    }
    const sourceFile = project.createSourceFile(`/snapshot/${path}`, text, { overwrite: true });
    files.push({ path, text, test: isTestPath(path), sourceFile });
  }

  const tsconfigText = allPaths.includes("tsconfig.json")
    ? await input.files.readText("tsconfig.json")
    : null;

  let maxFile: DesignSignalsOk["maxFileLines"] = null;
  let maxFunction: DesignSignalsOk["maxFunctionLines"] = null;
  const anyCounter = new LocatedCounter();
  let asAny = 0;
  const busyWaits = new LocatedCounter();
  const consoleLogs = new LocatedCounter();
  const weak = new LocatedCounter();
  let assertionTotal = 0;
  const lists: Array<StatementList & { sourceFile: ts.SourceFile }> = [];

  for (const file of files) {
    const { path, sourceFile } = file;
    if (file.test) {
      sourceFile.forEachDescendant((node) => {
        const matcher = expectMatcherOf(node);
        if (!matcher || !Node.isCallExpression(node)) return;
        assertionTotal += 1;
        const [firstArg] = node.getArguments();
        const isWeak =
          (!matcher.negated && WEAK_MATCHERS.has(matcher.name)) ||
          (matcher.negated && WEAK_WHEN_NEGATED.has(matcher.name)) ||
          (!matcher.negated && RANGE_MATCHERS.has(matcher.name) && isStatusRangeLiteral(firstArg));
        if (isWeak) weak.add(pointLocation(path, node));
      });
      continue;
    }
    const lines = countLines(file.text);
    if (lines > 0 && (maxFile === null || lines > maxFile.lines)) {
      maxFile = { lines, location: { path, startLine: 1, endLine: lines } };
    }
    sourceFile.forEachDescendant((node) => {
      const kind = node.getKind();
      if (FUNCTION_KINDS.has(kind)) {
        const location = lineLocation(path, node);
        const span = location.endLine - location.startLine + 1;
        if (maxFunction === null || span > maxFunction.lines) {
          maxFunction = { lines: span, name: functionNameOf(node), location };
        }
      } else if (kind === SyntaxKind.AnyKeyword) {
        anyCounter.add(pointLocation(path, node));
        const parent = node.getParent();
        if (parent && (Node.isAsExpression(parent) || Node.isTypeAssertion(parent))) asAny += 1;
      } else if (Node.isWhileStatement(node) || Node.isDoStatement(node)) {
        if (isFlagCondition(node.getExpression()) && bodyAwaits(node.getStatement())) {
          busyWaits.add(lineLocation(path, node));
        }
      } else if (Node.isCallExpression(node)) {
        const callee = node.getExpression();
        if (
          Node.isPropertyAccessExpression(callee) &&
          callee.getName() === "log" &&
          callee.getExpression().getText() === "console"
        ) {
          consoleLogs.add(pointLocation(path, node));
        }
      }
    });
    for (const list of statementLists(path, sourceFile)) {
      lists.push({ ...list, sourceFile: sourceFile.compilerNode });
    }
  }

  return {
    status: "ok",
    analyzerVersion: DESIGN_SIGNALS_ANALYZER_VERSION,
    sourceFiles: files.filter((f) => !f.test).length,
    testFiles: files.filter((f) => f.test).length,
    maxFileLines: maxFile,
    maxFunctionLines: maxFunction,
    explicitAny: { ...anyCounter.toJSON(), asAny },
    tsconfig: {
      path: tsconfigText === null ? null : "tsconfig.json",
      strict: tsconfigText === null ? null : tsconfigStrictOf(tsconfigText),
    },
    duplicateBlocks: findDuplicateBlocks(lists),
    busyWaits: busyWaits.toJSON(),
    consoleLogs: consoleLogs.toJSON(),
    weakAssertions: { ...weak.toJSON(), total: assertionTotal },
  };
}
