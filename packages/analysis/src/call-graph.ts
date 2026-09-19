/**
 * TypeScript AST에서 함수 노드·라우트 등록·프로젝트 내부 호출 간선을 뽑는다 (TICKET.md T-304).
 *
 * 함수 노드: 함수 선언, 클래스·객체 리터럴 메서드, 생성자, 변수·속성에 대입된 화살표 함수/함수 식, 라우트 핸들러로 넘긴 인라인 함수.
 * 그 밖의 인라인 콜백(`arr.map(() => …)`, `serial(() => …)`)은 노드로 만들지 않고 감싸는 함수의 일부로 본다.
 *
 * 라우트 등록: `<수신자>.<get|post|put|patch|delete|options|head|all>("<경로>", …핸들러)` (express·hono 공통).
 * 미들웨어 체인은 마지막 인자가 핸들러다. 첫 인자가 문자열 리터럴이 아니거나 마지막 인자가 함수로 풀리지 않으면 등록으로 보지 않는다.
 * `app.use("/prefix", router)`·`app.route("/prefix", sub)` 마운트는 한 단계까지 접두사로 반영한다.
 *
 * 호출 해석: 호출식의 심볼 → 선언 → 함수 노드. 인터페이스·타입 리터럴 멤버(`Commands["place"]`)는 언어 서비스의 구현 찾기로
 * 구현 위치를 찾는다. node_modules 안의 선언은 프로젝트 밖이므로 버린다. 모든 결과는 파일 경로·라인 순으로 결정적이다.
 */
import {
  functionGraphNodeId,
  type FunctionGraphNodeKind,
  type FunctionGraphRoute,
  type SourceLocation,
} from "@ohmyti/core";
import {
  Node,
  SymbolFlags,
  type ArrowFunction,
  type CallExpression,
  type ConstructorDeclaration,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type NewExpression,
  type Project,
  type SourceFile,
  type Symbol as TsSymbol,
} from "ts-morph";
import { relativeSourcePath, type LoadedProject } from "./project";
import { joinRoutePath, ROUTE_METHOD_NAMES } from "./routes";

export interface GraphFunction {
  id: string;
  name: string;
  kind: FunctionGraphNodeKind;
  location: SourceLocation;
  route: FunctionGraphRoute | null;
  /** 함수 본문 노드 (ts-morph). 스니펫 추출용 */
  node: Node;
}

export interface GraphCallEdge {
  from: string;
  to: string;
}

export interface RouteRegistration {
  method: FunctionGraphRoute["method"];
  path: string;
  /** 핸들러 함수 노드 id */
  handlerId: string;
  /** 등록 위치 (정렬 키) */
  location: SourceLocation;
}

export interface CallGraph {
  functions: GraphFunction[];
  edges: GraphCallEdge[];
  routes: RouteRegistration[];
  fileCount: number;
}

/** 파일 순 → 시작 라인 → 끝 라인 */
function compareLocation(a: SourceLocation, b: SourceLocation): number {
  return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine;
}

const MAX_ALIAS_DEPTH = 8;

type FunctionLikeNode =
  | FunctionDeclaration
  | MethodDeclaration
  | ConstructorDeclaration
  | ArrowFunction
  | FunctionExpression;

function isFunctionLike(node: Node | undefined): node is FunctionLikeNode {
  return (
    node !== undefined &&
    (Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isConstructorDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node))
  );
}

/** `as`·`satisfies`·괄호를 벗긴다 */
function unwrapExpression(expression: Expression | undefined): Expression | undefined {
  let current = expression;
  for (let i = 0; i < MAX_ALIAS_DEPTH && current; i += 1) {
    if (Node.isParenthesizedExpression(current)) current = current.getExpression();
    else if (Node.isAsExpression(current)) current = current.getExpression();
    else if (Node.isSatisfiesExpression(current)) current = current.getExpression();
    else if (Node.isNonNullExpression(current)) current = current.getExpression();
    else if (Node.isAwaitExpression(current)) current = current.getExpression();
    else break;
  }
  return current;
}

export class CallGraphBuilder {
  private readonly functions = new Map<Node, GraphFunction>();
  private readonly functionsById = new Map<string, GraphFunction>();
  private readonly edgeKeys = new Set<string>();
  private readonly edges: GraphCallEdge[] = [];
  private readonly routes: RouteRegistration[] = [];
  private readonly project: Project;
  private readonly rootDir: string;
  private readonly sourceFiles: SourceFile[];

  constructor(loaded: LoadedProject) {
    this.project = loaded.project;
    this.rootDir = loaded.rootDir;
    this.sourceFiles = [...loaded.project.getSourceFiles()].sort((a, b) =>
      a.getFilePath().localeCompare(b.getFilePath()),
    );
  }

