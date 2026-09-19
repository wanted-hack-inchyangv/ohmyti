"use client";

import { useState } from "react";

/** 클립보드 복사 버튼. 복사 결과는 버튼 옆 문구로만 알린다 */
export function CopyButton({
  value,
  label,
  idleText = "복사",
}: {
  value: string;
  label: string;
  /** 복사 전 버튼 글자 (기본 `복사`) */
  idleText?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      title={label}
      data-copy-state={state}
      className="inline-flex h-7 shrink-0 items-center rounded-md border border-neutral-200 bg-surface px-2 text-[12px] font-semibold text-neutral-600 transition-colors hover:border-neutral-300 hover:bg-neutral-50 hover:text-ink"
    >
      {state === "copied" ? "복사됨" : state === "failed" ? "복사 실패" : idleText}
    </button>
  );
}
