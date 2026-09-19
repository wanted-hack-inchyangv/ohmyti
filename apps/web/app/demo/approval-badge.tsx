import { Badge } from "@/components/ui";
import type { ApprovalBadgeView } from "@/lib/demo/service";

/**
 * `채점기 사전 검증 완료` 배지 (T-505, T-405 승인 정보). 통과한 검증 결과가 없으면 그렇다고 적는다.
 * 시드 승인이라 사람의 샘플 검토 서명이 비어 있으면 `샘플 검토 대기`를 함께 보인다(검증을 부풀리지 않는다).
 */
export function ApprovalBadge({ view }: { view: ApprovalBadgeView }) {
  return (
    <span
      className="inline-flex items-center gap-1"
      data-testid="approval-badge"
      data-validated={view.validated ? "true" : "false"}
    >
      <Badge tone={view.validated ? "ink" : "neutral"} title={view.detail}>
        {view.label}
      </Badge>
      {view.pendingHumanReview ? (
        <Badge
          tone="neutral"
          title="시드 승인입니다. 샘플 코드와 기대 결과표의 사람 검토 서명이 비어 있습니다"
        >
          샘플 검토 대기
        </Badge>
      ) : null}
    </span>
  );
}
