import { describe, expect, it } from "vitest";
import { InvalidArtifactKeyError } from "./errors";
import { artifactKeys, parseArtifactKey, parseArtifactPrefix, RUN_RECORD_PARTS } from "./keys";

describe("artifactKeys", () => {
  it("티켓의 키 규약과 일치한다", () => {
    expect(artifactKeys.snapshot("s1")).toBe("submissions/s1/snapshot.tar.gz");
    expect(artifactKeys.snapshotManifest("s1")).toBe("submissions/s1/snapshot-manifest.json");
    expect(artifactKeys.resume("s1")).toBe("submissions/s1/resume.pdf");
    expect(artifactKeys.submissionPrefix("s1")).toBe("submissions/s1/");
    expect(artifactKeys.evaluationPrefix("e1")).toBe("evaluations/e1/");
    expect(artifactKeys.runPrefix("e1", "r1")).toBe("evaluations/e1/runs/r1/");
    for (const part of RUN_RECORD_PARTS) {
      expect(artifactKeys.runRecord("e1", "r1", part)).toBe(`evaluations/e1/runs/r1/${part}.json`);
    }
    expect(artifactKeys.mutationDiff("e1", "m1")).toBe("evaluations/e1/mutations/m1/diff.patch");
    expect(artifactKeys.mutationSnapshot("e1", "M-01")).toBe(
      "evaluations/e1/mutations/M-01/snapshot.tar.gz",
    );
    expect(artifactKeys.functionGraph("e1")).toBe("evaluations/e1/analysis/function-graph.json");
    expect(artifactKeys.stageResult("e1", "REQUIREMENT_VERIFY", "harness")).toBe(
      "evaluations/e1/stages/REQUIREMENT_VERIFY/harness.json",
    );
    expect(() => artifactKeys.stageResult("e1", "REQUIREMENT_VERIFY", "../x")).toThrow(
      InvalidArtifactKeyError,
    );
    expect(artifactKeys.sandboxLogPrefix("e1", "env1")).toBe("evaluations/e1/sandbox/env1/");
    expect(artifactKeys.assignmentPrefix("a1")).toBe("assignments/a1/");
    expect(artifactKeys.assignmentSpec("a1", "f".repeat(64))).toBe(
      `assignments/a1/specs/${"f".repeat(64)}.md`,
    );
    expect(artifactKeys.validationSampleSnapshot("a1", 2, "A")).toBe(
      "assignments/a1/versions/2/samples/A/snapshot.tar.gz",
    );
    expect(artifactKeys.rubricDraftSpec("e".repeat(64))).toBe(
      `rubric-drafts/specs/${"e".repeat(64)}.md`,
    );
  });

  it("과제 버전 번호는 1 이상의 정수, 명세 다이제스트는 sha256 hex여야 한다", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => artifactKeys.validationSampleSnapshot("a1", bad, "A")).toThrow(
        InvalidArtifactKeyError,
      );
    }
    for (const bad of ["", "abc", "../x", "F".repeat(64)]) {
      expect(() => artifactKeys.assignmentSpec("a1", bad)).toThrow(InvalidArtifactKeyError);
      expect(() => artifactKeys.rubricDraftSpec(bad)).toThrow(InvalidArtifactKeyError);
    }
  });

  it("uuid를 세그먼트로 받는다", () => {
    const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(parseArtifactKey(artifactKeys.snapshot(uuid))).toEqual([
      "submissions",
      uuid,
      "snapshot.tar.gz",
    ]);
  });

  it("ID에 경로 문자가 들어오면 거부한다", () => {
    for (const bad of ["../x", "a/b", "", "..", "a b"]) {
      expect(() => artifactKeys.snapshot(bad)).toThrow(InvalidArtifactKeyError);
      expect(() => artifactKeys.runRecord(bad, "r", "input")).toThrow(InvalidArtifactKeyError);
    }
  });
});

describe("parseArtifactPrefix", () => {
  it("'/'로 끝나는 규약 경로만 받는다", () => {
    expect(parseArtifactPrefix("submissions/s1/")).toEqual(["submissions", "s1"]);
    expect(() => parseArtifactPrefix("submissions/s1")).toThrow(InvalidArtifactKeyError);
    expect(() => parseArtifactPrefix("/")).toThrow(InvalidArtifactKeyError);
    expect(() => parseArtifactPrefix("a//")).toThrow(InvalidArtifactKeyError);
  });
});
