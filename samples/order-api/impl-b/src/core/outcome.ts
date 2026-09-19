/**
 * 명령 결과를 값으로 돌려주는 타입. 예외 대신 실패 코드를 담는다.
 * HTTP 상태 변환은 api.ts가 맡으며, 여기서는 SPEC 4절의 오류 코드만 안다.
 */
export type FailureCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "INSUFFICIENT_STOCK"
  | "ALREADY_CANCELLED"
  | "IDEMPOTENCY_CONFLICT";

export type Failure = { ok: false; code: FailureCode; reason: string };
export type Success<T> = { ok: true; value: T };
export type Outcome<T> = Success<T> | Failure;

export const ok = <T>(value: T): Success<T> => ({ ok: true, value });
export const fail = (code: FailureCode, reason: string): Failure => ({ ok: false, code, reason });
