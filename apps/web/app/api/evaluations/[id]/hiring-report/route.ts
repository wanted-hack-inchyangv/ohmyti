import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import { readHiringReport } from "@/lib/reports/hiring-report";
import { reportResponse } from "@/lib/reports/http";

export const dynamic = "force-dynamic";

/**
 * 채용 리포트 (T-705): 저장된 판정·근거·키트·맥락 연결을 PRD 14.3의 9개 절로 조립해 돌려준다.
 * 응답은 `@ohmyti/core`의 `HiringReportResponseSchema`이며, 새 판단도 새 LLM 호출도 없다.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return reportResponse(await readHiringReport({ db: getDb().db, store: getArtifactStore() }, id));
}
