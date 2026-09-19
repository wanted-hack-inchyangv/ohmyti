/**
 * 연산자별 단위 테스트 (TICKET.md T-402 인수 기준 6). 코드 조각 픽스처마다 위치 탐색·변형·사전 검사를 확인한다.
 */
import { describe, expect, it } from "vitest";
import { isTestPath } from "./ast";
import { applyMutation, applyMutations, type MutationApplyResult } from "./apply";
import { findMutation, type MutationDefinition } from "./catalog";
import { applyTextEdits, unifiedDiff } from "./text";
import { memoryFiles, ROUTER_DECL } from "./test-support";

const TIMEOUT = 30_000;

/** `src/app.ts`에 라우트를 두고 `src/logic.ts`에 대상 코드를 둔 픽스처 */
function fixture(routes: string, logic: string, extra: Record<string, string> = {}) {
  return memoryFiles({
    "src/app.ts": `${ROUTER_DECL}import * as logic from "./logic";\n${routes}\n`,
    "src/logic.ts": logic,
    ...extra,
  });
}

const CREATE_ROUTE = `app.post("/orders", (req) => logic.createOrder(req.body, req.headers));`;
const CANCEL_ROUTE = `app.post("/orders/:id/cancel", (req) => logic.cancelOrder(req.params.id));`;

async function apply(
  mutationId: string,
  files: ReturnType<typeof fixture>,
): Promise<MutationApplyResult> {
  return applyMutation({ files, mutationId });
}

function changes(result: MutationApplyResult): string[] {
  return (result.diff ?? "").split("\n").filter((line) => /^[-+][^-+]/.test(line));
}

describe("M-01 재고 부족 검사 제거", () => {
  it(
    "수량 > 재고 보호 if를 통째로 지운다",
    async () => {
      const logic = [
        "export function createOrder(body: { qty: number; sku: string }, _h: unknown) {",
        "  const inventory = stockOf(body.sku);",
        '  if (body.qty > inventory) throw new Error("INSUFFICIENT_STOCK");',
        "  return { ok: true };",
        "}",
        "function stockOf(_sku: string): number {",
        "  return 3;",
        "}",
        "",
      ].join("\n");
      const r = await apply("M-01", fixture(CREATE_ROUTE, logic));
      expect(r.status).toBe("APPLIED");
      expect(changes(r)).toEqual([
        '-  if (body.qty > inventory) throw new Error("INSUFFICIENT_STOCK");',
      ]);
      expect(r.target).toEqual({ path: "src/logic.ts", startLine: 3, endLine: 3 });
    },
    TIMEOUT,
  );

  it(
    "재고 < 수량 (순서 반대)도 찾고, else가 있으면 조건만 false로 바꾼다",
    async () => {
      const logic = [
        "export function createOrder(body: { quantity: number }, _h: unknown) {",
        "  const stockLeft = 2;",
        "  if (stockLeft < body.quantity) {",
        '    return { error: "INSUFFICIENT_STOCK" };',
        "  } else {",
        "    return { ok: true };",
        "  }",
        "}",
        "",
      ].join("\n");
      const r = await apply("M-01", fixture(CREATE_ROUTE, logic));
      expect(r.status).toBe("APPLIED");
      expect(changes(r)).toEqual(["-  if (stockLeft < body.quantity) {", "+  if (false) {"]);
    },
    TIMEOUT,
  );

  it(
    "보호 if가 아닌 비교나 핸들러에서 닿지 않는 함수는 대상이 아니다",
    async () => {
      const logic = [
        "export function createOrder(body: { quantity: number }, _h: unknown) {",
        "  const enough = body.quantity <= 5;",
        "  return { enough };",
        "}",
        "export function unused(body: { quantity: number }, stock: number) {",
        '  if (body.quantity > stock) throw new Error("x");',
        "}",
        "",
      ].join("\n");
      const r = await apply("M-01", fixture(CREATE_ROUTE, logic));
      expect(r.status).toBe("NOT_APPLICABLE");
      expect(r.reason).toBe("대상 로직 없음");
    },
    TIMEOUT,
  );
});

