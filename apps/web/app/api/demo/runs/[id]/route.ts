import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { rewakeWorkerIfDue } from "@/lib/worker-wake";
import { readDemoRunStatus } from "@/lib/demo/service";

export const dynamic = "force-dynamic";

/** 샘플 새 실행 상태 폴링 (T-505). 화면이 3초마다 부르고 `terminal`이면 멈춘다. 읽기만 한다 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await readDemoRunStatus({ db: getDb().db }, id);
  // 아직 끝나지 않았으면 워커가 유휴 대기 중이어도 깨어나게 한다 (적재 때의 깨우기를 놓친 경우의 보완)
  if (result.ok && !result.data.terminal) rewakeWorkerIfDue();
  const status = result.ok ? 200 : result.code === "RUN_NOT_FOUND" ? 404 : 400;
  return NextResponse.json(result, { status, headers: { "cache-control": "no-store" } });
}
