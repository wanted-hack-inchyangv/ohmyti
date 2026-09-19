import { describe, expect, it } from "vitest";
import {
  DesignSignalsSchema,
  designSignalItems,
  weakAssertionPercent,
  type DesignSignalsOk,
} from "./design-signals";

const loc = (path: string, startLine: number, endLine = startLine) => ({
  path,
  startLine,
  endLine,
});

const SIGNALS: DesignSignalsOk = {
  status: "ok",
  analyzerVersion: "1",
  sourceFiles: 2,
  testFiles: 1,
  maxFileLines: { lines: 150, location: loc("src/index.ts", 1, 150) },
  maxFunctionLines: { lines: 51, name: "app.post 콜백", location: loc("src/index.ts", 56, 106) },
  explicitAny: { count: 12, asAny: 1, locations: [loc("src/index.ts", 8)] },
  tsconfig: { path: "tsconfig.json", strict: false },
  duplicateBlocks: {
    count: 1,
    groups: [
      { statements: 3, locations: [loc("src/index.ts", 48, 52), loc("src/index.ts", 117, 121)] },
    ],
  },
  busyWaits: { count: 1, locations: [loc("src/index.ts", 23)] },
  consoleLogs: { count: 0, locations: [] },
  weakAssertions: { count: 6, total: 6, locations: [loc("test/api.test.ts", 16)] },
};

describe("DesignSignalsSchema (T-605)", () => {
  it("ok·unavailable 결과를 받고, 점수·판정 키는 받지 않는다", () => {
    expect(DesignSignalsSchema.parse(SIGNALS)).toEqual(SIGNALS);
    expect(
      DesignSignalsSchema.parse({
        status: "unavailable",
        analyzerVersion: "1",
        reason: "시간 초과",
      }),
    ).toMatchObject({ status: "unavailable" });
    expect(DesignSignalsSchema.safeParse({ ...SIGNALS, score: 3 }).success).toBe(false);
    expect(
      DesignSignalsSchema.safeParse({
        ...SIGNALS,
        duplicateBlocks: { count: 1, groups: [{ statements: 3, locations: [loc("a.ts", 1)] }] },
      }).success,
    ).toBe(false);
  });

  it("약한 단언 비율은 단언이 없으면 null이다", () => {
    expect(weakAssertionPercent({ count: 1, total: 3 })).toBe(33.3);
    expect(weakAssertionPercent({ count: 0, total: 0 })).toBeNull();
  });

  it("표시 항목은 센 사실과 위치만 담는다", () => {
    const items = designSignalItems(SIGNALS);
    expect(items.map((i) => `${i.label}: ${i.value}`)).toEqual([
      "소스 파일: 2개 (테스트 파일 1개 별도)",
      "가장 긴 파일: src/index.ts · 150줄",
      "가장 긴 함수: app.post 콜백 · 51줄",
      "명시적 any: 12곳 (as any 1곳)",
      "tsconfig strict: 꺼짐",
      "같은 모양의 연속 문장 블록: 1건 (식별자 이름·리터럴 값만 다른 3문장 이상)",
      "바쁜 대기: 1곳 (플래그 조건 반복문 안의 await)",
      "console.log: 0곳 (테스트 제외)",
      "제출 테스트의 약한 단언: expect 단언 6개 중 6개 (100%, toBeTruthy·toBeDefined·상태 코드 범위 비교)",
    ]);
    expect(items.find((i) => i.id === "duplicate-blocks")!.locations).toHaveLength(2);
    expect(items.find((i) => i.id === "busy-waits")!.locations).toEqual([loc("src/index.ts", 23)]);
    expect(
      designSignalItems({ ...SIGNALS, tsconfig: { path: null, strict: null } }).find(
        (i) => i.id === "tsconfig-strict",
      )!.value,
    ).toBe("tsconfig.json 없음");
  });
});
