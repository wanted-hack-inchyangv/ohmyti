import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  /** 원시 postgres 클라이언트. 마이그레이션·테스트 유틸에서만 쓴다 */
  sql: Sql;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  url: string;
  /** 커넥션 풀 크기 */
  max: number;
  /** 유휴 커넥션 정리 시간(초). 서버리스는 짧게 둔다 */
  idleTimeout?: number;
}

/** 공통 팩토리. 용도별 프리셋은 아래 두 함수를 쓴다. */
export function createDb(options: CreateDbOptions): DbHandle {
  const sql = postgres(options.url, {
    max: options.max,
    idle_timeout: options.idleTimeout ?? 30,
    // 서버 측 prepared statement는 PgBouncer 트랜잭션 풀링과 충돌하므로 끈다.
    prepare: false,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

/** Vercel 서버리스 함수용. 함수 인스턴스당 커넥션 1개 (1.1). */
export function createServerlessDb(url: string): DbHandle {
  return createDb({ url, max: 1, idleTimeout: 10 });
}

/** Railway 워커용. 폴링 + 동시 실행을 감안해 10개. */
export function createWorkerDb(url: string): DbHandle {
  return createDb({ url, max: 10 });
}

/** 환경변수에서 연결 문자열을 읽는다. 없으면 즉시 실패해 잘못된 배포를 빨리 드러낸다. */
export function requireDatabaseUrl(name: "DATABASE_URL" | "DATABASE_URL_TEST" = "DATABASE_URL") {
  const url = process.env[name];
  if (!url) {
    throw new Error(`${name} 환경변수가 설정되어 있지 않습니다`);
  }
  return url;
}

/** 연결 확인용 `select 1`. 헬스 체크가 쓴다. 실패하면 드라이버 오류를 그대로 던진다. */
export async function pingDatabase(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}
