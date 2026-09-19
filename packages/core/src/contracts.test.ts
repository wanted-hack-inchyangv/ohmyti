import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CriterionResultSchema,
  EvidenceSchema,
  ExecutionRecordSchema,
  PRD_CONTRACT_FIELDS,
  type CriterionResult,
  type Evidence,
  type ExecutionRecord,
} from "./contracts";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

function shapeKeys(schema: z.ZodType): string[] {
  const inner = schema instanceof z.ZodPipe ? schema.in : schema;
  if (!(inner instanceof z.ZodObject)) throw new Error("object 스키마가 아닙니다");
  return Object.keys(inner.shape);
}

describe("PRD 9장 계약 필드명", () => {
  it.each([
    ["CriterionResult", CriterionResultSchema],
    ["Evidence", EvidenceSchema],
    ["ExecutionRecord", ExecutionRecordSchema],
  ] as const)("%s 스키마에 PRD 필드가 같은 이름으로 존재한다", (name, schema) => {
    const keys = shapeKeys(schema);
    for (const field of PRD_CONTRACT_FIELDS[name]) {
      expect(keys, `${name}.${field}`).toContain(field);
    }
  });

  it("타입 수준에서도 PRD 필드가 존재한다", () => {
    const criterion: Pick<CriterionResult, (typeof PRD_CONTRACT_FIELDS.CriterionResult)[number]> = {
      criterionId: "R-01",
      rubricVersion: "v1",
      maxPoints: 8,
      earnedPoints: 8,
      verdict: "PASS",
      method: "EXECUTION",
      evidenceIds: [],
      issueId: undefined,
      observation: "정상 주문 201",
      interpretation: undefined,
      reviewState: "NOT_REQUIRED",
    };
    const evidence: Pick<Evidence, (typeof PRD_CONTRACT_FIELDS.Evidence)[number]> = {
      id: "ev-1",
      submissionSha: SHA,
      source: undefined,
      runId: undefined,
      testId: undefined,
      artifactRefs: [],
    };
    const record: Pick<ExecutionRecord, (typeof PRD_CONTRACT_FIELDS.ExecutionRecord)[number]> = {
      id: "run-1",
      submissionSha: SHA,
      rubricVersion: "v1",
      harnessVersion: "h1",
      environmentDigest: DIGEST,
      patchDigest: undefined,
      seed: undefined,
      inputRef: "in",
      expectedRef: "exp",
      actualRef: "act",
      exitCode: 0,
      failureKind: "NONE",
    };
    expect([criterion, evidence, record]).toHaveLength(3);
  });
});

describe("CriterionResult 불변 규칙", () => {
  const base = {
    criterionId: "R-01",
    rubricVersion: "v1",
    maxPoints: 8,
    earnedPoints: 8,
    verdict: "PASS",
    method: "EXECUTION",
    evidenceIds: [],
    observation: "ok",
    reviewState: "NOT_REQUIRED",
  } satisfies Record<string, unknown>;

  it("만점이면 Evidence 없이도 유효하다", () => {
    expect(CriterionResultSchema.safeParse(base).success).toBe(true);
  });

  it("감점인데 Evidence가 없으면 거부한다 (G-02)", () => {
    const result = CriterionResultSchema.safeParse({ ...base, earnedPoints: 4, verdict: "FAIL" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["evidenceIds"]);
  });

  it("감점이어도 Evidence가 있으면 유효하다", () => {
    expect(
      CriterionResultSchema.safeParse({
        ...base,
        earnedPoints: 4,
        verdict: "FAIL",
        evidenceIds: ["ev-1"],
      }).success,
    ).toBe(true);
  });

  it("INCONCLUSIVE는 earnedPoints가 null이어야 한다 (G-04)", () => {
    expect(
      CriterionResultSchema.safeParse({ ...base, verdict: "INCONCLUSIVE", earnedPoints: 0 })
        .success,
    ).toBe(false);
    expect(
      CriterionResultSchema.safeParse({
        ...base,
        verdict: "INCONCLUSIVE",
        earnedPoints: null,
        reviewState: "PENDING",
      }).success,
    ).toBe(true);
  });

  it("earnedPoints가 maxPoints를 넘으면 거부한다", () => {
    expect(CriterionResultSchema.safeParse({ ...base, earnedPoints: 9 }).success).toBe(false);
  });

  it("알 수 없는 키는 거부한다", () => {
    expect(CriterionResultSchema.safeParse({ ...base, score: 1 }).success).toBe(false);
  });
});

describe("ExecutionRecord", () => {
  it("SHA·다이제스트 형식을 검사한다", () => {
    const record = {
      id: "run-1",
      submissionSha: SHA,
      rubricVersion: "v1",
      harnessVersion: "h1",
      environmentDigest: DIGEST,
      inputRef: "in",
      expectedRef: "exp",
      actualRef: "act",
      exitCode: null,
      failureKind: "TIMEOUT",
    };
    expect(ExecutionRecordSchema.safeParse(record).success).toBe(true);
    expect(ExecutionRecordSchema.safeParse({ ...record, submissionSha: "abc" }).success).toBe(
      false,
    );
    expect(ExecutionRecordSchema.safeParse({ ...record, environmentDigest: "abc" }).success).toBe(
      false,
    );
  });
});
