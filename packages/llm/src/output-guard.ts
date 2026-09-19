import { z, type ZodType } from "zod";
import { LlmForbiddenOutputKeyError } from "./errors";

/**
 * LLM 출력 스키마에 둘 수 없는 키 (G-01). 점수 계산과 PASS/FAIL 판정은 결정적 엔진만 한다.
 * 타입(`ForbidScoreKeys`)과 실행 시점(`assertNoForbiddenOutputKeys`) 양쪽에서 막는다.
 */
export const FORBIDDEN_OUTPUT_KEYS = ["score", "points", "earned", "verdict"] as const;
export type ForbiddenOutputKey = (typeof FORBIDDEN_OUTPUT_KEYS)[number];

type Depth = readonly unknown[];

/** T의 어느 깊이에든 금지 키가 있으면 true. 재귀는 8단계에서 멈춘다. */
export type HasForbiddenKey<T, D extends Depth = []> = D["length"] extends 8
  ? false
  : T extends readonly (infer E)[]
    ? HasForbiddenKey<E, [...D, 0]>
    : T extends object
      ? [Extract<keyof T, ForbiddenOutputKey>] extends [never]
        ? true extends { [K in keyof T]-?: HasForbiddenKey<T[K], [...D, 0]> }[keyof T]
          ? true
          : false
        : true
      : false;

/**
 * `LlmClient.complete()` 요청 타입에 교차로 붙인다. 출력 타입에 금지 키가 있으면
 * 채울 수 없는 필드(`never`)가 요구되어 컴파일 오류가 난다.
 */
export type ForbidScoreKeys<T> =
  true extends HasForbiddenKey<T>
    ? { readonly __outputSchemaMustNotContainScoreOrVerdictKeys: never }
    : unknown;

/** zod 스키마를 JSON Schema로 바꾼다. 표현할 수 없는 타입은 제약 없음으로 둔다. */
export function outputJsonSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { unrepresentable: "any", io: "output" });
}

/** JSON Schema 안의 모든 `properties` 키를 모은다. */
export function collectPropertyKeys(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectPropertyKeys(item, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
        found.add(prop);
        collectPropertyKeys(sub, found);
      }
    } else {
      collectPropertyKeys(value, found);
    }
  }
  return found;
}

/** 실행 시점 방어. 타입 검사를 우회한 스키마(any 캐스팅 등)도 호출 전에 거부한다. */
export function assertNoForbiddenOutputKeys(schema: ZodType): void {
  const keys = collectPropertyKeys(outputJsonSchema(schema));
  const hits = [...keys].filter((k) =>
    (FORBIDDEN_OUTPUT_KEYS as readonly string[]).includes(k.toLowerCase()),
  );
  if (hits.length > 0) throw new LlmForbiddenOutputKeyError(hits);
}
