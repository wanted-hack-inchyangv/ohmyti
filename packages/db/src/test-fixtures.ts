import type { ExecutionContract, Rubric } from "@ohmyti/core";
import type { Database } from "./client";
import { assignments, assignmentVersions, evaluations, submissions } from "./schema";

export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const DIGEST = "a".repeat(64);

export function minimalRubric(version = "test-v1"): Rubric {
  return {
    version,
    criteria: [
      {
        id: "R-01",
        area: "REQUIRED_FEATURES",
        title: "정상 주문",
        maxPoints: 100,
        method: "EXECUTION",
        condition: "정상 주문 201",
        allowPartial: false,
      },
    ],
    groups: [],
    partialRules: [],
    independentReasons: [],
  };
}

export function minimalContract(): ExecutionContract {
  return {
    startCommand: "npm start",
    portEnv: "PORT",
    healthPath: "/health",
    healthTimeoutMs: 10_000,
    resetPath: "/admin/reset",
    templateName: "order-api-ts",
    nodeVersion: "22",
  };
}

/**
 * assignment → version → submission → evaluation 한 벌을 만들고 ID를 돌려준다.
 * `rubric`을 주면 그 rubric(버전은 `rubricVersion`으로 맞춘다)으로 승인 버전을 만든다 (기본은 R-01 하나짜리 최소 rubric).
 */
export async function seedEvaluation(
  db: Database,
  rubricVersion = `test-v1-${Date.now()}`,
  rubric: Rubric = minimalRubric(rubricVersion),
) {
  const [assignment] = await db
    .insert(assignments)
    .values({ name: "테스트 과제" })
    .returning({ id: assignments.id });
  if (!assignment) throw new Error("assignment insert 실패");

  const [version] = await db
    .insert(assignmentVersions)
    .values({
      assignmentId: assignment.id,
      version: 1,
      title: "v1",
      specRef: "artifact://spec",
      specDigest: DIGEST,
      rubric: { ...rubric, version: rubricVersion },
      rubricVersion,
      executionContract: minimalContract(),
      harnessVersion: "harness-0",
      // 제출은 APPROVED 버전에만 만들 수 있다 (T-201 트리거)
      status: "APPROVED",
      approvedBy: "test-fixture",
      approvedAt: new Date(),
    })
    .returning({ id: assignmentVersions.id });
  if (!version) throw new Error("assignment_versions insert 실패");

  const [submission] = await db
    .insert(submissions)
    .values({
      assignmentVersionId: version.id,
      repoUrl: "https://github.com/example/order-api",
      submissionSha: SHA,
    })
    .returning({ id: submissions.id });
  if (!submission) throw new Error("submissions insert 실패");

  const [evaluation] = await db
    .insert(evaluations)
    .values({
      submissionId: submission.id,
      assignmentVersionId: version.id,
      rubricVersion,
      harnessVersion: "harness-0",
      environmentDigest: DIGEST,
      submissionSha: SHA,
    })
    .returning({ id: evaluations.id });
  if (!evaluation) throw new Error("evaluations insert 실패");

  return {
    assignmentId: assignment.id,
    assignmentVersionId: version.id,
    submissionId: submission.id,
    evaluationId: evaluation.id,
    rubricVersion,
  };
}
