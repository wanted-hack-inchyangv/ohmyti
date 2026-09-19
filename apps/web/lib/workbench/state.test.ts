import { describe, expect, it } from "vitest";
import { parseSourceParam, parseWorkbenchSearchParams, workbenchHref } from "./state";

const RUN = "55555555-5555-4555-8555-555555555555";

describe("parseWorkbenchSearchParams", () => {
  it("criterion·run·tab·filter·pane을 읽고 형식이 틀린 값은 없는 것으로 본다", () => {
    expect(
      parseWorkbenchSearchParams({
        criterion: "R-05",
        run: RUN,
        tab: "resume",
        filter: "fail",
        pane: "graph",
      }),
    ).toEqual({
      criterionId: "R-05",
      runId: RUN,
      tab: "resume",
      filter: "fail",
      pane: "graph",
      source: null,
      mutationId: null,
    });
    expect(
      parseWorkbenchSearchParams({
        criterion: "R 05/../x",
        run: "not-a-uuid",
        tab: "other",
        filter: "passed",
        pane: "diff",
      }),
    ).toEqual({
      criterionId: null,
      runId: null,
      tab: null,
      filter: "all",
      pane: "code",
      source: null,
      mutationId: null,
    });
    expect(parseWorkbenchSearchParams({})).toEqual({
      criterionId: null,
      runId: null,
      tab: null,
      filter: "all",
      pane: "code",
      source: null,
      mutationId: null,
    });
    expect(parseWorkbenchSearchParams({ filter: "inconclusive" }).filter).toBe("inconclusive");
  });

  it("source는 `path:start-end` 형식만 받고 경로 탈출·역순 범위는 버린다", () => {
    expect(parseWorkbenchSearchParams({ source: "src/http/routes.ts:25-28" }).source).toBe(
      "src/http/routes.ts:25-28",
    );
    expect(parseSourceParam("src/http/routes.ts:25-28")).toEqual({
      path: "src/http/routes.ts",
      startLine: 25,
      endLine: 28,
    });
    for (const bad of [
      "/etc/passwd:1-2",
      "../x.ts:1-2",
      "src/../x.ts:1-2",
      "src/x.ts:0-2",
      "src/x.ts:5-2",
      "src/x.ts",
      "src/x.ts:a-b",
      "",
    ]) {
      expect(parseSourceParam(bad), bad).toBeNull();
      expect(parseWorkbenchSearchParams({ source: bad }).source, bad).toBeNull();
    }
  });

  it("같은 키가 여러 번 오면 첫 값을 쓴다", () => {
    expect(parseWorkbenchSearchParams({ criterion: ["R-01", "R-02"] }).criterionId).toBe("R-01");
  });
});

describe("workbenchHref", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("상태를 쿼리로 직렬화하고 patch로 일부만 바꾼다", () => {
    const state = {
      criterionId: "R-05",
      runId: RUN,
      tab: "resume" as const,
      filter: "all" as const,
      pane: "code" as const,
      source: null,
      mutationId: null,
    };
    expect(workbenchHref(id, state)).toBe(
      `/evaluations/${id}?criterion=R-05&run=${RUN}&tab=resume`,
    );
    expect(workbenchHref(id, state, { tab: null })).toBe(
      `/evaluations/${id}?criterion=R-05&run=${RUN}`,
    );
    expect(
      workbenchHref(id, {
        criterionId: null,
        runId: null,
        tab: null,
        filter: "all",
        pane: "code",
        source: null,
        mutationId: null,
      }),
    ).toBe(`/evaluations/${id}`);
    expect(
      parseWorkbenchSearchParams(
        Object.fromEntries(new URL(`http://x${workbenchHref(id, state)}`).searchParams),
      ),
    ).toEqual(state);
  });

  it("필터는 all이면 키를 지우고 그 밖에는 filter 키로 남긴다", () => {
    const state = {
      criterionId: "R-05",
      runId: null,
      tab: null,
      filter: "fail" as const,
      pane: "code" as const,
      source: null,
      mutationId: null,
    };
    expect(workbenchHref(id, state)).toBe(`/evaluations/${id}?criterion=R-05&filter=fail`);
    expect(workbenchHref(id, state, { filter: "all" })).toBe(`/evaluations/${id}?criterion=R-05`);
    expect(workbenchHref(id, state, { filter: "inconclusive" })).toBe(
      `/evaluations/${id}?criterion=R-05&filter=inconclusive`,
    );
    expect(
      parseWorkbenchSearchParams(
        Object.fromEntries(new URL(`http://x${workbenchHref(id, state)}`).searchParams),
      ),
    ).toEqual(state);
  });

  it("중앙 탭은 code면 키를 지우고 graph면 pane 키로 남긴다", () => {
    const state = {
      criterionId: "R-05",
      runId: null,
      tab: null,
      filter: "all" as const,
      pane: "graph" as const,
      source: null,
      mutationId: null,
    };
    expect(workbenchHref(id, state)).toBe(`/evaluations/${id}?criterion=R-05&pane=graph`);
    expect(workbenchHref(id, state, { pane: "code" })).toBe(`/evaluations/${id}?criterion=R-05`);
    expect(workbenchHref(id, state, { pane: "code", source: "src/http/routes.ts:25-28" })).toBe(
      `/evaluations/${id}?criterion=R-05&source=src%2Fhttp%2Froutes.ts%3A25-28`,
    );
    expect(
      parseWorkbenchSearchParams(
        Object.fromEntries(new URL(`http://x${workbenchHref(id, state)}`).searchParams),
      ),
    ).toEqual(state);
  });
});
