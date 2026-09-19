import { z } from "zod";
import { DigestSchema, IdSchema, NonNegativeIntSchema, ShaSchema } from "./common";
import { ExecutionContractSchema } from "./entities";
import { RubricSchema } from "./rubric";

/**
 * 과제 채점 엔진의 입력 (PRD 4장 A). 명세·기준·실행 계약·코드 스냅샷 참조만 포함한다.
 * 이력서·GitHub·지원자 정보는 타입 수준에서 존재하지 않는다 (G-10). `grading-input.test.ts`가 고정한다.
 */
export const GradingInputSchema = z.strictObject({
  assignmentVersionId: IdSchema,
  rubricVersion: z.string().min(1),
  spec: z.strictObject({
    ref: z.string().min(1),
    digest: DigestSchema,
  }),
  rubric: RubricSchema,
  executionContract: ExecutionContractSchema,
  snapshot: z.strictObject({
    submissionSha: ShaSchema,
    artifactRef: z.string().min(1),
    fileCount: NonNegativeIntSchema,
    totalBytes: NonNegativeIntSchema,
    /** 수집 한도 때문에 일부만 읽었으면 true. 분석 범위를 UI에 표시한다 (PRD 10장). */
    truncated: z.boolean(),
  }),
  harnessVersion: z.string().min(1),
});
export type GradingInput = z.infer<typeof GradingInputSchema>;

/** 채점 입력에 들어갈 수 없는 키 접두사 (G-10). */
export const FORBIDDEN_GRADING_INPUT_PREFIXES = ["resume", "github", "applicant"] as const;
export type ForbiddenGradingInputPrefix = (typeof FORBIDDEN_GRADING_INPUT_PREFIXES)[number];

type ForbiddenKey = `${ForbiddenGradingInputPrefix}${string}`;

/**
 * 객체 트리 전체에서 금지 접두사로 시작하는 키를 찾는다. 하나라도 있으면 `never`가 되어 대입이 실패한다.
 * 사용: `const check: AssertNoForbiddenKeys<GradingInput> = true;`
 */
export type AssertNoForbiddenKeys<T> = HasForbiddenKey<T> extends true ? never : true;

type HasForbiddenKey<T> = T extends readonly (infer U)[]
  ? HasForbiddenKey<U>
  : T extends object
    ? Extract<keyof T, ForbiddenKey> extends never
      ? true extends { [K in keyof T]-?: HasForbiddenKey<T[K]> }[keyof T]
        ? true
        : false
      : true
    : false;

/** 런타임에서도 스키마 shape를 재귀 순회해 금지 키가 없는지 확인한다. */
export function findForbiddenGradingInputKeys(schema: z.ZodType, path: string[] = []): string[] {
  const found: string[] = [];
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = schema.shape;
    for (const [key, child] of Object.entries(shape)) {
      const childPath = [...path, key];
      if (FORBIDDEN_GRADING_INPUT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        found.push(childPath.join("."));
      }
      found.push(...findForbiddenGradingInputKeys(child, childPath));
    }
  } else if (schema instanceof z.ZodArray) {
    found.push(...findForbiddenGradingInputKeys(schema.element as z.ZodType, [...path, "[]"]));
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    found.push(...findForbiddenGradingInputKeys(schema.unwrap() as z.ZodType, path));
  }
  return found;
}
