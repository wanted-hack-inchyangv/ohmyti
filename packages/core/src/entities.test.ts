import { describe, expect, it } from "vitest";
import { AiReviewSchema, JobSchema, SubmissionSchema } from "./entities";
import { PACKAGE_NAME } from "./index";

const NOW = "2026-09-18T00:00:00.000Z";

describe("@ohmyti/core", () => {
  it("패키지 이름을 내보낸다", () => {
    expect(PACKAGE_NAME).toBe("@ohmyti/core");
  });
});

describe("엔터티 스키마", () => {
  it("Submission은 URL과 SHA 형식을 검사한다", () => {
    const base = {
      id: "s-1",
      assignmentVersionId: "av-1",
      repoUrl: "https://github.com/acme/order-api",
      status: "RECEIVED",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(SubmissionSchema.safeParse(base).success).toBe(true);
    expect(SubmissionSchema.safeParse({ ...base, repoUrl: "not a url" }).success).toBe(false);
    expect(SubmissionSchema.safeParse({ ...base, submissionSha: "short" }).success).toBe(false);
  });

  it("AiReview는 모델·프롬프트 버전·입력 다이제스트·사용량을 요구한다", () => {
    const review = {
      id: "ai-1",
      kind: "EVIDENCE_REVIEW",
      evaluationId: "e-1",
      provider: "deepseek",
      model: "deepseek-chat",
      promptVersion: "evidence-review@1",
      inputDigest: "e".repeat(64),
      output: { summary: "..." },
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0001 },
      version: 1,
      createdAt: NOW,
    };
    expect(AiReviewSchema.safeParse(review).success).toBe(true);
    const { inputDigest: _omit, ...withoutDigest } = review;
    expect(AiReviewSchema.safeParse(withoutDigest).success).toBe(false);
  });

  it("Job 타임스탬프는 오프셋이 있는 ISO 8601이어야 한다", () => {
    const job = {
      id: "j-1",
      type: "EVALUATE_SUBMISSION",
      payload: { submissionId: "s-1" },
      status: "QUEUED",
      attempts: 0,
      maxAttempts: 3,
      runAfter: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(JobSchema.safeParse(job).success).toBe(true);
    expect(JobSchema.safeParse({ ...job, runAfter: "2026-09-18 00:00:00" }).success).toBe(false);
  });
});

describe("EvaluateSubmissionPayloadSchema", () => {
  it("submissionId만 허용하고 다른 키는 거부한다", async () => {
    const { EvaluateSubmissionPayloadSchema, evaluateSubmissionDedupeKey } = await import("./jobs");
    expect(EvaluateSubmissionPayloadSchema.safeParse({ submissionId: "s-1" }).success).toBe(true);
    expect(EvaluateSubmissionPayloadSchema.safeParse({}).success).toBe(false);
    expect(
      EvaluateSubmissionPayloadSchema.safeParse({ submissionId: "s-1", resumeText: "x" }).success,
    ).toBe(false);
    expect(evaluateSubmissionDedupeKey("s-1")).toBe("EVALUATE_SUBMISSION:s-1");
  });
});
