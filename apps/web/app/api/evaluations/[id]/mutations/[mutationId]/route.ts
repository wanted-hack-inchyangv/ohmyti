import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import { reportResponse } from "@/lib/reports/http";
import { readMutationDiff } from "@/lib/reports/service";

export const dynamic = "force-dynamic";

/**
 * 변형 실험의 diff (T-404): 워커가 저장한 `evaluations/<id>/mutations/<mutationId>/diff.patch` 본문 그대로.
 * 응답 `data`는 `@ohmyti/core`의 `MutationDiffReportSchema`다.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; mutationId: string }> },
) {
  const { id, mutationId } = await context.params;
  return reportResponse(
    await readMutationDiff({ db: getDb().db, store: getArtifactStore() }, id, mutationId),
  );
}
