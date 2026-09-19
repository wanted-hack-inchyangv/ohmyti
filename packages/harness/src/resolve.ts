/**
 * 캡처 참조·템플릿 해석과 검사 평가. 순수 함수이며 네트워크를 쓰지 않는다.
 */
import type { BodyValue, Check, JsonValue, RequestSpec, ValueExpr, Where } from "./dsl";
import type { ResolvedRequest } from "./http";
import type { CheckResult } from "./result";

/** 캡처 이름 → 값. 스텝 실행이 채운다. */
export type Captures = ReadonlyMap<string, JsonValue>;

const TEMPLATE_RE = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** `이름.필드.0.필드` 경로를 따라 값을 찾는다. 없으면 undefined. */
export function lookup(captures: Captures, ref: string): JsonValue | undefined {
  const [head, ...rest] = ref.split(".");
  if (head === undefined || !captures.has(head)) return undefined;
  return walk(captures.get(head)!, rest);
}

/** 값 안에서 점 경로를 따라간다. */
export function walk(value: JsonValue, segments: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else {
      current = current[segment];
    }
  }
  return current;
}

function templateToString(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** `{{ref}}` 템플릿을 캡처 값으로 치환한다. 풀 수 없는 참조는 빈 문자열이 된다. */
export function renderTemplate(text: string, captures: Captures): string {
  return text.replace(TEMPLATE_RE, (_m, ref: string) => templateToString(lookup(captures, ref)));
}

function isRef(value: BodyValue): value is { $ref: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $ref?: unknown }).$ref === "string"
  );
}

/** 본문 안의 `{ $ref }`와 문자열 템플릿을 모두 치환한다. 풀 수 없는 참조는 null이 된다. */
export function resolveBody(value: BodyValue, captures: Captures): JsonValue {
  if (isRef(value)) return lookup(captures, value.$ref) ?? null;
  if (typeof value === "string") return renderTemplate(value, captures);
  if (Array.isArray(value)) return value.map((item) => resolveBody(item, captures));
  if (typeof value === "object" && value !== null) {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveBody(item, captures);
    return out;
  }
  return value;
}

export function resolveRequest(spec: RequestSpec, captures: Captures): ResolvedRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    headers[name] = renderTemplate(value, captures);
  }
  const resolved: ResolvedRequest = {
    method: spec.method,
    path: renderTemplate(spec.path, captures),
    headers,
  };
  if (spec.rawBody !== undefined) resolved.rawBody = spec.rawBody;
  else if (spec.body !== undefined) resolved.body = resolveBody(spec.body, captures);
  return resolved;
}

export function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

function filterItems(captures: Captures, of: string, where: Where | undefined): JsonValue[] {
  const list = captures.get(of);
  if (!Array.isArray(list)) return [];
  if (!where) return list;
  return list.filter((item) => deepEqual(walk(item, where.path.split(".")), where.equals));
}

/** 관측값 식을 평가한다. 참조를 풀 수 없으면 undefined. 집계는 항상 스칼라를 돌려준다. */
export function evaluateValue(expr: ValueExpr, captures: Captures): JsonValue | undefined {
  if ("$ref" in expr) return lookup(captures, expr.$ref);
  if ("$countWhere" in expr) {
    const { of, where } = expr.$countWhere;
    return filterItems(captures, of, where).length;
  }
  if ("$distinctCount" in expr) {
    const { of, path, where } = expr.$distinctCount;
    const seen = new Set<string>();
    for (const item of filterItems(captures, of, where)) {
      seen.add(JSON.stringify(walk(item, path.split(".")) ?? null));
    }
    return seen.size;
  }
  if ("$allEqual" in expr) {
    const { of, path, where } = expr.$allEqual;
    const items = filterItems(captures, of, where);
    if (items.length === 0) return false;
    const first = walk(items[0]!, path.split("."));
    return items.every((item) => deepEqual(walk(item, path.split(".")), first));
  }
  if ("$min" in expr) {
    const { of, path, where } = expr.$min;
    const values = filterItems(captures, of, where).map((item) => walk(item, path.split(".")));
    if (values.length === 0 || values.some((v) => typeof v !== "number")) return null;
    return Math.min(...(values as number[]));
  }
  const values = expr.$sameValue.refs.map((ref) => lookup(captures, ref));
  if (values.some((v) => v === undefined)) return false;
  return values.every((v) => deepEqual(v, values[0]));
}

export function evaluateCheck(check: Check, captures: Captures): CheckResult {
  const actual = evaluateValue(check.actual, captures);
  const recorded: JsonValue = actual === undefined ? null : actual;
  if (check.equals !== undefined) {
    return {
      name: check.name,
      ok: deepEqual(actual, check.equals),
      expected: check.equals,
      actual: recorded,
    };
  }
  if (check.gte !== undefined) {
    return {
      name: check.name,
      ok: typeof actual === "number" && actual >= check.gte,
      expected: `>= ${check.gte}`,
      actual: recorded,
    };
  }
  return nonEmptyStringCheck(check.name, actual);
}

export const NON_EMPTY_STRING = "non-empty string";

/**
 * 비어 있지 않은 문자열 검사. 통과하면 관측값을 원문(서버가 만든 무작위 id 등) 대신 기대값 문구로 기록해
 * 같은 서비스에 여러 번 실행한 결과가 동일하게 남는다. 원문은 타임라인에 있다. 실패하면 원문을 그대로 남긴다.
 */
export function nonEmptyStringCheck(name: string, actual: JsonValue | undefined): CheckResult {
  const ok = typeof actual === "string" && actual.length > 0;
  return {
    name,
    ok,
    expected: NON_EMPTY_STRING,
    actual: ok ? NON_EMPTY_STRING : (actual ?? null),
  };
}
