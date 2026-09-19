/**
 * 인라인 핸들러 구조의 mutation 위치 탐색 (TICKET.md T-602). 로직이 라우트 핸들러 안에 있고, 멱등 기록을 배열 순회로 찾고,
 * 취소 시 재고를 `x.stock = x.stock + q` 대입으로 되돌리는 제출물에서도 M-03·M-05를 찾아야 한다.
 * 변형 검증(하네스에서 대상 기준이 FAIL로 바뀌는지)은 워커의 TEST_EFFECTIVENESS 통합 테스트가 같은 픽스처로 본다.
 */
import { FakeLlmClient } from "@ohmyti/llm";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMutations, type MutationApplyResult } from "./apply";
import { isIdempotencyKeyExpression } from "./catalog";
import {
  memoryFiles,
  readTree,
  REPO_ROOT,
  ROUTER_DECL,
  TEMPLATE_NODE_MODULES,
} from "./test-support";

const TIMEOUT = 60_000;
const INLINE_FIXTURE_DIR = path.join(REPO_ROOT, "packages/analysis/fixtures/inline-order-api");

function byId(results: MutationApplyResult[]): Record<string, MutationApplyResult> {
  return Object.fromEntries(results.map((r) => [r.mutationId, r]));
}

/** `diff`의 바뀐 줄만 (`-`·`+`로 시작하는 본문 줄) */
function changedLines(result: MutationApplyResult): string[] {
  return (result.diff ?? "").split("\n").filter((line) => /^[-+](?![-+]{2} )/.test(line));
}

/** 한 파일짜리 코드 조각. 라우트 핸들러 본문에 `body`를 인라인으로 둔다 */
function inlineRoute(
  route: string,
  body: string[],
  prelude: string[] = [],
): Record<string, string> {
  return {
    "src/app.ts": [
      ROUTER_DECL,
      ...prelude,
      `app.post("${route}", async (req) => {`,
      ...body.map((line) => `  ${line}`),
      "});",
      "",
    ].join("\n"),
  };
}

const IDEM_PRELUDE = [
  "const records: Array<{ key: string; id: string }> = [];",
  "const items: Array<{ id: string; stock: number }> = [];",
];

describe("인라인 픽스처 (packages/analysis/fixtures/inline-order-api)", () => {
  let results: MutationApplyResult[];
  beforeAll(async () => {
    results = await applyMutations({
      files: memoryFiles(await readTree(INLINE_FIXTURE_DIR)),
      nodeModulesDir: TEMPLATE_NODE_MODULES,
    });
  }, TIMEOUT);

  it("M-01~M-05가 모두 AST 휴리스틱으로 적용되고 타입 오류가 없다", () => {
    for (const r of results) {
      expect(r.status, `${r.mutationId}: ${r.reason} ${r.detail}`).toBe("APPLIED");
      expect(r.locatedBy).toBe("heuristic");
      expect(r.buildErrors).toEqual([]);
      expect(r.target?.path).toBe("src/index.ts");
    }
  });

  it("M-03: 배열 순회 조회의 키 비교를 false로 바꾼다 (헤더 → 변수 2단계 추적, 이름에 idem 없음)", () => {
    expect(changedLines(byId(results)["M-03"]!)).toEqual([
      "-      if (rec.key === k) {",
      "+      if (false) {",
    ]);
  });

  it("M-04: 반복문 조회에서 대입된 기록의 본문 비교를 찾는다", () => {
    expect(changedLines(byId(results)["M-04"]!)).toEqual([
      "-      if (prior.fingerprint === fingerprint) return res.status(201).json(prior.response);",
      "+      if (true) return res.status(201).json(prior.response);",
    ]);
  });

  it("M-05: `x.stock = x.stock + q` 대입 문장을 지운다", () => {
    expect(changedLines(byId(results)["M-05"]!)).toEqual([
      "-      target.stock = target.stock + order.quantity;",
    ]);
  });

  it("상품 조회 반복문과 재고 차감 대입은 대상이 아니다", () => {
    const all = results.flatMap(changedLines).join("\n");
    expect(all).not.toContain("items[i].id === pid");
    expect(all).not.toContain("it.id === order.productId");
    expect(all).not.toContain("item.stock = item.stock - qty");
  });
});