  build(): CallGraph {
    // 1) 함수 노드와 라우트 등록을 먼저 모은다 (호출 해석은 노드 집합이 완성된 뒤에 한다)
    const registrations: Array<{
      call: CallExpression;
      method: FunctionGraphRoute["method"];
      path: string;
    }> = [];
    for (const file of this.sourceFiles) {
      file.forEachDescendant((node) => {
        if (isFunctionLike(node)) this.registerFunction(node);
        if (Node.isCallExpression(node)) {
          const registration = this.routeRegistrationOf(node);
          if (registration) registrations.push({ call: node, ...registration });
        }
      });
    }
    // 2) 라우트 핸들러 결정 (인라인 함수 또는 함수 노드로 풀리는 식). 마운트 접두사를 붙인다
    const prefixes = this.collectMountPrefixes();
    for (const { call, method, path } of registrations) {
      const args = call.getArguments();
      const handler = this.handlerOfArgument(args[args.length - 1]);
      if (!handler) continue;
      const callee = call.getExpression();
      const receiver = Node.isPropertyAccessExpression(callee)
        ? unwrapExpression(callee.getExpression())
        : undefined;
      const receiverKey = receiver ? this.symbolKeyOf(receiver) : undefined;
      const prefix = receiverKey ? (prefixes.get(receiverKey) ?? "") : "";
      const fullPath = joinRoutePath(prefix, path);
      if (handler.route === null) {
        handler.route = { method, path: fullPath };
        if (handler.kind === "handler") handler.name = `${method} ${fullPath}`;
      }
      const location = this.locationOf(call);
      if (location) this.routes.push({ method, path: fullPath, handlerId: handler.id, location });
    }
    // 3) 호출 간선
    for (const file of this.sourceFiles) {
      file.forEachDescendant((node) => {
        if (Node.isCallExpression(node) || Node.isNewExpression(node)) this.addCallEdges(node);
      });
    }
    const functions = [...this.functions.values()].sort((a, b) =>
      compareLocation(a.location, b.location),
    );
    const routes = [...this.routes].sort((a, b) => compareLocation(a.location, b.location));
    return { functions, edges: this.edges, routes, fileCount: this.sourceFiles.length };
  }

  private locationOf(node: Node): SourceLocation | null {
    const relativePath = relativeSourcePath(this.rootDir, node.getSourceFile().getFilePath());
    if (relativePath === null) return null;
    return {
      path: relativePath,
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
    };
  }

  /** 함수 노드로 등록한다. 인라인 콜백(라우트 핸들러 제외)은 등록하지 않는다 */
  private registerFunction(node: Node): GraphFunction | undefined {
    const existing = this.functions.get(node);
    if (existing) return existing;
    const named = this.nameOf(node);
    if (!named) return undefined;
    const location = this.locationOf(node);
    if (!location) return undefined;
    const fn: GraphFunction = {
      id: functionGraphNodeId(location),
      name: named.name,
      kind: named.kind,
      location,
      route: null,
      node,
    };
    // 같은 위치(id)에 두 노드가 오는 경우(변수 선언과 그 초기화 화살표 함수가 한 줄)는 먼저 등록한 것을 쓴다
    const sameId = this.functionsById.get(fn.id);
    if (sameId) {
      this.functions.set(node, sameId);
      return sameId;
    }
    this.functions.set(node, fn);
    this.functionsById.set(fn.id, fn);
    return fn;
  }

  private nameOf(node: Node): { name: string; kind: FunctionGraphNodeKind } | undefined {
    if (Node.isFunctionDeclaration(node)) {
      return { name: node.getName() ?? "default", kind: "function" };
    }
    if (Node.isMethodDeclaration(node)) {
      const owner = node.getParent();
      const ownerName =
        Node.isClassDeclaration(owner) || Node.isClassExpression(owner)
          ? owner.getName()
          : undefined;
      return {
        name: ownerName ? `${ownerName}.${node.getName()}` : node.getName(),
        kind: "method",
      };
    }
    if (Node.isConstructorDeclaration(node)) {
      const owner = node.getParent();
      const ownerName = Node.isClassDeclaration(owner) ? owner.getName() : undefined;
      return { name: `${ownerName ?? "class"}.constructor`, kind: "method" };
    }
    // 화살표 함수·함수 식: 대입 대상의 이름을 쓴다
    const parent = node.getParent();
    if (!parent) return undefined;
    if (Node.isVariableDeclaration(parent)) {
      return { name: parent.getName(), kind: "function" };
    }
    if (Node.isPropertyAssignment(parent)) {
      return { name: parent.getName(), kind: "method" };
    }
    if (Node.isPropertyDeclaration(parent)) {
      const owner = parent.getParent();
      const ownerName = Node.isClassDeclaration(owner) ? owner.getName() : undefined;
      return {
        name: ownerName ? `${ownerName}.${parent.getName()}` : parent.getName(),
        kind: "method",
      };
    }
    if (Node.isCallExpression(parent)) {
      const registration = this.routeRegistrationOf(parent);
      const args = parent.getArguments();
      if (registration && args[args.length - 1] === node) {
        return { name: `${registration.method} ${registration.path}`, kind: "handler" };
      }
    }
    if (Node.isExportAssignment(parent)) {
      return { name: "default", kind: "function" };
    }
    return undefined;
  }

