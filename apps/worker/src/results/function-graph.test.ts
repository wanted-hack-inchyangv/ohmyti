import { DEFAULT_CASE_SET, HarnessReportSchema, type HarnessReport } from "@ohmyti/harness";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeRepoFiles } from "../repo/test-support";
import { caseInputsOf, runFunctionGraphAnalysis, templateNodeModulesDir } from "./function-graph";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates");
const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");

async function readTree(dir: string, base = dir): Promise<FakeRepoFiles> {
  const out: FakeRepoFiles = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) Object.assign(out, await readTree(full, base));
    else out[path.relative(base, full)] = await readFile(full);
  }
  return out;
}

describe("caseInputsOf", () => {
  it("보고서의 케이스 timeline을 요청 목록으로 옮기고 reset은 준비 요청으로 표시한다", () => {
    const report: HarnessReport = HarnessReportSchema.parse({
      caseSet: DEFAULT_CASE_SET,
      harnessVersion: "h",
      rubricVersion: "v1",
      baseUrl: "http://127.0.0.1:1",
      requestTimeoutMs: 5000,
      startedAt: "2026-09-18T09:00:00.000Z",
      finishedAt: "2026-09-18T09:00:01.000Z",
      summary: { total: 1, pass: 1, fail: 0, inconclusive: 0 },
      results: [
        {
          caseId: "R-01-normal-order",
          criterionIds: ["R-01"],
          verdict: "PASS",
          failureKind: "NONE",
          startedAt: "2026-09-18T09:00:00.000Z",
          finishedAt: "2026-09-18T09:00:01.000Z",
          timeline: [
            {
              seq: 0,
              stepIndex: -1,
              kind: "reset",
              request: { method: "POST", path: "/admin/reset", headers: {}, body: null },
              response: { status: 200, headers: {}, body: { ok: true }, bodyIsJson: true },
              elapsedMs: 1,
            },
            {
              seq: 1,
              stepIndex: 0,
              kind: "request",
              request: { method: "POST", path: "/orders", headers: {}, body: { productId: "p1" } },
              response: { status: 201, headers: {}, body: {}, bodyIsJson: true },
              elapsedMs: 2,
            },
          ],
          checks: [],
          expected: {},
          actual: {},
        },
      ],
    });
    expect(caseInputsOf(report)).toEqual([
      {
        caseId: "R-01-normal-order",
        requests: [
          { method: "POST", path: "/admin/reset", isSetup: true },
          { method: "POST", path: "/orders", isSetup: false },
        ],
      },
    ]);
    expect(caseInputsOf(null)).toEqual([]);
    expect(templateNodeModulesDir("./templates", "order-api-ts")).toBe(
      path.resolve("templates", "order-api-ts", "node_modules"),
    );
  });

  it("보고서가 없어도(기동 실패) 라우트는 분석하고 정적 관계 근거는 없다", async () => {
    const tree = await readTree(path.join(SAMPLES_DIR, "impl-b"));
    const files = {
      listFiles: () => Promise.resolve(Object.keys(tree).sort()),
      readText: (p: string) => Promise.resolve(tree[p] ? tree[p].toString("utf8") : null),
    };
    const { analysis, staticRelations } = await runFunctionGraphAnalysis({
      files,
      harness: null,
      templateRoot: TEMPLATE_ROOT,
      templateName: "order-api-ts",
    });
    expect(analysis.status).toBe("ok");
    if (analysis.status === "ok") {
      expect(analysis.routes.some((r) => r.method === "POST" && r.path === "/orders")).toBe(true);
      expect(analysis.cases).toEqual([]);
    }
    expect(staticRelations).toEqual([]);
  });
});
