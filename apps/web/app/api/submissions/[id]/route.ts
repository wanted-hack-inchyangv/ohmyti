import { getDb } from "@/lib/db";
import { reportResponse } from "@/lib/reports/http";
import { readSubmissionSummary } from "@/lib/reports/service";

export const dynamic = "force-dynamic";

/**
 * 제출 상태와 최신 평가 ID (T-207). 화면용 단계 뷰는 `./status`(T-206)가 따로 낸다.
 * 응답은 `@ohmyti/core`의 `SubmissionSummaryResponseSchema`다.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return reportResponse(await readSubmissionSummary({ db: getDb().db }, id));
}
