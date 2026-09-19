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
 *
 * 로직이 라우트 핸들러 안에 인라인으로 있는 제출물(T-602)도 같은 판별을 쓴다. 멱등 키는 이름뿐 아니라
 * `Idempotency-Key` 헤더를 읽는 식에서 변수 대입을 따라가 식별하고, 배열 순회 조회·`x.stock = x.stock + q` 대입도 본다.
 */
import { Node, SyntaxKind, type BinaryExpression, type IfStatement } from "ts-morph";
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
  | "BinaryExpression"
  | "IfStatement"
  | "CallExpression"
  | "ExpressionStatement"
  | "ForOfStatement"
  | "ForStatement";

/**
 * LLM 후보를 버린 사유 코드. 앞의 넷은 후보 검증(`validateCandidate`)이, 나머지는 각 변형의 `llmAccept`가 낸다.
 * `NOT_APPLICABLE` 사유에 붙어 "왜 적용하지 못했는지"를 사람이 확인할 수 있게 한다.
 */
export type MutationRejectCode =
  | "FILE_NOT_MUTABLE"
  | "LINE_OUT_OF_RANGE"
  | "WRONG_NODE_KIND"
  | "NODE_NOT_FOUND"
  | "NOT_GUARD"
  | "CONSTANT_OPERAND"
  | "NOT_LOWER_BOUND"
  | "NOT_LOOKUP"
  | "NAME_MISMATCH"
  | "RESULT_UNUSED"
  | "NOT_EQUALITY"
  | "NOT_RESTOCK";

/** `llmAccept`가 후보를 받지 않을 때 돌려주는 값 */
export interface MutationRejection {
  reject: MutationRejectCode;
}

export function isRejection(value: Node | MutationRejection): value is MutationRejection {
  return "reject" in value;
}

