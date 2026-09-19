/**
 * 실행 가능한 명령의 규칙 (T-108).
 * 어떤 러너도 제출물의 의존성 설치를 실행하지 않는다 (1.4). `npm install`·`npm ci`·`pnpm add`처럼
 * 패키지를 내려받거나 lockfile을 바꾸는 명령은 인자와 `package.json` 스크립트 본문 양쪽에서 거부한다.
 */
import { BlockedCommandError } from "../runner";

/** 패키지 관리자 프로그램. 이 프로그램의 설치 계열 하위 명령은 차단한다 */
export const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "corepack"]);

/** 항상 차단하는 프로그램 (실행하려는 패키지를 내려받는다) */
export const ALWAYS_BLOCKED_PROGRAMS = new Set(["npx", "pnpx", "bunx", "yarn-dlx"]);

/** 설치·갱신·링크 계열 하위 명령 (npm·pnpm·yarn·bun의 별칭 포함) */
export const INSTALL_SUBCOMMANDS = new Set([
  "install",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
  "add",
  "ci",
  "clean-install",
  "install-clean",
  "isntall-clean",
  "install-test",
  "it",
  "update",
  "up",
  "upgrade",
  "upgrade-interactive",
  "dedupe",
  "ddp",
  "link",
  "ln",
  "unlink",
  "uninstall",
  "un",
  "remove",
  "rm",
  "r",
  "prune",
  "rebuild",
  "rb",
  "import",
  "dlx",
  "exec",
  "x",
  "create",
  "init",
  "publish",
  "pack",
  "patch",
  "patch-commit",
  "set",
  "enable",
  "disable",
  "prepare",
  "use",
]);

/** 프로그램 이름만 남긴다 (`/usr/bin/npm` → `npm`, `npm.cmd` → `npm`) */
export function programName(argv0: string): string {
  const base = argv0.split(/[\\/]/).pop() ?? argv0;
  return base.replace(/\.(cmd|exe|bat)$/i, "").toLowerCase();
}

/** npm의 `--flag` 옵션을 건너뛰고 첫 위치 인자(하위 명령)를 찾는다 */
function firstPositional(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    return arg.toLowerCase();
  }
  return undefined;
}

/**
 * 인자 배열이 차단 대상이면 사유를, 아니면 null을 돌려준다.
 * `npm run <script>`·`npm start`·`npm test` 같은 스크립트 실행은 허용한다 (스크립트 본문은 `assertScriptsAllowed`).
 */
export function blockedReason(argv: readonly string[]): string | null {
  const first = argv[0];
  if (first === undefined || first.trim() === "") return "빈 명령";
  const program = programName(first);
  if (ALWAYS_BLOCKED_PROGRAMS.has(program)) {
    return `${program}은(는) 패키지를 내려받아 실행하므로 허용하지 않습니다`;
  }
  if (!PACKAGE_MANAGERS.has(program)) return null;
  const sub = firstPositional(argv.slice(1));
  if (sub === undefined) return `${program}의 하위 명령이 없습니다`;
  if (INSTALL_SUBCOMMANDS.has(sub)) {
    return `${program} ${sub}은(는) 의존성 설치·갱신 명령이므로 허용하지 않습니다 (템플릿 의존성만 사용)`;
  }
  if (program === "corepack") return "corepack은 패키지 관리자를 내려받으므로 허용하지 않습니다";
  return null;
}

export function assertCommandAllowed(argv: readonly string[]): void {
  const reason = blockedReason(argv);
  if (reason !== null) throw new BlockedCommandError(argv, reason);
}

/**
 * 스크립트 본문 안의 설치 명령. `npm install`, `pnpm add x`, `yarn`(인자 없음 = install), `npx foo` 등.
 * 셸 연산자(`&&`, `;`, `|`)로 이어진 각 부분을 따로 본다.
 */
const SCRIPT_SEGMENT_SPLIT = /&&|\|\||;|\||\n/;

export function scriptBlockedReason(script: string): string | null {
  for (const rawSegment of script.split(SCRIPT_SEGMENT_SPLIT)) {
    const tokens = rawSegment
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    // 환경변수 대입(`FOO=bar cmd`)은 건너뛴다
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
    if (tokens.length === 0) continue;
    const program = programName(tokens[0]!);
    if (program === "yarn" && firstPositional(tokens.slice(1)) === undefined) {
      return "인자 없는 yarn은 install이므로 허용하지 않습니다";
    }
    const reason = blockedReason(tokens);
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * `npm <script>`·`npm run <script>`가 실행할 스크립트(pre/post 포함)의 본문에 설치 명령이 없는지 확인한다.
 * npm이 아닌 프로그램이거나 스크립트를 실행하지 않는 하위 명령이면 아무것도 하지 않는다.
 */
export function assertScriptsAllowed(
  argv: readonly string[],
  scripts: Readonly<Record<string, string>> | undefined,
): void {
  const first = argv[0];
  if (first === undefined) return;
  const program = programName(first);
  if (!PACKAGE_MANAGERS.has(program) || !scripts) return;
  const scriptName = requestedScriptName(argv.slice(1));
  if (scriptName === undefined) return;
  for (const name of [`pre${scriptName}`, scriptName, `post${scriptName}`]) {
    const body = scripts[name];
    if (body === undefined) continue;
    const reason = scriptBlockedReason(body);
    if (reason !== null) {
      throw new BlockedCommandError(argv, `package.json 스크립트 "${name}"(${body}): ${reason}`);
    }
  }
}

const LIFECYCLE_SHORTCUTS = new Set(["start", "test", "stop", "restart"]);

/** `npm start` → `start`, `npm run build` → `build`, `npm run-script x` → `x`, `npm t` → `test` */
export function requestedScriptName(args: readonly string[]): string | undefined {
  const positionals = args.filter((a) => !a.startsWith("-"));
  const sub = positionals[0]?.toLowerCase();
  if (sub === undefined) return undefined;
  if (sub === "t" || sub === "tst") return "test";
  if (LIFECYCLE_SHORTCUTS.has(sub)) return sub;
  if (sub === "run" || sub === "run-script" || sub === "rum" || sub === "urn") {
    return positionals[1];
  }
  return undefined;
}
