import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 저장소 루트의 `.env.local`과 `.env`를 읽는다. 앞의 파일이 우선하며,
 * 이미 process.env에 있는 값(배포 환경변수)은 덮어쓰지 않는다.
 * 번들(dist/index.js)과 소스(src/env.ts) 어느 위치에서 실행해도 루트를 찾도록 두 단계 위를 기준으로 한다.
 */
export function loadEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..", "..");
  config({
    path: [path.join(repoRoot, ".env.local"), path.join(repoRoot, ".env")],
    quiet: true,
  });
}
