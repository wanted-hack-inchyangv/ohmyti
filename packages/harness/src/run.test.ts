import { ReplayTimelineSchema, RubricSchema, type Rubric } from "@ohmyti/core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORDER_API_V1_CASES, ORDER_API_V1_CASE_SET } from "./cases";
import { defineCase } from "./dsl";
import { runHarness } from "./report";
import { HarnessReportSchema, type CaseResult } from "./result";
import { runCase, runCases } from "./run";
import { startFakeOrderApi, type FakeOrderApi } from "./test-support/fake-order-api";

const here = path.dirname(fileURLToPath(import.meta.url));
const rubric: Rubric = RubricSchema.parse(
  JSON.parse(readFileSync(path.join(here, "../../../samples/order-api/rubric.v1.json"), "utf8")),
);

const TIMEOUT_MS = 2000;
const byId = (results: CaseResult[]) => new Map(results.map((r) => [r.caseId, r]));
const verdicts = (results: CaseResult[]) =>
  Object.fromEntries(results.map((r) => [r.caseId, `${r.verdict}/${r.failureKind}`]));

/** 실행마다 달라도 되는 값(시각·소요 시간·서버 생성 id)을 뺀 비교용 형태 */
function deterministicView(results: CaseResult[]) {
  return results.map((r) => ({
    caseId: r.caseId,
    verdict: r.verdict,
    failureKind: r.failureKind,
    expected: r.expected,
    actual: r.actual,
    checks: r.checks,
    timelineShape: r.timeline.map((t) => [t.seq, t.kind, t.capture, t.response?.status ?? null]),
  }));
}

