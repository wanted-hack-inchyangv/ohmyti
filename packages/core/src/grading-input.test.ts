import { describe, expect, it } from "vitest";
import { sampleRubric } from "./fixtures";
import {
  FORBIDDEN_GRADING_INPUT_PREFIXES,
  GradingInputSchema,
  findForbiddenGradingInputKeys,
  type AssertNoForbiddenKeys,
  type GradingInput,
} from "./grading-input";
import { SubmissionSchema } from "./entities";

// 컴파일 시점 검사 (G-10). GradingInput에 resume/github/applicant 키가 생기면 여기서 typecheck가 실패한다.
const gradingInputHasNoForbiddenKeys: AssertNoForbiddenKeys<GradingInput> = true;

// 검사 자체가 동작하는지 고정: 금지 키를 추가한 타입은 never가 되어 대입할 수 없다.
type WithResume = GradingInput & { resumeText: string };
type WithNestedGithub = GradingInput & { snapshot: { githubLogin: string } };
type WithApplicantInArray = GradingInput & { extras: { applicantName: string }[] };
// @ts-expect-error resume* 키가 있으면 대입이 실패해야 한다
const withResume: AssertNoForbiddenKeys<WithResume> = true;
// @ts-expect-error 중첩 객체의 github* 키도 잡아야 한다
const withNestedGithub: AssertNoForbiddenKeys<WithNestedGithub> = true;
// @ts-expect-error 배열 원소의 applicant* 키도 잡아야 한다
const withApplicantInArray: AssertNoForbiddenKeys<WithApplicantInArray> = true;

describe("GradingInput (G-10)", () => {
  it("타입 검사가 컴파일 시점에 고정된다", () => {
    expect([
      gradingInputHasNoForbiddenKeys,
      withResume,
      withNestedGithub,
      withApplicantInArray,
    ]).toEqual([true, true, true, true]);
  });

  it("스키마 트리 어디에도 resume/github/applicant 키가 없다", () => {
    expect(FORBIDDEN_GRADING_INPUT_PREFIXES).toEqual(["resume", "github", "applicant"]);
    expect(findForbiddenGradingInputKeys(GradingInputSchema)).toEqual([]);
  });

  it("런타임 검사는 금지 키를 실제로 찾아낸다 (Submission에는 resumeRef·githubLogin이 있다)", () => {
    expect(findForbiddenGradingInputKeys(SubmissionSchema)).toEqual(["resumeRef", "githubLogin"]);
  });

  it("알 수 없는 키가 들어오면 파싱을 거부한다", () => {
    const input: GradingInput = {
      assignmentVersionId: "av-1",
      rubricVersion: "sample-v1",
      spec: { ref: "spec.md", digest: "c".repeat(64) },
      rubric: sampleRubric(),
      executionContract: {
        startCommand: "npm start",
        portEnv: "PORT",
        healthPath: "/health",
        healthTimeoutMs: 10_000,
        resetPath: "/admin/reset",
        templateName: "order-api-ts",
        nodeVersion: "22",
      },
      snapshot: {
        submissionSha: "d".repeat(40),
        artifactRef: "snapshots/x.tar.gz",
        fileCount: 12,
        totalBytes: 4096,
        truncated: false,
      },
      harnessVersion: "h1",
    };
    expect(GradingInputSchema.safeParse(input).success).toBe(true);
    expect(GradingInputSchema.safeParse({ ...input, resumeText: "..." }).success).toBe(false);
    expect(GradingInputSchema.safeParse({ ...input, applicant: { name: "x" } }).success).toBe(
      false,
    );
  });
});
