import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { existsSync } from "node:fs";
import path from "node:path";

// drizzle-kit은 이 파일을 CJS로 번들하므로 import.meta 대신 cwd에서 저장소 루트를 찾는다.
function findRepoRoot(from: string): string {
  let dir = from;
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
  return dir;
}

const repoRoot = findRepoRoot(process.cwd());
config({ path: [path.join(repoRoot, ".env.local"), path.join(repoRoot, ".env")], quiet: true });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
