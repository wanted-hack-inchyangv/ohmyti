/**
 * UI 문구 점검 (TICKET.md T-507, PRD 13장, G-16).
 *
 * 화면에 나가는 문구에 측정 전 홍보 수치(정확도·비용 절감률·실행 속도)와 "조작 불가능" 류 표현이 없는지 검사한다.
 * PRD 13장은 "조작 불가능" 대신 "버전이 고정되고 검토 가능한 실행 근거"라고 쓰도록 정했다.
 *
 * 대상: 웹 화면 소스(`apps/web/app`·`components`·`lib`·`public`), 화면에 표시되는 도메인 문구(`packages/core/src`),
 * 사용자 문서(`README.md`, `docs/demo.md`, `docs/acceptance.md`). 테스트 파일(`*.test.*`, `*.spec.*`)은 금지 표현을
 * "없어야 한다"고 검사하는 문자열을 담으므로 제외한다.
 *
 * "채점을 조작하려는 문구"처럼 조작 시도를 설명하는 문장은 허용한다. 막는 것은 불가능·보장 주장과 수치 홍보다.
 *
 * 실행: `pnpm copy:check` (금지 표현이 있으면 위치를 출력하고 종료 코드 1)
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const COPY_CHECK_TARGETS = [
  "apps/web/app",
  "apps/web/components",
  "apps/web/lib",
  "apps/web/public",
  "packages/core/src",
  "README.md",
  "docs/demo.md",
  "docs/acceptance.md",
] as const;

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".mdx", ".json", ".html"]);
const EXCLUDED_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export interface ForbiddenRule {
  id: "TAMPER_PROOF" | "ACCURACY_FIGURE" | "COST_FIGURE" | "SPEED_FIGURE";
  description: string;
  pattern: RegExp;
}

export const FORBIDDEN_RULES: readonly ForbiddenRule[] = [
  {
    id: "TAMPER_PROOF",
    description: '"조작 불가능" 류 표현 (PRD 13장: "버전이 고정되고 검토 가능한 실행 근거"로 쓴다)',
    pattern:
      /조작\s*(이|은)?\s*불가|조작할\s*수\s*없|조작\s*방지\s*보장|위\s*변조\s*(가\s*)?불가|변조\s*불가|tamper[-\s]?proof|unhackable|cannot\s+be\s+(tampered|manipulated|gamed)/i,
  },
  {
    id: "ACCURACY_FIGURE",
    description: "정확도 수치 홍보",
    pattern:
      /(정확도|정확률|정답률|적중률|정밀도|재현율|accuracy|precision)\s*[:：]?\s*(약\s*)?\d+(\.\d+)?\s*%?|\d+(\.\d+)?\s*%\s*(의\s*)?(정확|정밀|적중|accura)/i,
  },
  {
    id: "COST_FIGURE",
    description: "비용 절감률 수치 홍보",
    pattern:
      /\d+(\.\d+)?\s*(%|배|퍼센트)\s*(의\s*)?(비용\s*)?(절감|저렴|싸|아낄|cheaper|cost\s+(saving|reduction))|(비용|cost)[^\n]{0,20}?\d+(\.\d+)?\s*(%|배)\s*(절감|감소|줄|낮|저렴|less|lower|cheaper|saving)/i,
  },
  {
    id: "SPEED_FIGURE",
    description: "실행 속도 수치 홍보",
    pattern:
      /\d+(\.\d+)?\s*배\s*(더\s*)?(빠|빨|단축)|\d+(\.\d+)?\s*%\s*(더\s*)?(빠|빨|단축)|\d+(\.\d+)?\s*[x×]\s*faster|\d+(\.\d+)?\s*(초|분|시간|seconds?|minutes?)\s*(만에|안에|이내에?|in)\s*(채점|평가|분석|리뷰|완료|검토|grade|review)/i,
  },
];

export interface CopyViolation {
  file: string;
  line: number;
  rule: ForbiddenRule["id"];
  text: string;
}

export function findForbiddenCopy(source: string, file: string): CopyViolation[] {
  const violations: CopyViolation[] = [];
  source.split("\n").forEach((line, index) => {
    for (const rule of FORBIDDEN_RULES) {
      const match = rule.pattern.exec(line);
      if (match) {
        violations.push({ file, line: index + 1, rule: rule.id, text: match[0].trim() });
      }
    }
  });
  return violations;
}

async function collectFiles(target: string): Promise<string[]> {
  const absolute = path.join(REPO_ROOT, target);
  const info = await stat(absolute).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [target];
  const files: string[] = [];
  for (const entry of await readdir(absolute, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const relative = path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name));
    if (relative.split(path.sep).some((part) => part === "node_modules" || part === ".next")) {
      continue;
    }
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name)) || EXCLUDED_FILE.test(entry.name)) continue;
    files.push(relative);
  }
  return files.sort();
}

export async function checkCopy(
  targets: readonly string[] = COPY_CHECK_TARGETS,
): Promise<{ files: string[]; violations: CopyViolation[] }> {
  const files = (await Promise.all(targets.map(collectFiles))).flat();
  const violations: CopyViolation[] = [];
  for (const file of files) {
    violations.push(...findForbiddenCopy(await readFile(path.join(REPO_ROOT, file), "utf8"), file));
  }
  return { files, violations };
}

async function main(): Promise<void> {
  const { files, violations } = await checkCopy();
  if (violations.length > 0) {
    const describe = new Map(FORBIDDEN_RULES.map((r) => [r.id, r.description]));
    for (const v of violations) {
      console.error(`${v.file}:${v.line} [${v.rule}] "${v.text}" — ${describe.get(v.rule)}`);
    }
    console.error(
      `copy:check 실패: 금지 표현 ${violations.length}건 (${files.length}개 파일 검사)`,
    );
    process.exit(1);
  }
  console.log(`copy:check OK: 금지 표현 없음 (${files.length}개 파일 검사)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`copy:check 오류: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
  });
}
