import type { ReactNode } from "react";

/**
 * 일반 화면의 본문 틀. 원티드처럼 넓은 고정 폭(최대 1120px)과 넉넉한 위아래 여백을 쓴다.
 * 워크벤치처럼 화면 전체를 쓰는 곳은 이 틀을 쓰지 않는다.
 */
export function PageContainer({
  children,
  width = "default",
  className,
  ...rest
}: {
  children: ReactNode;
  width?: "narrow" | "default" | "wide";
  className?: string;
  "data-testid"?: string;
}) {
  const max = width === "narrow" ? "max-w-2xl" : width === "wide" ? "max-w-6xl" : "max-w-5xl";
  return (
    <main
      data-testid={rest["data-testid"]}
      className={`mx-auto flex w-full ${max} flex-col gap-8 px-4 pt-10 pb-20 sm:px-6 sm:pt-14 ${className ?? ""}`}
    >
      {children}
    </main>
  );
}

/** 화면 제목. 제목 옆 배지, 아래 설명, 오른쪽 동작을 둔다 */
export function PageHeader({
  title,
  description,
  badges,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        {eyebrow ? <div className="text-sm font-semibold text-primary">{eyebrow}</div> : null}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-bold tracking-tight sm:text-[28px]">{title}</h1>
          {badges}
        </div>
        {description ? (
          <div className="max-w-3xl text-[15px] leading-relaxed text-neutral-600">
            {description}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** 섹션 제목 (원티드의 "한 번쯤 가보고 싶은 회사"처럼 굵은 소제목 + 오른쪽 보조 링크) */
export function SectionHeader({ title, aside }: { title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-bold tracking-tight sm:text-xl">{title}</h2>
      {aside ? <div className="text-sm text-neutral-500">{aside}</div> : null}
    </div>
  );
}

/** 입력 요소 공통 클래스 */
export const inputClassName =
  "h-12 w-full rounded-lg border border-neutral-300 bg-surface px-4 text-[15px] text-ink placeholder:text-neutral-400 hover:border-neutral-400 focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none aria-[invalid=true]:border-fail";

/** 안내 박스 (정보·주의) */
export function Notice({
  children,
  tone = "info",
  ...rest
}: {
  children: ReactNode;
  tone?: "info" | "neutral" | "error";
  "data-testid"?: string;
}) {
  const cls =
    tone === "info"
      ? "bg-primary/5 text-neutral-800"
      : tone === "error"
        ? "bg-fail/5 text-neutral-800 ring-1 ring-fail/20"
        : "bg-neutral-50 text-neutral-700";
  return (
    <div
      data-testid={rest["data-testid"]}
      className={`rounded-lg px-4 py-3 text-sm leading-relaxed ${cls}`}
    >
      {children}
    </div>
  );
}
