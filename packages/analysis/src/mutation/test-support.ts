/** mutation 테스트 공용 도구. 샘플 디렉터리를 메모리 파일 맵으로 읽고, 코드 조각 픽스처를 파일 공급자로 만든다 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AnalysisFiles } from "../project";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
export const SAMPLES_DIR = path.join(REPO_ROOT, "samples/order-api");
export const TEMPLATE_NODE_MODULES = path.join(REPO_ROOT, "templates/order-api-ts/node_modules");

/** 디렉터리를 메모리 파일 맵으로 (node_modules·.git·링크 제외) */
export async function readTree(dir: string, base = dir): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of await readTree(full, base)) out.set(k, v);
    } else {
      out.set(path.relative(base, full).split(path.sep).join("/"), await readFile(full, "utf8"));
    }
  }
  return out;
}

export function memoryFiles(files: Map<string, string> | Record<string, string>): AnalysisFiles {
  const map = files instanceof Map ? files : new Map(Object.entries(files));
  return {
    listFiles: () => Promise.resolve([...map.keys()].sort()),
    readText: (p) => Promise.resolve(map.get(p) ?? null),
  };
}

export async function sampleFiles(impl: string): Promise<Map<string, string>> {
  return readTree(path.join(SAMPLES_DIR, impl));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 공급자의 모든 파일 해시 (경로 → sha256) */
export async function hashAll(files: AnalysisFiles): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of await files.listFiles()) out.set(p, sha256((await files.readText(p)) ?? ""));
  return out;
}

/** 코드 조각 픽스처용 라우터 선언. 라우트 등록 분석은 `<수신자>.post("<경로>", 핸들러)` 모양만 본다 */
export const ROUTER_DECL =
  "declare const app: { post(path: string, handler: (req: any) => unknown): void };\n";