export interface MutationLocator {
  entryRequests: MutationEntryRequest[];
  /** 도달 가능한 함수 안의 노드 하나를 보고 변형 대상 노드를 돌려준다 */
  heuristic(node: Node): Node | undefined;
  /** LLM 후보로 받을 노드 종류. 이 밖의 종류를 가리키면 버린다 */
  llmNodeKinds: readonly MutationNodeKind[];
  /** LLM 후보 위치의 노드를 검증해 변형 대상 노드를 돌려준다 (느슨한 조건). 받지 않으면 거절 코드 */
  llmAccept(node: Node): Node | MutationRejection;
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
/** 멱등 키 이름의 보조 패턴 (`idemKey`, `idemStore`). 헤더 추적이 실패했을 때만 쓴다 */
const IDEMPOTENCY_NAME = /idem/i;
const IDEMPOTENCY_HEADER = /^idempotency-key$/i;
/** 멱등 기록의 키 속성 (`rec.key`, `r.idempotencyKey`) */
const KEY_NAME = /key/i;
const REQUEST_SIGNATURE = /digest|fingerprint|hash|signature|payload|body/i;
/** 이름만으로 재고 증가로 볼 수 있는 호출 */
const RESTOCK_CALL = /stock|inventory|replenish/i;
/** 일반 동사라서 수량 인자가 있어야 재고 증가로 보는 호출 (`release()` 잠금 해제와 구분) */
const RESTORE_CALL = /release|restore|return|refund|increment|increase|credit/i;
const LOOKUP_METHOD = /^(get|has|find|lookup|load|read|fetch)/i;
/** 배열 조회 메서드와 변형 후 "기록 없음" 값 */
const ARRAY_LOOKUP_EMPTY: Readonly<Record<string, string>> = {
  find: "undefined",
  findLast: "undefined",
  findIndex: "-1",
  findLastIndex: "-1",
  some: "false",
  filter: "[]",
};
/** 멱등 키를 식별자에서 헤더 읽기까지 따라가는 변수 대입 단계 수 */
const KEY_TRACE_DEPTH = 2;
const reject = (code: MutationRejectCode): MutationRejection => ({ reject: code });

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
      if (!isRelational(comparison) || !guardIfOf(comparison)) return reject("NOT_GUARD");
      if (isConstantLike(comparison.getLeft()) || isConstantLike(comparison.getRight())) {
        return reject("CONSTANT_OPERAND");
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
    llmAccept: (node) => (lowerBoundShape(node) ? node : reject("NOT_LOWER_BOUND")),
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

/** `Idempotency-Key` 헤더 읽기: `req.header(…)`·`req.get(…)`·`c.req.header(…)`·`req.headers["idempotency-key"]` */
function isIdempotencyHeaderRead(node: Node): boolean {
  const inner = unwrap(node);
  if (Node.isCallExpression(inner)) {
    const name = calleeName(inner);
    const [first] = inner.getArguments();
    return (
      (name === "header" || name === "get") &&
      first !== undefined &&
      Node.isStringLiteral(first) &&
      IDEMPOTENCY_HEADER.test(first.getLiteralValue())
    );
  }
  if (Node.isElementAccessExpression(inner)) {
    const argument = inner.getArgumentExpression();
    return (
      argument !== undefined &&
      Node.isStringLiteral(argument) &&
      IDEMPOTENCY_HEADER.test(argument.getLiteralValue())
    );
  }
  return false;
}

/** 식 자체나 하위 식이 헤더 읽기이거나 멱등 키로 추적되는 식별자인지 (변수 초기화식용) */
function containsIdempotencyKey(node: Node, depth: number): boolean {
  if (isIdempotencyKeyExpression(node, depth)) return true;
  let found = false;
  node.forEachDescendant((inner, traversal) => {
    if (Node.isFunctionLikeDeclaration(inner)) {
      traversal.skip();
      return;
    }
    if (isIdempotencyKeyExpression(inner, depth)) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

/**
 * 멱등 키로 볼 수 있는 식. 헤더 읽기에서 시작해 같은 함수 안의 변수 초기화를 `depth` 단계까지 따라간다
 * (`const raw = req.header("Idempotency-Key"); const key = raw;`). 이름 패턴(`/idem/i`)은 보조로 쓴다.
 */
export function isIdempotencyKeyExpression(node: Node, depth = KEY_TRACE_DEPTH): boolean {
  const inner = unwrap(node);
  if (isIdempotencyHeaderRead(inner)) return true;
  if (Node.isPropertyAccessExpression(inner)) return IDEMPOTENCY_NAME.test(inner.getName());
  if (!Node.isIdentifier(inner)) return false;
  if (IDEMPOTENCY_NAME.test(inner.getText())) return true;
  if (depth <= 0) return false;
  for (const declaration of inner.getSymbol()?.getDeclarations() ?? []) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const initializer = declaration.getInitializer();
    if (initializer && containsIdempotencyKey(initializer, depth - 1)) return true;
  }
  return false;
}

/** 멱등성 저장소 조회: 수신자 이름에 `idempot`이 있는 `.get()`/`.has()`이고 결과를 쓴다 */
function isIdempotencyLookup(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = unwrap(node.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return false;
  const method = callee.getName();
  if (method !== "get" && method !== "has") return false;
  return namesMatch(callee.getExpression(), IDEMPOTENCY) && resultIsUsed(node);
}

/** 노드 안(함수 경계를 넘지 않는다)의 동등 비교. 양쪽 모두 고정 값인 비교는 뺀다 */
function equalitiesIn(node: Node): BinaryExpression[] {
  const out: BinaryExpression[] = [];
  const visit = (inner: Node) => {
    if (
      isEquality(inner) &&
      !isConstantLike(inner.getLeft()) &&
      !isConstantLike(inner.getRight())
    ) {
      out.push(inner);
    }
  };
  visit(node);
  node.forEachDescendant((inner, traversal) => {
    if (inner !== node && Node.isFunctionLikeDeclaration(inner)) {
      traversal.skip();
      return;
    }
    visit(inner);
  });
  return out;
}

/**
 * 멱등 키와 기록을 맞춰 보는 비교: 한쪽이 멱등 키 식이다. `store`가 멱등 저장소 계열 이름이면
 * 한쪽 이름에 `key`가 들어간 비교(`r.key === key`)도 받는다
 */
function isKeyComparison(comparison: BinaryExpression, storeRelated: boolean): boolean {
  const sides = [comparison.getLeft(), comparison.getRight()];
  if (sides.some((side) => isIdempotencyKeyExpression(side))) return true;
  return storeRelated && sides.some((side) => namesMatch(side, KEY_NAME));
}

/** `store.find(r => r.key === key)` 모양의 배열 조회 호출이고 결과를 쓴다 */
function isArrayIdempotencyLookup(node: Node, storePattern: RegExp): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = unwrap(node.getExpression());
  if (!Node.isPropertyAccessExpression(callee)) return false;
  if (!Object.hasOwn(ARRAY_LOOKUP_EMPTY, callee.getName())) return false;
  const [callback] = node.getArguments();
  if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) {
    return false;
  }
  const storeRelated = namesMatch(callee.getExpression(), storePattern);
  return (
    resultIsUsed(node) &&
    equalitiesIn(callback.getBody()).some((comparison) => isKeyComparison(comparison, storeRelated))
  );
}

function isLoop(node: Node): boolean {
  return Node.isForOfStatement(node) || Node.isForStatement(node) || Node.isForInStatement(node);
}

/** 비교가 조건에 들어 있는 `if`와 그 `if`를 감싸는 반복문 (사이에 함수 경계가 없다) */
function loopIfOf(comparison: Node): { ifStatement: IfStatement; loop: Node } | undefined {
  let current = comparison.getParent();
  let ifStatement: IfStatement | undefined;
  while (current) {
    if (Node.isFunctionLikeDeclaration(current)) return undefined;
    if (!ifStatement) {
      if (Node.isIfStatement(current)) {
        if (!current.getExpression().containsRange(comparison.getPos(), comparison.getEnd())) {
          return undefined;
        }
        ifStatement = current;
      } else if (Node.isStatement(current)) {
        return undefined;
      }
    } else if (isLoop(current)) {
      return { ifStatement, loop: current };
    }
    current = current.getParent();
  }
  return undefined;
}

/** `if`의 then 쪽에서 반복문 밖에 선언된 변수에 대입하는 식 (`existing = rec`) */
function assignedOuterVariables(ifStatement: IfStatement, loop: Node): Node[] {
  const out: Node[] = [];
  ifStatement.getThenStatement().forEachDescendant((inner, traversal) => {
    if (Node.isFunctionLikeDeclaration(inner)) {
      traversal.skip();
      return;
    }
    if (!Node.isBinaryExpression(inner)) return;
    if (inner.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return;
    const left = unwrap(inner.getLeft());
    if (!Node.isIdentifier(left)) return;
    const declarations = left.getSymbol()?.getDeclarations() ?? [];
    if (declarations.some((d) => !loop.containsRange(d.getPos(), d.getEnd()))) out.push(left);
  });
  return out;
}

/**
 * 반복문 조회: `for (const rec of store) { if (rec.key === key) { existing = rec; break; } }`의 비교식.
 * 비교가 멱등 키를 쓰고, `if`의 then 쪽이 반복문 밖 변수에 대입해야 한다 (상품·주문 조회 반복문과 구분)
 */
function isLoopIdempotencyLookup(node: Node, storePattern: RegExp): boolean {
  if (!isEquality(node) || isNegatedEquality(node)) return false;
  if (isConstantLike(node.getLeft()) || isConstantLike(node.getRight())) return false;
  const found = loopIfOf(node);
  if (!found) return false;
  const header =
    Node.isForOfStatement(found.loop) || Node.isForInStatement(found.loop)
      ? found.loop.getExpression()
      : found.loop;
  const storeRelated =
    namesMatch(header, storePattern) || namesMatch(found.ifStatement.getExpression(), storePattern);
  return (
    isKeyComparison(node, storeRelated) &&
    assignedOuterVariables(found.ifStatement, found.loop).length > 0
  );
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

/** 1차 휴리스틱: 저장소 `.get()`/`.has()`, 배열 조회 호출, 반복문 조회의 비교식 */
function isIdempotencyLookupTarget(node: Node): boolean {
  return (
    isIdempotencyLookup(node) ||
    isArrayIdempotencyLookup(node, IDEMPOTENCY_NAME) ||
    isLoopIdempotencyLookup(node, IDEMPOTENCY_NAME)
  );
}

/** LLM 후보 검증: 반복문·`if`를 가리키면 안의 조회 비교식을 찾는다 */
function acceptIdempotencyLookup(node: Node): Node | MutationRejection {
  if (Node.isCallExpression(node)) {
    if (isLooseIdempotencyLookup(node) || isArrayIdempotencyLookup(node, IDEMPOTENCY_LOOSE)) {
      return node;
    }
    const callee = unwrap(node.getExpression());
    const lookupShaped =
      Node.isPropertyAccessExpression(callee) &&
      (LOOKUP_METHOD.test(callee.getName()) || Object.hasOwn(ARRAY_LOOKUP_EMPTY, callee.getName()));
    if (!lookupShaped) return reject("NOT_LOOKUP");
    return reject(resultIsUsed(node) ? "NAME_MISMATCH" : "RESULT_UNUSED");
  }
  const comparisons = Node.isBinaryExpression(node) ? [node] : equalitiesIn(node);
  const target = comparisons.find((c) => isLoopIdempotencyLookup(c, IDEMPOTENCY_LOOSE));
  if (target) return target;
  const inLoop = comparisons.some((c) => loopIfOf(c) !== undefined);
  return reject(inLoop ? "NAME_MISMATCH" : "NOT_LOOKUP");
}

const M03: MutationDefinition = {
  id: "M-03",
  targetCriterionIds: ["R-05"],
  group: "G2",
  description: "멱등 키 조회 건너뜀 (저장된 응답이 없는 것처럼 처리한다)",
  llmHint:
    "주문 생성 경로에서 Idempotency-Key로 이전 요청 기록을 조회하는 호출식(예: idempotencyStore.get(key), records.find(r => r.key === key)) 또는 기록 배열을 도는 반복문 안의 키 비교식(예: rec.key === key)",
  locate: {
    entryRequests: CREATE_ORDER,
    heuristic: (node) => (isIdempotencyLookupTarget(node) ? node : undefined),
    llmNodeKinds: ["CallExpression", "BinaryExpression", "ForOfStatement", "ForStatement"],
    llmAccept: acceptIdempotencyLookup,
  },
  transform(target) {
    // 반복문 조회: 키 비교를 `false`로 바꿔 기록을 찾지 못하게 한다
    if (Node.isBinaryExpression(target)) return [replaceNodeEdit(target, "false")];
    if (!Node.isCallExpression(target)) return [];
    // `.has()`·`.some()`은 false, 배열 조회는 메서드별 빈 값, 나머지 조회는 undefined. `await`로 감싸져 있으면 await까지 바꾼다
    const name = calleeName(target) ?? "";
    const replacement =
      name === "has"
        ? "false"
        : target
              .getArguments()
              .some((arg) => Node.isArrowFunction(arg) || Node.isFunctionExpression(arg))
          ? (ARRAY_LOOKUP_EMPTY[name] ?? "undefined")
          : "undefined";
    const parent = target.getParent();
    const node = parent && Node.isAwaitExpression(parent) ? parent : target;
    return [replaceNodeEdit(node, replacement)];
  },
};

// ─── M-04 같은 키의 본문 비교 건너뜀 ────────────────────────────────────

/** 선언된 변수가 반복문 조회(`isLoopIdempotencyLookup`)의 then 쪽에서 대입되는지 */
function assignedByLoopLookup(declaration: Node, symbolName: string): boolean {
  const scope = declaration.getFirstAncestor(
    (ancestor) => Node.isBlock(ancestor) || Node.isSourceFile(ancestor),
  );
  if (!scope) return false;
  let found = false;
  scope.forEachDescendant((inner, traversal) => {
    if (!isLoopIdempotencyLookup(inner, IDEMPOTENCY_NAME)) return;
    const loopIf = loopIfOf(inner)!;
    const assigned = assignedOuterVariables(loopIf.ifStatement, loopIf.loop);
    if (
      assigned.some(
        (identifier) =>
          identifier.getText() === symbolName &&
          (identifier.getSymbol()?.getDeclarations() ?? []).includes(declaration),
      )
    ) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

/** 식별자가 멱등성 조회 결과로 초기화되거나 반복문 조회에서 대입되는 변수인지 */
function isLookupResultVariable(node: Node): boolean {
  const target = unwrap(node);
  if (!Node.isIdentifier(target)) return false;
  for (const declaration of target.getSymbol()?.getDeclarations() ?? []) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const initializer = declaration.getInitializer();
    if (initializer) {
      const inner = unwrap(initializer);
      if (isIdempotencyLookup(inner) || isArrayIdempotencyLookup(inner, IDEMPOTENCY_NAME)) {
        return true;
      }
    }
    if (assignedByLoopLookup(declaration, target.getText())) return true;
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
    llmAccept(node) {
      if (!isEquality(node)) return reject("NOT_EQUALITY");
      if ([node.getLeft(), node.getRight()].some(isConstantLike)) return reject("CONSTANT_OPERAND");
      return isLooseRequestComparison(node) ? node : reject("NAME_MISMATCH");
    },
  },
  transform(target) {
    if (!isEquality(target)) return [];
    // 비교 결과를 "본문이 같다"로 고정한다
    return [replaceNodeEdit(target, isNegatedEquality(target) ? "false" : "true")];
  },
};

// ─── M-05 취소 시 재고 복구 제거 ───────────────────────────────────────

/** 공백을 뺀 식 텍스트. `x.stock`과 `x . stock`을 같은 대상으로 본다 */
function compactText(node: Node): string {
  return unwrap(node).getText().replace(/\s+/g, "");
}

/** `X = X + q` 또는 `X = q + X` (좌변과 같은 대상에 더한다) */
function isSelfAddition(assignment: BinaryExpression): boolean {
  const right = unwrap(assignment.getRight());
  if (
    !Node.isBinaryExpression(right) ||
    right.getOperatorToken().getKind() !== SyntaxKind.PlusToken
  ) {
    return false;
  }
  const target = compactText(assignment.getLeft());
  return compactText(right.getLeft()) === target || compactText(right.getRight()) === target;
}

/**
 * 재고를 늘리는 문장: 재고 계열 이름의 호출, 수량 인자가 있는 복구 계열 호출(음수 인자 제외),
 * 재고 계열 대상의 `+=`·`++`, 또는 `X.stock = X.stock + q` 대입
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
    if (!namesMatch(expression.getLeft(), STOCK)) return false;
    const operator = expression.getOperatorToken().getKind();
    if (operator === SyntaxKind.PlusEqualsToken) return true;
    return operator === SyntaxKind.EqualsToken && isSelfAddition(expression);
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
      return statement && isRestockStatement(statement, true) ? statement : reject("NOT_RESTOCK");
    },
  },
  transform: (target) => [removeStatementEdit(target)],
};

/** 부록 A의 카탈로그. 순서가 적용 순서다 */
export const MUTATION_CATALOG: readonly MutationDefinition[] = [M01, M02, M03, M04, M05];

export function findMutation(id: string): MutationDefinition | undefined {
  return MUTATION_CATALOG.find((entry) => entry.id === id);
}
