/**
 * 케이스 실행기. 케이스마다 `POST /admin/reset`으로 시작하고, 스텝을 순서대로 실행하며,
 * 관측값을 기대값과 비교해 판정한다. 판정은 결정적이며 LLM을 쓰지 않는다 (G-01).
 *
 * - reset 실패(응답 없음 또는 200 아님) → INCONCLUSIVE · ENVIRONMENT
 * - 요청 시간 초과 → INCONCLUSIVE · TIMEOUT, 연결 실패 → INCONCLUSIVE · ENVIRONMENT
 * - 검사 실패 → FAIL · ASSERTION. 응답 중 5xx가 있으면 FAIL · SUBMISSION
 */
import type { CaseDefinition, JsonValue, RequestSpec, ResponseExpectation, Step } from "./dsl";
import { sendRequest, type Exchange, type HttpClientOptions } from "./http";
import {
  deepEqual,
  evaluateCheck,
  nonEmptyStringCheck,
  resolveRequest,
  walk,
  type Captures,
} from "./resolve";
import type { CaseResult, CheckResult, TimelineEntry } from "./result";

export interface RunCaseOptions extends HttpClientOptions {
  /** 초기화 경로. 실행 계약의 `resetPath` (기본 `/admin/reset`) */
  resetPath?: string;
  /** 시각 주입 (테스트용) */
  now?: () => Date;
}

const DEFAULT_RESET_PATH = "/admin/reset";

/** 캡처에 저장하는 응답 형태. 검사는 `이름.status`, `이름.body.필드`로 참조한다. */
function captureOf(exchange: Exchange): JsonValue {
  if (!exchange.response) return null;
  return {
    status: exchange.response.status,
    headers: exchange.response.headers,
    body: exchange.response.body,
  };
}

class TransportAbort extends Error {
  constructor(
    readonly failureKind: "TIMEOUT" | "ENVIRONMENT",
    message: string,
  ) {
    super(message);
  }
}

function expectationChecks(
  label: string,
  captured: JsonValue | undefined,
  expect: ResponseExpectation,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const status = captured === undefined ? undefined : walk(captured, ["status"]);
  if (expect.status !== undefined) {
    checks.push({
      name: `${label}.status`,
      ok: status === expect.status,
      expected: expect.status,
      actual: status ?? null,
    });
  }
  for (const [key, expected] of Object.entries(expect.body ?? {})) {
    const actual = captured === undefined ? undefined : walk(captured, ["body", ...key.split(".")]);
    checks.push({
      name: `${label}.body.${key}`,
      ok: deepEqual(actual, expected),
      expected,
      actual: actual ?? null,
    });
  }
  for (const key of expect.nonEmptyStrings ?? []) {
    const actual = captured === undefined ? undefined : walk(captured, ["body", ...key.split(".")]);
    checks.push(nonEmptyStringCheck(`${label}.body.${key}`, actual));
  }
  return checks;
}

function stateChecks(
  label: string,
  captured: JsonValue,
  expect: Record<string, JsonValue>,
): CheckResult[] {
  return Object.entries(expect).map(([key, expected]) => {
    const actual = walk(captured, ["body", ...key.split(".")]);
    return {
      name: `${label}.${key}`,
      ok: deepEqual(actual, expected),
      expected,
      actual: actual ?? null,
    };
  });
}

