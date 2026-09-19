import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { readSubmissionStatus } from "@/lib/submissions/service";

export const dynamic = "force-dynamic";

/**
 * 제출 상태 폴링 (T-206). 화면이 3초마다 부르고, 응답의 `terminal`이 true면 멈춘다.
 * 접근 보호는 proxy가 적용한다. 리포트 조회 API는 T-207(`/api/submissions/[id]`, `/api/evaluations/[id]`).
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await readSubmissionStatus({ db: getDb().db }, id);
  const status = result.ok ? 200 : result.code === "SUBMISSION_NOT_FOUND" ? 404 : 400;
  return NextResponse.json(result, { status, headers: { "cache-control": "no-store" } });
}
