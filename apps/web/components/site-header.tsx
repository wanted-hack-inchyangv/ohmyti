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
      <div className="mx-auto flex h-[60px] max-w-6xl items-center gap-6 px-4 sm:px-6">
        <a href="/" className="flex items-center gap-2 text-ink">
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-lg bg-primary text-[12px] font-extrabold text-surface"
          >
            CG
          </span>
          <span className="hidden text-[17px] font-bold tracking-tight sm:inline">
            CodeGraph Reviewer
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
