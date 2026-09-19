import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVALUATION_STAGE_ORDER } from "./enums";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  nextStates,
  TRANSITION_TABLE,
  type StateEntity,
} from "./state-machine";

const README_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../README.md");

/** README의 `| 엔터티 | from | to |` 표를 `entity|from|to` 문자열 집합으로 읽는다. */
function readmeTransitions(): string[] {
  const lines = readFileSync(README_PATH, "utf8").split("\n");
  const header = lines.findIndex((line) => /^\|\s*엔터티\s*\|\s*from\s*\|\s*to\s*\|/.test(line));
  expect(header, "README에 상태 전이 표 헤더가 있어야 한다").toBeGreaterThanOrEqual(0);
  const rows: string[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    expect(cells).toHaveLength(3);
    rows.push(cells.join("|"));
  }
  return rows;
}

function tableTransitions(): string[] {
  return (Object.keys(TRANSITION_TABLE) as StateEntity[]).flatMap((entity) =>
    TRANSITION_TABLE[entity].map(([from, to]) => `${entity}|${from}|${to}`),
  );
}

describe("상태 전이 표", () => {
  it("README.md의 표와 TRANSITION_TABLE이 같다 (순서 포함)", () => {
    expect(readmeTransitions()).toEqual(tableTransitions());
  });

  it("전이 표에 중복 항목이 없다", () => {
    const all = tableTransitions();
    expect(new Set(all).size).toBe(all.length);
  });

  it("부록 B: Submission은 어느 상태에서든 DELETED로 갈 수 있다", () => {
    for (const from of [
      "RECEIVED",
      "QUEUED",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "UNSUPPORTED",
    ] as const) {
      expect(canTransition("submission", from, "DELETED")).toBe(true);
    }
    expect(nextStates("submission", "DELETED")).toEqual([]);
  });

  it("부록 B: Job은 어느 상태에서든 CANCELLED로 갈 수 있고 RUNNING → QUEUED 회수가 가능하다", () => {
    for (const from of ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"] as const) {
      expect(canTransition("job", from, "CANCELLED")).toBe(true);
    }
    expect(canTransition("job", "RUNNING", "QUEUED")).toBe(true);
    expect(canTransition("job", "SUCCEEDED", "RUNNING")).toBe(false);
  });

  it("부록 B: AssignmentVersion은 VALIDATING에서 DRAFT로 되돌아가거나 APPROVED로 간다", () => {
    expect(nextStates("assignmentVersion", "VALIDATING")).toEqual(["DRAFT", "APPROVED"]);
    expect(canTransition("assignmentVersion", "DRAFT", "APPROVED")).toBe(false);
    expect(canTransition("assignmentVersion", "RETIRED", "APPROVED")).toBe(false);
  });

  it("부록 B: 평가 단계는 PENDING → RUNNING → DONE | SKIPPED | FAILED | UNSUPPORTED", () => {
    expect(nextStates("evaluationStage", "RUNNING")).toEqual([
      "DONE",
      "SKIPPED",
      "FAILED",
      "UNSUPPORTED",
    ]);
    expect(canTransition("evaluationStage", "DONE", "RUNNING")).toBe(false);
    expect(EVALUATION_STAGE_ORDER).toEqual([
      "REPO_CHECK",
      "ENV_PREP",
      "REQUIREMENT_VERIFY",
      "TEST_EFFECTIVENESS",
      "REVIEW_WRITE",
      "CONTEXT_LINK",
      "INTERVIEW_KIT",
    ]);
  });

  it("같은 상태로의 전이는 허용하지 않는다", () => {
    expect(canTransition("submission", "RUNNING", "RUNNING")).toBe(false);
    expect(canTransition("job", "QUEUED", "QUEUED")).toBe(false);
  });

  it("assertTransition은 허용되지 않는 전이에 InvalidTransitionError를 던진다", () => {
    expect(() => assertTransition("submission", "COMPLETED", "RUNNING")).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition("submission", "RECEIVED", "QUEUED")).not.toThrow();
  });
});
