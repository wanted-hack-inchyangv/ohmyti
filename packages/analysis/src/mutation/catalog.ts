/**
 * Mutation 카탈로그 M-01~M-05 (TICKET.md T-402, 부록 A). 명세와 연결된 소수의 결함만 주입한다.
 *
 * 각 변형은 두 단계로 위치를 찾는다.
 * - 1차 `heuristic`: 대상 요청(`entryRequests`)이 매치된 라우트 핸들러에서 호출 그래프로 도달 가능한 함수 안의 노드만 본다.
 *   식별자 이름과 구문 모양이 모두 맞아야 한다.
 * - 2차 `llmAccept`: 1차가 실패했을 때 LLM이 제안한 위치의 노드를 검증한다. 도달 가능성은 요구하지 않지만(정적 분석이
 *   놓친 간접 호출을 보완) 구문 모양과 느슨한 이름 조건은 요구한다. 대상 로직이 없는 코드에 가짜 변형을 만들지 않기 위해서다.
 *
 * `transform`은 원문 텍스트 편집만 돌려준다. 적용과 판정은 `apply.ts`가 한다.
 */
import { Node } from "ts-morph";
import {
  calleeName,
  enclosingExpressionStatement,
  guardIfOf,
  isConstantLike,
  isEquality,
  isNegatedEquality,
  isRelational,
  namesMatch,
  numericValue,
  resultIsUsed,
  unwrap,
} from "./ast";
import { removeStatementEdit, replaceNodeEdit, type TextEdit } from "./text";

export interface MutationEntryRequest {
  method: string;
  /** 실제 요청 경로 예시. 라우트 패턴(`/orders/:id/cancel`)과 매칭한다 */
  path: string;
}

/** LLM이 돌려줄 수 있는 노드 종류 (ts-morph `getKindName()` 값) */
export type MutationNodeKind =
  "BinaryExpression" | "IfStatement" | "CallExpression" | "ExpressionStatement";

export interface MutationLocator {
  entryRequests: MutationEntryRequest[];
  /** 도달 가능한 함수 안의 노드 하나를 보고 변형 대상 노드를 돌려준다 */
  heuristic(node: Node): Node | undefined;
  /** LLM 후보로 받을 노드 종류. 이 밖의 종류를 가리키면 버린다 */
  llmNodeKinds: readonly MutationNodeKind[];
  /** LLM 후보 위치의 노드를 검증해 변형 대상 노드를 돌려준다 (느슨한 조건) */
  llmAccept(node: Node): Node | undefined;
}

export interface MutationDefinition {
  id: string;
  targetCriterionIds: readonly string[];
  /** rubric 그룹 (G1~G3) */
  group: string;
  description: string;
  /** LLM 위치 탐색 프롬프트에 넣는 대상 설명 */
  llmHint: string;
  locate: MutationLocator;
  transform(target: Node): TextEdit[];
}

/** evaluation 하나에서 적용하는 mutation 수 상한 */
export const MAX_MUTATIONS_PER_EVALUATION = 5;

const QUANTITY = /quantity|qty|amount|count/i;
const STOCK = /stock|inventory|available|remaining/i;
const IDEMPOTENCY = /idempot/i;
const IDEMPOTENCY_LOOSE = /idempot|dedup|replay/i;
const REQUEST_SIGNATURE = /digest|fingerprint|hash|signature|payload|body/i;
/** 이름만으로 재고 증가로 볼 수 있는 호출 */
const RESTOCK_CALL = /stock|inventory|replenish/i;
/** 일반 동사라서 수량 인자가 있어야 재고 증가로 보는 호출 (`release()` 잠금 해제와 구분) */
const RESTORE_CALL = /release|restore|return|refund|increment|increase|credit/i;
const LOOKUP_METHOD = /^(get|has|find|lookup|load|read|fetch)/i;

const CREATE_ORDER: MutationEntryRequest[] = [{ method: "POST", path: "/orders" }];
const CANCEL_ORDER: MutationEntryRequest[] = [
  { method: "POST", path: "/orders/__mutation_probe__/cancel" },
];

// ─── M-01 재고 부족 검사 제거 ─────────────────────────────────────────

/** 수량 계열과 재고 계열을 비교하는 관계 연산 (양쪽 순서 무관) */
function isStockComparison(node: Node): boolean {
  if (!isRelational(node)) return false;
  const left = node.getLeft();
  const right = node.getRight();
  return (
    (namesMatch(left, QUANTITY) && namesMatch(right, STOCK)) ||
    (namesMatch(left, STOCK) && namesMatch(right, QUANTITY))
  );
}

/** 보호 `if`를 지운다. else가 있으면 조건만 `false`로 바꿔 else 쪽을 남긴다 */
function removeGuard(comparison: Node): TextEdit[] {
  const guard = guardIfOf(comparison);
  if (!guard) return [];
  if (guard.getElseStatement()) return [replaceNodeEdit(guard.getExpression(), "false")];
  return [removeStatementEdit(guard)];
}

