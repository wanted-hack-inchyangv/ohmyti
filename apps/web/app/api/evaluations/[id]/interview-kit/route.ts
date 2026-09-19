import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import { reportResponse } from "@/lib/reports/http";
import { readInterviewKit } from "@/lib/reports/service";

export const dynamic = "force-dynamic";

/**
 * 인터뷰 키트 (T-704): 워커가 저장한 키트 아티팩트 그대로. 응답은 `@ohmyti/core`의 `InterviewKitReportResponseSchema`다.
 * 키트가 없는 이전 평가는 404(`ARTIFACT_NOT_FOUND`)다. 점수·판정을 담지 않는다.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return reportResponse(await readInterviewKit({ db: getDb().db, store: getArtifactStore() }, id));
}
