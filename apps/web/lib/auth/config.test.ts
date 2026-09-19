import { describe, expect, it } from "vitest";
import { AccessConfigError, resolveAccessConfig } from "./config";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("resolveAccessConfig", () => {
  it("비밀번호 미설정 + development면 보호가 꺼진다", () => {
    const config = resolveAccessConfig({ NODE_ENV: "development" });
    expect(config).toEqual({ enabled: false, reason: "NO_PASSWORD_IN_DEVELOPMENT" });
  });

  it("비밀번호 미설정 + test도 보호가 꺼진다 (production만 오류)", () => {
    expect(resolveAccessConfig({ NODE_ENV: "test" }).enabled).toBe(false);
  });

  it("비밀번호 미설정 + production이면 AccessConfigError를 던진다", () => {
    expect(() => resolveAccessConfig({ NODE_ENV: "production" })).toThrow(AccessConfigError);
    expect(() => resolveAccessConfig({ NODE_ENV: "production", APP_ACCESS_PASSWORD: "" })).toThrow(
      /APP_ACCESS_PASSWORD/,
    );
  });

  it("APP_ACCESS_MODE=public이면 production에서도 비밀번호 없이 보호가 꺼진다", () => {
    expect(resolveAccessConfig({ NODE_ENV: "production", APP_ACCESS_MODE: "public" })).toEqual({
      enabled: false,
      reason: "PUBLIC_MODE",
    });
    expect(
      resolveAccessConfig({
        NODE_ENV: "production",
        APP_ACCESS_MODE: " Public ",
        APP_ACCESS_PASSWORD: "pw",
        SESSION_SECRET: SECRET,
      }).enabled,
    ).toBe(false);
  });

  it("APP_ACCESS_MODE가 public이 아니면 기존 규칙을 따른다", () => {
    expect(() =>
      resolveAccessConfig({ NODE_ENV: "production", APP_ACCESS_MODE: "private" }),
    ).toThrow(AccessConfigError);
  });

  it("비밀번호가 있으면 SESSION_SECRET이 32자 이상이어야 한다", () => {
    expect(() =>
      resolveAccessConfig({ NODE_ENV: "development", APP_ACCESS_PASSWORD: "pw" }),
    ).toThrow(/SESSION_SECRET/);
    expect(() =>
      resolveAccessConfig({
        NODE_ENV: "development",
        APP_ACCESS_PASSWORD: "pw",
        SESSION_SECRET: "short",
      }),
    ).toThrow(/SESSION_SECRET/);
  });

  it("비밀번호와 서명 키가 있으면 보호가 켜진다", () => {
    const config = resolveAccessConfig({
      NODE_ENV: "production",
      APP_ACCESS_PASSWORD: "pw",
      SESSION_SECRET: SECRET,
    });
    expect(config).toEqual({ enabled: true, password: "pw", secret: SECRET });
  });
});
