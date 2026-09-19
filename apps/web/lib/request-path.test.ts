import { describe, expect, it } from "vitest";
import { submissionIdFromPath } from "./request-path";

describe("submissionIdFromPath (T-506)", () => {
  it("제출 상태 경로에서만 ID를 꺼낸다", () => {
    const id = "5c4db445-b8ce-4872-a59e-fabb4a585276";
    expect(submissionIdFromPath(`/submissions/${id}`)).toBe(id);
    expect(submissionIdFromPath(`/submissions/${id}/`)).toBe(id);
    expect(submissionIdFromPath("/submissions/new")).toBeNull();
    expect(submissionIdFromPath(`/evaluations/${id}`)).toBeNull();
    expect(submissionIdFromPath(null)).toBeNull();
  });
});
