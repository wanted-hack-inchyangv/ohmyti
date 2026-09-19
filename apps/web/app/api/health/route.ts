import { pingDatabase } from "@ohmyti/db";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export interface HealthResponse {
  ok: boolean;
  db: "ok" | "error";
  checkedAt: string;
}

/** DB 연결을 확인해 200 또는 503을 돌려준다. 응답에 연결 문자열 등 비밀값은 넣지 않는다. */
export async function checkHealth(ping: () => Promise<void>): Promise<HealthResponse> {
  let db: HealthResponse["db"] = "ok";
  try {
    await ping();
  } catch {
    db = "error";
  }
  return { ok: db === "ok", db, checkedAt: new Date().toISOString() };
}

export async function GET() {
  const report = await checkHealth(() => pingDatabase(getDb().db));
  return NextResponse.json(report, {
    status: report.ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
