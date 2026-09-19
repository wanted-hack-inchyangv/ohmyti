import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./client";

/** 마이그레이션 SQL 폴더 (`packages/db/drizzle`). */
export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

/**
 * 적용되지 않은 마이그레이션만 적용한다. drizzle이 `drizzle.__drizzle_migrations`에 이력을 남기므로
 * 같은 DB에 여러 번 실행해도 두 번째부터는 변경이 없다.
 * `migrationsFolder`는 소스가 없는 배포 이미지(워커 컨테이너의 `/app/drizzle`)에서 폴더를 바꿀 때 쓴다.
 */
export async function runMigrations(
  db: Database,
  options: { migrationsFolder?: string } = {},
): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });
}