describe("M-03 조회 형태 확장", () => {
  async function m03(files: Record<string, string>): Promise<MutationApplyResult> {
    const [result] = await applyMutations({ files: memoryFiles(files), mutationIds: ["M-03"] });
    return result!;
  }

  it(
    ".find()·.findIndex()·.some()·.filter() 콜백의 키 비교는 기록 없음 값으로 바뀐다",
    async () => {
      const cases: Array<[string, string]> = [
        ["const hit = records.find((r) => r.key === key);", "const hit = undefined;"],
        ["const at = records.findIndex((r) => r.key === key);", "const at = -1;"],
        ["const hit = records.some((r) => key === r.key);", "const hit = false;"],
        [
          "const hits = records.filter(function (r) { return r.key === key; });",
          "const hits = [];",
        ],
      ];
      for (const [line, expected] of cases) {
        const result = await m03(
          inlineRoute(
            "/orders",
            [
              'const raw = req.header("Idempotency-Key");',
              "const key = String(raw);",
              line,
              "return hit ?? at ?? hits;",
            ],
            [...IDEM_PRELUDE, "declare const hit: unknown, at: unknown, hits: unknown;"],
          ),
        );
        expect(result.status, line).toBe("APPLIED");
        expect(changedLines(result), line).toEqual([`-  ${line}`, `+  ${expected}`]);
      }
    },
    TIMEOUT,
  );

  it(
    "멱등 저장소 이름의 배열이면 키 이름 비교만으로도 찾는다 (키가 함수 인자)",
    async () => {
      const result = await m03({
        "src/app.ts": [
          ROUTER_DECL,
          "const idemStore: Array<{ key: string }> = [];",
          "function lookup(key: string) {",
          "  return idemStore.find((r) => r.key === key);",
          "}",
          'app.post("/orders", (req) => lookup(req.body.k));',
          "",
        ].join("\n"),
      });
      expect(result.status).toBe("APPLIED");
      expect(changedLines(result)).toEqual([
        "-  return idemStore.find((r) => r.key === key);",
        "+  return undefined;",
      ]);
    },
    TIMEOUT,
  );

  it(
    'for 문(인덱스)과 req.headers["idempotency-key"]도 찾는다',
    async () => {
      const result = await m03(
        inlineRoute(
          "/orders",
          [
            'const key = req.headers["idempotency-key"];',
            "let found: unknown = null;",
            "for (let i = 0; i < records.length; i++) {",
            "  if (records[i]!.key === key) found = records[i];",
            "}",
            "return found;",
          ],
          IDEM_PRELUDE,
        ),
      );
      expect(result.status).toBe("APPLIED");
      expect(changedLines(result)).toEqual([
        "-    if (records[i]!.key === key) found = records[i];",
        "+    if (false) found = records[i];",
      ]);
    },
    TIMEOUT,
  );

  it(
    "멱등 키와 무관한 반복문·배열 조회, 대입이 없는 비교는 후보가 아니다",
    async () => {
      const result = await m03(
        inlineRoute(
          "/orders",
          [
            'const key = req.header("Idempotency-Key");',
            "const pid = req.body.productId;",
            "let item: unknown = null;",
            "for (let i = 0; i < items.length; i++) {",
            "  if (items[i]!.id === pid) item = items[i];",
            "}",
            "const other = items.find((it) => it.id === pid);",
            "let count = 0;",
            "for (const r of records) {",
            "  if (r.key === key) console.log(count);",
            "}",
            "for (const r of records) {",
            "  if (r.key !== key) count = count + 1;",
            "}",
            "return [item, other, count];",
          ],
          IDEM_PRELUDE,
        ),
      );
      expect(result.status).toBe("NOT_APPLICABLE");
      expect(result.detail).toBe("AST 휴리스틱 후보 없음, LLM 탐색 미사용");
    },
    TIMEOUT,
  );

  it("멱등 키 식 판별: 헤더 읽기 형태와 변수 추적 깊이", async () => {
    const { Project } = await import("ts-morph");
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile(
      "a.ts",
      [
        "declare const req: any; declare const c: any;",
        'const a = req.header("Idempotency-Key");',
        'const b = c.req.header("idempotency-key");',
        'const d = req.get("Idempotency-Key");',
        "const e1 = a; const e2 = e1;",
        'const f = req.header("X-Request-Id");',
        "const idemKey = f;",
      ].join("\n"),
    );
    const init = (name: string) => file.getVariableDeclarationOrThrow(name).getInitializerOrThrow();
    const ident = (name: string) => file.getVariableDeclarationOrThrow(name).getNameNode();
    expect(isIdempotencyKeyExpression(init("a"))).toBe(true);
    expect(isIdempotencyKeyExpression(init("b"))).toBe(true);
    expect(isIdempotencyKeyExpression(init("d"))).toBe(true);
    expect(isIdempotencyKeyExpression(init("f"))).toBe(false);
    // e1 → a → 헤더 읽기: 변수 2단계. e2는 3단계라 추적하지 않는다
    expect(isIdempotencyKeyExpression(ident("e1"))).toBe(true);
    expect(isIdempotencyKeyExpression(ident("e2"))).toBe(false);
    // 이름 보조 패턴
    expect(isIdempotencyKeyExpression(ident("idemKey"))).toBe(true);
  });
});

