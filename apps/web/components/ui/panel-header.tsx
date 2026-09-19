import type { ReactNode } from "react";

/** 패널 상단: 제목과 오른쪽 보조 정보. 세 열과 하단 탭이 같은 높이·글꼴을 쓴다 */
export function PanelHeader({
  title,
  aside,
  level = 2,
}: {
  title: string;
  aside?: ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
      <Heading className="truncate text-[15px] font-bold tracking-tight text-ink">{title}</Heading>
      {aside ? <div className="flex shrink-0 items-center gap-2 text-xs">{aside}</div> : null}
    </div>
  );
}
