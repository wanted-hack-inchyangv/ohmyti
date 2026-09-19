/**
 * proxy가 요청 경로를 서버 컴포넌트에 넘기는 요청 헤더 (T-506). `not-found.tsx`는 params를 받지 않으므로
 * 삭제된 제출의 "삭제됨" 안내가 이 헤더로 제출 ID를 안다. 클라이언트가 보낸 같은 이름의 헤더는 proxy가 덮어쓴다.
 */
export const REQUEST_PATHNAME_HEADER = "x-ohmyti-pathname";

/** `/submissions/<id>` 경로에서 제출 ID를 꺼낸다. 형식이 다르면 null */
export function submissionIdFromPath(pathname: string | null): string | null {
  const match = /^\/submissions\/([0-9a-fA-F-]{36})\/?$/.exec(pathname ?? "");
  return match?.[1] ?? null;
}
