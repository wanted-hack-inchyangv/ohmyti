import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";
import { fromIsoTimestamp, toIsoTimestamp, toIsoTimestampOrUndefined } from "./timestamps";

describe("@ohmyti/db timestamps", () => {
  it("패키지 이름을 내보낸다", () => {
    expect(PACKAGE_NAME).toBe("@ohmyti/db");
  });

  it("Date ↔ ISO 8601 문자열을 왕복한다", () => {
    const date = new Date("2026-09-18T05:04:03.210Z");
    const iso = toIsoTimestamp(date);
    expect(iso).toBe("2026-09-18T05:04:03.210Z");
    expect(fromIsoTimestamp(iso).getTime()).toBe(date.getTime());
  });

  it("오프셋이 있는 문자열도 받는다", () => {
    expect(fromIsoTimestamp("2026-09-18T14:00:00+09:00").toISOString()).toBe(
      "2026-09-18T05:00:00.000Z",
    );
  });

  it("오프셋이 없는 문자열은 거부한다", () => {
    expect(() => fromIsoTimestamp("2026-09-18T14:00:00")).toThrow();
  });

  it("null·undefined는 undefined로 변환한다", () => {
    expect(toIsoTimestampOrUndefined(null)).toBeUndefined();
    expect(toIsoTimestampOrUndefined(undefined)).toBeUndefined();
    expect(toIsoTimestampOrUndefined(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
  });
});
