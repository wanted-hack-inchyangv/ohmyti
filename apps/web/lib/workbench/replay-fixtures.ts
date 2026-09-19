/**
 * 재생 뷰 테스트용 실행 기록 본문 픽스처 (T-303). 결함 샘플 C와 같은 동작(멱등성 없음)의 가짜 order-api에 하네스
 * `R-05-idempotent-resend` 케이스를 실제로 돌린 결과를 워커(`buildRequirementResults`)가 저장하는 형태 그대로 옮겼다
 * (주문 id·시각만 고정값으로 바꿨다). 응답 헤더 `set-cookie`는 하네스가 이미 `[TOKEN]`으로 가린 값이다.
 * 재고 관측: 시드 2 → 첫 주문 뒤 1 → 같은 키 재전송 뒤 0 (기대 1, 실제 0).
 */
import { RunRecordReportSchema, type RunRecordReport } from "@ohmyti/core";
import { FIXTURE_DIGEST, FIXTURE_EVALUATION_ID, FIXTURE_RUN_ID, FIXTURE_SHA } from "./fixtures";

export const R05_CASE_ID = "R-05-idempotent-resend";

const key = (part: string) =>
  `evaluations/${FIXTURE_EVALUATION_ID}/runs/${FIXTURE_RUN_ID}/${part}.json`;

