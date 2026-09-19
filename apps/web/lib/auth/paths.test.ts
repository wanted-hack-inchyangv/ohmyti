import { describe, expect, it } from "vitest";
import { isPublicPath, sanitizeReturnPath } from "./paths";

describe("isPublicPath", () => {
  it("/login, /api/login, /api/health, /_next/*, robots.txt, favicon은 공개", () => {
    for (const p of [
      "/login",
      "/api/login",
      "/api/health",
      "/_next/static/chunks/main.js",
      "/_next/image?url=x",
      "/robots.txt",
      "/favicon.ico",
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it("그 밖의 경로는 보호 대상", () => {
    for (const p of [
      "/",
      "/submissions",
      "/api/submissions",
      "/login/extra",
      "/api/healthz",
      "/_nextish",
    ]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});

describe("sanitizeReturnPath", () => {
  it("같은 사이트의 절대 경로만 허용한다", () => {
    expect(sanitizeReturnPath("/submissions/1?tab=x")).toBe("/submissions/1?tab=x");
    expect(sanitizeReturnPath("/")).toBe("/");
  });

  it("외부 URL, 프로토콜 상대 경로, 개행, 빈 값은 루트로 바꾼다", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil",
      "/a\r\nSet-Cookie: x",
      "relative",
    ]) {
      expect(sanitizeReturnPath(bad), String(bad)).toBe("/");
    }
  });

  it("/login으로 되돌아가는 루프는 막는다", () => {
    expect(sanitizeReturnPath("/login")).toBe("/");
    expect(sanitizeReturnPath("/login?next=%2F")).toBe("/");
  });
});