const M01: MutationDefinition = {
  id: "M-01",
  targetCriterionIds: ["R-03"],
  group: "G1",
  description: "재고 부족 검사 제거 (주문 수량이 재고보다 많아도 거절하지 않는다)",
  llmHint:
    "주문 생성 경로에서 주문 수량과 현재 재고를 비교해 재고가 부족하면 오류를 던지거나 반환하는 if 문의 비교식",
  locate: {
    entryRequests: CREATE_ORDER,
    heuristic: (node) => (isStockComparison(node) && guardIfOf(node) ? node : undefined),
    llmNodeKinds: ["BinaryExpression", "IfStatement"],
    llmAccept(node) {
      const comparison = Node.isIfStatement(node) ? unwrap(node.getExpression()) : node;
      if (!isRelational(comparison) || !guardIfOf(comparison)) return undefined;
      if (isConstantLike(comparison.getLeft()) || isConstantLike(comparison.getRight())) {
        return undefined;
      }
      return comparison;
    },
  },
  transform: removeGuard,
};

// ─── M-02 수량 경계 `<= 0` → `< 0` ────────────────────────────────────

/** `x <= 0`, `x < 1`, `0 >= x`, `1 > x` 모양이면 변수 쪽 노드와 방향 */
function lowerBoundShape(node: Node): { operand: Node; side: "left" | "right" } | undefined {
  if (!isRelational(node)) return undefined;
  const operator = node.getOperatorToken().getText();
  const left = node.getLeft();
  const right = node.getRight();
  const rightValue = numericValue(right);
  const leftValue = numericValue(left);
  if (
    rightValue !== undefined &&
    leftValue === undefined &&
    ((operator === "<=" && rightValue === 0) || (operator === "<" && rightValue === 1))
  ) {
    return { operand: left, side: "left" };
  }
  if (
    leftValue !== undefined &&
    rightValue === undefined &&
    ((operator === ">=" && leftValue === 0) || (operator === ">" && leftValue === 1))
  ) {
    return { operand: right, side: "right" };
  }
  return undefined;
}

const M02: MutationDefinition = {
  id: "M-02",
  targetCriterionIds: ["R-04"],
  group: "G1",
  description: "수량 하한 완화: `quantity <= 0` → `quantity < 0` (수량 0을 받아들인다)",
  llmHint: "주문 수량이 0 이하(또는 1 미만)인지 검사하는 경계 비교식 (예: quantity <= 0, qty < 1)",
  locate: {
    entryRequests: CREATE_ORDER,
    heuristic(node) {
      const shape = lowerBoundShape(node);
      return shape && namesMatch(shape.operand, QUANTITY) ? node : undefined;
    },
    llmNodeKinds: ["BinaryExpression"],
    llmAccept: (node) => (lowerBoundShape(node) ? node : undefined),
  },
  transform(target) {
    const shape = lowerBoundShape(target);
    if (!shape) return [];
    const text =
      shape.side === "left" ? `${shape.operand.getText()} < 0` : `0 > ${shape.operand.getText()}`;
    return [replaceNodeEdit(target, text)];
  },
};

// ─── M-03 멱등 키 조회 건너뜀 ──────────────────────────────────────────

/** 멱등성 저장소 조회: 수신자 이름에 `idempot`이 있는 `.get()`/`.has()`이고 결과를 쓴다 */
function isIdempotencyLookup(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = unwrap(node.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return false;
  const method = callee.getName();
  if (method !== "get" && method !== "has") return false;
  return namesMatch(callee.getExpression(), IDEMPOTENCY) && resultIsUsed(node);
}

function isLooseIdempotencyLookup(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = unwrap(node.getExpression());
  if (!Node.isPropertyAccessExpression(callee) || !LOOKUP_METHOD.test(callee.getName())) {
    return false;
  }
  const related =
    namesMatch(callee.getExpression(), IDEMPOTENCY_LOOSE) ||
    node.getArguments().some((arg) => namesMatch(arg, IDEMPOTENCY_LOOSE));
  return related && resultIsUsed(node);
}

const M03: MutationDefinition = {
  id: "M-03",
  targetCriterionIds: ["R-05"],
  group: "G2",
  description: "멱등 키 조회 건너뜀 (저장된 응답이 없는 것처럼 처리한다)",
  llmHint:
    "주문 생성 경로에서 Idempotency-Key로 이전 요청 기록을 조회하는 호출식 (예: idempotencyStore.get(key))",
  locate: {
    entryRequests: CREATE_ORDER,
    heuristic: (node) => (isIdempotencyLookup(node) ? node : undefined),
    llmNodeKinds: ["CallExpression"],
    llmAccept: (node) => (isLooseIdempotencyLookup(node) ? node : undefined),
  },
  transform(target) {
    if (!Node.isCallExpression(target)) return [];
    // `.has()`는 "없음"(false), 나머지 조회는 "없음"(undefined). `await`로 감싸져 있으면 await까지 바꾼다
    const replacement = calleeName(target) === "has" ? "false" : "undefined";
    const parent = target.getParent();
    const node = parent && Node.isAwaitExpression(parent) ? parent : target;
    return [replaceNodeEdit(node, replacement)];
  },
};

// ─── M-04 같은 키의 본문 비교 건너뜀 ────────────────────────────────────

/** 식별자가 멱등성 조회 결과로 초기화된 변수인지 */
function isLookupResultVariable(node: Node): boolean {
  const target = unwrap(node);
  if (!Node.isIdentifier(target)) return false;
  for (const declaration of target.getSymbol()?.getDeclarations() ?? []) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const initializer = declaration.getInitializer();
    if (!initializer) continue;
    if (isIdempotencyLookup(unwrap(initializer))) return true;
  }
  return false;
}

