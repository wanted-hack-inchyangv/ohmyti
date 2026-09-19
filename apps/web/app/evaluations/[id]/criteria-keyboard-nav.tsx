"use client";

import type { KeyboardEvent, ReactNode } from "react";

/**
 * 기준 카드 목록의 키보드 상하 이동 (T-302). ↑/↓는 이전·다음 카드 링크로 포커스를 옮기고
 * Home/End는 처음·끝으로 간다. 선택(URL 갱신)은 링크의 기본 동작(Enter)이 맡으므로
 * 이 컴포넌트는 상태를 갖지 않고 네트워크 요청도 하지 않는다.
 */
export const CRITERION_LINK_SELECTOR = "a[data-criterion-link]";

export function moveFocus(links: HTMLAnchorElement[], current: number, key: string): number {
  if (links.length === 0) return -1;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(current + 1, links.length - 1);
    case "ArrowUp":
      return current < 0 ? links.length - 1 : Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return links.length - 1;
    default:
      return -1;
  }
}

export function CriteriaKeyboardNav({ children }: { children: ReactNode }) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const links = Array.from(
      event.currentTarget.querySelectorAll<HTMLAnchorElement>(CRITERION_LINK_SELECTOR),
    );
    const current = links.findIndex((link) => link === document.activeElement);
    const next = moveFocus(links, current, event.key);
    if (next < 0) return;
    event.preventDefault();
    links[next]?.focus();
  }
  return (
    <div onKeyDown={onKeyDown} data-testid="criteria-keyboard-nav">
      {children}
    </div>
  );
}