describe("정답 구현", () => {
  let api: FakeOrderApi;
  beforeAll(async () => {
    api = await startFakeOrderApi();
  });
  afterAll(() => api.close());

  it("모든 케이스가 PASS이고 보고서가 스키마를 통과한다", async () => {
    const report = await runHarness(ORDER_API_V1_CASES, {
      baseUrl: api.baseUrl,
      timeoutMs: TIMEOUT_MS,
      caseSet: ORDER_API_V1_CASE_SET,
      rubric,
    });
    expect(HarnessReportSchema.parse(report)).toEqual(report);
    expect(report.summary).toEqual({ total: 10, pass: 10, fail: 0, inconclusive: 0 });
    expect(report.results.every((r) => r.verdict === "PASS" && r.failureKind === "NONE")).toBe(
      true,
    );
    expect(report.results.every((r) => r.expected && Object.keys(r.expected).length === 0)).toBe(
      true,
    );
    expect(report.rubricVersion).toBe("v1");
    expect(report.harnessVersion).toMatch(/^0\.1\.0\+[0-9a-f]{16}$/);
  });

  it("케이스마다 초기화 요청이 먼저 기록된다", async () => {
    const [result] = await runCases(ORDER_API_V1_CASES, {
      baseUrl: api.baseUrl,
      timeoutMs: TIMEOUT_MS,
      caseIds: ["R-01-normal-order"],
    });
    expect(result!.timeline[0]).toMatchObject({
      seq: 0,
      stepIndex: -1,
      kind: "reset",
      request: { method: "POST", path: "/admin/reset" },
      response: { status: 200, body: { ok: true } },
    });
    // observeState 항목은 stateAfter를 담는다
    const observed = result!.timeline.find((t) => t.kind === "observeState");
    expect(observed?.stateAfter).toEqual({ id: "p1", name: "Keyboard", stock: 1 });
  });

  it("3회 연속 실행한 결과가 verdict·actual·검사 결과까지 동일하다", async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      runs.push(
        deterministicView(
          await runCases(ORDER_API_V1_CASES, { baseUrl: api.baseUrl, timeoutMs: TIMEOUT_MS }),
        ),
      );
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  it("헤더·본문의 비밀값과 개인정보를 마스킹해 기록한다", async () => {
    const masked = await startFakeOrderApi({
      extraHeader: ["x-debug", "token=sk-abcdefgh12345678"],
    });
    try {
      const probe = defineCase({
        id: "probe",
        title: "probe",
        criterionIds: ["R-01"],
        steps: [
          {
            kind: "request",
            capture: "a",
            request: {
              method: "POST",
              path: "/orders",
              headers: { "Idempotency-Key": "k", Authorization: "Bearer top-secret-value-1" },
              body: { productId: "p1", quantity: 1, note: "contact me@example.com" },
            },
          },
        ],
        expect: [],
      });
      const result = await runCase(probe, {
        baseUrl: masked.baseUrl,
        timeoutMs: TIMEOUT_MS,
        secrets: ["top-secret-value-1"],
      });
      const entry = result.timeline[1]!;
      expect(entry.request.headers["authorization"]).toBe("Bearer [SECRET]");
      expect(JSON.stringify(entry.request.body)).toContain("[EMAIL]");
      expect(JSON.stringify(entry.request.body)).not.toContain("me@example.com");
      expect(entry.response!.headers["x-debug"]).toBe("token=[TOKEN]");
    } finally {
      await masked.close();
    }
  });
});

describe("결함 구현 (멱등성 없음, 샘플 C와 같은 동작)", () => {
  let api: FakeOrderApi;
  let results: CaseResult[];
  beforeAll(async () => {
    api = await startFakeOrderApi({ idempotency: false });
    results = await runCases(ORDER_API_V1_CASES, { baseUrl: api.baseUrl, timeoutMs: TIMEOUT_MS });
  });
  afterAll(() => api.close());

  it("R-05·R-06·R-07 케이스만 FAIL(ASSERTION)이다", () => {
    expect(verdicts(results)).toEqual({
      "R-01-normal-order": "PASS/NONE",
      "R-02-lookups": "PASS/NONE",
      "R-05-idempotent-resend": "FAIL/ASSERTION",
      "R-06-idempotency-conflict": "FAIL/ASSERTION",
      "R-09-cancel": "PASS/NONE",
      "R-03-insufficient-stock": "PASS/NONE",
      "R-04-validation": "PASS/NONE",
      "R-07-same-key-concurrent": "FAIL/ASSERTION",
      "R-08-distinct-keys-concurrent": "PASS/NONE",
      "R-10-health-and-reset": "PASS/NONE",
    });
  });

  it("R-05의 expected/actual에 재고 기대 1·실제 0과 id 불일치가 남고 timeline에 요청·응답 전체가 있다", () => {
    const r05 = byId(results).get("R-05-idempotent-resend")!;
    expect(r05.expected).toEqual({ "p1After.stock": 1, "second.body.id == first.body.id": true });
    expect(r05.actual).toEqual({ "p1After.stock": 0, "second.body.id == first.body.id": false });
    // reset + 재고 관측 + POST + 재고 관측 + POST + 재고 관측 + GET /orders/:id
    expect(r05.timeline.map((t) => `${t.request.method} ${t.request.path}`)).toEqual([
      "POST /admin/reset",
      "GET /products/p1",
      "POST /orders",
      "GET /products/p1",
      "POST /orders",
      "GET /products/p1",
      expect.stringMatching(/^GET \/orders\/.+$/),
    ]);
    // 관측 스텝의 stateAfter에 재고 2 → 1 → 0이 남는다 (T-303 재생 뷰가 그대로 보여 준다)
    expect(
      r05.timeline
        .filter((t) => t.kind === "observeState")
        .map((t) => (t.stateAfter as { stock: number }).stock),
    ).toEqual([2, 1, 0]);
    // core의 재생용 스키마(T-303 web이 읽는 형태)가 실제 타임라인을 그대로 통과시킨다
    expect(ReplayTimelineSchema.parse(r05.timeline)).toEqual(r05.timeline);
    const second = r05.timeline[4]!;
    expect(second.request).toMatchObject({
      headers: { "idempotency-key": "r05-k1", "content-type": "application/json" },
      body: { productId: "p1", quantity: 1 },
    });
    expect(second.response).toMatchObject({
      status: 201,
      headers: { "content-type": "application/json" },
      body: { productId: "p1", quantity: 1, status: "CREATED" },
      bodyIsJson: true,
    });
    expect(typeof (second.response!.body as { id: string }).id).toBe("string");
  });

  it("R-06·R-07의 expected/actual이 구체 값을 담는다", () => {
    const r06 = byId(results).get("R-06-idempotency-conflict")!;
    expect(r06.expected["otherProduct.status"]).toBe(422);
    expect(r06.actual["otherProduct.status"]).toBe(201);
    expect(r06.actual["otherProduct.body.error.code"]).toBeNull();
    const r07 = byId(results).get("R-07-same-key-concurrent")!;
    expect(r07.expected).toEqual({
      "p2After.stock": 4,
      "burst.count(status == 201)": 10,
      "burst.allEqual(body.id)": true,
    });
    expect(r07.actual).toEqual({
      "p2After.stock": 0,
      "burst.count(status == 201)": 5,
      "burst.allEqual(body.id)": false,
    });
    expect(r07.timeline.filter((t) => t.kind === "parallel")).toHaveLength(10);
  });
});

describe("환경 장애와 제출 오류 구분 (G-11)", () => {
  it("서비스가 없으면 INCONCLUSIVE · ENVIRONMENT이고 초기화 요청만 기록된다", async () => {
    const closed = await startFakeOrderApi();
    const { baseUrl } = closed;
    await closed.close();
    const results = await runCases(ORDER_API_V1_CASES, {
      baseUrl,
      timeoutMs: TIMEOUT_MS,
      caseIds: ["R-01-normal-order", "R-07-same-key-concurrent"],
    });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.verdict).toBe("INCONCLUSIVE");
      expect(r.failureKind).toBe("ENVIRONMENT");
      expect(r.reason).toMatch(/초기화 요청 실패/);
      expect(r.timeline).toHaveLength(1);
      expect(r.timeline[0]!.error?.kind).toBe("CONNECTION");
      expect(r.checks).toEqual([]);
    }
  });

  it("초기화가 200이 아니면 INCONCLUSIVE · ENVIRONMENT다", async () => {
    const api = await startFakeOrderApi({ resetFails: true });
    try {
      const [r] = await runCases(ORDER_API_V1_CASES, {
        baseUrl: api.baseUrl,
        timeoutMs: TIMEOUT_MS,
        caseIds: ["R-01-normal-order"],
      });
      expect(r).toMatchObject({ verdict: "INCONCLUSIVE", failureKind: "ENVIRONMENT" });
      expect(r!.reason).toMatch(/200이 아닙니다 \(500\)/);
    } finally {
      await api.close();
    }
  });

  it("응답이 제한 시간을 넘으면 INCONCLUSIVE · TIMEOUT이며 재시도하지 않는다", async () => {
    const api = await startFakeOrderApi({ delayMs: 400 });
    try {
      const [r] = await runCases(ORDER_API_V1_CASES, {
        baseUrl: api.baseUrl,
        timeoutMs: 100,
        caseIds: ["R-01-normal-order"],
      });
      expect(r).toMatchObject({ verdict: "INCONCLUSIVE", failureKind: "TIMEOUT" });
      expect(r!.timeline).toHaveLength(1);
      expect(r!.timeline[0]!.error?.kind).toBe("TIMEOUT");
    } finally {
      await api.close();
    }
  });

  it("5xx 응답이 있으면 FAIL · SUBMISSION이다", async () => {
    const api = await startFakeOrderApi({ serverError: true });
    try {
      const [r] = await runCases(ORDER_API_V1_CASES, {
        baseUrl: api.baseUrl,
        timeoutMs: TIMEOUT_MS,
        caseIds: ["R-01-normal-order"],
      });
      expect(r).toMatchObject({ verdict: "FAIL", failureKind: "SUBMISSION" });
      expect(r!.reason).toMatch(/500 \(POST \/orders\)/);
      expect(r!.actual["order.status"]).toBe(500);
    } finally {
      await api.close();
    }
  });
});