describe("M-02 수량 경계 완화", () => {
  it.each([
    ["qty < 1", "qty < 0"],
    ["quantity <= 0", "quantity < 0"],
    ["0 >= body.count", "0 > body.count"],
    ["1 > amount", "0 > amount"],
  ])(
    "`%s` → `%s`",
    async (from, to) => {
      const logic = [
        "export function createOrder(body: { count: number }, _h: unknown) {",
        "  const qty = body.count, quantity = qty, amount = qty;",
        `  if (${from}) throw new Error("VALIDATION_ERROR");`,
        "  return { qty, quantity, amount };",
        "}",
        "",
      ].join("\n");
      const r = await apply("M-02", fixture(CREATE_ROUTE, logic));
      expect(r.status).toBe("APPLIED");
      expect(changes(r)).toEqual([
        `-  if (${from}) throw new Error("VALIDATION_ERROR");`,
        `+  if (${to}) throw new Error("VALIDATION_ERROR");`,
      ]);
    },
    TIMEOUT,
  );

  it(
    "수량 계열이 아닌 경계 비교(`retries <= 0`)는 대상이 아니다",
    async () => {
      const logic = [
        "export function createOrder(body: { retries: number }, _h: unknown) {",
        '  if (body.retries <= 0) throw new Error("x");',
        "  return body;",
        "}",
        "",
      ].join("\n");
      const r = await apply("M-02", fixture(CREATE_ROUTE, logic));
      expect(r.status).toBe("NOT_APPLICABLE");
      expect(r.reasonCode).toBe("NO_TARGET");
    },
    TIMEOUT,
  );
});

describe("M-03 멱등 키 조회 건너뜀", () => {
  it(
    "`await store.get(key)`는 await까지 undefined로, `.has(key)`는 false로 바꾼다",
    async () => {
      const getLogic = [
        "const idempotencyStore = new Map<string, { id: string }>();",
        "export async function createOrder(_b: unknown, h: { key: string }) {",
        "  const cached = await idempotencyStore.get(h.key);",
        "  if (cached) return cached;",
        "  return { id: 'new' };",
        "}",
        "",
      ].join("\n");
      const get = await apply("M-03", fixture(CREATE_ROUTE, getLogic));
      expect(get.status).toBe("APPLIED");
      expect(changes(get)).toEqual([
        "-  const cached = await idempotencyStore.get(h.key);",
        "+  const cached = undefined;",
      ]);

      const hasLogic = [
        "const seenIdempotencyKeys = new Set<string>();",
        "export function createOrder(_b: unknown, h: { key: string }) {",
        "  if (seenIdempotencyKeys.has(h.key)) return { replay: true };",
        "  seenIdempotencyKeys.add(h.key);",
        "  return { replay: false };",
        "}",
        "",
      ].join("\n");
      const has = await apply("M-03", fixture(CREATE_ROUTE, hasLogic));
      expect(has.status).toBe("APPLIED");
      expect(changes(has)).toEqual([
        "-  if (seenIdempotencyKeys.has(h.key)) return { replay: true };",
        "+  if (false) return { replay: true };",
      ]);
    },
    TIMEOUT,
  );

  it(
    "멱등성과 무관한 조회나 결과를 버리는 호출은 대상이 아니다",
    async () => {
      const logic = [
        "const orders = new Map<string, { id: string }>();",
        "const idempotencyLog = new Map<string, number>();",
        "export function createOrder(_b: unknown, h: { key: string }) {",
        "  idempotencyLog.get(h.key);",
        "  return orders.get(h.key) ?? { id: 'new' };",
        "}",
        "",
      ].join("\n");
      const r = await apply("M-03", fixture(CREATE_ROUTE, logic));
      expect(r.status).toBe("NOT_APPLICABLE");
      expect(r.reason).toBe("대상 로직 없음");
    },
    TIMEOUT,
  );
});

