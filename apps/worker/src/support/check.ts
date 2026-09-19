/**
 * 지원 여부 판정 (TICKET.md T-203). ENV_PREP 단계의 앞부분이며 아무것도 실행하지 않는다.
 *
 * 스냅샷의 `package.json`과 파일 목록만 보고 승인 템플릿(T-102)으로 실행할 수 있는지 판정한다.
 * README·주석의 문구는 판단에 쓰지 않는다 (G-06). 지원하지 않으면 사유 코드와 설명을 남기고 거절한다 (G-09).
 *
 * 사유 코드:
 * - `MISSING_PACKAGE_JSON`: 루트에 `package.json`이 없거나 JSON 객체가 아니다
 * - `MISSING_START_SCRIPT`: `scripts.start`가 없거나 비어 있다
 * - `DISALLOWED_DEPENDENCY` / `DEPENDENCY_VERSION_MISMATCH`: `checkDependencies()`(T-102) 결과 그대로
 * - `UNSUPPORTED_LANGUAGE`: TypeScript·JavaScript 소스가 없거나, 시작 명령이 Node가 아닌 런타임을 부른다
 */
import {
  checkDependencies,
  detectTestFramework,
  SubmissionPackageJsonSchema,
  TestFrameworkSchema,
  type SubmissionFiles,
  type TemplateManifest,
} from "@ohmyti/runner";
import { z } from "zod";

export const SUPPORT_REASON_CODES = [
  "MISSING_PACKAGE_JSON",
  "MISSING_START_SCRIPT",
  "DISALLOWED_DEPENDENCY",
  "DEPENDENCY_VERSION_MISMATCH",
  "UNSUPPORTED_LANGUAGE",
] as const;
export const SupportReasonCodeSchema = z.enum(SUPPORT_REASON_CODES);
export type SupportReasonCode = z.infer<typeof SupportReasonCodeSchema>;

export const SupportReasonSchema = z.strictObject({
  code: SupportReasonCodeSchema,
  detail: z.string().min(1),
});
export type SupportReason = z.infer<typeof SupportReasonSchema>;

export const SUBMISSION_LANGUAGES = ["typescript", "javascript", "unknown"] as const;
export const SubmissionLanguageSchema = z.enum(SUBMISSION_LANGUAGES);
export type SubmissionLanguage = z.infer<typeof SubmissionLanguageSchema>;

/** 템플릿 허용 목록에 있는 HTTP 프레임워크. 판정에는 쓰지 않고 정보로만 남긴다 */
export const HTTP_FRAMEWORKS = ["express", "hono", "unknown"] as const;
export const HttpFrameworkSchema = z.enum(HTTP_FRAMEWORKS);
export type HttpFramework = z.infer<typeof HttpFrameworkSchema>;

/** `evaluations.stage_log[ENV_PREP].detail`에 그대로 저장한다 */
export const SupportReportSchema = z.strictObject({
  supported: z.boolean(),
  reasons: z.array(SupportReasonSchema),
  /** 제출물이 쓰는 HTTP 프레임워크 (의존성 선언 기준) */
  framework: HttpFrameworkSchema,
  /** 소스 언어. `unknown`이면 `UNSUPPORTED_LANGUAGE` 사유가 함께 있다 */
  language: SubmissionLanguageSchema,
  /** 감지한 테스트 프레임워크 (T-109 `detectTestFramework`). 지원 여부 판정에는 영향을 주지 않는다 */
  testFramework: TestFrameworkSchema,
  /** 감지한 테스트 프레임워크를 실행기가 지원하는지 (vitest만) */
  testFrameworkSupported: z.boolean(),
  /** `scripts.start` 원문. 없으면 null */
  startScript: z.string().nullable(),
  templateName: z.string().min(1),
});
export type SupportReport = z.infer<typeof SupportReportSchema>;

const TS_SOURCE = /\.(ts|tsx|mts|cts)$/;
const JS_SOURCE = /\.(js|jsx|mjs|cjs)$/;
const TYPE_DECLARATION = /\.d\.(ts|mts|cts)$/;

/** 다른 언어 프로젝트의 매니페스트. 사유 설명에만 쓴다 */
const FOREIGN_MANIFESTS = [
  "go.mod",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "mix.exs",
] as const;

/** 시작 명령이 이 프로그램을 부르면 Node 런타임이 아니다 */
const NON_NODE_PROGRAMS = new Set([
  "python",
  "python3",
  "py",
  "go",
  "java",
  "ruby",
  "bundle",
  "dotnet",
  "cargo",
  "php",
  "deno",
  "bun",
  "perl",
  "gradle",
  "mvn",
]);

/** HTTP 프레임워크 감지: 의존성 이름만 본다 */
const HTTP_FRAMEWORK_DEPENDENCIES: ReadonlyArray<readonly [string, HttpFramework]> = [
  ["express", "express"],
  ["hono", "hono"],
];

