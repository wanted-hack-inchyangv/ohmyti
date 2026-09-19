import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ORDER_API_V1_CASES, getCaseSet } from "./cases";
import { collectCheckNames, defineCase, type CaseDefinition } from "./dsl";
import {
  CASE_HASH_LENGTH,
  HARNESS_PACKAGE_VERSION,
  canonicalJson,
  caseSetDigest,
  harnessVersionOf,
} from "./version";

const here = path.dirname(fileURLToPath(import.meta.url));

const minimal: CaseDefinition = {
  id: "c1",
  title: "t",
  criterionIds: ["R-01"],
  steps: [{ kind: "request", capture: "a", request: { method: "GET", path: "/health" } }],
  expect: [{ name: "a.status", actual: { $ref: "a.status" }, equals: 200 }],
};

describe("defineCase", () => {
  it("유효한 정의를 그대로 돌려준다", () => {
    expect(defineCase(minimal)).toEqual(minimal);
  });

  it("criterionIds가 비면 거부한다", () => {
    expect(() => defineCase({ ...minimal, criterionIds: [] })).toThrow();
  });

  it("body와 rawBody를 함께 쓰면 거부한다", () => {
    expect(() =>
      defineCase({
        ...minimal,
        steps: [
          {
            kind: "request",
            capture: "a",
            request: { method: "POST", path: "/x", body: {}, rawBody: "x" },
          },
        ],
      }),
    ).toThrow();
  });

  it("검사는 비교 방식을 정확히 하나만 가진다", () => {
    expect(() =>
      defineCase({ ...minimal, expect: [{ name: "x", actual: { $ref: "a" }, equals: 1, gte: 0 }] }),
    ).toThrow();
    expect(() =>
      defineCase({ ...minimal, expect: [{ name: "x", actual: { $ref: "a" } }] }),
    ).toThrow();
  });

  it("parallel은 requests와 forEach 중 하나만 지정한다", () => {
    expect(() => defineCase({ ...minimal, steps: [{ kind: "parallel", capture: "p" }] })).toThrow(
      /requests와 forEach/,
    );
    expect(() =>
      defineCase({
        ...minimal,
        steps: [
          {
            kind: "parallel",
            capture: "p",
            requests: [{ method: "GET", path: "/x" }],
            forEach: { of: "a", request: { method: "GET", path: "/y" } },
          },
        ],
      }),
    ).toThrow(/requests와 forEach/);
  });

  it("검사 이름이 중복되면 거부한다 (스텝 축약형 포함)", () => {
    expect(() =>
      defineCase({
        ...minimal,
        steps: [...minimal.steps, { kind: "assertResponse", of: "a", expect: { status: 200 } }],
      }),
    ).toThrow(/검사 이름이 중복/);
  });

  it("collectCheckNames가 스텝 축약형의 이름을 만든다", () => {
    const names = collectCheckNames({
      ...minimal,
      steps: [
        ...minimal.steps,
        {
          kind: "assertResponse",
          of: "a",
          label: "h",
          expect: { status: 200, body: { "error.code": "X" }, nonEmptyStrings: ["id"] },
        },
        { kind: "observeState", capture: "p1", path: "/products/p1", expect: { stock: 2 } },
      ],
    });
    expect(names).toEqual(["h.status", "h.body.error.code", "h.body.id", "p1.stock", "a.status"]);
  });
});

describe("order-api-v1 케이스 집합", () => {
  it("10개 케이스가 R-01~R-10을 각각 참조하고 ID가 유일하다", () => {
    expect(ORDER_API_V1_CASES).toHaveLength(10);
    expect(new Set(ORDER_API_V1_CASES.map((c) => c.id)).size).toBe(10);
    expect(ORDER_API_V1_CASES.flatMap((c) => c.criterionIds).sort()).toEqual([
      "R-01",
      "R-02",
      "R-03",
      "R-04",
      "R-05",
      "R-06",
      "R-07",
      "R-08",
      "R-09",
      "R-10",
    ]);
  });

  it("JSON으로 왕복해도 같다 (함수 없는 선언형)", () => {
    expect(JSON.parse(JSON.stringify(ORDER_API_V1_CASES))).toEqual(ORDER_API_V1_CASES);
  });

  it("R-05는 같은 키·같은 본문을 두 번 보내고 재고를 관측한다", () => {
    const r05 = ORDER_API_V1_CASES.find((c) => c.id === "R-05-idempotent-resend")!;
    const posts = r05.steps.filter((s) => s.kind === "request" && s.request.method === "POST");
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(posts[0])).toContain('"r05-k1"');
    expect(JSON.stringify((posts[0] as { request: unknown }).request)).toBe(
      JSON.stringify((posts[1] as { request: unknown }).request),
    );
    expect(r05.steps.some((s) => s.kind === "observeState" && s.path === "/products/p1")).toBe(
      true,
    );
  });

  it("R-07은 같은 키 10건, R-08은 서로 다른 키 10건을 동시에 보낸다", () => {
    const r07 = ORDER_API_V1_CASES.find((c) => c.id === "R-07-same-key-concurrent")!;
    const r08 = ORDER_API_V1_CASES.find((c) => c.id === "R-08-distinct-keys-concurrent")!;
    const keysOf = (c: CaseDefinition) =>
      c.steps
        .filter((s) => s.kind === "parallel" && s.requests)
        .flatMap((s) => (s as { requests: Array<{ headers?: Record<string, string> }> }).requests)
        .map((r) => r.headers?.["Idempotency-Key"]);
    expect(keysOf(r07)).toHaveLength(10);
    expect(new Set(keysOf(r07)).size).toBe(1);
    expect(keysOf(r08)).toHaveLength(10);
    expect(new Set(keysOf(r08)).size).toBe(10);
  });

  it("getCaseSet은 알 수 없는 이름을 거부한다", () => {
    expect(getCaseSet("order-api-v1")).toBe(ORDER_API_V1_CASES);
    expect(() => getCaseSet("nope")).toThrow(/알 수 없는 케이스 집합/);
  });
});

describe("harnessVersion", () => {
  it("패키지 버전 상수가 package.json과 같다", () => {
    const pkg = JSON.parse(readFileSync(path.join(here, "../package.json"), "utf8")) as {
      version: string;
    };
    expect(HARNESS_PACKAGE_VERSION).toBe(pkg.version);
  });

  it("정규 직렬화는 키 순서에 영향을 받지 않는다", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it("같은 케이스는 같은 버전, 케이스가 바뀌면 다른 버전이다", () => {
    const v1 = harnessVersionOf(ORDER_API_V1_CASES);
    expect(v1).toBe(
      harnessVersionOf(JSON.parse(JSON.stringify(ORDER_API_V1_CASES)) as CaseDefinition[]),
    );
    expect(v1).toMatch(
      new RegExp(
        `^${HARNESS_PACKAGE_VERSION.replace(/\./g, "\\.")}\\+[0-9a-f]{${CASE_HASH_LENGTH}}$`,
      ),
    );
    const changed = ORDER_API_V1_CASES.map((c) =>
      c.id === "R-01-normal-order" ? { ...c, title: "x" } : c,
    );
    expect(harnessVersionOf(changed)).not.toBe(v1);
    expect(caseSetDigest(ORDER_API_V1_CASES)).toHaveLength(64);
  });
});
