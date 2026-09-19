/**
 * 도메인 오류. 오류 코드와 HTTP 상태 매핑을 이 파일 한 곳에 모은다 (SPEC 4절).
 * 새 오류 코드를 추가하려면 ERROR_STATUS에 한 줄만 더하면 된다.
 */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  INSUFFICIENT_STOCK: 409,
  ALREADY_CANCELLED: 409,
  IDEMPOTENCY_CONFLICT: 422,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}