describe("M-04 같은 키의 본문 비교 건너뜀", () => {
  it(
    "저장된 기록의 속성과 비교하는 `===`는 true로, `!==`는 false로 바꾼다",
    async () => {
      const logic = [
        "const idempotencyRecords = new Map<string, { bodyHash: string; id: string }>();",
        "export function createOrder(b: { hash: string }, h: { key: string }) {",
        "  const prev = idempotencyRecords.get(h.key);",
        "  if (prev && prev.bodyHash === b.hash) return prev;",
        "  if (prev) throw new Error('IDEMPOTENCY_CONFLICT');",
        "  return { id: 'new' };",
        "}",
        "",
      ].join("\n");
      const r = await apply("M-04", fixture(CREATE_ROUTE, logic));
      expect(r.status).toBe("APPLIED");
      expect(changes(r)).toEqual([
        "-  if (prev && prev.bodyHash === b.hash) return prev;",
        "+  if (prev && true) return prev;",
      ]);
    },
    TIMEOUT,
  );

  it(
    '조회 결과가 아닌 값의 비교(`order.status === "CANCELLED"`, 두 지역 변수)는 대상이 아니다',
    async () => {
      const logic = [
        "export function createOrder(b: { hash: string; status: string }, _h: unknown) {",
        "  const expected = 'x';",
        "  if (b.status === 'CANCELLED') throw new Error('x');",
        "  if (b.hash !== expected) throw new Error('y');",
        "  return b;",
        "}",
        "",
      ].join("\n");
      const r = await apply("M-04", fixture(CREATE_ROUTE, logic));
      expect(r.status).toBe("NOT_APPLICABLE");
      expect(r.reason).toBe("대상 로직 없음");
    },
    TIMEOUT,
  );
});

