import { describe, expect, it } from "vitest";
import { type AccessConfig } from "./config";
import { decideAccess, type GuardInput } from "./guard";
import { createSessionToken } from "./session";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-09-18T00:00:00Z");
const ENABLED: AccessConfig = { enabled: true, password: "pw", secret: SECRET };
const DISABLED: AccessConfig = { enabled: false, reason: "NO_PASSWORD_IN_DEVELOPMENT" };

function page(pathname: string, overrides: Partial<GuardInput> = {}): GuardInput {
  return {
    pathname,
    search: "",
    method: "GET",
    accept: "text/html,application/xhtml+xml",
    sessionToken: undefined,
    ...overrides,
  };
}

describe("decideAccess", () => {
  it("보호가 꺼져 있으면 모든 경로를 허용한다", async () => {
    expect(await decideAccess(page("/"), DISABLED, NOW)).toEqual({ kind: "allow" });
    expect(
      await decideAccess(page("/api/x", { accept: null, method: "POST" }), DISABLED, NOW),
    ).toEqual({
      kind: "allow",
    });
  });

  it("/api/health, /login, /_next/*는 쿠키 없이도 허용한다", async () => {
    for (const p of ["/api/health", "/login", "/_next/static/a.js", "/robots.txt"]) {
      expect(await decideAccess(page(p), ENABLED, NOW), p).toEqual({ kind: "allow" });
    }
  });

  it("쿠키 없는 HTML 탐색은 /login?next=원래경로로 보낸다", async () => {
    const decision = await decideAccess(
      page("/submissions/1", { search: "?tab=graph" }),
      ENABLED,
      NOW,
    );
    expect(decision).toEqual({
      kind: "redirect",
      location: `/login?next=${encodeURIComponent("/submissions/1?tab=graph")}`,
    });
  });

  it("쿠키 없는 API·비HTML 요청은 401", async () => {
    expect(
      await decideAccess(page("/api/submissions", { accept: "application/json" }), ENABLED, NOW),
    ).toEqual({
      kind: "unauthorized",
    });
    expect(await decideAccess(page("/api/submissions"), ENABLED, NOW)).toEqual({
      kind: "unauthorized",
    });
    expect(await decideAccess(page("/submit", { method: "POST" }), ENABLED, NOW)).toEqual({
      kind: "unauthorized",
    });
  });

  it("유효한 쿠키는 허용하고, 변조·만료된 쿠키는 거부한다", async () => {
    const token = await createSessionToken(SECRET, NOW);
    expect(await decideAccess(page("/", { sessionToken: token }), ENABLED, NOW)).toEqual({
      kind: "allow",
    });

    const tampered = `${token.slice(0, -2)}zz`;
    const rejected = await decideAccess(page("/", { sessionToken: tampered }), ENABLED, NOW);
    expect(rejected.kind).toBe("redirect");

    const expired = await decideAccess(
      page("/", { sessionToken: token }),
      ENABLED,
      new Date(NOW.getTime() + 8 * 86_400 * 1000),
    );
    expect(expired.kind).toBe("redirect");
  });
});
