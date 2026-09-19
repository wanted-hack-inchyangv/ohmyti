import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_SECONDS,
  createSessionToken,
  timingSafeEqualString,
  verifySessionToken,
} from "./session";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-09-18T00:00:00Z");

describe("session token", () => {
  it("발급한 토큰은 같은 키로 검증되고 만료는 7일 뒤다", async () => {
    const token = await createSessionToken(SECRET, NOW);
    const verdict = await verifySessionToken(token, SECRET, NOW);
    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.expiresAt.getTime()).toBe(NOW.getTime() + SESSION_TTL_SECONDS * 1000);
    }
  });

  it("서명이 변조된 토큰은 거부된다", async () => {
    const token = await createSessionToken(SECRET, NOW);
    const [version, exp, sig] = token.split(".") as [string, string, string];
    const flipped = sig.endsWith("A") ? `${sig.slice(0, -1)}B` : `${sig.slice(0, -1)}A`;
    const verdict = await verifySessionToken(`${version}.${exp}.${flipped}`, SECRET, NOW);
    expect(verdict).toEqual({ valid: false, reason: "BAD_SIGNATURE" });
  });

  it("만료 시각이 변조된 토큰은 서명 불일치로 거부된다", async () => {
    const token = await createSessionToken(SECRET, NOW);
    const [version, exp, sig] = token.split(".") as [string, string, string];
    const later = String(Number(exp) + 86_400 * 365);
    const verdict = await verifySessionToken(`${version}.${later}.${sig}`, SECRET, NOW);
    expect(verdict).toEqual({ valid: false, reason: "BAD_SIGNATURE" });
  });

  it("다른 키로 만든 토큰은 거부된다", async () => {
    const token = await createSessionToken("another-secret-another-secret-xx", NOW);
    const verdict = await verifySessionToken(token, SECRET, NOW);
    expect(verdict).toEqual({ valid: false, reason: "BAD_SIGNATURE" });
  });

  it("만료된 토큰은 거부된다", async () => {
    const token = await createSessionToken(SECRET, NOW);
    const afterExpiry = new Date(NOW.getTime() + (SESSION_TTL_SECONDS + 1) * 1000);
    const verdict = await verifySessionToken(token, SECRET, afterExpiry);
    expect(verdict).toEqual({ valid: false, reason: "EXPIRED" });
  });

  it("형식이 다른 값은 MALFORMED", async () => {
    for (const bad of [undefined, "", "abc", "v1.abc.def", "v2.1.x", "v1.1.2.3", "v1..sig"]) {
      const verdict = await verifySessionToken(bad, SECRET, NOW);
      expect(verdict).toEqual({ valid: false, reason: "MALFORMED" });
    }
  });

  it("timingSafeEqualString은 길이와 내용이 모두 같을 때만 true", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "abcd")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(true);
    expect(timingSafeEqualString("한글", "한글")).toBe(true);
  });
});
