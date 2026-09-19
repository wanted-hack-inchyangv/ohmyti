/**
 * DeepSeek 가격표 설정. 출처: https://api-docs.deepseek.com/quick_start/pricing (2026-09-19 확인)
 * 단가는 100만 토큰당 USD이며 피크 시간 기준이다. 오프피크는 피크의 50%다.
 * 가격이 바뀌면 이 표와 `DEEPSEEK_PRICING_CHECKED_AT`을 함께 고친다.
 */
export const DEEPSEEK_PRICING_CHECKED_AT = "2026-09-19";
export const DEEPSEEK_PRICING_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing";

export interface ModelPrice {
  /** 캐시 적중 입력 */
  inputCacheHitPerMTok: number;
  /** 캐시 미적중 입력 */
  inputCacheMissPerMTok: number;
  outputPerMTok: number;
}

export const DEEPSEEK_PEAK_PRICES: Record<string, ModelPrice> = {
  "deepseek-flash": { inputCacheHitPerMTok: 0.006, inputCacheMissPerMTok: 0.3, outputPerMTok: 1.2 },
  "deepseek-v4-pro": {
    inputCacheHitPerMTok: 0.044,
    inputCacheMissPerMTok: 1.32,
    outputPerMTok: 3.96,
  },
};

/** 문서에 있는 별칭. `deepseek-chat`도 현재 `deepseek-flash`가 응답한다(2026-09-19 실제 호출로 확인). */
export const DEEPSEEK_MODEL_ALIASES: Record<string, string> = {
  "deepseek-chat": "deepseek-flash",
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

export const OFF_PEAK_MULTIPLIER = 0.5;

/** 피크 시간: 월~금 UTC 01:00–04:00, 06:00–10:00. */
export function isDeepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export interface TokenCounts {
  inputTokens: number;
  /** inputTokens 중 캐시 적중 수 */
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * 사용량으로 비용을 계산한다. 가격표에 없는 모델은 과소 계산을 피하려고 가장 비싼 단가(피크)로 계산한다.
 * 예산 상한(G-14 비용 보호)이 목적이므로 과대 계산 쪽으로 틀린다.
 */
export function computeDeepSeekCostUsd(
  model: string,
  tokens: TokenCounts,
  at: Date,
): { costUsd: number; priceKnown: boolean } {
  const canonical = DEEPSEEK_MODEL_ALIASES[model] ?? model;
  const known = DEEPSEEK_PEAK_PRICES[canonical];
  const price = known ?? mostExpensive();
  const multiplier = known && !isDeepSeekPeak(at) ? OFF_PEAK_MULTIPLIER : 1;
  const hit = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  const miss = tokens.inputTokens - hit;
  const raw =
    (hit * price.inputCacheHitPerMTok +
      miss * price.inputCacheMissPerMTok +
      tokens.outputTokens * price.outputPerMTok) /
    1_000_000;
  return { costUsd: roundUsd(raw * multiplier), priceKnown: known !== undefined };
}

function mostExpensive(): ModelPrice {
  return Object.values(DEEPSEEK_PEAK_PRICES).reduce((a, b) =>
    b.outputPerMTok > a.outputPerMTok ? b : a,
  );
}

/** `ai_reviews.cost_usd`가 numeric(10,6)이므로 소수 6자리로 맞춘다. */
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
