import { config } from "dotenv";
import path from "node:path";

// 저장소 루트의 .env.local(우선)과 .env를 읽는다. 이미 설정된 process.env는 덮어쓰지 않는다.
const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
config({ path: [path.join(repoRoot, ".env.local"), path.join(repoRoot, ".env")], quiet: true });
