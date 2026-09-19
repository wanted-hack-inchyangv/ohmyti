import { describe, expect, it } from "vitest";
import { HarnessCaseActualSchema, HarnessCaseExpectedSchema, ReplayTimelineSchema } from "./replay";

/** 재생용 스키마는 모르는 필드를 통과시키고(looseObject) 필수 필드가 없으면 거부한다 */
describe("replay schemas", () => {
  const entry = {
    seq: 0,
    stepIndex: -1,
    kind: "reset",
    request: { method: "POST", path: "/admin/reset", headers: {}, body: null },
    response: { status: 200, headers: {}, body: { ok: true }, bodyIsJson: true },
    elapsedMs: 3,
    futureField: "ignored",
  };

  it("타임라인 항목은 모르는 필드를 보존하고 필수 필드가 없으면 거부한다", () => {
    const parsed = ReplayTimelineSchema.parse([entry]);
    expect(parsed[0]).toMatchObject({ seq: 0, kind: "reset", futureField: "ignored" });
    expect(ReplayTimelineSchema.safeParse([{ ...entry, request: undefined }]).success).toBe(false);
    expect(ReplayTimelineSchema.safeParse([{ ...entry, kind: "unknown" }]).success).toBe(false);
  });

  it("하네스 케이스의 expected·actual 형태를 검사한다", () => {
    expect(
      HarnessCaseExpectedSchema.safeParse({
        caseId: "R-05-idempotent-resend",
        expected: { "p1After.stock": 1 },
        checks: [{ name: "p1After.stock", expected: 1 }],
      }).success,
    ).toBe(true);
    expect(
      HarnessCaseActualSchema.safeParse({
        caseId: "R-05-idempotent-resend",
        verdict: "FAIL",
        failureKind: "ASSERTION",
        reason: null,
        actual: { "p1After.stock": 0 },
        checks: [{ name: "p1After.stock", ok: false, expected: 1, actual: 0 }],
      }).success,
    ).toBe(true);
    // checks[].ok가 없으면 판정을 화면에서 계산해야 하므로 거부한다
    expect(
      HarnessCaseActualSchema.safeParse({
        caseId: "x",
        verdict: "FAIL",
        failureKind: "ASSERTION",
        reason: null,
        actual: {},
        checks: [{ name: "a", expected: 1, actual: 0 }],
      }).success,
    ).toBe(false);
  });
});
