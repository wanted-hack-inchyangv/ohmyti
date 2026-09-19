import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import { reportResponse } from "@/lib/reports/http";
import { readRunRecord } from "@/lib/reports/service";

export const dynamic = "force-dynamic";

/**
 * 실행 기록 본문 (T-207): 기록의 ref가 가리키는 input·expected·actual·timeline과 stdout·stderr 로그 키.
 * 응답은 `@ohmyti/core`의 `RunRecordReportResponseSchema`다.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await context.params;
  return reportResponse(
    await readRunRecord({ db: getDb().db, store: getArtifactStore() }, id, runId),
  );
}
