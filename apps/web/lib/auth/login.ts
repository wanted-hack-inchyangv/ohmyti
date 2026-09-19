import { type AccessConfig } from "./config";
import { sanitizeReturnPath } from "./paths";
import { createSessionToken, timingSafeEqualString } from "./session";

export interface LoginInput {
  password: string;
  next?: string | null;
}

export type LoginResult =
  | { status: 200; body: { ok: true; redirectTo: string }; sessionToken?: string }
  | { status: 401; body: { ok: false; error: string } };

/** 비밀번호를 확인하고 성공하면 발급할 세션 토큰을 돌려준다. 보호가 꺼져 있으면 토큰 없이 통과시킨다. */
export async function handleLogin(
  input: LoginInput,
  config: AccessConfig,
  now: Date = new Date(),
): Promise<LoginResult> {
  const redirectTo = sanitizeReturnPath(input.next);
  if (!config.enabled) {
    return { status: 200, body: { ok: true, redirectTo } };
  }
  if (!timingSafeEqualString(input.password, config.password)) {
    return { status: 401, body: { ok: false, error: "비밀번호가 올바르지 않습니다" } };
  }
  const sessionToken = await createSessionToken(config.secret, now);
  return { status: 200, body: { ok: true, redirectTo }, sessionToken };
}

/** JSON 또는 form 본문에서 로그인 입력을 읽는다. 알 수 없는 형식이면 빈 비밀번호로 취급한다. */
export async function readLoginInput(request: Request): Promise<LoginInput> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const raw: unknown = await request.json().catch(() => null);
    const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      password: typeof body.password === "string" ? body.password : "",
      next: typeof body.next === "string" ? body.next : null,
    };
  }
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData().catch(() => null);
    const password = form?.get("password");
    const next = form?.get("next");
    return {
      password: typeof password === "string" ? password : "",
      next: typeof next === "string" ? next : null,
    };
  }
  return { password: "", next: null };
}
