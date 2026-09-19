import { isDemoModeEnabled } from "@/lib/demo/service";

const NAV_LINK = "rounded-lg px-3 py-2 text-[15px] font-semibold text-ink hover:bg-neutral-100";

/** 모든 화면 위에 붙는 공통 헤더. 제품명과 주요 화면으로 가는 링크를 둔다 */
export function SiteHeader() {
  const demo = isDemoModeEnabled();
  return (
    <header
      className="sticky top-0 z-30 border-b border-neutral-200 bg-surface/95 backdrop-blur"
      data-testid="site-header"
    >
      <div
        data-site-header-inner
        className="mx-auto flex h-[60px] max-w-6xl items-center gap-6 px-4 sm:px-6"
      >
        <a
          href="/"
          className="group flex items-center gap-2.5 text-ink"
          aria-label="CodeGraph Reviewer 홈"
        >
          <LogoMark />
          <span className="hidden items-baseline gap-1.5 tracking-tight sm:flex">
            <span className="text-[17px] font-extrabold">CodeGraph</span>
            <span className="text-[15px] font-semibold text-neutral-500">Reviewer</span>
          </span>
        </a>
        <nav aria-label="주요 화면" className="flex items-center gap-1">
          {demo ? (
            <a href="/demo" className={NAV_LINK}>
              샘플 체험
            </a>
          ) : null}
          <a href="/assignments" className={NAV_LINK}>
            과제
          </a>
        </nav>
        <a
          href="/submissions/new"
          className="ml-auto inline-flex h-9 items-center rounded-lg border border-neutral-300 px-3.5 text-sm font-semibold text-primary hover:bg-primary/5"
        >
          채점 요청
        </a>
      </div>
    </header>
  );
}

function LogoMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 64 64"
      fill="none"
      className="size-8 shrink-0 transition-transform duration-200 group-hover:-rotate-3 group-hover:scale-105"
    >
      <path
        d="M47.5 16.5 32 8 14.5 18v27L32 55l15.5-9"
        stroke="#0066FF"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m28 32.5 7.5 7.5L50 24.5"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="14.5" cy="18" r="6.5" fill="#0066FF" />
      <circle cx="14.5" cy="45" r="6.5" fill="#0066FF" />
      <circle cx="32" cy="55" r="6.5" fill="#0066FF" />
    </svg>
  );
}
