import { getDb } from "@/lib/db";
import { reportResponse } from "@/lib/reports/http";
import { readEvaluationReport } from "@/lib/reports/service";

export const dynamic = "force-dynamic";

/**
 * 평가 리포트 JSON (T-207): 저장된 점수, 기준별 판정·근거, 실행 기록 참조, `stage_log`, 검토 이력.
 * 응답은 `@ohmyti/core`의 `EvaluationReportResponseSchema`다. 접근 보호는 proxy가 적용한다 (미인증 401).
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return reportResponse(await readEvaluationReport({ db: getDb().db }, id));
}
