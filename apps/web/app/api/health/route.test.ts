import { describe, expect, it } from "vitest";
import { checkHealth } from "./route";

describe("GET /api/health", () => {
  it("DB ping이 성공하면 ok", async () => {
    const report = await checkHealth(() => Promise.resolve());
    expect(report.ok).toBe(true);
    expect(report.db).toBe("ok");
    expect(() => new Date(report.checkedAt).toISOString()).not.toThrow();
  });

  it("DB ping이 실패하면 ok=false, db=error이고 오류 내용은 응답에 넣지 않는다", async () => {
    const report = await checkHealth(() => {
      return Promise.reject(new Error("password authentication failed for user secret"));
    });
    expect(report.ok).toBe(false);
    expect(report.db).toBe("error");
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});
