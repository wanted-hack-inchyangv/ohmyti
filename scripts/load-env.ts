import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .env.local이 .env보다 우선한다. 이미 설정된 process.env 값은 덮어쓰지 않는다.
config({
  path: [path.join(repoRoot, ".env.local"), path.join(repoRoot, ".env")],
  quiet: true,
});
