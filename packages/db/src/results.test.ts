import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEvaluation } from "./evaluations";
import {
  EvaluationResultsExistError,
  getEvaluationResults,
  hasCriterionResults,
  persistEvaluationResults,
  toCriterionResult,
  toEvidence,
  toExecutionRecord,
  type EvaluationResultsInput,
  type NewCriterionResult,
} from "./results";
import { DIGEST, seedEvaluation, SHA } from "./test-fixtures";
import { createTestDatabase, type TestDatabase } from "./testing";

const hasTestDb = Boolean(process.env.DATABASE_URL_TEST);
if (!hasTestDb) {
  console.warn("[@ohmyti/db] DATABASE_URL_TEST가 없어 results 통합 테스트를 건너뜁니다");
}

function sampleInput(
  evaluationId: string,
  rubricVersion: string,
  overrides: Partial<NewCriterionResult> = {},
): EvaluationResultsInput {
  const runId = randomUUID();
  const evidenceId = randomUUID();
  return {
    evaluationId,
    executionRecords: [
      {
        id: runId,
        evaluationId,
        kind: "HARNESS",
        submissionSha: SHA,
        rubricVersion,
        harnessVersion: "harness-0",
        environmentDigest: DIGEST,
        inputRef: `evaluations/${evaluationId}/runs/${runId}/input.json`,
        expectedRef: `evaluations/${evaluationId}/runs/${runId}/expected.json`,
        actualRef: `evaluations/${evaluationId}/runs/${runId}/actual.json`,
        exitCode: null,
        failureKind: "ASSERTION",
        startedAt: "2026-09-18T09:00:00.000Z",
        finishedAt: "2026-09-18T09:00:01.500Z",
        durationMs: 1500,
      },
    ],
    evidences: [
      {
        id: evidenceId,
        evaluationId,
        submissionSha: SHA,
        runId,
        testId: "R-01-normal-order",
        artifactRefs: [`evaluations/${evaluationId}/runs/${runId}/timeline.json`],
      },
    ],
    criterionResults: [
      {
        evaluationId,
        criterionId: "R-01",
        rubricVersion,
        maxPoints: 100,
        earnedPoints: 0,
        verdict: "FAIL",
        method: "EXECUTION",
        evidenceIds: [evidenceId],
        issueId: "case:R-01-normal-order",
        observation: "하네스 케이스 R-01-normal-order FAIL(ASSERTION)",
        reviewState: "NOT_REQUIRED",
        ...overrides,
      },
    ],
    score: { earned: 0, min: 0, max: 0, pendingPoints: 0 },
  };
}

describe.skipIf(!hasTestDb)("@ohmyti/db results (통합)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(async () => {
    await tdb?.destroy();
  });

  it("실행 기록·근거·판정·점수를 한 트랜잭션에 쓰고 core 타입으로 되읽는다", async () => {
    const seed = await seedEvaluation(tdb.db);
    const input = sampleInput(seed.evaluationId, seed.rubricVersion);
    expect(await hasCriterionResults(tdb.db, seed.evaluationId)).toBe(false);

    const saved = await persistEvaluationResults(tdb.db, input);
    expect(saved.executionRecords).toHaveLength(1);
    expect(saved.evidences).toHaveLength(1);
    expect(saved.criterionResults).toHaveLength(1);
    expect(await hasCriterionResults(tdb.db, seed.evaluationId)).toBe(true);

    const evaluation = (await getEvaluation(tdb.db, seed.evaluationId))!;
    expect(evaluation.scoreEarned).toBe(0);
    expect(evaluation.scoreMin).toBe(0);
    expect(evaluation.scoreMax).toBe(0);
    expect(evaluation.pendingPoints).toBe(0);

    const results = await getEvaluationResults(tdb.db, seed.evaluationId);
    const record = toExecutionRecord(results.executionRecords[0]!);
    expect(record).toMatchObject({
      id: input.executionRecords[0]!.id,
      kind: "HARNESS",
      failureKind: "ASSERTION",
      exitCode: null,
      startedAt: "2026-09-18T09:00:00.000Z",
      finishedAt: "2026-09-18T09:00:01.500Z",
      durationMs: 1500,
    });
    expect(record).not.toHaveProperty("patchDigest");
    const evidence = toEvidence(results.evidences[0]!);
    expect(evidence).toMatchObject({
      id: input.evidences[0]!.id,
      runId: record.id,
      testId: "R-01-normal-order",
      artifactRefs: input.evidences[0]!.artifactRefs,
    });
    expect(evidence).not.toHaveProperty("source");
    const result = toCriterionResult(results.criterionResults[0]!);
    expect(result).toMatchObject({
      criterionId: "R-01",
      earnedPoints: 0,
      verdict: "FAIL",
      evidenceIds: [evidence.id],
      issueId: "case:R-01-normal-order",
      reviewState: "NOT_REQUIRED",
    });
    expect(result).not.toHaveProperty("interpretation");
    expect(result).not.toHaveProperty("satisfiedSubCriterionIds");
  });

  it("이미 판정이 있는 평가에는 다시 쓰지 않는다 (EvaluationResultsExistError)", async () => {
    const seed = await seedEvaluation(tdb.db);
    await persistEvaluationResults(tdb.db, sampleInput(seed.evaluationId, seed.rubricVersion));
    await expect(
      persistEvaluationResults(tdb.db, sampleInput(seed.evaluationId, seed.rubricVersion)),
    ).rejects.toBeInstanceOf(EvaluationResultsExistError);
    const results = await getEvaluationResults(tdb.db, seed.evaluationId);
    expect(results.executionRecords).toHaveLength(1);
    expect(results.evidences).toHaveLength(1);
  });

  it("G-02 위반(감점인데 근거 없음)은 스키마가 거부하고 트랜잭션이 되돌아간다", async () => {
    const seed = await seedEvaluation(tdb.db);
    await expect(
      persistEvaluationResults(
        tdb.db,
        sampleInput(seed.evaluationId, seed.rubricVersion, { evidenceIds: [] }),
      ),
    ).rejects.toThrow(/Evidence/);
    const results = await getEvaluationResults(tdb.db, seed.evaluationId);
    expect(results.executionRecords).toHaveLength(0);
    expect(results.evidences).toHaveLength(0);
    expect(results.criterionResults).toHaveLength(0);
    expect((await getEvaluation(tdb.db, seed.evaluationId))?.scoreEarned).toBeNull();
  });

  it("입력에 없는 근거를 가리키는 판정은 거부한다", async () => {
    const seed = await seedEvaluation(tdb.db);
    await expect(
      persistEvaluationResults(
        tdb.db,
        sampleInput(seed.evaluationId, seed.rubricVersion, { evidenceIds: [randomUUID()] }),
      ),
    ).rejects.toThrow(/입력에 없는 근거/);
    expect(await hasCriterionResults(tdb.db, seed.evaluationId)).toBe(false);
  });

  it("PARTIAL 판정의 satisfiedSubCriterionIds를 저장하고 되읽는다", async () => {
    const seed = await seedEvaluation(tdb.db);
    const input = sampleInput(seed.evaluationId, seed.rubricVersion, {
      verdict: "PARTIAL",
      earnedPoints: 40,
      satisfiedSubCriterionIds: ["R-01a"],
    });
    await persistEvaluationResults(tdb.db, input);
    const [row] = (await getEvaluationResults(tdb.db, seed.evaluationId)).criterionResults;
    expect(row?.satisfiedSubCriterionIds).toEqual(["R-01a"]);
    expect(toCriterionResult(row!).satisfiedSubCriterionIds).toEqual(["R-01a"]);
  });
});
