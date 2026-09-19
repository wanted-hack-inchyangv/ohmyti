import { NextResponse } from "next/server";
import { resolveAccessConfig } from "@/lib/auth/config";
import { handleLogin, readLoginInput } from "@/lib/auth/login";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const config = resolveAccessConfig(process.env);
  const input = await readLoginInput(request);
  const result = await handleLogin(input, config);

  const response = NextResponse.json(result.body, {
    status: result.status,
    headers: { "cache-control": "no-store" },
  });
  if (result.status === 200 && result.sessionToken) {
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: result.sessionToken,
      httpOnly: true,
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
  }
  return response;
}
