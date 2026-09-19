import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { readDemoRunStatus } from "@/lib/demo/service";

export const dynamic = "force-dynamic";

/** 샘플 새 실행 상태 폴링 (T-505). 화면이 3초마다 부르고 `terminal`이면 멈춘다. 읽기만 한다 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await readDemoRunStatus({ db: getDb().db }, id);
  const status = result.ok ? 200 : result.code === "RUN_NOT_FOUND" ? 404 : 400;
  return NextResponse.json(result, { status, headers: { "cache-control": "no-store" } });
}