/** 파일 목록에서 소스 언어를 정한다. `.d.ts`만 있는 것은 TypeScript로 치지 않는다 */
export function detectLanguage(paths: readonly string[]): SubmissionLanguage {
  const source = paths.filter(
    (p) => !p.split("/").some((s) => s === "node_modules" || s === ".git"),
  );
  if (source.some((p) => TS_SOURCE.test(p) && !TYPE_DECLARATION.test(p))) return "typescript";
  if (source.some((p) => JS_SOURCE.test(p))) return "javascript";
  return "unknown";
}

/** `npm start`가 실행할 본문의 첫 프로그램 이름 (`FOO=bar` 접두 무시). 없으면 null */
export function startProgramOf(startScript: string): string | null {
  const first = startScript
    .split(/&&|;|\|\|?/)[0]
    ?.trim()
    .split(/\s+/)
    .find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  if (!first) return null;
  return first.split("/").at(-1) ?? null;
}

interface ParsedPackageJson {
  scripts: Record<string, unknown>;
  dependencies: Record<string, unknown>;
  devDependencies: Record<string, unknown>;
}

function parsePackageJson(raw: string): ParsedPackageJson | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `JSON 구문 오류: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "JSON 객체가 아닙니다" };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    scripts: isRecord(obj.scripts) ? obj.scripts : {},
    dependencies: isRecord(obj.dependencies) ? obj.dependencies : {},
    devDependencies: isRecord(obj.devDependencies) ? obj.devDependencies : {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 문자열 값만 남긴다. `checkDependencies`는 `이름 → 버전 범위` 문자열 맵을 받는다 */
function stringEntries(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    out[name] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

/**
 * 스냅샷을 승인 템플릿으로 실행할 수 있는지 판정한다. 파일을 읽기만 하며 어떤 명령도 실행하지 않는다.
 * 사유는 발견한 순서대로 모두 모은다 (첫 사유에서 멈추지 않는다: 지원자가 한 번에 고칠 수 있게).
 */
export async function checkSupport(
  files: SubmissionFiles,
  template: Pick<TemplateManifest, "name" | "allowedDependencies">,
): Promise<SupportReport> {
  const paths = await files.listFiles();
  const reasons: SupportReason[] = [];
  const language = detectLanguage(paths);
  let framework: HttpFramework = "unknown";
  let startScript: string | null = null;

  const raw = await files.readText("package.json");
  if (raw === null) {
    reasons.push({ code: "MISSING_PACKAGE_JSON", detail: "루트에 package.json이 없습니다" });
  } else {
    const pkg = parsePackageJson(raw);
    if ("error" in pkg) {
      reasons.push({
        code: "MISSING_PACKAGE_JSON",
        detail: `package.json을 읽을 수 없습니다 (${pkg.error})`,
      });
    } else {
      const start = pkg.scripts.start;
      if (typeof start !== "string" || start.trim() === "") {
        reasons.push({
          code: "MISSING_START_SCRIPT",
          detail:
            "package.json scripts.start가 없습니다. 실행 계약은 `npm start`로 서비스를 띄웁니다",
        });
      } else {
        startScript = start;
        const program = startProgramOf(start);
        if (program !== null && NON_NODE_PROGRAMS.has(program)) {
          reasons.push({
            code: "UNSUPPORTED_LANGUAGE",
            detail: `scripts.start가 ${program}을(를) 실행합니다. 템플릿은 Node.js(tsx·node)만 지원합니다`,
          });
        }
      }

      const dependencies = stringEntries(pkg.dependencies);
      const devDependencies = stringEntries(pkg.devDependencies);
      const dependencyCheck = checkDependencies(
        SubmissionPackageJsonSchema.parse({ dependencies, devDependencies }),
        template,
      );
      for (const issue of dependencyCheck.reasons) {
        reasons.push({ code: issue.code, detail: issue.detail });
      }
      for (const [name, value] of HTTP_FRAMEWORK_DEPENDENCIES) {
        if (name in dependencies || name in devDependencies) {
          framework = value;
          break;
        }
      }
    }
  }

  if (language === "unknown") {
    const foreign = FOREIGN_MANIFESTS.filter((name) => paths.includes(name));
    reasons.push({
      code: "UNSUPPORTED_LANGUAGE",
      detail:
        foreign.length > 0
          ? `TypeScript·JavaScript 소스가 없고 ${foreign.join(", ")}이(가) 있습니다. 템플릿은 Node.js 프로젝트만 지원합니다`
          : "TypeScript·JavaScript 소스 파일이 없습니다. 템플릿은 Node.js 프로젝트만 지원합니다",
    });
  }

  const detection = await detectTestFramework(files);
  return SupportReportSchema.parse({
    supported: reasons.length === 0,
    reasons,
    framework,
    language,
    testFramework: detection.framework,
    testFrameworkSupported: detection.supported,
    startScript,
    templateName: template.name,
  });
}

/** `submissions.unsupported_reason` 형식(`<CODE>: <detail>`). 사유가 여럿이면 `; `로 잇는다 */
export function formatSupportReasons(reasons: readonly SupportReason[]): string {
  return reasons.map((r) => `${r.code}: ${r.detail}`).join("; ");
}
