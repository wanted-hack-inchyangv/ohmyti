import { readEvaluationContextReport } from "@/lib/context/service";
import { getDb } from "@/lib/db";
import { reportResponse } from "@/lib/reports/http";

export const dynamic = "force-dynamic";

/**
 * 지원자 맥락 (T-606): 워크벤치 하단 탭과 같은 맥락 연결·GitHub 보충 조회 결과. 이력서 본문은 없다.
 * 응답은 `@ohmyti/core`의 `EvaluationContextReportResponseSchema`다. 점수·판정과 무관하다.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return reportResponse(await readEvaluationContextReport({ db: getDb().db }, id));
}
