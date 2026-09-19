import { z } from "zod";
import { canonicalJson, NonNegativeIntSchema } from "./common";
import { MethodSchema, RubricAreaSchema } from "./enums";

/** PARTIAL 판정에 쓰는 하위 기준. 명시된 하위 기준만 부분 점수를 받는다 (PRD 5장 불변 규칙 2). */
export const SubCriterionSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  points: NonNegativeIntSchema,
});
export type SubCriterion = z.infer<typeof SubCriterionSchema>;

/** 기준별 PARTIAL 규칙. */
export const PartialRuleSchema = z.strictObject({
  criterionId: z.string().min(1),
  subCriteria: z.array(SubCriterionSchema),
});
export type PartialRule = z.infer<typeof PartialRuleSchema>;

/** 같은 근본 원인에서 실패할 수 있는 기준을 각각 감점하는 근거 (G-12). */
export const IndependentReasonSchema = z.strictObject({
  criterionIds: z.array(z.string().min(1)).min(2),
  reason: z.string().min(1),
});
export type IndependentReason = z.infer<typeof IndependentReasonSchema>;

/** 요구사항 그룹. mutation 실험은 그룹 단위로 점수를 산정한다 (PRD 5장 테스트 실효성). */
export const RubricGroupSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  criterionIds: z.array(z.string().min(1)).min(1),
  mutationIds: z.array(z.string().min(1)),
});
export type RubricGroup = z.infer<typeof RubricGroupSchema>;

/**
 * STATIC 기준의 구조화된 추가 검사 (T-405). 판정 조건 문장은 해석하지 않으므로, 정적으로 확인할 조건은 여기에 둔다.
 * `DEPENDENCY_DECLARED`: 저장소 루트 `package.json`의 dependencies·devDependencies에 패키지가 선언되어 있다.
 * 명세가 요구하지 않은 의존성을 요구하면 대안 정답 샘플(ALTERNATIVE)이 실패하므로 채점기 사전 검증(W3)이 승인을 막는다.
 */
export const StaticCheckSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("DEPENDENCY_DECLARED"),
    packageName: z
      .string()
      .regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/, "npm 패키지 이름 형식이 아닙니다"),
  }),
]);
export type StaticCheck = z.infer<typeof StaticCheckSchema>;

/** 채점 기준 하나. */
export const CriterionSchema = z.strictObject({
  id: z.string().min(1),
  area: RubricAreaSchema,
  title: z.string().min(1),
  maxPoints: NonNegativeIntSchema,
  method: MethodSchema,
  /** 판정 조건. 관측 가능한 사실로 적으며 라이브러리 이름을 필수 조건으로 쓰지 않는다. */
  condition: z.string().min(1),
  /** true면 PARTIAL 판정을 허용하며 partialRules에 하위 기준이 있어야 한다. */
  allowPartial: z.boolean(),
  /** MUTATION 기준이 참조하는 그룹 ID. */
  groupId: z.string().min(1).optional(),
  /** STATIC 기준에만 허용. 기본 검사(README 등)와 함께 모두 통과해야 PASS다 (T-405). */
  staticChecks: z.array(StaticCheckSchema).min(1).optional(),
});
export type Criterion = z.infer<typeof CriterionSchema>;

export const RubricSchema = z.strictObject({
  version: z.string().min(1),
  criteria: z.array(CriterionSchema),
  groups: z.array(RubricGroupSchema),
  partialRules: z.array(PartialRuleSchema),
  independentReasons: z.array(IndependentReasonSchema),
});
export type Rubric = z.infer<typeof RubricSchema>;

export const RUBRIC_TOTAL_POINTS = 100;

/**
 * 판정 조건에 필수 조건으로 넣을 수 없는 라이브러리·프레임워크 이름.
 * 기준은 관측 가능한 동작에 배점하며 특정 구현 도구를 강제하지 않는다.
 */
