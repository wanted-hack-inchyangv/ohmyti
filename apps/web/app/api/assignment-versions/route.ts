import { getDb } from "@/lib/db";
import { reportResponse } from "@/lib/reports/http";
import { listApprovedVersionOptions } from "@/lib/submissions/service";

export const dynamic = "force-dynamic";

/**
 * 제출 가능한(APPROVED) 과제 버전 목록 (T-208). 게이트 스크립트가 제출할 버전 ID를 찾는 데 쓴다.
 * 폼(T-206)의 선택지와 같은 `listApprovedVersionOptions`를 쓴다. 접근 보호는 proxy(T-008)가 적용한다.
 */
export async function GET() {
  return reportResponse({ ok: true, data: await listApprovedVersionOptions({ db: getDb().db }) });
}
