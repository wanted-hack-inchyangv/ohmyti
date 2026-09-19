/**
 * mutation 위치 탐색에 쓰는 AST 판별 함수 (TICKET.md T-402). 모두 순수 함수이며 노드 텍스트가 아니라 구문 종류와
 * 식별자 이름으로 판단한다. 주석은 판별에 쓰지 않는다(샘플의 `M-01` 주석 같은 표식에 기대지 않는다, G-06).
 */
import { Node, SyntaxKind, type BinaryExpression, type IfStatement } from "ts-morph";
import { isSourcePath } from "../project";

const TEST_DIRS = new Set(["__tests__", "__mocks__", "test", "tests", "spec", "specs"]);

/** 테스트 파일. 변형은 이 파일들을 절대 건드리지 않는다 */
export function isTestPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  return segments.slice(0, -1).some((segment) => TEST_DIRS.has(segment));
}

/** 변형 대상이 될 수 있는 파일: 소스이면서 테스트·설정·선언 파일이 아닌 것 */
export function isMutablePath(relativePath: string): boolean {
  if (!isSourcePath(relativePath) || isTestPath(relativePath)) return false;
  const base = relativePath.split("/").pop() ?? "";
  return !/\.config\.[cm]?[jt]s$/.test(base);
}

/** 노드와 하위 노드의 식별자 이름 (속성 이름 포함, 등장 순) */
export function identifierNames(node: Node): string[] {
  const names: string[] = [];
  if (Node.isIdentifier(node) || Node.isPrivateIdentifier(node)) names.push(node.getText());
  node.forEachDescendant((inner) => {
    if (Node.isIdentifier(inner) || Node.isPrivateIdentifier(inner)) names.push(inner.getText());
  });
  return names;
}

export function namesMatch(node: Node, pattern: RegExp): boolean {
  return identifierNames(node).some((name) => pattern.test(name));
}

/** 괄호·`await`·`!`(non-null)·`as`를 벗긴다 */
export function unwrap(node: Node): Node {
  let current = node;
  for (let i = 0; i < 8; i += 1) {
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAwaitExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current)
    ) {
      current = current.getExpression();
    } else break;
  }
  return current;
}

const RELATIONAL = new Set([
  SyntaxKind.GreaterThanToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.LessThanEqualsToken,
]);

const EQUALITY = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

export function isRelational(node: Node): node is BinaryExpression {
  return Node.isBinaryExpression(node) && RELATIONAL.has(node.getOperatorToken().getKind());
}

export function isEquality(node: Node): node is BinaryExpression {
  return Node.isBinaryExpression(node) && EQUALITY.has(node.getOperatorToken().getKind());
}

/** 부정 비교(`!==`, `!=`)인지 */
export function isNegatedEquality(node: BinaryExpression): boolean {
  const kind = node.getOperatorToken().getKind();
  return (
    kind === SyntaxKind.ExclamationEqualsEqualsToken || kind === SyntaxKind.ExclamationEqualsToken
  );
}

/** 리터럴·`typeof`·`undefined` 같은 고정 값. 비교 한쪽이 이런 값이면 "두 값의 비교"가 아니다 */
export function isConstantLike(node: Node): boolean {
  const inner = unwrap(node);
  if (
    Node.isStringLiteral(inner) ||
    Node.isNumericLiteral(inner) ||
    Node.isNoSubstitutionTemplateLiteral(inner) ||
    Node.isNullLiteral(inner) ||
    Node.isTrueLiteral(inner) ||
    Node.isFalseLiteral(inner) ||
    Node.isTypeOfExpression(inner)
  ) {
    return true;
  }
  if (Node.isPrefixUnaryExpression(inner)) return isConstantLike(inner.getOperand());
  return Node.isIdentifier(inner) && inner.getText() === "undefined";
}

/** 숫자 리터럴 값 (`-1` 포함). 아니면 undefined */
export function numericValue(node: Node): number | undefined {
  const inner = unwrap(node);
  if (Node.isNumericLiteral(inner)) return inner.getLiteralValue();
  if (
    Node.isPrefixUnaryExpression(inner) &&
    inner.getOperatorToken() === SyntaxKind.MinusToken &&
    Node.isNumericLiteral(inner.getOperand())
  ) {
    const operand = inner.getOperand();
    return Node.isNumericLiteral(operand) ? -operand.getLiteralValue() : undefined;
  }
  return undefined;
}

function contains(outer: Node, inner: Node): boolean {
  return outer.getStart() <= inner.getStart() && inner.getEnd() <= outer.getEnd();
}

/** 문장이 흐름을 끝내는지(`throw`·`return`, 또는 그것으로 끝나는 블록) */
function exitsFlow(statement: Node): boolean {
  if (Node.isThrowStatement(statement) || Node.isReturnStatement(statement)) return true;
  if (Node.isBlock(statement)) {
    const statements = statement.getStatements();
    const last = statements[statements.length - 1];
    return last !== undefined && exitsFlow(last);
  }
  return false;
}

/**
 * 식이 조건에 들어 있는 보호 `if` (then 쪽이 `throw`·`return`으로 끝난다). 식과 `if` 사이에 함수 경계가 있으면 아니다
 */
export function guardIfOf(expression: Node): IfStatement | undefined {
  let current = expression.getParent();
  while (current) {
    if (Node.isIfStatement(current)) {
      if (!contains(current.getExpression(), expression)) return undefined;
      return exitsFlow(current.getThenStatement()) ? current : undefined;
    }
    if (Node.isStatement(current) || Node.isFunctionLikeDeclaration(current)) return undefined;
    current = current.getParent();
  }
  return undefined;
}

/** 호출식의 함수 이름 (`a.b.c()` → `c`, `f()` → `f`) */
export function calleeName(node: Node): string | undefined {
  if (!Node.isCallExpression(node)) return undefined;
  const callee = unwrap(node.getExpression());
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  if (Node.isIdentifier(callee)) return callee.getText();
  return undefined;
}

/** 호출 결과가 쓰이는지 (문장으로 버려지지 않는다) */
export function resultIsUsed(call: Node): boolean {
  let current: Node = call;
  let parent = current.getParent();
  while (parent && (Node.isAwaitExpression(parent) || Node.isParenthesizedExpression(parent))) {
    current = parent;
    parent = current.getParent();
  }
  return parent !== undefined && !Node.isExpressionStatement(parent);
}

/** 노드를 감싸는 가장 가까운 식 문장 */
export function enclosingExpressionStatement(node: Node): Node | undefined {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isExpressionStatement(current)) return current;
    if (Node.isStatement(current) || Node.isFunctionLikeDeclaration(current)) return undefined;
    current = current.getParent();
  }
  return undefined;
}
