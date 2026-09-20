import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXAMPLE_ASSIGNMENT } from "./example-spec";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("T-906 예시 명세", () => {
  it("원본 명세의 엔드포인트와 오류 코드를 모두 담는다", () => {
    const spec = EXAMPLE_ASSIGNMENT.specMarkdown;
    for (const endpoint of [
      "GET /health",
      "POST /admin/reset",
      "GET /products/:id",
      "POST /orders",
      "GET /orders/:id",
      "POST /orders/:id/cancel",
    ]) {
      expect(spec, endpoint).toContain(endpoint);
    }
    for (const code of [
      "VALIDATION_ERROR",
      "NOT_FOUND",
      "INSUFFICIENT_STOCK",
      "ALREADY_CANCELLED",
      "IDEMPOTENCY_CONFLICT",
    ]) {
      expect(spec, code).toContain(code);
    }
  });

  it("원본 명세와 같은 시드 데이터·실행 계약 전제를 쓴다", () => {
    const original = readFileSync(path.join(REPO_ROOT, "samples/order-api/SPEC.md"), "utf8");
    const contract = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "samples/order-api/execution-contract.json"), "utf8"),
    ) as { healthPath: string; resetPath: string };
    expect(EXAMPLE_ASSIGNMENT.specMarkdown).toContain(contract.healthPath);
    expect(EXAMPLE_ASSIGNMENT.specMarkdown).toContain(contract.resetPath);
    // 시드 재고는 원본과 같아야 한다 (`p1` 2, `p2` 5, `p3` 0)
    for (const line of ["`p1` | Keyboard | 2", "`p2` | Mouse | 5", "`p3` | Monitor | 0"]) {
      expect(EXAMPLE_ASSIGNMENT.specMarkdown).toContain(line);
    }
    expect(original).toContain("Idempotency-Key");
  });

  it("점수·판정을 적지 않는다 (기준은 AI 초안이나 사람이 정한다)", () => {
    const text = `${EXAMPLE_ASSIGNMENT.name} ${EXAMPLE_ASSIGNMENT.description} ${EXAMPLE_ASSIGNMENT.specMarkdown}`;
    expect(text).not.toMatch(/배점\s*\d|\d+\s*점\b|합격|불합격/);
  });
});
