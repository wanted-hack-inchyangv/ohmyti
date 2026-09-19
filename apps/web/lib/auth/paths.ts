/** 보호 대상에서 제외되는 경로. proxy의 matcher와 함께 이중으로 검사한다. */
const PUBLIC_EXACT = new Set([
  "/login",
  "/api/login",
  "/api/health",
  "/robots.txt",
  "/favicon.ico",
]);
const PUBLIC_PREFIXES = ["/_next/"];

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * 로그인 후 돌아갈 경로를 같은 사이트의 절대 경로로 제한한다.
 * `//evil.example`이나 `/\evil` 같은 값은 외부로 빠져나갈 수 있으므로 루트로 바꾼다.
 */
export function sanitizeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\r\n]/.test(value)) return "/";
  if (value === "/login" || value.startsWith("/login?")) return "/";
  return value;
}
