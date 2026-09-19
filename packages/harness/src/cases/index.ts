import type { CaseDefinition } from "../dsl";
import { ORDER_API_V1_CASES, ORDER_API_V1_CASE_SET } from "./order-api-v1";

export * from "./order-api-v1";

/** 이름으로 고르는 케이스 집합. 과제가 늘면 여기에 추가한다. */
export const CASE_SETS: Readonly<Record<string, readonly CaseDefinition[]>> = {
  [ORDER_API_V1_CASE_SET]: ORDER_API_V1_CASES,
};

export const DEFAULT_CASE_SET = ORDER_API_V1_CASE_SET;

export function getCaseSet(name: string): readonly CaseDefinition[] {
  const cases = CASE_SETS[name];
  if (!cases) {
    throw new Error(
      `알 수 없는 케이스 집합: ${name} (사용 가능: ${Object.keys(CASE_SETS).join(", ")})`,
    );
  }
  return cases;
}
