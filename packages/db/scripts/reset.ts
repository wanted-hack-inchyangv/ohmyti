/**
 * `pnpm db:reset` (개발 전용): public·drizzle 스키마를 통째로 지우고 마이그레이션을 처음부터 적용한다.
 * 운영 환경(NODE_ENV=production, RAILWAY_ENVIRONMENT, VERCEL_ENV=production)에서는 거부한다.
 */
import "./load-env";
import { createDb, requireDatabaseUrl } from "../src/client";
import { runMigrations } from "../src/migrate";

const guards = [
  process.env.NODE_ENV === "production",
  Boolean(process.env.RAILWAY_ENVIRONMENT),
  process.env.VERCEL_ENV === "production",
];
if (guards.some(Boolean)) {
  console.error("db:reset은 개발 환경에서만 실행할 수 있습니다");
  process.exit(1);
}

const handle = createDb({ url: requireDatabaseUrl(), max: 1 });
try {
  await handle.sql.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await handle.sql.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
  await handle.sql.unsafe(`CREATE SCHEMA public`);
  await runMigrations(handle.db);
  console.log("db:reset OK");
} finally {
  await handle.close();
}
