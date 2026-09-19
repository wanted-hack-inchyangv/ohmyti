"use server";

/**
 * 샘플 체험 서버 액션 (T-505). 실제 로직은 `service.ts`에 있으며 여기서는 DB·스토어 핸들만 넘긴다.
 * 웹은 저장된 스냅샷 바이트를 복사하고 job을 넣을 뿐 코드를 실행하지 않는다 (G-05).
 */
import { getArtifactStore } from "@/lib/artifacts";
import { getDb } from "@/lib/db";
import { startDemoRun, type DemoResult, type StartedDemoRun } from "./service";

/** `이 샘플로 새로 실행`. 성공하면 클라이언트가 `/demo/runs/<submissionId>`로 이동한다 */
export async function startDemoRunAction(sampleId: string): Promise<DemoResult<StartedDemoRun>> {
  return startDemoRun({ db: getDb().db, store: getArtifactStore() }, sampleId);
}
