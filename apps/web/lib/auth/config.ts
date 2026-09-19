/**
 * 접근 보호 설정 (TICKET.md T-008).
 * - `APP_ACCESS_PASSWORD`가 있으면 보호가 켜지고 `SESSION_SECRET`이 반드시 필요하다.
 * - 없으면 production에서는 오류(기동 실패), 그 밖의 모드에서는 보호를 끈다.
 * - `APP_ACCESS_MODE=public`이면 모드와 상관없이 보호를 끈다 (공개 데모 배포). 비밀번호보다 우선한다.
 */

export interface AccessEnv {
  APP_ACCESS_PASSWORD?: string;
  APP_ACCESS_MODE?: string;
  SESSION_SECRET?: string;
  NODE_ENV?: string;
}

export type AccessConfig =
  | { enabled: false; reason: "NO_PASSWORD_IN_DEVELOPMENT" | "PUBLIC_MODE" }
  | { enabled: true; password: string; secret: string };

/** 서명 키 최소 길이. 짧은 키는 HMAC 위조 시도에 취약하다. */
export const MIN_SESSION_SECRET_LENGTH = 32;

export class AccessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessConfigError";
  }
}

export function resolveAccessConfig(env: AccessEnv): AccessConfig {
  if (env.APP_ACCESS_MODE?.trim().toLowerCase() === "public") {
    return { enabled: false, reason: "PUBLIC_MODE" };
  }

  const password = env.APP_ACCESS_PASSWORD ?? "";
  const secret = env.SESSION_SECRET ?? "";
  const isProduction = env.NODE_ENV === "production";

  if (password === "") {
    if (isProduction) {
      throw new AccessConfigError(
        "APP_ACCESS_PASSWORD가 설정되어 있지 않습니다. production에서는 접근 보호 없이 기동할 수 없습니다",
      );
    }
    return { enabled: false, reason: "NO_PASSWORD_IN_DEVELOPMENT" };
  }

  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new AccessConfigError(
      `SESSION_SECRET은 ${MIN_SESSION_SECRET_LENGTH}자 이상이어야 합니다 (APP_ACCESS_PASSWORD가 설정된 경우 필수)`,
    );
  }

  return { enabled: true, password, secret };
}
