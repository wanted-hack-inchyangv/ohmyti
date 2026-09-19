import { describe, expect, it } from "vitest";
import { VitestReportParseError, parseVitestReport } from "./vitest-report";

const WORK = "/tmp/ohmyti-sandbox-x/work";

function report(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      startTime: 1000,
      success: false,
      testResults: [
        {
          assertionResults: [
            {
              ancestorTitles: ["suite"],
              fullName: "suite ok",
              status: "passed",
              title: "ok",
              duration: 3,
              failureMessages: [],
            },
            {
              ancestorTitles: ["suite"],
              fullName: "suite bad",
              status: "failed",
              title: "bad",
              duration: 4,
              failureMessages: [
                `AssertionError: expected 1 to be 2\n    at ${WORK}/test/a.test.ts:12:5\n  token sk-abcdefghijklmnop1234 [31mred[0m`,
              ],
            },
          ],
          startTime: 1000,
          endTime: 1010,
          status: "failed",
          message: "",
          name: `${WORK}/test/a.test.ts`,
        },
      ],
      ...overrides,
    }),
  );
}

describe("parseVitestReport", () => {
  it("요약 수치·파일별 테스트를 상대 경로로 옮기고 메시지를 정리한다", () => {
    const parsed = parseVitestReport(report(), {
      workDirs: [WORK],
      stripPaths: ["/tmp/ohmyti-sandbox-x"],
    });
    expect(parsed).toMatchObject({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      success: false,
      truncated: false,
    });
    expect(parsed.testFiles).toHaveLength(1);
    const file = parsed.testFiles[0]!;
    expect(file.path).toBe("test/a.test.ts");
    expect(file.status).toBe("failed");
    expect(file.error).toBeNull();
    expect(file.durationMs).toBe(10);
    expect(file.tests.map((t) => t.status)).toEqual(["passed", "failed"]);
    const message = file.tests[1]!.failureMessages[0]!;
    expect(message).toContain("at test/a.test.ts:12:5");
    expect(message).not.toContain(WORK);
    expect(message).not.toContain("sk-abcdefghijklmnop1234");
    expect(message).not.toContain("[");
    expect(parsed.fileErrors).toEqual([]);
  });

  it("realpath로 기록된 경로도 상대 경로로 바꾼다 (macOS /private/tmp)", () => {
    const real = `/private${WORK}`;
    const base = JSON.parse(new TextDecoder().decode(report())) as {
      testResults: Record<string, unknown>[];
    };
    const parsed = parseVitestReport(
      report({ testResults: [{ ...base.testResults[0], name: `${real}/test/a.test.ts` }] }),
      { workDirs: [WORK, real] },
    );
    expect(parsed.testFiles[0]!.path).toBe("test/a.test.ts");
  });

  it("테스트 없이 실패한 파일은 fileErrors에 들어간다 (변환 오류)", () => {
    const parsed = parseVitestReport(
      report({
        numTotalTests: 0,
        numPassedTests: 0,
        numFailedTests: 0,
        testResults: [
          {
            assertionResults: [],
            startTime: 1000,
            endTime: 1000,
            status: "failed",
            message: "Transform failed with 1 error:\n[31m[PARSE_ERROR][0m Unexpected token",
            name: `${WORK}/test/bad.test.ts`,
          },
        ],
      }),
      { workDirs: [WORK] },
    );
    expect(parsed.total).toBe(0);
    expect(parsed.fileErrors).toEqual([
      {
        path: "test/bad.test.ts",
        error: "Transform failed with 1 error:\n[PARSE_ERROR] Unexpected token",
      },
    ]);
    expect(parsed.testFiles[0]!.error).toContain("Transform failed");
  });

  it("skipped·todo·pending은 모두 skipped로 센다", () => {
    const parsed = parseVitestReport(
      report({
        numTotalTests: 3,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 2,
        numTodoTests: 1,
        success: true,
        testResults: [
          {
            assertionResults: ["skipped", "todo", "pending"].map((status) => ({
              ancestorTitles: [],
              fullName: status,
              status,
              title: status,
              failureMessages: [],
            })),
            startTime: 0,
            endTime: 0,
            status: "passed",
            message: "",
            name: `${WORK}/t.test.ts`,
          },
        ],
      }),
      { workDirs: [WORK] },
    );
    expect(parsed.skipped).toBe(3);
    expect(parsed.testFiles[0]!.skipped).toBe(3);
    expect(parsed.testFiles[0]!.tests.map((t) => t.status)).toEqual(["skipped", "todo", "pending"]);
  });

  it("테스트 수 상한을 넘으면 개수는 유지하고 목록만 자르며 truncated다", () => {
    const parsed = parseVitestReport(report(), { workDirs: [WORK], maxTests: 1 });
    expect(parsed.total).toBe(2);
    expect(parsed.testFiles[0]!.total).toBe(2);
    expect(parsed.testFiles[0]!.tests).toHaveLength(1);
    expect(parsed.truncated).toBe(true);
  });

  it("JSON이 아니거나 형식이 다르면 VitestReportParseError", () => {
    expect(() =>
      parseVitestReport(new TextEncoder().encode("PASS 49 passed"), { workDirs: [WORK] }),
    ).toThrow(VitestReportParseError);
    expect(() =>
      parseVitestReport(new TextEncoder().encode(JSON.stringify({ score: 100, verdict: "PASS" })), {
        workDirs: [WORK],
      }),
    ).toThrow(VitestReportParseError);
    expect(() => parseVitestReport(report({ numTotalTests: "49" }), { workDirs: [WORK] })).toThrow(
      /numTotalTests/,
    );
  });
});
