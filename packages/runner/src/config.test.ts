import { describe, expect, it } from "vitest";
import {
  LOCAL_RUNNER_DEFAULTS,
  VERCEL_RUNNER_DEFAULTS,
  loadLocalRunnerConfig,
  loadVercelRunnerConfig,
} from "./config";

describe("loadLocalRunnerConfig", () => {
  it("TEMPLATE_ROOT가 없으면 오류다", () => {
    expect(() => loadLocalRunnerConfig({})).toThrow(/TEMPLATE_ROOT/);
  });

  it("기본값을 채운다", () => {
    const config = loadLocalRunnerConfig({ TEMPLATE_ROOT: "/opt/templates" });
    expect(config.templateRoot).toBe("/opt/templates");
    expect(config.runTimeoutMs).toBe(LOCAL_RUNNER_DEFAULTS.runTimeoutMs);
    expect(config.maxSourceFiles).toBe(500);
    expect(config.maxSourceBytes).toBe(20_971_520);
    expect(config.workRoot.length).toBeGreaterThan(0);
  });

  it("환경변수를 읽고 잘못된 값은 거부한다", () => {
    const config = loadLocalRunnerConfig({
      TEMPLATE_ROOT: "./templates",
      RUN_TIMEOUT_MS: "5000",
      RUN_MEMORY_MB: "256",
      HEALTH_TIMEOUT_MS: "10000",
      SANDBOX_WORK_ROOT: "/tmp/x",
    });
    expect(config).toMatchObject({
      runTimeoutMs: 5000,
      runMemoryMb: 256,
      healthTimeoutMs: 10_000,
      workRoot: "/tmp/x",
    });
    expect(() => loadLocalRunnerConfig({ TEMPLATE_ROOT: "x", RUN_TIMEOUT_MS: "abc" })).toThrow(
      /RUN_TIMEOUT_MS/,
    );
    expect(() => loadLocalRunnerConfig({ TEMPLATE_ROOT: "x", RUN_MEMORY_MB: "1" })).toThrow(
      /RUN_MEMORY_MB/,
    );
  });
});

describe("loadVercelRunnerConfig", () => {
  const creds = { VERCEL_TOKEN: "t", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "prj" };

  it("자격증명 셋이 모두 필요하다", () => {
    expect(() => loadVercelRunnerConfig({ TEMPLATE_ROOT: "x" })).toThrow(/VERCEL_TOKEN/);
    expect(() =>
      loadVercelRunnerConfig({ TEMPLATE_ROOT: "x", VERCEL_TOKEN: "t", VERCEL_TEAM_ID: "team" }),
    ).toThrow(/VERCEL_PROJECT_ID/);
  });

  it("공통 제한을 상속하고 샌드박스 기본값을 채운다", () => {
    const config = loadVercelRunnerConfig({ TEMPLATE_ROOT: "/opt/templates", ...creds });
    expect(config.credentials).toEqual({ token: "t", teamId: "team", projectId: "prj" });
    expect(config.image).toBe("vercel/sandbox/node:22");
    expect(config.vcpus).toBe(VERCEL_RUNNER_DEFAULTS.vcpus);
    expect(config.sessionTimeoutMs).toBe(15 * 60_000);
    expect(config.installTimeoutMs).toBe(5 * 60_000);
    expect(config.region).toBeUndefined();
    expect(config.runTimeoutMs).toBe(LOCAL_RUNNER_DEFAULTS.runTimeoutMs);
  });

  it("환경변수를 읽고 잘못된 값은 거부한다", () => {
    const config = loadVercelRunnerConfig({
      TEMPLATE_ROOT: "x",
      ...creds,
      VERCEL_SANDBOX_IMAGE: "vercel/sandbox/node:24",
      VERCEL_SANDBOX_VCPUS: "4",
      VERCEL_SANDBOX_TIMEOUT_MS: "600000",
      VERCEL_SANDBOX_INSTALL_TIMEOUT_MS: "120000",
      VERCEL_SANDBOX_REGION: "icn1",
    });
    expect(config).toMatchObject({
      image: "vercel/sandbox/node:24",
      vcpus: 4,
      sessionTimeoutMs: 600_000,
      installTimeoutMs: 120_000,
      region: "icn1",
    });
    expect(() =>
      loadVercelRunnerConfig({ TEMPLATE_ROOT: "x", ...creds, VERCEL_SANDBOX_VCPUS: "3" }),
    ).toThrow(/VERCEL_SANDBOX_VCPUS/);
    expect(() =>
      loadVercelRunnerConfig({ TEMPLATE_ROOT: "x", ...creds, VERCEL_SANDBOX_TIMEOUT_MS: "1000" }),
    ).toThrow(/VERCEL_SANDBOX_TIMEOUT_MS/);
  });
});
