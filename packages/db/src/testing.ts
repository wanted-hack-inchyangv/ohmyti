import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDb, requireDatabaseUrl, type DbHandle } from "./client";
import { runMigrations } from "./migrate";

export interface TestDatabase extends DbHandle {
  /** 임시 데이터베이스 이름 */
  name: string;
  /** 임시 데이터베이스 연결 문자열. 자식 프로세스에 넘길 때 쓴다 */
  url: string;
  /** 커넥션을 닫고 임시 데이터베이스를 지운다 */
  destroy: () => Promise<void>;
}

/**
 * `DATABASE_URL_TEST`가 가리키는 서버에 임시 데이터베이스를 만들고 마이그레이션을 적용한다.
 * 테스트마다 격리된 스키마를 얻으며, `destroy()`가 데이터베이스를 지운다.
 *
 * 스키마(search_path)가 아니라 데이터베이스를 만드는 이유: drizzle-kit이 생성하는 enum 타입은
 * `public`으로 한정되어 있어 같은 서버의 여러 스키마에 같은 마이그레이션을 적용할 수 없다.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = requireDatabaseUrl("DATABASE_URL_TEST");
  const name = `ohmyti_test_${randomBytes(6).toString("hex")}`;

  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = replaceDatabaseName(adminUrl, name);
  const handle = createDb({ url, max: 2, idleTimeout: 5 });
  try {
    await runMigrations(handle.db);
  } catch (error) {
    await handle.close();
    await dropDatabase(adminUrl, name);
    throw error;
  }

  return {
    ...handle,
    name,
    url,
    destroy: async () => {
      await handle.close();
      await dropDatabase(adminUrl, name);
    },
  };
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export function replaceDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
