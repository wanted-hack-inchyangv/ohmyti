/**
 * 배포 전 마이그레이션 엔트리 (`dist/migrate.js`). Railway `preDeployCommand`가 워커 이미지 안에서 실행한다.
 * 컨테이너에는 pnpm·tsx·소스가 없으므로 `@ohmyti/db`의 `runMigrations`를 번들에 포함하고,
 * SQL 폴더는 `MIGRATIONS_FOLDER`(기본: 저장소의 `packages/db/drizzle`)에서 읽는다.
 * 두 번 실행해도 두 번째는 변경이 없다 (drizzle이 적용 이력을 남긴다).
 */
import { createDb, requireDatabaseUrl, runMigrations } from "@ohmyti/db";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "./env";

/**
 * 마이그레이션 폴더를 정한다. `MIGRATIONS_FOLDER`가 있으면 그것, 없으면 실행 파일 기준으로
 * 컨테이너 배치(`/app/dist/migrate.js` → `/app/drizzle`)와 저장소 배치(`apps/worker/dist` → `packages/db/drizzle`)를 차례로 찾는다.
 */
export function resolveMigrationsFolder(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIGRATIONS_FOLDER) return env.MIGRATIONS_FOLDER;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "drizzle"),
    path.resolve(here, "..", "..", "..", "packages", "db", "drizzle"),
    path.resolve(here, "..", "..", "packages", "db", "drizzle"),
  ];
  const found = candidates.find((dir) => existsSync(path.join(dir, "meta", "_journal.json")));
  if (!found) {
    throw new Error(
      `마이그레이션 폴더를 찾지 못했습니다. MIGRATIONS_FOLDER를 설정하세요. 확인한 경로: ${candidates.join(", ")}`,
    );
  }
  return found;
}

export async function runMigrateCommand(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder(env);
  const handle = createDb({ url: requireDatabaseUrl(), max: 1 });
  try {
    await runMigrations(handle.db, { migrationsFolder });
    console.log(`db:migrate OK (${migrationsFolder})`);
  } finally {
    await handle.close();
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  loadEnv();
  runMigrateCommand().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
