/**
 * `harnessVersion = <패키지 버전>+<케이스 해시>`.
 * 케이스 정의는 선언형 JSON이므로 정규 직렬화(키 정렬)의 sha256으로 해시한다. 소스 파일을 읽지 않아
 * 워커 번들 안에서도 같은 값이 나온다. 케이스 문장이 하나라도 바뀌면 버전이 바뀐다.
 */
import { createHash } from "node:crypto";
import type { CaseDefinition, JsonValue } from "./dsl";

/** `package.json`의 version과 같아야 한다 (테스트로 대조). */
export const HARNESS_PACKAGE_VERSION = "0.1.0";

export const CASE_HASH_LENGTH = 16;

/** 객체 키를 재귀적으로 정렬해 직렬화한다. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value as JsonValue));
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]!);
    return out;
  }
  return value;
}

export function caseSetDigest(cases: readonly CaseDefinition[]): string {
  return createHash("sha256").update(canonicalJson(cases)).digest("hex");
}

export function harnessVersionOf(cases: readonly CaseDefinition[]): string {
  return `${HARNESS_PACKAGE_VERSION}+${caseSetDigest(cases).slice(0, CASE_HASH_LENGTH)}`;
}
