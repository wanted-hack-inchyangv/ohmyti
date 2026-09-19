import type { ReactNode } from "react";

/**
 * 빈 상태. 아직 연결되지 않은 패널(뒤 티켓), 데이터 없음, 선택 없음을 같은 형태로 보여 준다.
 * 진행률·가짜 값을 꾸미지 않는다 (G-08).
 */
export function EmptyState({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-start gap-1 rounded-lg bg-neutral-50 px-5 py-8 text-sm"
    >
      <p className="font-semibold text-neutral-800">{title}</p>
      {description ? <p className="text-neutral-500">{description}</p> : null}
      {children}
    </div>
  );
}
