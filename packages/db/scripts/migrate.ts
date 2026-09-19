/** `pnpm db:migrate`: DATABASE_URL에 미적용 마이그레이션을 적용한다. 두 번 실행해도 두 번째는 변경이 없다. */
import "./load-env";
import { createDb, requireDatabaseUrl } from "../src/client";
import { runMigrations } from "../src/migrate";

const handle = createDb({ url: requireDatabaseUrl(), max: 1 });
try {
  await runMigrations(handle.db);
  console.log("db:migrate OK");
} finally {
  await handle.close();
}
