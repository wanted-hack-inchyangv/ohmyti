/**
 * 접근 쿠키 토큰: `v1.<만료 epoch 초>.<base64url(HMAC-SHA256(secret, "v1.<만료>"))>`.
 * Web Crypto만 사용해 proxy(Node 런타임)와 라우트 핸들러 어디서든 같은 코드를 쓴다.
 */

export const SESSION_COOKIE_NAME = "ohmyti_access";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const TOKEN_VERSION = "v1";
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** 길이가 같을 때 내용 비교 시간이 값에 따라 달라지지 않게 한다. 길이 차이는 노출된다. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

export async function createSessionToken(
  secret: string,
  now: Date = new Date(),
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  const expiresAt = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const payload = `${TOKEN_VERSION}.${expiresAt}`;
  const signature = toBase64Url(await hmacSha256(secret, payload));
  return `${payload}.${signature}`;
}

export type SessionVerdict =
  | { valid: true; expiresAt: Date }
  | { valid: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  now: Date = new Date(),
): Promise<SessionVerdict> {
  if (!token) return { valid: false, reason: "MALFORMED" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION)
    return { valid: false, reason: "MALFORMED" };
  const [, expiresRaw, signature] = parts;
  if (!/^\d{1,12}$/.test(expiresRaw!)) return { valid: false, reason: "MALFORMED" };

  const payload = `${TOKEN_VERSION}.${expiresRaw}`;
  const expected = toBase64Url(await hmacSha256(secret, payload));
  if (!timingSafeEqualString(signature!, expected))
    return { valid: false, reason: "BAD_SIGNATURE" };

  const expiresAt = new Date(Number(expiresRaw) * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { valid: false, reason: "EXPIRED" };
  return { valid: true, expiresAt };
}
