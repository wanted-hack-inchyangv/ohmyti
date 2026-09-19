/**
 * 하네스의 HTTP 클라이언트. 제출 서비스와는 HTTP로만 통신하며(하네스 코드·자격증명은 제출 환경에 들어가지 않는다),
 * 요청 타임아웃만 있고 재시도는 없다. 요청·응답 전체를 마스킹해 기록한다.
 */
import { maskSensitive } from "@ohmyti/core";
import type { HttpMethod, JsonValue } from "./dsl";
import type { RecordedRequest, RecordedResponse, TransportError } from "./result";

export interface HttpClientOptions {
  baseUrl: string;
  /** 요청 하나의 벽시계 제한. 넘으면 TIMEOUT 전송 오류다 */
  timeoutMs: number;
  /** 기록에서 가려야 할 비밀값 (`maskSensitive`의 지정 비밀값) */
  secrets?: readonly string[];
}

/** 템플릿·참조가 모두 풀린, 실제로 보낼 요청. */
export interface ResolvedRequest {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  /** JSON 본문. `rawBody`와 함께 쓰지 않는다 */
  body?: JsonValue;
  rawBody?: string;
}

export interface Exchange {
  request: RecordedRequest;
  response: RecordedResponse | null;
  error?: TransportError;
  elapsedMs: number;
}

/** 값 안의 문자열을 모두 마스킹한다. JSON 문자열로 직렬화한 뒤 가리고 다시 파싱하므로 구조는 유지된다. */
export function maskJson(value: JsonValue, secrets: readonly string[] = []): JsonValue {
  if (value === null) return null;
  return JSON.parse(maskSensitive(JSON.stringify(value), secrets)) as JsonValue;
}

function maskHeaders(
  headers: Record<string, string>,
  secrets: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = maskSensitive(value, secrets);
  }
  return out;
}

/** 응답 본문 문자열을 기록용 값으로 바꾼다. JSON이면 파싱하고, 아니면 원문을 둔다. */
export function parseBody(text: string): { body: JsonValue; bodyIsJson: boolean } {
  if (text.length === 0) return { body: null, bodyIsJson: false };
  try {
    return { body: JSON.parse(text) as JsonValue, bodyIsJson: true };
  } catch {
    return { body: text, bodyIsJson: false };
  }
}

function describeTransportError(err: unknown): TransportError {
  if (err instanceof Error && err.name === "TimeoutError") {
    return { kind: "TIMEOUT", message: "요청 시간 제한을 넘었습니다" };
  }
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const causeText =
    cause instanceof Error
      ? `${(cause as NodeJS.ErrnoException).code ?? cause.name}: ${cause.message}`
      : typeof cause === "string"
        ? cause
        : "";
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: "CONNECTION",
    message: causeText.length > 0 ? `${message} (${causeText})` : message,
  };
}

/** 요청을 한 번 보내고 결과를 기록한다. 응답이 없으면 `response`가 null이고 `error`가 채워진다. */
export async function sendRequest(
  options: HttpClientOptions,
  request: ResolvedRequest,
): Promise<Exchange> {
  const secrets = options.secrets ?? [];
  const headers: Record<string, string> = { ...request.headers };
  let payload: string | undefined;
  if (request.rawBody !== undefined) {
    payload = request.rawBody;
    if (!hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
  } else if (request.body !== undefined) {
    payload = JSON.stringify(request.body);
    if (!hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
  }
  if (!hasHeader(headers, "accept")) headers["accept"] = "application/json";

  const recordedRequest: RecordedRequest = {
    method: request.method,
    path: request.path,
    headers: maskHeaders(headers, secrets),
    body:
      request.rawBody !== undefined
        ? maskSensitive(request.rawBody, secrets)
        : request.body !== undefined
          ? maskJson(request.body, secrets)
          : null,
  };

  const url = new URL(request.path, options.baseUrl).toString();
  const startedAt = performance.now();
  try {
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    };
    if (payload !== undefined) init.body = payload;
    const res = await fetch(url, init);
    const text = await res.text();
    const elapsedMs = Math.round(performance.now() - startedAt);
    const parsed = parseBody(text);
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    return {
      request: recordedRequest,
      response: {
        status: res.status,
        headers: maskHeaders(responseHeaders, secrets),
        body:
          typeof parsed.body === "string"
            ? maskSensitive(parsed.body, secrets)
            : maskJson(parsed.body, secrets),
        bodyIsJson: parsed.bodyIsJson,
      },
      elapsedMs,
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const error = describeTransportError(err);
    return {
      request: recordedRequest,
      response: null,
      error: { kind: error.kind, message: maskSensitive(error.message, secrets) },
      elapsedMs,
    };
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}
