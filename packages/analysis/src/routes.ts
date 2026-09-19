/**
 * 라우트 경로 매칭 (TICKET.md T-304). 코드에 등록된 패턴(`/orders/:id`)과 timeline의 실제 요청 경로(`/orders/abc?x=1`)를 대조한다.
 * express 5·hono의 공통 문법만 다룬다: `:param`(hono의 `:param{regex}` 포함), `*`(나머지 전부), 세그먼트 뒤 `?`(선택).
 * 정규식 라우트·배열 라우트는 등록 단계에서 거절되므로 여기까지 오지 않는다.
 */
import type { FunctionGraphRoute, FunctionGraphRouteMethod } from "@ohmyti/core";

export const ROUTE_METHOD_NAMES: ReadonlyMap<string, FunctionGraphRouteMethod> = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
  ["options", "OPTIONS"],
  ["head", "HEAD"],
  ["all", "ALL"],
]);

/** 쿼리·해시를 떼고 중복·끝 슬래시를 정리한다. 빈 경로는 `/` */
export function normalizeRequestPath(raw: string): string {
  const withoutQuery = raw.split(/[?#]/, 1)[0] ?? "";
  const segments = withoutQuery.split("/").filter((s) => s.length > 0);
  return `/${segments.join("/")}`;
}

/** 마운트 접두사와 등록 경로를 잇는다. `("/api", "/")` → `/api`, `("", "/x")` → `/x` */
export function joinRoutePath(prefix: string, path: string): string {
  const segments = [...prefix.split("/"), ...path.split("/")].filter((s) => s.length > 0);
  return `/${segments.join("/")}`;
}

function segmentMatches(pattern: string, actual: string | undefined): boolean {
  if (pattern === "*" || pattern.startsWith("*")) return true;
  if (actual === undefined) return false;
  if (pattern.startsWith(":")) return actual.length > 0;
  return pattern === actual;
}

/** 등록 패턴이 실제 경로에 매치되는지 */
export function matchRoutePath(pattern: string, actualPath: string): boolean {
  // 패턴은 쿼리를 떼지 않는다 (`:name?`의 `?`는 선택 표시다)
  const patternSegments = pattern.split("/").filter((s) => s.length > 0);
  const actualSegments = normalizeRequestPath(actualPath)
    .split("/")
    .filter((s) => s.length > 0);
  let ai = 0;
  for (let pi = 0; pi < patternSegments.length; pi += 1) {
    const raw = patternSegments[pi]!;
    if (raw === "*" || raw.startsWith("*")) return true;
    const optional = raw.endsWith("?");
    const segment = optional ? raw.slice(0, -1) : raw;
    const actual = actualSegments[ai];
    if (segmentMatches(segment, actual)) {
      ai += 1;
      continue;
    }
    if (optional) continue;
    return false;
  }
  return ai === actualSegments.length;
}

export function methodMatches(route: FunctionGraphRouteMethod, requestMethod: string): boolean {
  const method = requestMethod.toUpperCase();
  if (route === "ALL") return true;
  if (route === "GET" && method === "HEAD") return true;
  return route === method;
}

/** 요청에 매치되는 첫 라우트 (등록 순). 없으면 undefined */
export function findMatchingRoute<T extends FunctionGraphRoute>(
  routes: readonly T[],
  request: { method: string; path: string },
): T | undefined {
  return routes.find(
    (route) =>
      methodMatches(route.method, request.method) && matchRoutePath(route.path, request.path),
  );
}
