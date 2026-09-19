import { NextResponse, type NextRequest } from "next/server";
import { resolveAccessConfig } from "@/lib/auth/config";
import { decideAccess } from "@/lib/auth/guard";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { REQUEST_PATHNAME_HEADER } from "@/lib/request-path";

/**
 * 접근 보호 (T-008). `APP_ACCESS_PASSWORD`가 설정되면 공개 경로(/login, /api/health, /_next/*, robots.txt)
 * 외 모든 요청에 서명 쿠키를 요구한다. 설정이 잘못되면 열어 두지 않고 503으로 닫는다.
 */
export async function proxy(request: NextRequest) {
  let config;
  try {
    config = resolveAccessConfig(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "접근 보호 설정 오류";
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }

  const decision = await decideAccess(
    {
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
      method: request.method,
      accept: request.headers.get("accept"),
      sessionToken: request.cookies.get(SESSION_COOKIE_NAME)?.value,
    },
    config,
  );

  switch (decision.kind) {
    case "allow": {
      // not-found 화면이 경로를 알 수 있게 넘긴다 (삭제된 제출 안내, T-506)
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set(REQUEST_PATHNAME_HEADER, request.nextUrl.pathname);
      return NextResponse.next({ request: { headers: requestHeaders } });
    }
    case "redirect":
      return NextResponse.redirect(new URL(decision.location, request.url));
    case "unauthorized":
      return NextResponse.json({ ok: false, error: "로그인이 필요합니다" }, { status: 401 });
  }
}

export const config = {
  // 정적 자산과 이미지 최적화는 proxy를 거치지 않는다. 나머지 공개 경로는 decideAccess가 판단한다.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
