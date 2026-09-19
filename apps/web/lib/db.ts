import { createServerlessDb, type DbHandle } from "@ohmyti/db";

// Vercel 함수 인스턴스당 커넥션 1개(TICKET.md 1.1). 모듈 스코프 대신 globalThis에 두어
// 개발 모드의 HMR로 모듈이 다시 평가돼도 커넥션이 늘어나지 않게 한다.
const globalForDb = globalThis as typeof globalThis & { __ohmytiDb?: DbHandle };

/** 웹(서버 컴포넌트·라우트 핸들러·서버 액션)이 쓰는 DB 핸들. 첫 호출에서 만들고 재사용한다. */
export function getDb(): DbHandle {
  if (!globalForDb.__ohmytiDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL 환경변수가 설정되어 있지 않습니다");
    }
    globalForDb.__ohmytiDb = createServerlessDb(url);
  }
  return globalForDb.__ohmytiDb;
}
