import { describe, expect, it } from "vitest";
import { collectSecrets, loadWorkerConfig, WORKER_CONFIG_DEFAULTS } from "./config";

describe("loadWorkerConfig", () => {
  it("환경변수가 없으면 기본값을 쓰고 파생 주기를 계산한다", () => {
    const config = loadWorkerConfig({});
    expect(config.pollIntervalMs).toBe(WORKER_CONFIG_DEFAULTS.pollIntervalMs);
    expect(config.concurrency).toBe(1);
    expect(config.staleMs).toBe(60_000);
    expect(config.heartbeatIntervalMs).toBe(20_000);
    expect(config.reclaimIntervalMs).toBe(30_000);
    expect(config.healthPort).toBe(8080);
    expect(config.workerId).toMatch(/.+-\d+$/);
  });

  it("환경변수 값을 읽고 heartbeat 주기가 stale 시간보다 길면 거절한다", () => {
    const config = loadWorkerConfig({
      WORKER_ID: "w-a",
      WORKER_POLL_INTERVAL_MS: "50",
      WORKER_CONCURRENCY: "4",
      WORKER_STALE_MS: "900",
      PORT: "0",
    });
    expect(config).toMatchObject({
      workerId: "w-a",
      pollIntervalMs: 50,
      concurrency: 4,
      staleMs: 900,
      heartbeatIntervalMs: 300,
      reclaimIntervalMs: 450,
      healthPort: 0,
    });
    expect(() =>
      loadWorkerConfig({ WORKER_STALE_MS: "100", WORKER_HEARTBEAT_INTERVAL_MS: "100" }),
    ).toThrow(/WORKER_HEARTBEAT_INTERVAL_MS/);
    expect(() => loadWorkerConfig({ WORKER_CONCURRENCY: "0" })).toThrow(/WORKER_CONCURRENCY/);
    expect(() => loadWorkerConfig({ WORKER_POLL_INTERVAL_MS: "abc" })).toThrow(
      /WORKER_POLL_INTERVAL_MS/,
    );
  });
});

describe("collectSecrets", () => {
  it("비밀 환경변수 값과 연결 문자열의 비밀번호를 모은다", () => {
    const secrets = collectSecrets({
      DATABASE_URL: "postgresql://user:p%40ss@host:5432/db",
      DEEP_SEEK_API_KEY: "sk-deepseek-key",
      GITHUB_TOKEN: "   ",
      DEMO_MODE: "1",
    });
    expect(secrets).toEqual(
      expect.arrayContaining(["postgresql://user:p%40ss@host:5432/db", "p@ss", "sk-deepseek-key"]),
    );
    expect(secrets).not.toContain("1");
    expect(secrets).toHaveLength(3);
  });
});
