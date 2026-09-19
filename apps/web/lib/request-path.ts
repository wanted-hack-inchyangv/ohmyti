/**
 * proxy가 요청 경로를 서버 컴포넌트에 넘기는 요청 헤더 (T-506). `not-found.tsx`는 params를 받지 않으므로
 * 삭제된 제출의 "삭제됨" 안내가 이 헤더로 제출 ID를 안다. 클라이언트가 보낸 같은 이름의 헤더는 proxy가 덮어쓴다.
 */
export const REQUEST_PATHNAME_HEADER = "x-ohmyti-pathname";

/**
 * 요청 헤더에서 이 배포의 origin(`https://host`)을 만든다 (T-704 내보내기의 절대 주소).
 * `host`가 없으면 null이며, 이때 내보내기는 상대 경로를 쓴다. 호스트 값은 URL에 넣기 전에 형태를 확인한다
 */
export function requestOrigin(headers: { get(name: string): string | null }): string | null {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host || !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const scheme = proto === "http" || proto === "https" ? proto : local ? "http" : "https";
  return `${scheme}://${host}`;
}

/** `/submissions/<id>` 경로에서 제출 ID를 꺼낸다. 형식이 다르면 null */
export function submissionIdFromPath(pathname: string | null): string | null {
  const match = /^\/submissions\/([0-9a-fA-F-]{36})\/?$/.exec(pathname ?? "");
  return match?.[1] ?? null;
}