  /** `x.post("/path", …)` 형태면 method·path. 경로가 문자열 리터럴이 아니면 undefined */
  private routeRegistrationOf(
    call: CallExpression,
  ): { method: FunctionGraphRoute["method"]; path: string } | undefined {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return undefined;
    const method = ROUTE_METHOD_NAMES.get(callee.getName());
    if (!method) return undefined;
    const args = call.getArguments();
    if (args.length < 2) return undefined;
    const first = args[0]!;
    if (!Node.isStringLiteral(first) && !Node.isNoSubstitutionTemplateLiteral(first)) {
      return undefined;
    }
    const path = first.getLiteralText();
    if (!path.startsWith("/")) return undefined;
    return { method, path };
  }

  /** 핸들러 인자 → 함수 노드. 배열이면 마지막 원소, 식별자·속성 접근이면 심볼로 푼다 */
  private handlerOfArgument(argument: Node | undefined): GraphFunction | undefined {
    let target: Node | undefined = argument;
    if (target && Node.isArrayLiteralExpression(target)) {
      const elements = target.getElements();
      target = elements[elements.length - 1];
    }
    target = Node.isExpression(target) ? unwrapExpression(target) : target;
    if (!target) return undefined;
    if (isFunctionLike(target)) return this.registerFunction(target);
    const targets = this.resolveTargets(target, 0);
    return targets[0];
  }

  /** 식별자의 심볼 키 (마운트 접두사 대조용) */
  private symbolKeyOf(expression: Node): string | undefined {
    const symbol = this.resolvedSymbol(expression);
    if (!symbol) return undefined;
    const declaration = symbol.getDeclarations()[0];
    if (!declaration) return undefined;
    return `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`;
  }

