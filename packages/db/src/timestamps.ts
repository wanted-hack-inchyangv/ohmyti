import { TimestampSchema } from "@ohmyti/core";

/**
 * DB의 timestamptz(Date) ↔ @ohmyti/core의 ISO 8601 문자열 변환.
 * web·worker 사이를 JSON으로 오가는 값은 문자열, DB 컬럼은 Date로 다룬다 (결정 로그).
 */
export function toIsoTimestamp(date: Date): string {
  return date.toISOString();
}

export function fromIsoTimestamp(value: string): Date {
  const parsed = TimestampSchema.parse(value);
  return new Date(parsed);
}

export function toIsoTimestampOrUndefined(date: Date | null | undefined): string | undefined {
  return date == null ? undefined : toIsoTimestamp(date);
}