export async function runCase(
  definition: CaseDefinition,
  options: RunCaseOptions,
): Promise<CaseResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const timeline: TimelineEntry[] = [];
  const checks: CheckResult[] = [];
  const captures = new Map<string, JsonValue>();
  let seq = 0;

  const record = (
    stepIndex: number,
    kind: TimelineEntry["kind"],
    exchange: Exchange,
    capture?: string,
    stateAfter?: JsonValue,
  ): TimelineEntry => {
    const entry: TimelineEntry = {
      seq: seq++,
      stepIndex,
      kind,
      request: exchange.request,
      response: exchange.response,
      elapsedMs: exchange.elapsedMs,
    };
    if (capture !== undefined) entry.capture = capture;
    if (exchange.error) entry.error = exchange.error;
    if (stateAfter !== undefined) entry.stateAfter = stateAfter;
    timeline.push(entry);
    return entry;
  };

  const abortIfTransportFailed = (exchange: Exchange, what: string): void => {
    if (!exchange.error) return;
    throw new TransportAbort(
      exchange.error.kind === "TIMEOUT" ? "TIMEOUT" : "ENVIRONMENT",
      `${what}: ${exchange.error.message}`,
    );
  };

  const send = (spec: RequestSpec, scope: Captures): Promise<Exchange> =>
    sendRequest(options, resolveRequest(spec, scope));

  let failureKind: CaseResult["failureKind"] = "NONE";
  let reason: string | undefined;

  try {
    // 케이스 시작 전 초기화. 실패하면 제출 코드가 아니라 환경 문제로 본다 (T-107 범위).
    const reset = await sendRequest(options, {
      method: "POST",
      path: options.resetPath ?? DEFAULT_RESET_PATH,
      headers: {},
    });
    record(-1, "reset", reset);
    abortIfTransportFailed(reset, "초기화 요청 실패");
    if (reset.response!.status !== 200) {
      throw new TransportAbort(
        "ENVIRONMENT",
        `초기화 응답이 200이 아닙니다 (${reset.response!.status})`,
      );
    }

    for (const [stepIndex, step] of definition.steps.entries()) {
      await runStep(step, stepIndex);
    }
    for (const check of definition.expect) checks.push(evaluateCheck(check, captures));
  } catch (err) {
    if (err instanceof TransportAbort) {
      failureKind = err.failureKind;
      reason = err.message;
    } else {
      throw err;
    }
  }

  async function runStep(step: Step, stepIndex: number): Promise<void> {
    switch (step.kind) {
      case "request": {
        const exchange = await send(step.request, captures);
        record(stepIndex, "request", exchange, step.capture);
        abortIfTransportFailed(exchange, `요청 실패 (${step.capture})`);
        captures.set(step.capture, captureOf(exchange));
        return;
      }
      case "observeState": {
        const exchange = await send({ method: "GET", path: step.path }, captures);
        const captured = captureOf(exchange);
        record(stepIndex, "observeState", exchange, step.capture, exchange.response?.body);
        abortIfTransportFailed(exchange, `상태 관측 실패 (${step.capture})`);
        captures.set(step.capture, captured);
        if (step.expect)
          checks.push(...stateChecks(step.label ?? step.capture, captured, step.expect));
        return;
      }
      case "assertResponse": {
        checks.push(
          ...expectationChecks(step.label ?? step.of, captures.get(step.of), step.expect),
        );
        return;
      }
      case "parallel": {
        const specs: Array<{ spec: RequestSpec; scope: Captures }> = [];
        if (step.requests) {
          for (const spec of step.requests) specs.push({ spec, scope: captures });
        } else if (step.forEach) {
          const list = captures.get(step.forEach.of);
          const items = Array.isArray(list) ? list : [];
          const where = step.forEach.where;
          for (const item of items) {
            if (where && !deepEqual(walk(item, where.path.split(".")), where.equals)) continue;
            const scope = new Map(captures);
            scope.set("item", item);
            specs.push({ spec: step.forEach.request, scope });
          }
        }
        const exchanges = await Promise.all(specs.map(({ spec, scope }) => send(spec, scope)));
        exchanges.forEach((exchange, i) =>
          record(stepIndex, "parallel", exchange, `${step.capture}[${i}]`),
        );
        for (const exchange of exchanges)
          abortIfTransportFailed(exchange, `동시 요청 실패 (${step.capture})`);
        captures.set(step.capture, exchanges.map(captureOf));
        return;
      }
    }
  }

  const failed = checks.filter((c) => !c.ok);
  const expected: Record<string, JsonValue> = {};
  const actual: Record<string, JsonValue> = {};
  for (const check of failed) {
    expected[check.name] = check.expected;
    actual[check.name] = check.actual;
  }

  let verdict: CaseResult["verdict"];
  if (failureKind === "TIMEOUT" || failureKind === "ENVIRONMENT") {
    verdict = "INCONCLUSIVE";
  } else if (failed.length === 0) {
    verdict = "PASS";
  } else {
    verdict = "FAIL";
    const serverError = timeline.find((e) => e.response !== null && e.response.status >= 500);
    if (serverError) {
      failureKind = "SUBMISSION";
      reason = `서버 오류 응답 ${serverError.response!.status} (${serverError.request.method} ${serverError.request.path})`;
    } else {
      failureKind = "ASSERTION";
    }
  }

  const result: CaseResult = {
    caseId: definition.id,
    criterionIds: definition.criterionIds,
    verdict,
    failureKind,
    timeline,
    checks,
    expected,
    actual,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
  };
  if (reason !== undefined) result.reason = reason;
  return result;
}

export interface RunCasesOptions extends RunCaseOptions {
  /** 실행할 케이스 ID. 생략하면 전부 */
  caseIds?: readonly string[];
  /** 케이스 하나가 끝날 때마다 호출 (CLI 진행 표시용) */
  onCaseFinished?: (result: CaseResult) => void;
}

/** 케이스를 정의 순서대로 하나씩 실행한다. 케이스끼리는 상태를 공유하지 않으므로 순차 실행이 결정성을 지킨다. */
export async function runCases(
  definitions: readonly CaseDefinition[],
  options: RunCasesOptions,
): Promise<CaseResult[]> {
  const selected = options.caseIds
    ? definitions.filter((d) => options.caseIds!.includes(d.id))
    : definitions;
  const results: CaseResult[] = [];
  for (const definition of selected) {
    const result = await runCase(definition, options);
    results.push(result);
    options.onCaseFinished?.(result);
  }
  return results;
}
