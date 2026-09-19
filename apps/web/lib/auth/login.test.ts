import { describe, expect, it } from "vitest";
import { type AccessConfig } from "./config";
import { handleLogin, readLoginInput } from "./login";
import { verifySessionToken } from "./session";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-09-18T00:00:00Z");
const ENABLED: AccessConfig = { enabled: true, password: "correct horse", secret: SECRET };

describe("handleLogin", () => {
  it("잘못된 비밀번호는 401이고 토큰을 만들지 않는다", async () => {
    const result = await handleLogin({ password: "wrong", next: "/x" }, ENABLED, NOW);
    expect(result.status).toBe(401);
    expect("sessionToken" in result).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain("correct horse");
  });

  it("올바른 비밀번호는 200, 검증되는 토큰, 원래 경로", async () => {
    const result = await handleLogin(
      { password: "correct horse", next: "/submissions/9" },
      ENABLED,
      NOW,
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, redirectTo: "/submissions/9" });
    if (result.status === 200) {
      const verdict = await verifySessionToken(result.sessionToken, SECRET, NOW);
      expect(verdict.valid).toBe(true);
    }
  });

  it("외부 URL을 next로 주면 루트로 보낸다", async () => {
    const result = await handleLogin(
      { password: "correct horse", next: "//evil.example" },
      ENABLED,
      NOW,
    );
    expect(result.body).toEqual({ ok: true, redirectTo: "/" });
  });

  it("보호가 꺼져 있으면 토큰 없이 통과한다", async () => {
    const result = await handleLogin(
      { password: "" },
      { enabled: false, reason: "NO_PASSWORD_IN_DEVELOPMENT" },
      NOW,
    );
    expect(result).toEqual({ status: 200, body: { ok: true, redirectTo: "/" } });
  });
});

describe("readLoginInput", () => {
  it("JSON 본문", async () => {
    const request = new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "a", next: "/b", extra: 1 }),
    });
    expect(await readLoginInput(request)).toEqual({ password: "a", next: "/b" });
  });

  it("form 본문", async () => {
    const request = new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "a", next: "/b" }).toString(),
    });
    expect(await readLoginInput(request)).toEqual({ password: "a", next: "/b" });
  });

  it("깨진 JSON이나 알 수 없는 형식은 빈 비밀번호", async () => {
    const broken = new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(await readLoginInput(broken)).toEqual({ password: "", next: null });
    const plain = new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "pw",
    });
    expect(await readLoginInput(plain)).toEqual({ password: "", next: null });
  });
});
