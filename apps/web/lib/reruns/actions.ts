"use server";

/**
 * 중앙 패널 `재실행` 버튼의 서버 액션 (T-307). 규칙은 `service.ts`에 있으며 여기서는 DB 핸들만 붙인다.
 * 워커가 job을 처리하는 동안 클라이언트는 `GET /api/evaluations/[id]/reruns`를 폴링하고, 끝나면 `router.refresh()`로
 * 서버 컴포넌트를 다시 그려 새 실행 기록을 목록에 보인다.
 */
import { getDb } from "@/lib/db";
import { requestRerun, type RerunResult } from "./service";
import type { RerunRequested } from "@ohmyti/core";

export async function requestRerunAction(
  evaluationId: string,
  caseId: unknown,
): Promise<RerunResult<RerunRequested>> {
  return requestRerun({ db: getDb().db }, evaluationId, caseId);
}
