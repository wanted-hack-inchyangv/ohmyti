/**
 * 맥락 연결 단계 격리 검사 (TICKET.md T-503 인수 기준).
 *
 * CONTEXT_LINK 단계의 코드가 `criterion_results`·`evaluations`의 점수 열을 참조하지 않는지 TypeScript AST로 검사한다.
 * 주석과 문자열은 보지 않고 식별자만 본다.
 *
 * 규칙
 * 1. 이름에 score·points·earned가 들어간 식별자를 쓰지 않는다.
 * 2. 판정 행 전체나 평가 행을 돌려주는 함수(`listCriterionResults`, `getEvaluation` 등)와 `evaluations` 테이블을 쓰지 않는다.
 * 3. `criterionResults.<열>`은 기준 ID·판정·관측·평가 ID 네 열만 쓴다.
 * 4. `from(criterionResults)` 앞의 `select()`는 열을 명시해야 한다(인자 없는 select는 모든 열을 읽는다).
 *
 * 실행: `pnpm context:isolation-check` (위반이 있으면 종료 코드 1)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 검사 대상: 맥락 연결 단계를 이루는 파일 */
export const CONTEXT_STAGE_FILES = [
  "packages/context/src/context-link.ts",
  "packages/db/src/context-links.ts",
  "apps/worker/src/pipeline/context-link.ts",
] as const;

const SCORE_NAME = /score|points|earned/i;

const BANNED_IDENTIFIERS = new Set([
  "evaluations",
  "listCriterionResults",
  "lockCriterionResults",
  "toCriterionResult",
  "getEvaluation",
  "findOpenEvaluation",
  "findFinishedEvaluationForVersion",
  "aggregateScore",
  "persistEvaluationResults",
]);

const ALLOWED_CRITERION_COLUMNS = new Set([
  "criterionId",
  "verdict",
  "observation",
  "evaluationId",
]);

export interface IsolationViolation {
  file: string;
  line: number;
  rule: "SCORE_IDENTIFIER" | "BANNED_IDENTIFIER" | "CRITERION_COLUMN" | "SELECT_ALL";
  text: string;
}

export function findIsolationViolations(source: string, file: string): IsolationViolation[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: IsolationViolation[] = [];
  const report = (node: ts.Node, rule: IsolationViolation["rule"]) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({ file, line: line + 1, rule, text: node.getText(sf).slice(0, 120) });
  };

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const name = node.text;
      if (SCORE_NAME.test(name)) report(node, "SCORE_IDENTIFIER");
      else if (BANNED_IDENTIFIERS.has(name)) report(node, "BANNED_IDENTIFIER");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "criterionResults" &&
      !ALLOWED_CRITERION_COLUMNS.has(node.name.text)
    ) {
      report(node, "CRITERION_COLUMN");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "from" &&
      node.arguments.some((a) => ts.isIdentifier(a) && a.text === "criterionResults")
    ) {
      const selectCall = node.expression.expression;
      const explicit =
        ts.isCallExpression(selectCall) &&
        ts.isPropertyAccessExpression(selectCall.expression) &&
        selectCall.expression.name.text === "select" &&
        selectCall.arguments.length > 0;
      if (!explicit) report(node, "SELECT_ALL");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

export async function checkContextIsolation(
  files: readonly string[] = CONTEXT_STAGE_FILES,
): Promise<IsolationViolation[]> {
  const all: IsolationViolation[] = [];
  for (const file of files) {
    const source = await readFile(path.join(REPO_ROOT, file), "utf8");
    all.push(...findIsolationViolations(source, file));
  }
  return all;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const violations = await checkContextIsolation();
  if (violations.length > 0) {
    for (const v of violations) console.error(`${v.file}:${v.line} ${v.rule} ${v.text}`);
    console.error(`맥락 연결 격리 검사 실패: 위반 ${violations.length}건`);
    process.exit(1);
  }
  console.log(`맥락 연결 격리 검사 OK (${CONTEXT_STAGE_FILES.length}개 파일)`);
}
