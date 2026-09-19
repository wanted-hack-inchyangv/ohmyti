import { afterEach, describe, expect, it, vi } from "vitest";
import { setJobEnqueuedHook } from "./queue";
import { installWorkerWakeHook, resolveWorkerWakeUrl, wakeWorker } from "./wake";

describe("워커 깨우기", () => {
  afterEach(() => setJobEnqueuedHook(null));

  it("WORKER_WAKE_URL이 없으면 주소도 훅도 없다", () => {
    expect(resolveWorkerWakeUrl({})).toBeNull();
    expect(resolveWorkerWakeUrl({ WORKER_WAKE_URL: "  " })).toBeNull();
    expect(installWorkerWakeHook({})).toBe(false);
  });

  it("http(s)가 아닌 주소는 거부한다", () => {
    expect(() => resolveWorkerWakeUrl({ WORKER_WAKE_URL: "ftp://worker/wake" })).toThrow(
      /http\(s\)/,
    );
  });

  it("재운 서비스의 첫 502 뒤에 다시 시도해 성공하면 true", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response("{}", { status: 202 }));
    const ok = await wakeWorker("https://worker.example/wake", {
      fetch: fetchMock,
      retryDelayMs: 1,
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("끝까지 실패해도 던지지 않고 false", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("연결 실패"));
    const ok = await wakeWorker("https://worker.example/wake", {
      fetch: fetchMock,
      attempts: 2,
      retryDelayMs: 1,
    });
    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
