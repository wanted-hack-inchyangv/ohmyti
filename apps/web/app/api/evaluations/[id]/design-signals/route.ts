import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import { reportResponse } from "@/lib/reports/http";
import { readDesignSignals } from "@/lib/reports/service";

export const dynamic = "force-dynamic";

/**
 * 설계 평가용 코드 신호 (T-605): 워커가 저장한 `evaluations/<id>/analysis/design-signals.json` 그대로.
 * 응답은 `@ohmyti/core`의 `DesignSignalsReportResponseSchema`다. 점수·판정과 무관하다.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return reportResponse(await readDesignSignals({ db: getDb().db, store: getArtifactStore() }, id));
}