export const FORBIDDEN_LIBRARY_TERMS: readonly string[] = [
  "express",
  "fastify",
  "koa",
  "hapi",
  "nestjs",
  "nest.js",
  "hono",
  "prisma",
  "typeorm",
  "drizzle",
  "sequelize",
  "knex",
  "mongoose",
  "jest",
  "vitest",
  "mocha",
  "jasmine",
  "supertest",
  "zod",
  "yup",
  "joi",
  "lodash",
  "axios",
  "redis",
  "postgres",
  "postgresql",
  "mysql",
  "sqlite",
  "mongodb",
];

export type RubricValidationCode =
  | "TOTAL_POINTS_MISMATCH"
  | "DUPLICATE_CRITERION_ID"
  | "DUPLICATE_GROUP_ID"
  | "PARTIAL_WITHOUT_SUB_CRITERIA"
  | "PARTIAL_RULE_UNKNOWN_CRITERION"
  | "PARTIAL_RULE_NOT_ALLOWED"
  | "PARTIAL_POINTS_EXCEED_MAX"
  | "GROUP_UNKNOWN_CRITERION"
  | "CRITERION_UNKNOWN_GROUP"
  | "INDEPENDENT_REASON_UNKNOWN_CRITERION"
  | "FORBIDDEN_LIBRARY_TERM"
  | "STATIC_CHECK_NOT_STATIC";

export interface RubricValidationError {
  code: RubricValidationCode;
  message: string;
  /** 문제가 된 기준·그룹 ID (있으면). */
  ref?: string;
}

export type RubricValidationResult = { ok: true } | { ok: false; errors: RubricValidationError[] };

function findForbiddenTerms(condition: string): string[] {
  return FORBIDDEN_LIBRARY_TERMS.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(condition);
  });
}

/**
 * 기준 검증 규칙.
 * - 배점 합계 100
 * - 기준 ID·그룹 ID 유일
 * - PARTIAL 허용 기준은 하위 기준 1개 이상 명시, 하위 배점 합은 maxPoints 이하
 * - 그룹·독립 감점 사유·PARTIAL 규칙은 존재하는 기준만 참조
 * - 판정 조건에 라이브러리 이름 금지
 * - 정적 검사(staticChecks)는 STATIC 기준에만
 */
