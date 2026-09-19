/**
 * 승인 실행 템플릿 계약 (TICKET.md 1.4, T-102).
 * 제출물은 템플릿에 사전 설치된 고정 의존성만 쓸 수 있고, 어떤 러너도 제출물의 `npm install`을 실행하지 않는다.
 */
import { createHash } from "node:crypto";
import semver from "semver";
import { z } from "zod";

/** npm 패키지 이름 (스코프 허용). */
const PackageNameSchema = z
  .string()
  .regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/, "npm 패키지 이름이 아닙니다");
const ExactVersionSchema = z
  .string()
  .refine((v) => semver.valid(v) === v, "정확한 버전(예: 1.2.3)이어야 합니다");
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex가 아닙니다");

export const RUNNER_KINDS = ["local", "vercel"] as const;
export const RunnerKindSchema = z.enum(RUNNER_KINDS);
export type RunnerKind = z.infer<typeof RunnerKindSchema>;

/** `templates/<name>/template.json`. `pnpm template:build`가 digest를 채운다. */
export const TemplateManifestSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "템플릿 이름은 소문자·숫자·하이픈만 허용합니다"),
  version: ExactVersionSchema,
  /** 실행 계약의 `nodeVersion`과 같은 표기 (예: `22`). */
  nodeVersion: z.string().regex(/^\d+(\.\d+){0,2}$/, "Node 버전 표기가 아닙니다"),
  /** 템플릿 `node_modules`를 만든 명령. 제출물에는 실행하지 않는다. */
  installCommand: z.string().min(1),
  lockfile: z.string().min(1),
  /** 패키지 이름 → 설치된 정확한 버전. 제출물 `package.json`의 의존성은 이 목록의 부분집합이어야 한다. */
  allowedDependencies: z.record(PackageNameSchema, ExactVersionSchema),
  /** digest 계산에 넣은 러너 종류. T-108의 LocalProcessRunner는 `local`이다. */
  runnerKind: RunnerKindSchema,
  lockfileDigest: Sha256HexSchema,
  /** sha256(node 버전 + lockfile 내용 + 러너 종류). 실행 기록(ExecutionRecord)의 `environmentDigest`에 쓴다. */
  environmentDigest: Sha256HexSchema,
});
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * 환경 digest. 입력을 줄바꿈으로 구분한 고정 형식으로 이어 붙여 해시하므로 같은 입력이면 항상 같은 값이다.
 * lockfile 내용은 `\r\n`을 `\n`으로 정규화한다 (체크아웃 설정에 따라 줄바꿈이 달라져도 digest가 같도록).
 */
export function computeEnvironmentDigest(input: {
  nodeVersion: string;
  lockfileContent: string;
  runnerKind: RunnerKind;
}): string {
  const lockfile = input.lockfileContent.replace(/\r\n/g, "\n");
  return sha256Hex(
    `node:${input.nodeVersion}\nlockfile:\n${lockfile}\nrunner:${input.runnerKind}\n`,
  );
}

export const DependencyIssueCodeSchema = z.enum([
  "DISALLOWED_DEPENDENCY",
  "DEPENDENCY_VERSION_MISMATCH",
]);
export type DependencyIssueCode = z.infer<typeof DependencyIssueCodeSchema>;

export interface DependencyIssue {
  code: DependencyIssueCode;
  /** 패키지 이름 */
  name: string;
  /** 제출물이 선언한 버전 범위 */
  requested: string;
  /** 템플릿에 설치된 버전. 허용 목록에 없으면 undefined */
  installed?: string;
  /** `dependencies` 또는 `devDependencies` */
  field: "dependencies" | "devDependencies";
  detail: string;
}

export interface DependencyCheckResult {
  supported: boolean;
  /** 지원하지 않는 패키지 이름 목록 (중복 제거, 선언 순서). 허용 목록에 없거나 버전이 맞지 않는 것 모두 포함한다. */
  unsupported: string[];
  reasons: DependencyIssue[];
}

/** 제출물 `package.json`에서 검사에 필요한 부분만 읽는다. 다른 필드는 무시한다. */
export const SubmissionPackageJsonSchema = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});
export type SubmissionPackageJson = z.infer<typeof SubmissionPackageJsonSchema>;

const CHECKED_FIELDS = ["dependencies", "devDependencies"] as const;

/**
 * 제출물의 의존성이 템플릿 허용 목록에 모두 있고, 선언한 버전 범위가 설치된 버전을 만족하는지 검사한다.
 * `peerDependencies`·`optionalDependencies`는 설치 대상이 아니므로 보지 않는다.
 * 정확한 버전이 아닌 범위(`^`, `~`, `>=`, `*` 등)도 semver로 판정하고, semver로 해석할 수 없는 값
 * (`latest`, `file:`, `github:` 등)은 버전 불일치로 기록한다.
 */
export function checkDependencies(
  packageJson: SubmissionPackageJson,
  template: Pick<TemplateManifest, "allowedDependencies">,
): DependencyCheckResult {
  const reasons: DependencyIssue[] = [];
  for (const field of CHECKED_FIELDS) {
    for (const [name, requested] of Object.entries(packageJson[field] ?? {})) {
      const installed = template.allowedDependencies[name];
      if (installed === undefined) {
        reasons.push({
          code: "DISALLOWED_DEPENDENCY",
          name,
          requested,
          field,
          detail: `${name}은(는) 템플릿 허용 목록에 없습니다`,
        });
        continue;
      }
      const range = semver.validRange(requested, { includePrerelease: true });
      if (range === null) {
        reasons.push({
          code: "DEPENDENCY_VERSION_MISMATCH",
          name,
          requested,
          installed,
          field,
          detail: `${name}@${requested}은(는) semver 범위가 아니어서 설치 버전 ${installed}과(와) 대조할 수 없습니다`,
        });
        continue;
      }
      if (!semver.satisfies(installed, range, { includePrerelease: true })) {
        reasons.push({
          code: "DEPENDENCY_VERSION_MISMATCH",
          name,
          requested,
          installed,
          field,
          detail: `${name}@${requested}은(는) 템플릿 설치 버전 ${installed}을(를) 만족하지 않습니다`,
        });
      }
    }
  }
  const unsupported = [...new Set(reasons.map((r) => r.name))];
  return { supported: reasons.length === 0, unsupported, reasons };
}
