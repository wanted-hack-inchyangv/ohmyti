import { NextResponse } from "next/server";
import { httpStatusOf, type ReportResult } from "./service";

/** `ReportResult`를 JSON 응답으로 만든다. 조회 결과는 캐시하지 않는다 (재실행·사람 수정으로 바뀐다) */
export function reportResponse<T>(result: ReportResult<T>): NextResponse {
  const status = result.ok ? 200 : httpStatusOf(result.code);
  return NextResponse.json(result, { status, headers: { "cache-control": "no-store" } });
}
