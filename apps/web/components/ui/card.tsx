import type { HTMLAttributes, ReactNode } from "react";

/** 흰 배경·회색 테두리 카드. 선택 상태는 파란 테두리로 표시한다 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  selected?: boolean;
  children: ReactNode;
}

export function Card({ selected = false, children, className, ...rest }: CardProps) {
  return (
    <div
      {...rest}
      data-selected={selected ? "true" : undefined}
      className={`min-w-0 rounded-lg border bg-surface transition-colors ${selected ? "border-primary ring-1 ring-primary" : "border-neutral-200"} ${className ?? ""}`}
    >
      {children}
    </div>
  );
}
