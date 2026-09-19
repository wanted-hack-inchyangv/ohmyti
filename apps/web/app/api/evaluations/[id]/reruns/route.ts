import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { readRerunStatus, rerunHttpStatusOf } from "@/lib/reruns/service";

export const dynamic = "force-dynamic";

/**
 * 재실행 상태 (T-307): 평가의 `RERUN_EXECUTION` job 목록과 횟수 상한. 응답은 `@ohmyti/core`의 `RerunStatusReportSchema`를
 * `{ ok, data }` 봉투에 담은 것이다. 화면이 재실행 진행 중에 폴링한다 (1.1: 상태 갱신은 폴링).
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await readRerunStatus({ db: getDb().db }, id);
  return NextResponse.json(result, {
    status: result.ok ? 200 : rerunHttpStatusOf(result.code),
    headers: { "cache-control": "no-store" },
  });
}