  /**
   * `app.use("/p", router)` / `app.route("/p", sub)` → 라우터 심볼 키 → 접두사.
   * 두 번째 인자가 식별자면 그 심볼, 호출식(`createRoutes(x)`)이면 그 함수의 `return <식별자>` 심볼을 쓴다
   */
  private collectMountPrefixes(): Map<string, string> {
    const prefixes = new Map<string, string>();
    for (const file of this.sourceFiles) {
      file.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        const callee = node.getExpression();
        if (!Node.isPropertyAccessExpression(callee)) return;
        const name = callee.getName();
        if (name !== "use" && name !== "route") return;
        const args = node.getArguments();
        if (args.length !== 2) return;
        const first = args[0]!;
        if (!Node.isStringLiteral(first) && !Node.isNoSubstitutionTemplateLiteral(first)) return;
        const prefix = first.getLiteralText();
        if (!prefix.startsWith("/")) return;
        const second = unwrapExpression(args[1] as Expression);
        if (!second) return;
        for (const key of this.routerSymbolKeys(second)) {
          if (!prefixes.has(key)) prefixes.set(key, prefix);
        }
      });
    }
    return prefixes;
  }

  private routerSymbolKeys(expression: Expression): string[] {
    if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression)) {
      const key = this.symbolKeyOf(expression);
      return key ? [key] : [];
    }
    if (Node.isCallExpression(expression)) {
      const keys: string[] = [];
      for (const fn of this.resolveTargets(expression.getExpression(), 0)) {
        fn.node.forEachDescendant((inner) => {
          if (!Node.isReturnStatement(inner)) return;
          const returned = unwrapExpression(inner.getExpression());
          if (returned && Node.isIdentifier(returned)) {
            const key = this.symbolKeyOf(returned);
            if (key) keys.push(key);
          }
        });
      }
      return keys;
    }
    return [];
  }

  /** 노드를 감싸는 가장 가까운 함수 노드 */
  private enclosingFunction(node: Node): GraphFunction | undefined {
    let current: Node | undefined = node.getParent();
    while (current) {
      const fn = this.functions.get(current);
      if (fn) return fn;
      current = current.getParent();
    }
    return undefined;
  }

  private addCallEdges(call: CallExpression | NewExpression): void {
    const owner = this.enclosingFunction(call);
    if (!owner) return;
    const callee = Node.isNewExpression(call) ? call.getExpression() : call.getExpression();
    for (const target of this.resolveTargets(callee, 0)) {
      if (target === owner) continue;
      const key = `${owner.id}→${target.id}`;
      if (this.edgeKeys.has(key)) continue;
      this.edgeKeys.add(key);
      this.edges.push({ from: owner.id, to: target.id });
    }
  }

  /** 호출 대상 식의 심볼 (import 별칭은 원 심볼로) */
  private resolvedSymbol(expression: Node): TsSymbol | undefined {
    let symbol: TsSymbol | undefined;
    if (Node.isPropertyAccessExpression(expression)) symbol = expression.getNameNode().getSymbol();
    else symbol = expression.getSymbol();
    for (
      let i = 0;
      i < MAX_ALIAS_DEPTH && symbol && symbol.getFlags() & SymbolFlags.Alias;
      i += 1
    ) {
      const aliased = symbol.getAliasedSymbol();
      if (!aliased || aliased === symbol) break;
      symbol = aliased;
    }
    return symbol;
  }

  /** 호출 대상 식 → 함수 노드들 (선언 순) */
  private resolveTargets(expression: Node, depth: number): GraphFunction[] {
    if (depth > MAX_ALIAS_DEPTH) return [];
    const unwrapped = Node.isExpression(expression) ? unwrapExpression(expression) : expression;
    if (!unwrapped) return [];
    if (isFunctionLike(unwrapped)) {
      const fn = this.functions.get(unwrapped);
      return fn ? [fn] : [];
    }
    const symbol = this.resolvedSymbol(unwrapped);
    if (!symbol) return [];
    const targets: GraphFunction[] = [];
    for (const declaration of symbol.getDeclarations()) {
      for (const fn of this.functionsOfDeclaration(declaration, depth + 1)) {
        if (!targets.includes(fn)) targets.push(fn);
      }
    }
    return targets;
  }

  private functionsOfDeclaration(declaration: Node, depth: number): GraphFunction[] {
    if (
      declaration.getSourceFile().isInNodeModules() ||
      declaration.getSourceFile().isFromExternalLibrary()
    ) {
      return [];
    }
    if (isFunctionLike(declaration)) {
      const fn = this.functions.get(declaration);
      return fn ? [fn] : [];
    }
    if (Node.isClassDeclaration(declaration)) {
      return declaration.getConstructors().flatMap((ctor) => {
        const fn = this.functions.get(ctor);
        return fn ? [fn] : [];
      });
    }
    if (Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration)) {
      const initializer = unwrapExpression(declaration.getInitializer());
      if (!initializer) return [];
      if (isFunctionLike(initializer)) {
        const fn = this.functions.get(initializer);
        return fn ? [fn] : [];
      }
      return this.resolveTargets(initializer, depth);
    }
    if (Node.isShorthandPropertyAssignment(declaration)) {
      const valueSymbol = declaration.getValueSymbol();
      if (!valueSymbol) return [];
      return valueSymbol
        .getDeclarations()
        .flatMap((inner) => this.functionsOfDeclaration(inner, depth + 1));
    }
    if (Node.isPropertyDeclaration(declaration)) {
      const initializer = unwrapExpression(declaration.getInitializer());
      if (initializer && isFunctionLike(initializer)) {
        const fn = this.functions.get(initializer);
        return fn ? [fn] : [];
      }
      return this.implementationsOf(declaration, depth);
    }
    if (Node.isPropertySignature(declaration) || Node.isMethodSignature(declaration)) {
      return this.implementationsOf(declaration, depth);
    }
    if (Node.isExportSpecifier(declaration) || Node.isExportAssignment(declaration)) {
      const symbol = declaration.getSymbol();
      const aliased = symbol?.getAliasedSymbol();
      if (!aliased) return [];
      return aliased
        .getDeclarations()
        .flatMap((inner) => this.functionsOfDeclaration(inner, depth + 1));
    }
    return [];
  }

  /** 인터페이스·타입 리터럴 멤버 → 언어 서비스의 구현 찾기로 구현 함수 노드 */
  private implementationsOf(
    member: Node & { getNameNode(): Node },
    depth: number,
  ): GraphFunction[] {
    if (depth > MAX_ALIAS_DEPTH) return [];
    const results: GraphFunction[] = [];
    let implementations: ReturnType<
      ReturnType<Project["getLanguageService"]>["getImplementations"]
    >;
    try {
      implementations = this.project.getLanguageService().getImplementations(member.getNameNode());
    } catch {
      return [];
    }
    for (const implementation of implementations) {
      const node = implementation.getNode();
      const candidate = node.getParent();
      if (!candidate || candidate === member) continue;
      for (const fn of this.functionsOfDeclaration(candidate, depth + 1)) {
        if (!results.includes(fn)) results.push(fn);
      }
    }
    return results.sort((a, b) => compareLocation(a.location, b.location));
  }
}

export function buildCallGraph(loaded: LoadedProject): CallGraph {
  return new CallGraphBuilder(loaded).build();
}
