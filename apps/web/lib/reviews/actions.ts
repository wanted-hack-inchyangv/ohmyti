"use server";

/**
 * 워크벤치 오른쪽 패널의 검토 액션 (T-306). 실제 규칙과 트랜잭션은 `service.ts`에 있으며 여기서는 DB 핸들만 붙인다.
 * 성공하면 클라이언트가 `router.refresh()`로 서버 컴포넌트를 다시 그려 헤더 점수·판정·이력을 갱신한다.
 */
import { getDb } from "@/lib/db";
import { applyReviewAction, type ReviewActionResult, type ReviewApplied } from "./service";

export async function submitReviewAction(
  target: { evaluationId: string; criterionId: string },
  input: unknown,
): Promise<ReviewActionResult<ReviewApplied>> {
  return applyReviewAction({ db: getDb().db }, target, input);
}
