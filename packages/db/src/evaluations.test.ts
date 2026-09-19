import { InvalidTransitionError, type EvaluationStageRecord } from "@ohmyti/core";
import { describe, expect, it } from "vitest";
import { applyStagePatch, stageRecordOf } from "./evaluations";

const NOW = new Date("2026-09-18T09:00:00.000Z");

describe("applyStagePatch", () => {
  it("기록이 없는 단계는 PENDING이며 RUNNING으로 바꾸면 startedAt이 붙는다", () => {
    expect(stageRecordOf([], "ENV_PREP")).toEqual({ stage: "ENV_PREP", state: "PENDING" });
    const log = applyStagePatch([], "ENV_PREP", { state: "RUNNING", now: NOW });
    expect(log).toEqual([
      { stage: "ENV_PREP", state: "RUNNING", startedAt: "2026-09-18T09:00:00.000Z" },
    ]);
  });

  it("종료 상태로 바꾸면 finishedAt이 붙고 reason·detail이 보존된다", () => {
    const running = applyStagePatch([], "ENV_PREP", {
      state: "RUNNING",
      detail: { supported: false },
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 1000);
    const closed = applyStagePatch(running, "ENV_PREP", {
      state: "UNSUPPORTED",
      reason: "MISSING_START_SCRIPT: x",
      now: later,
    });
    expect(closed[0]).toEqual({
      stage: "ENV_PREP",
      state: "UNSUPPORTED",
      startedAt: "2026-09-18T09:00:00.000Z",
      finishedAt: "2026-09-18T09:00:01.000Z",
      reason: "MISSING_START_SCRIPT: x",
      detail: { supported: false },
    });
  });

  it("허용되지 않는 전이는 InvalidTransitionError이고 같은 상태 유지 갱신은 허용한다", () => {
    const done = applyStagePatch(
      applyStagePatch([], "REPO_CHECK", { state: "RUNNING", now: NOW }),
      "REPO_CHECK",
      { state: "DONE", now: NOW },
    );
    expect(() => applyStagePatch(done, "REPO_CHECK", { state: "RUNNING" })).toThrow(
      InvalidTransitionError,
    );
    expect(() => applyStagePatch([], "ENV_PREP", { state: "DONE" })).toThrow(
      InvalidTransitionError,
    );
    const same = applyStagePatch(done, "REPO_CHECK", { state: "DONE", detail: { sha: "x" } });
    expect(same[0]?.detail).toEqual({ sha: "x" });
    expect(same[0]?.finishedAt).toBe(done[0]?.finishedAt);
  });

  it("단계 순서대로 정렬하고 다른 단계 기록은 건드리지 않는다", () => {
    const log: EvaluationStageRecord[] = [
      { stage: "ENV_PREP", state: "RUNNING", startedAt: "2026-09-18T09:00:00.000Z" },
    ];
    const next = applyStagePatch(log, "REPO_CHECK", { state: "SKIPPED", reason: "r", now: NOW });
    expect(next.map((s) => s.stage)).toEqual(["REPO_CHECK", "ENV_PREP"]);
    expect(next[1]).toEqual(log[0]);
  });
});