export function validateRubric(rubric: Rubric): RubricValidationResult {
  const errors: RubricValidationError[] = [];
  const criterionIds = new Set<string>();

  for (const criterion of rubric.criteria) {
    if (criterionIds.has(criterion.id)) {
      errors.push({
        code: "DUPLICATE_CRITERION_ID",
        message: `기준 ID가 중복됩니다: ${criterion.id}`,
        ref: criterion.id,
      });
    }
    criterionIds.add(criterion.id);
  }

  const total = rubric.criteria.reduce((sum, criterion) => sum + criterion.maxPoints, 0);
  if (total !== RUBRIC_TOTAL_POINTS) {
    errors.push({
      code: "TOTAL_POINTS_MISMATCH",
      message: `배점 합계가 ${RUBRIC_TOTAL_POINTS}이어야 합니다 (현재 ${total})`,
    });
  }

  const partialRuleByCriterion = new Map<string, PartialRule>();
  for (const rule of rubric.partialRules) {
    partialRuleByCriterion.set(rule.criterionId, rule);
    if (!criterionIds.has(rule.criterionId)) {
      errors.push({
        code: "PARTIAL_RULE_UNKNOWN_CRITERION",
        message: `PARTIAL 규칙이 존재하지 않는 기준을 참조합니다: ${rule.criterionId}`,
        ref: rule.criterionId,
      });
    }
  }

  for (const criterion of rubric.criteria) {
    const rule = partialRuleByCriterion.get(criterion.id);
    if (criterion.allowPartial) {
      if (!rule || rule.subCriteria.length === 0) {
        errors.push({
          code: "PARTIAL_WITHOUT_SUB_CRITERIA",
          message: `PARTIAL을 허용하는 기준은 하위 기준을 명시해야 합니다: ${criterion.id}`,
          ref: criterion.id,
        });
      } else {
        const subTotal = rule.subCriteria.reduce((sum, sub) => sum + sub.points, 0);
        if (subTotal > criterion.maxPoints) {
          errors.push({
            code: "PARTIAL_POINTS_EXCEED_MAX",
            message: `하위 기준 배점 합(${subTotal})이 maxPoints(${criterion.maxPoints})를 넘습니다: ${criterion.id}`,
            ref: criterion.id,
          });
        }
      }
    } else if (rule) {
      errors.push({
        code: "PARTIAL_RULE_NOT_ALLOWED",
        message: `PARTIAL을 허용하지 않는 기준에 PARTIAL 규칙이 있습니다: ${criterion.id}`,
        ref: criterion.id,
      });
    }

    if (criterion.staticChecks !== undefined && criterion.method !== "STATIC") {
      errors.push({
        code: "STATIC_CHECK_NOT_STATIC",
        message: `정적 검사(staticChecks)는 STATIC 기준에만 둘 수 있습니다: ${criterion.id}`,
        ref: criterion.id,
      });
    }

    const forbidden = findForbiddenTerms(criterion.condition);
    if (forbidden.length > 0) {
      errors.push({
        code: "FORBIDDEN_LIBRARY_TERM",
        message: `판정 조건에 라이브러리 이름을 쓸 수 없습니다 (${forbidden.join(", ")}): ${criterion.id}`,
        ref: criterion.id,
      });
    }
  }

  const groupIds = new Set<string>();
  for (const group of rubric.groups) {
    if (groupIds.has(group.id)) {
      errors.push({
        code: "DUPLICATE_GROUP_ID",
        message: `그룹 ID가 중복됩니다: ${group.id}`,
        ref: group.id,
      });
    }
    groupIds.add(group.id);
    for (const criterionId of group.criterionIds) {
      if (!criterionIds.has(criterionId)) {
        errors.push({
          code: "GROUP_UNKNOWN_CRITERION",
          message: `그룹 ${group.id}이(가) 존재하지 않는 기준을 참조합니다: ${criterionId}`,
          ref: group.id,
        });
      }
    }
  }

  for (const criterion of rubric.criteria) {
    if (criterion.groupId !== undefined && !groupIds.has(criterion.groupId)) {
      errors.push({
        code: "CRITERION_UNKNOWN_GROUP",
        message: `기준 ${criterion.id}이(가) 존재하지 않는 그룹을 참조합니다: ${criterion.groupId}`,
        ref: criterion.id,
      });
    }
  }

  for (const reason of rubric.independentReasons) {
    for (const criterionId of reason.criterionIds) {
      if (!criterionIds.has(criterionId)) {
        errors.push({
          code: "INDEPENDENT_REASON_UNKNOWN_CRITERION",
          message: `독립 감점 사유가 존재하지 않는 기준을 참조합니다: ${criterionId}`,
          ref: criterionId,
        });
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** `rubric_version` 문자열의 해시 길이 (T-201: `v<n>-<sha256(rubric json) 앞 8자>`). */
export const RUBRIC_VERSION_HASH_LENGTH = 8;
export const RUBRIC_VERSION_PATTERN = /^v[1-9]\d*-[0-9a-f]{8}$/;

/**
 * 다이제스트 입력이 되는 rubric 내용. `version` 필드는 계산 결과가 들어가는 자리이므로 제외한다.
 * 키 순서와 무관하게 같은 내용이면 같은 문자열이다.
 */
export function rubricContentForDigest(rubric: Rubric): string {
  const { version: _version, ...content } = rubric;
  return canonicalJson(content);
}

/**
 * `v<n>-<contentDigest 앞 8자>`. `contentDigest`는 `rubricContentForDigest()`의 sha256 hex이며
 * 해시 계산은 런타임(Node `crypto`)을 가진 호출자가 한다.
 */
export function formatRubricVersion(version: number, contentDigest: string): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError(`version은 1 이상의 정수여야 합니다: ${version}`);
  }
  if (!/^[0-9a-f]{64}$/.test(contentDigest)) {
    throw new RangeError("contentDigest는 sha256 hex(64자)여야 합니다");
  }
  return `v${version}-${contentDigest.slice(0, RUBRIC_VERSION_HASH_LENGTH)}`;
}
