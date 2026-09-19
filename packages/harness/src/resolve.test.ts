import { describe, expect, it } from "vitest";
import type { JsonValue } from "./dsl";
import {
  deepEqual,
  evaluateCheck,
  evaluateValue,
  lookup,
  renderTemplate,
  resolveBody,
  resolveRequest,
} from "./resolve";

const captures = new Map<string, JsonValue>([
  ["a", { status: 201, body: { id: "x1", stock: 3 } }],
  ["b", { status: 201, body: { id: "x1" } }],
  [
    "burst",
    [
      { status: 201, body: { id: "o1" } },
      { status: 201, body: { id: "o1" } },
      { status: 409, body: { error: { code: "INSUFFICIENT_STOCK" } } },
    ],
  ],
  [
    "obs",
    [
      { status: 200, body: { stock: 3 } },
      { status: 200, body: { stock: 0 } },
    ],
  ],
]);

describe("lookup · 템플릿", () => {
  it("점 경로와 배열 인덱스를 따라간다", () => {
    expect(lookup(captures, "a.body.id")).toBe("x1");
    expect(lookup(captures, "burst.2.body.error.code")).toBe("INSUFFICIENT_STOCK");
    expect(lookup(captures, "a.body.missing")).toBeUndefined();
    expect(lookup(captures, "nope.body")).toBeUndefined();
    expect(lookup(captures, "a.body.id.deeper")).toBeUndefined();
  });

  it("템플릿을 치환하고 풀 수 없는 참조는 빈 문자열이 된다", () => {
    expect(renderTemplate("/orders/{{a.body.id}}/cancel", captures)).toBe("/orders/x1/cancel");
    expect(renderTemplate("/orders/{{ a.body.id }}", captures)).toBe("/orders/x1");
    expect(renderTemplate("/orders/{{missing.id}}", captures)).toBe("/orders/");
  });

  it("본문 안의 $ref와 템플릿을 모두 치환한다", () => {
    expect(
      resolveBody(
        {
          productId: "{{a.body.id}}",
          quantity: { $ref: "a.body.stock" },
          list: [{ $ref: "nope" }],
        },
        captures,
      ),
    ).toEqual({ productId: "x1", quantity: 3, list: [null] });
  });

  it("요청 헤더·경로·본문을 해석하고 rawBody는 그대로 둔다", () => {
    const resolved = resolveRequest(
      {
        method: "POST",
        path: "/orders/{{a.body.id}}",
        headers: { "X-Id": "{{b.body.id}}" },
        body: { q: 1 },
      },
      captures,
    );
    expect(resolved).toEqual({
      method: "POST",
      path: "/orders/x1",
      headers: { "X-Id": "x1" },
      body: { q: 1 },
    });
    expect(
      resolveRequest({ method: "POST", path: "/orders", rawBody: "{bad" }, captures).rawBody,
    ).toBe("{bad");
  });
});

describe("deepEqual", () => {
  it("구조적으로 비교한다", () => {
    expect(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(undefined, null)).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
  });
});

describe("evaluateValue · evaluateCheck", () => {
  it("집계 식은 결정적인 스칼라를 돌려준다", () => {
    expect(
      evaluateValue(
        { $countWhere: { of: "burst", where: { path: "status", equals: 201 } } },
        captures,
      ),
    ).toBe(2);
    expect(
      evaluateValue(
        {
          $distinctCount: { of: "burst", path: "body.id", where: { path: "status", equals: 201 } },
        },
        captures,
      ),
    ).toBe(1);
    expect(evaluateValue({ $distinctCount: { of: "burst", path: "body.id" } }, captures)).toBe(2);
    expect(
      evaluateValue(
        { $allEqual: { of: "burst", path: "body.id", where: { path: "status", equals: 201 } } },
        captures,
      ),
    ).toBe(true);
    expect(evaluateValue({ $allEqual: { of: "burst", path: "body.id" } }, captures)).toBe(false);
    expect(evaluateValue({ $allEqual: { of: "nope", path: "body.id" } }, captures)).toBe(false);
    expect(evaluateValue({ $min: { of: "obs", path: "body.stock" } }, captures)).toBe(0);
    expect(evaluateValue({ $min: { of: "burst", path: "body.stock" } }, captures)).toBeNull();
    expect(evaluateValue({ $sameValue: { refs: ["a.body.id", "b.body.id"] } }, captures)).toBe(
      true,
    );
    expect(evaluateValue({ $sameValue: { refs: ["a.body.id", "a.body.stock"] } }, captures)).toBe(
      false,
    );
    expect(evaluateValue({ $sameValue: { refs: ["a.body.id", "missing.id"] } }, captures)).toBe(
      false,
    );
  });

  it("equals·gte·nonEmptyString 검사를 평가하고 기대·관측값을 남긴다", () => {
    expect(
      evaluateCheck({ name: "s", actual: { $ref: "a.body.stock" }, equals: 3 }, captures),
    ).toEqual({ name: "s", ok: true, expected: 3, actual: 3 });
    expect(
      evaluateCheck({ name: "s", actual: { $ref: "a.body.stock" }, equals: 1 }, captures),
    ).toMatchObject({ ok: false, expected: 1, actual: 3 });
    expect(
      evaluateCheck({ name: "m", actual: { $ref: "a.body.missing" }, equals: 1 }, captures),
    ).toMatchObject({ ok: false, actual: null });
    expect(
      evaluateCheck(
        { name: "g", actual: { $min: { of: "obs", path: "body.stock" } }, gte: 0 },
        captures,
      ),
    ).toMatchObject({ ok: true, expected: ">= 0", actual: 0 });
    expect(
      evaluateCheck({ name: "g", actual: { $ref: "a.body.id" }, gte: 0 }, captures),
    ).toMatchObject({ ok: false });
    // 통과한 nonEmptyString 검사는 원문(무작위 id) 대신 기대값 문구를 남긴다 (결정성)
    expect(
      evaluateCheck({ name: "n", actual: { $ref: "a.body.id" }, nonEmptyString: true }, captures),
    ).toEqual({ name: "n", ok: true, expected: "non-empty string", actual: "non-empty string" });
    expect(
      evaluateCheck(
        { name: "n", actual: { $ref: "a.body.stock" }, nonEmptyString: true },
        captures,
      ),
    ).toMatchObject({ ok: false, actual: 3 });
  });
});