/** `저장된기록.속성 !== 이번요청값` 모양. 한쪽이 멱등성 조회 결과의 속성이어야 한다 */
function isStoredRequestComparison(node: Node): boolean {
  if (!isEquality(node)) return false;
  const sides = [node.getLeft(), node.getRight()];
  if (sides.some(isConstantLike)) return false;
  return sides.some((side) => {
    const inner = unwrap(side);
    return Node.isPropertyAccessExpression(inner) && isLookupResultVariable(inner.getExpression());
  });
}

function isLooseRequestComparison(node: Node): boolean {
  if (!isEquality(node)) return false;
  const sides = [node.getLeft(), node.getRight()];
  if (sides.some(isConstantLike)) return false;
  return sides.some((side) => namesMatch(side, REQUEST_SIGNATURE));
}

const M04: MutationDefinition = {
  id: "M-04",
  targetCriterionIds: ["R-06"],
  group: "G2",
  description: "같은 키의 본문 비교 건너뜀 (다른 본문으로 재전송해도 충돌로 보지 않는다)",
  llmHint:
    "같은 Idempotency-Key로 저장된 요청의 본문(다이제스트·지문)과 이번 요청 본문을 비교하는 동등 비교식 (예: stored.digest !== digest)",
  locate: {
    entryRequests: CREATE_ORDER,
    heuristic: (node) => (isStoredRequestComparison(node) ? node : undefined),
    llmNodeKinds: ["BinaryExpression"],
    llmAccept: (node) => (isLooseRequestComparison(node) ? node : undefined),
  },
  transform(target) {
    if (!isEquality(target)) return [];
    // 비교 결과를 "본문이 같다"로 고정한다
    return [replaceNodeEdit(target, isNegatedEquality(target) ? "false" : "true")];
  },
};

// ─── M-05 취소 시 재고 복구 제거 ───────────────────────────────────────

/**
 * 재고를 늘리는 문장: 재고 계열 이름의 호출, 수량 인자가 있는 복구 계열 호출(음수 인자 제외),
 * 또는 재고 계열 대상의 `+=`·`++`
 */
function isRestockStatement(node: Node, loose: boolean): boolean {
  if (!Node.isExpressionStatement(node)) return false;
  const expression = unwrap(node.getExpression());
  if (Node.isCallExpression(expression)) {
    const name = calleeName(expression) ?? "";
    const negative = expression
      .getArguments()
      .some((arg) => Node.isPrefixUnaryExpression(unwrap(arg)) && arg.getText().startsWith("-"));
    if (negative) return false;
    const hasQuantity = expression.getArguments().some((arg) => namesMatch(arg, QUANTITY));
    if (RESTOCK_CALL.test(name) || (RESTORE_CALL.test(name) && hasQuantity)) return true;
    return loose && hasQuantity && namesMatch(expression, RESTOCK_CALL);
  }
  if (Node.isBinaryExpression(expression)) {
    return (
      expression.getOperatorToken().getText() === "+=" && namesMatch(expression.getLeft(), STOCK)
    );
  }
  if (Node.isPostfixUnaryExpression(expression) || Node.isPrefixUnaryExpression(expression)) {
    return expression.getText().includes("++") && namesMatch(expression.getOperand(), STOCK);
  }
  return false;
}

const M05: MutationDefinition = {
  id: "M-05",
  targetCriterionIds: ["R-09"],
  group: "G3",
  description: "취소 시 재고 복구 제거 (주문을 취소해도 재고가 돌아오지 않는다)",
  llmHint:
    "주문 취소 경로에서 취소된 주문의 수량만큼 재고를 되돌리는 문장 (예: adjustStock(productId, quantity))",
  locate: {
    entryRequests: CANCEL_ORDER,
    heuristic: (node) => (isRestockStatement(node, false) ? node : undefined),
    llmNodeKinds: ["ExpressionStatement", "CallExpression"],
    llmAccept(node) {
      const statement = Node.isExpressionStatement(node)
        ? node
        : enclosingExpressionStatement(node);
      return statement && isRestockStatement(statement, true) ? statement : undefined;
    },
  },
  transform: (target) => [removeStatementEdit(target)],
};

/** 부록 A의 카탈로그. 순서가 적용 순서다 */
export const MUTATION_CATALOG: readonly MutationDefinition[] = [M01, M02, M03, M04, M05];

export function findMutation(id: string): MutationDefinition | undefined {
  return MUTATION_CATALOG.find((entry) => entry.id === id);
}
