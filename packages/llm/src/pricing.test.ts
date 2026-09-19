import { describe, expect, it } from "vitest";
import { computeDeepSeekCostUsd, isDeepSeekPeak } from "./pricing";

// 2026-09-21은 월요일, 2026-09-19는 토요일
const MON_PEAK = new Date("2026-09-21T07:30:00Z");
const MON_OFF = new Date("2026-09-21T05:00:00Z");
const SAT = new Date("2026-09-19T07:30:00Z");

describe("DeepSeek 가격표", () => {
  it("피크 시간은 평일 UTC 01–04시, 06–10시다", () => {
    expect(isDeepSeekPeak(MON_PEAK)).toBe(true);
    expect(isDeepSeekPeak(new Date("2026-09-21T01:00:00Z"))).toBe(true);
    expect(isDeepSeekPeak(new Date("2026-09-21T04:00:00Z"))).toBe(false);
    expect(isDeepSeekPeak(MON_OFF)).toBe(false);
    expect(isDeepSeekPeak(new Date("2026-09-21T10:00:00Z"))).toBe(false);
    expect(isDeepSeekPeak(SAT)).toBe(false);
  });

  it("캐시 적중·미적중 입력과 출력을 따로 계산하고 오프피크는 절반이다", () => {
    const tokens = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 };
    // 피크: 0.4*0.006 + 0.6*0.3 + 0.1*1.2 = 0.0024 + 0.18 + 0.12
    expect(computeDeepSeekCostUsd("deepseek-flash", tokens, MON_PEAK)).toEqual({
      costUsd: 0.3024,
      priceKnown: true,
    });
    expect(computeDeepSeekCostUsd("deepseek-flash", tokens, MON_OFF).costUsd).toBe(0.1512);
    // deepseek-chat은 deepseek-flash 별칭
    expect(computeDeepSeekCostUsd("deepseek-chat", tokens, MON_PEAK).costUsd).toBe(0.3024);
  });

  it("모르는 모델은 가장 비싼 피크 단가로 계산한다", () => {
    const tokens = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };
    expect(computeDeepSeekCostUsd("deepseek-v9", tokens, SAT)).toEqual({
      costUsd: 5.28,
      priceKnown: false,
    });
  });
});
