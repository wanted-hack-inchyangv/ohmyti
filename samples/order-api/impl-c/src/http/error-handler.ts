import { type ErrorRequestHandler } from "express";
import { AppError } from "../domain/errors.js";

/** 본문 파서(express.json)가 던지는 오류인지 판별한다. JSON 파싱 실패는 400 VALIDATION_ERROR다. */
function isBodyParseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    (err as { type?: unknown }).type === "entity.parse.failed"
  );
}

/**
 * 오류 응답 직렬화를 한 곳에서 처리한다 (SPEC 3절 `{ error: { code, message } }`).
 * 도메인 오류는 AppError의 상태·코드를 그대로 쓰고, 그 밖의 오류는 500이다.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (isBodyParseError(err)) {
    res
      .status(400)
      .json({ error: { code: "VALIDATION_ERROR", message: "request body is not valid JSON" } });
    return;
  }
  const message = err instanceof Error ? err.message : "unexpected error";
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message } });
};