describe("M-05 취소 시 재고 복구 제거", () => {
  it.each([
    ["restoreStock(order.sku, order.qty);", "restoreStock"],
    ["inventory[order.sku] += order.qty;", "+="],
    ["release(ledger, order.sku, order.qty);", "수량 인자가 있는 release"],
  ])(
    "`%s` (%s) 문장을 지운다",
    async (statement) => {
      const logic = [
        "const inventory: Record<string, number> = {};",
        "const ledger: number[] = [];",
        "function restoreStock(_sku: string, _qty: number) {}",
        "function release(_l: number[], _sku: string, _qty: number) {}",
        "const lock = { release() {} };",
        "export function cancelOrder(_id: string) {",
        "  const order = { sku: 'p1', qty: 1 };",
        "  lock.release();",
        `  ${statement}`,
        "  return order;",
        "}",
        "",
      ].join("\n");
      const r = await apply("M-05", fixture(CANCEL_ROUTE, logic));
      expect(r.status).toBe("APPLIED");
      expect(changes(r)).toEqual([`-  ${statement}`]);
      expect(r.changedLines).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "블록이 아닌 자리의 문장은 빈 블록으로 바꾸고, 잠금 해제(`lock.release()`)는 대상이 아니다",
    async () => {
      const nested = [
        "function restock(_qty: number) {}",
        "export function cancelOrder(id: string) {",
        "  const qty = id.length;",
        "  if (qty > 0) restock(qty);",
        "  return id;",
        "}",
        "",
      ].join("\n");
      const r = await apply("M-05", fixture(CANCEL_ROUTE, nested));
      expect(changes(r)).toEqual(["-  if (qty > 0) restock(qty);", "+  if (qty > 0) {}"]);

      const lockOnly = [
        "const lock = { release() {} };",
        "export function cancelOrder(id: string) {",
        "  lock.release();",
        "  return id;",
        "}",
        "",
      ].join("\n");
      const none = await apply("M-05", fixture(CANCEL_ROUTE, lockOnly));
      expect(none.status).toBe("NOT_APPLICABLE");
    },
    TIMEOUT,
  );

  it(
    "취소 라우트가 아닌 경로의 재고 증가는 대상이 아니다",
    async () => {
      const logic = [
        "function restoreStock(_sku: string, _qty: number) {}",
        "export function createOrder(_b: unknown, _h: unknown) {",
        "  restoreStock('p1', 1);",
        "}",
        "export function cancelOrder(id: string) {",
        "  return id;",
        "}",
        "",
      ].join("\n");
      const r = await apply("M-05", fixture(`${CREATE_ROUTE}\n${CANCEL_ROUTE}`, logic));
      expect(r.status).toBe("NOT_APPLICABLE");
    },
    TIMEOUT,
  );
});

describe("사전 검사와 상한", () => {
  const m02 = findMutation("M-02")!;
  const logic = [
    "export function createOrder(body: { quantity: number }, _h: unknown) {",
    '  if (body.quantity <= 0) throw new Error("VALIDATION_ERROR");',
    "  return body;",
    "}",
    "",
  ].join("\n");

  it(
    "변형이 타입 오류를 만들면 BUILD_FAIL이고 새 오류만 보고한다",
    async () => {
      const broken: MutationDefinition = {
        ...m02,
        id: "X-BUILD",
        transform: (target) => [
          { start: target.getStart(), end: target.getEnd(), text: "undefinedName123 < 0" },
        ],
      };
      const [r] = await applyMutations({
        files: fixture(CREATE_ROUTE, logic),
        catalog: [broken],
      });
      expect(r!.status).toBe("BUILD_FAIL");
      expect(r!.reason).toBe("변형 후 타입 검사 실패");
      expect(r!.buildErrors).toHaveLength(1);
      expect(r!.buildErrors[0]).toMatch(/^src\/logic\.ts: TS2304 .*undefinedName123/);
      // diff와 digest는 남긴다 (실험 기록용)
      expect(r!.patchDigest).toMatch(/^[0-9a-f]{64}$/);
    },
    TIMEOUT,
  );

  it(
    "diff가 비면 NOT_APPLICABLE(EMPTY_DIFF)",
    async () => {
      const noop: MutationDefinition = { ...m02, id: "X-NOOP", transform: () => [] };
      const [r] = await applyMutations({ files: fixture(CREATE_ROUTE, logic), catalog: [noop] });
      expect(r!.status).toBe("NOT_APPLICABLE");
      expect(r!.reasonCode).toBe("EMPTY_DIFF");
      expect(r!.diff).toBeNull();
    },
    TIMEOUT,
  );

  it(
    "evaluation당 5개를 넘는 요청은 OVER_LIMIT, 카탈로그에 없는 id는 UNKNOWN_MUTATION",
    async () => {
      const results = await applyMutations({
        files: fixture(CREATE_ROUTE, logic),
        mutationIds: ["M-01", "M-02", "M-03", "M-04", "M-05", "M-02", "M-99"],
      });
      expect(results.map((r) => r.reasonCode)).toEqual([
        "NO_TARGET",
        null,
        "NO_TARGET",
        "NO_TARGET",
        "NO_TARGET",
        "OVER_LIMIT",
        "UNKNOWN_MUTATION",
      ]);
      expect(results[1]!.status).toBe("APPLIED");
    },
    TIMEOUT,
  );

  it(
    "테스트 파일 안의 같은 코드는 찾지 않는다",
    async () => {
      const files = memoryFiles({
        "src/app.ts": `${ROUTER_DECL}import { createOrder } from "../test/logic.test";\n${CREATE_ROUTE.replace("logic.createOrder", "createOrder")}\n`,
        "test/logic.test.ts": logic,
      });
      const r = await applyMutation({ files, mutationId: "M-02" });
      expect(r.status).toBe("NOT_APPLICABLE");
    },
    TIMEOUT,
  );
});

describe("텍스트 도구", () => {
  it("isTestPath", () => {
    for (const p of [
      "a.test.ts",
      "src/x.spec.tsx",
      "__tests__/a.ts",
      "test/h.ts",
      "spec/b.ts",
      "src/tests/c.ts",
    ]) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ["src/app.ts", "src/testing.ts", "src/contest/a.ts"]) {
      expect(isTestPath(p), p).toBe(false);
    }
  });

  it("unifiedDiff는 앞뒤 3줄 문맥의 한 덩어리를 만들고 변경 줄 수를 센다", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n") + "\n";
    const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n") + "\n";
    const diff = unifiedDiff("src/x.ts", before, after);
    expect(diff.changedLines).toBe(2);
    expect(diff.text).toBe(
      "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -2,7 +2,7 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n",
    );
    expect(unifiedDiff("src/x.ts", before, before).text).toBe("");
    const removed = unifiedDiff("src/x.ts", "a\nb\nc\n", "a\nc\n");
    expect(removed.text).toBe("--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,3 +1,2 @@\n a\n-b\n c\n");
  });

  it("applyTextEdits는 겹치는 편집을 거부한다", () => {
    expect(
      applyTextEdits("abcdef", [
        { start: 1, end: 2, text: "X" },
        { start: 4, end: 6, text: "" },
      ]),
    ).toBe("aXcd");
    expect(() =>
      applyTextEdits("abcdef", [
        { start: 1, end: 4, text: "" },
        { start: 3, end: 5, text: "" },
      ]),
    ).toThrow();
  });
});
