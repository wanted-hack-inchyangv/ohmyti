import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import { reportResponse } from "@/lib/reports/http";
import { readFunctionGraph } from "@/lib/reports/service";

export const dynamic = "force-dynamic";

/**
 * 관련 함수 그래프 분석 결과 (T-304): 워커가 저장한 `evaluations/<id>/analysis/function-graph.json` 그대로.
 * 응답은 `@ohmyti/core`의 `FunctionGraphReportResponseSchema`다.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return reportResponse(await readFunctionGraph({ db: getDb().db, store: getArtifactStore() }, id));
}