export const R05_TIMELINE = [
  {
    seq: 0,
    stepIndex: -1,
    kind: "reset",
    request: {
      method: "POST",
      path: "/admin/reset",
      headers: {
        accept: "application/json",
      },
      body: null,
    },
    response: {
      status: 200,
      headers: {
        connection: "keep-alive",
        "content-length": "11",
        "content-type": "application/json",
        date: "Fri, 18 Sep 2026 09:01:00 GMT",
        "keep-alive": "timeout=5",
        "set-cookie": "session=[TOKEN]",
      },
      body: {
        ok: true,
      },
      bodyIsJson: true,
    },
    elapsedMs: 13,
  },
  {
    seq: 1,
    stepIndex: 0,
    kind: "observeState",
    request: {
      method: "GET",
      path: "/products/p1",
      headers: {
        accept: "application/json",
      },
      body: null,
    },
    response: {
      status: 200,
      headers: {
        connection: "keep-alive",
        "content-length": "39",
        "content-type": "application/json",
        date: "Fri, 18 Sep 2026 09:01:00 GMT",
        "keep-alive": "timeout=5",
        "set-cookie": "session=[TOKEN]",
      },
      body: {
        id: "p1",
        name: "Keyboard",
        stock: 2,
      },
      bodyIsJson: true,
    },
    elapsedMs: 1,
    capture: "p1Seed",
    stateAfter: {
      id: "p1",
      name: "Keyboard",
      stock: 2,
    },
  },
  {
    seq: 2,
    stepIndex: 1,
    kind: "request",
    request: {
      method: "POST",
      path: "/orders",
      headers: {
        "idempotency-key": "r05-k1",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: {
        productId: "p1",
        quantity: 1,
      },
    },
    response: {
      status: 201,
      headers: {
        connection: "keep-alive",
        "content-length": "94",
        "content-type": "application/json",
        date: "Fri, 18 Sep 2026 09:01:00 GMT",
        "keep-alive": "timeout=5",
        "set-cookie": "session=[TOKEN]",
      },
      body: {
        id: "order-0001",
        productId: "p1",
        quantity: 1,
        status: "CREATED",
      },
      bodyIsJson: true,
    },
    elapsedMs: 2,
    capture: "first",
  },
  {
    seq: 3,
    stepIndex: 2,
    kind: "observeState",
    request: {
      method: "GET",
      path: "/products/p1",
      headers: {
        accept: "application/json",
      },
      body: null,
    },
    response: {
      status: 200,
      headers: {
        connection: "keep-alive",
        "content-length": "39",
        "content-type": "application/json",
        date: "Fri, 18 Sep 2026 09:01:00 GMT",
        "keep-alive": "timeout=5",
        "set-cookie": "session=[TOKEN]",
      },
      body: {
        id: "p1",
        name: "Keyboard",
        stock: 1,
      },
      bodyIsJson: true,
    },
    elapsedMs: 0,
    capture: "p1AfterFirst",
    stateAfter: {
      id: "p1",
      name: "Keyboard",
      stock: 1,
    },
  },
  {
    seq: 4,
    stepIndex: 3,
    kind: "request",
    request: {
      method: "POST",
      path: "/orders",
      headers: {
        "idempotency-key": "r05-k1",
        "content-type": "application/json",
        accept: "application/json",
      },
      body: {
        productId: "p1",
        quantity: 1,
      },
    },
    response: {
      status: 201,
      headers: {
        connection: "keep-alive",
        "content-length": "94",
        "content-type": "application/json",
        date: "Fri, 18 Sep 2026 09:01:00 GMT",
        "keep-alive": "timeout=5",
        "set-cookie": "session=[TOKEN]",
      },
      body: {
        id: "order-0002",
        productId: "p1",
        quantity: 1,
        status: "CREATED",
      },
      bodyIsJson: true,
    },
    elapsedMs: 1,
    capture: "second",
  },
  {
    seq: 5,
    stepIndex: 6,
    kind: "observeState",
    request: {
      method: "GET",
      path: "/products/p1",
      headers: {
        accept: "application/json",
      },
      body: null,
    },
    response: {
      status: 200,
      headers: {
        connection: "keep-alive",
        "content-length": "39",
        "content-type": "application/json",
        date: "Fri, 18 Sep 2026 09:01:00 GMT",
        "keep-alive": "timeout=5",
        "set-cookie": "session=[TOKEN]",
      },
      body: {
        id: "p1",
        name: "Keyboard",
        stock: 0,
      },
      bodyIsJson: true,
    },
    elapsedMs: 1,
    capture: "p1After",
    stateAfter: {
      id: "p1",
      name: "Keyboard",
      stock: 0,
    },
  },
  {
    seq: 6,
    stepIndex: 7,
    kind: "request",
    request: {
      method: "GET",
      path: "/orders/order-0001",
      headers: {
        accept: "application/json",
      },
      body: null,
    },
    response: {
      status: 200,
      headers: {
        connection: "keep-alive",
        "content-length": "94",
        "content-type": "application/json",
        date: "Fri, 18 Sep 2026 09:01:00 GMT",
        "keep-alive": "timeout=5",
        "set-cookie": "session=[TOKEN]",
      },
      body: {
        id: "order-0001",
        productId: "p1",
        quantity: 1,
        status: "CREATED",
      },
      bodyIsJson: true,
    },
    elapsedMs: 0,
    capture: "firstGet",
  },
] as const;

export const R05_EXPECTED = {
  caseId: "R-05-idempotent-resend",
  expected: {
    "p1After.stock": 1,
    "second.body.id == first.body.id": true,
  },
  checks: [
    {
      name: "p1Seed.stock",
      expected: 2,
    },
    {
      name: "p1AfterFirst.stock",
      expected: 1,
    },
    {
      name: "first.status",
      expected: 201,
    },
    {
      name: "first.body.id",
      expected: "non-empty string",
    },
    {
      name: "second.status",
      expected: 201,
    },
    {
      name: "p1After.stock",
      expected: 1,
    },
    {
      name: "firstGet.status",
      expected: 200,
    },
    {
      name: "second.body.id == first.body.id",
      expected: true,
    },
  ],
};

export const R05_ACTUAL = {
  caseId: "R-05-idempotent-resend",
  verdict: "FAIL",
  failureKind: "ASSERTION",
  reason: null,
  actual: {
    "p1After.stock": 0,
    "second.body.id == first.body.id": false,
  },
  checks: [
    {
      name: "p1Seed.stock",
      ok: true,
      expected: 2,
      actual: 2,
    },
    {
      name: "p1AfterFirst.stock",
      ok: true,
      expected: 1,
      actual: 1,
    },
    {
      name: "first.status",
      ok: true,
      expected: 201,
      actual: 201,
    },
    {
      name: "first.body.id",
      ok: true,
      expected: "non-empty string",
      actual: "non-empty string",
    },
    {
      name: "second.status",
      ok: true,
      expected: 201,
      actual: 201,
    },
    {
      name: "p1After.stock",
      ok: false,
      expected: 1,
      actual: 0,
    },
    {
      name: "firstGet.status",
      ok: true,
      expected: 200,
      actual: 200,
    },
    {
      name: "second.body.id == first.body.id",
      ok: false,
      expected: true,
      actual: false,
    },
  ],
};

export const R05_INPUT = {
  kind: "HARNESS_CASE",
  caseId: "R-05-idempotent-resend",
  criterionIds: ["R-05"],
  caseSet: "order-api-v1",
  harnessVersion: "0.0.0+abcdef0123456789",
  requestTimeoutMs: 5000,
  resetPath: "/admin/reset",
  definition: null,
};

export function r05RunRecordFixture(overrides: Partial<RunRecordReport> = {}): RunRecordReport {
  const report: RunRecordReport = {
    evaluationId: FIXTURE_EVALUATION_ID,
    runId: FIXTURE_RUN_ID,
    record: {
      id: FIXTURE_RUN_ID,
      evaluationId: FIXTURE_EVALUATION_ID,
      kind: "HARNESS",
      submissionSha: FIXTURE_SHA,
      rubricVersion: "v1",
      harnessVersion: "0.0.0+abcdef0123456789",
      environmentDigest: FIXTURE_DIGEST,
      inputRef: key("input"),
      expectedRef: key("expected"),
      actualRef: key("actual"),
      exitCode: null,
      failureKind: "ASSERTION",
      startedAt: "2026-09-18T09:01:00.000Z",
      finishedAt: "2026-09-18T09:01:00.250Z",
      durationMs: 250,
    },
    evidences: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        evaluationId: FIXTURE_EVALUATION_ID,
        submissionSha: FIXTURE_SHA,
        runId: FIXTURE_RUN_ID,
        testId: R05_CASE_ID,
        artifactRefs: [
          key("input"),
          key("expected"),
          key("actual"),
          key("timeline"),
          "logs/service/stdout.txt",
          "logs/service/stderr.txt",
        ],
      },
    ],
    input: R05_INPUT,
    expected: R05_EXPECTED,
    actual: R05_ACTUAL,
    timeline: structuredClone(R05_TIMELINE) as unknown as RunRecordReport["timeline"],
    logs: { stdout: ["logs/service/stdout.txt"], stderr: ["logs/service/stderr.txt"] },
    ...overrides,
  };
  return RunRecordReportSchema.parse(report);
}