describe("M-05 대입 형태 확장", () => {
  async function m05(lines: string[]): Promise<MutationApplyResult> {
    const [result] = await applyMutations({
      files: memoryFiles(
        inlineRoute("/orders/:id/cancel", lines, [
          "const item = { stock: 1 };",
          "const order = { quantity: 1 };",
        ]),
      ),
      mutationIds: ["M-05"],
    });
    return result!;
  }

  it(
    "`X.stock = X.stock + q`와 `X.stock = q + X.stock`은 지운다",
    async () => {
      for (const line of [
        "item.stock = item.stock + order.quantity;",
        "item.stock = order.quantity + item.stock;",
        "item.stock = (item . stock) + order.quantity;",
      ]) {
        const result = await m05([line, "return item;"]);
        expect(result.status, line).toBe("APPLIED");
        expect(changedLines(result), line).toEqual([`-  ${line}`]);
      }
    },
    TIMEOUT,
  );

  it(
    "재고 차감, 다른 대상에 더하기, 재고 아닌 대상의 자기 더하기는 후보가 아니다",
    async () => {
      const result = await m05([
        "item.stock = item.stock - order.quantity;",
        "item.stock = order.quantity + 1;",
        "let total = 0;",
        "total = total + order.quantity;",
        "return [item, total];",
      ]);
      expect(result.status).toBe("NOT_APPLICABLE");
      expect(result.reasonCode).toBe("NO_TARGET");
    },
    TIMEOUT,
  );
});

describe("LLM 후보 거절 코드가 NOT_APPLICABLE 사유에 들어간다", () => {
  it(
    "재고 차감 문장을 가리킨 M-05 후보는 NOT_RESTOCK, 받지 않는 종류는 WRONG_NODE_KIND",
    async () => {
      const files = inlineRoute(
        "/orders/:id/cancel",
        ["item.stock = item.stock - order.quantity;", "return item;"],
        ["const item = { stock: 1 };", "const order = { quantity: 1 };"],
      );
      const line = files["src/app.ts"]!.split("\n").findIndex((l) => l.includes("- order")) + 1;
      const llm = new FakeLlmClient({
        responses: {
          MUTATION_TARGETS: {
            output: {
              candidates: [
                { file: "src/app.ts", line, nodeKind: "ExpressionStatement", reason: "차감" },
                { file: "src/app.ts", line, nodeKind: "BinaryExpression", reason: "종류" },
              ],
            },
          },
        },
      });
      const [result] = await applyMutations({
        files: memoryFiles(files),
        mutationIds: ["M-05"],
        llm,
      });
      expect(result!.status).toBe("NOT_APPLICABLE");
      expect(result!.discardedCandidates.map((d) => d.code)).toEqual([
        "NOT_RESTOCK",
        "WRONG_NODE_KIND",
      ]);
      expect(result!.detail).toBe(
        "AST 휴리스틱 후보 없음, LLM 후보 2개 모두 검증 실패 (거절 코드: NOT_RESTOCK, WRONG_NODE_KIND)",
      );
    },
    TIMEOUT,
  );

  it(
    "LLM이 반복문을 가리키면 안의 멱등 키 비교를 대상으로 쓰고, 상품 조회 반복문은 NAME_MISMATCH로 버린다",
    async () => {
      const files = inlineRoute(
        "/orders",
        [
          "const dedupKey = req.body.k;",
          "let item: unknown = null;",
          "for (const it of items) {",
          "  if (it.id === req.body.productId) item = it;",
          "}",
          "let prev: unknown = null;",
          "for (const r of records) {",
          "  if (r.id === dedupKey) prev = r;",
          "}",
          "return [item, prev];",
        ],
        IDEM_PRELUDE,
      );
      const lines = files["src/app.ts"]!.split("\n");
      const loopLines = lines.flatMap((l, i) => (l.includes("for (const") ? [i + 1] : []));
      const llm = new FakeLlmClient({
        responses: {
          MUTATION_TARGETS: {
            output: {
              candidates: loopLines.map((line) => ({
                file: "src/app.ts",
                line,
                nodeKind: "ForOfStatement",
                reason: "조회 반복문",
              })),
            },
          },
        },
      });
      const [result] = await applyMutations({
        files: memoryFiles(files),
        mutationIds: ["M-03"],
        llm,
      });
      expect(result!.status).toBe("APPLIED");
      expect(result!.locatedBy).toBe("llm");
      expect(result!.discardedCandidates.map((d) => d.code)).toEqual(["NAME_MISMATCH"]);
      expect(changedLines(result!)).toEqual([
        "-    if (r.id === dedupKey) prev = r;",
        "+    if (false) prev = r;",
      ]);
    },
    TIMEOUT,
  );
});
