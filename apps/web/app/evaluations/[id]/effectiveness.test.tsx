import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EvaluationReportSchema,
  type EvaluationReport,
  type ExecutionRecord,
  type MutationExperiment,
  type RunRecordReport,
} from "@ohmyti/core";
import {
  FIXTURE_DIGEST,
  FIXTURE_EVALUATION_ID,
  FIXTURE_SHA,
  reportFixture,
} from "@/lib/workbench/fixtures";
import {
  buildMutationPanelView,
  parseDiffLines,
  selectMutationExperiment,
  type MutationDetailInput,
} from "@/lib/workbench/mutation";
import { selectReplayRunId } from "@/lib/workbench/replay";
import { parseWorkbenchSearchParams, workbenchHref } from "@/lib/workbench/state";
import { buildWorkbenchView } from "@/lib/workbench/view";
import { WorkbenchShell } from "./workbench-shell";

/**
 * 테스트 실효성 점수(T-404)의 워크벤치 표시. 결함 샘플 C와 같은 모양의 리포트(G1 FAIL: M-01·M-02 SURVIVED,
 * G2 INCONCLUSIVE: M-03·M-04 NOT_APPLICABLE, G3 PASS: M-05 KILLED)로 왼쪽 그룹 행과 중앙 변형 실험 뷰를 검사한다.
 */

const E = FIXTURE_EVALUATION_ID;
const uuid = (n: number) => `a${String(n).padStart(7, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const runKey = (runId: string, part: string) => `evaluations/${E}/runs/${runId}/${part}.json`;
const diffKey = (mutationId: string) => `evaluations/${E}/mutations/${mutationId}/diff.patch`;

const IDS = {
  m01Validation: uuid(1),
  m01Tests: uuid(2),
  m02Validation: uuid(3),
  m02Tests: uuid(4),
  m05Validation: uuid(5),
  m05Tests: uuid(6),
  baselineTests: uuid(7),
} as const;

function record(
  id: string,
  kind: NonNullable<ExecutionRecord["kind"]>,
  failureKind: ExecutionRecord["failureKind"],
): ExecutionRecord {
  return {
    id,
    evaluationId: E,
    kind,
    submissionSha: FIXTURE_SHA,
    rubricVersion: "v1",
    harnessVersion: "0.0.0+abcdef0123456789",
    environmentDigest: FIXTURE_DIGEST,
    ...(kind.startsWith("MUTATION") ? { patchDigest: "b".repeat(64) } : {}),
    inputRef: runKey(id, "input"),
    expectedRef: runKey(id, "expected"),
    actualRef: runKey(id, "actual"),
    exitCode: null,
    failureKind,
  };
}

function experiment(
  mutationId: string,
  groupId: string,
  targetCriterionId: string,
  outcome: MutationExperiment["outcome"],
  ids: { validation?: string; tests?: string } = {},
): MutationExperiment {
  const applied = outcome !== "NOT_APPLICABLE";
  return {
    id: uuid(100 + Number(mutationId.slice(2))),
    evaluationId: E,
    mutationId,
    groupId,
    targetCriterionId,
    ...(applied
      ? {
          target: { path: "src/order-service.ts", startLine: 12, endLine: 17 },
          patchDigest: "b".repeat(64),
          patchRef: diffKey(mutationId),
        }
      : {}),
    outcome,
    ...(ids.validation
      ? { validationRecordId: ids.validation, validationVerdict: "FAIL" as const }
      : {}),
    ...(ids.tests ? { testRecordId: ids.tests } : {}),
    ...(outcome === "SURVIVED"
      ? { reason: "제출 테스트가 변형에서도 모두 통과함" }
      : outcome === "NOT_APPLICABLE"
        ? { reason: "대상 로직 없음 · 휴리스틱 후보 없음" }
        : {}),
    createdAt: "2026-09-19T01:00:00.000Z",
  };
}

/** 결함 샘플 C 모양: 워커(T-404)가 저장했을 판정·근거·실험 */
function defectiveReport(): EvaluationReport {
  const base = reportFixture({
    verdicts: {
      "R-01": "PASS",
      "R-05": "FAIL",
      G1: "FAIL",
      G2: "INCONCLUSIVE",
      G3: "PASS",
      "R-12": "INCONCLUSIVE",
    },
    aggregate: true,
    stages: [
      { stage: "REQUIREMENT_VERIFY", state: "DONE" },
      { stage: "TEST_EFFECTIVENESS", state: "DONE", detail: { precondition: { status: "READY" } } },
    ],
    mutationExperiments: [
      experiment("M-01", "G1", "R-03", "SURVIVED", {
        validation: IDS.m01Validation,
        tests: IDS.m01Tests,
      }),
      experiment("M-02", "G1", "R-04", "SURVIVED", {
        validation: IDS.m02Validation,
        tests: IDS.m02Tests,
      }),
      experiment("M-03", "G2", "R-05", "NOT_APPLICABLE"),
      experiment("M-04", "G2", "R-06", "NOT_APPLICABLE"),
      experiment("M-05", "G3", "R-09", "KILLED", {
        validation: IDS.m05Validation,
        tests: IDS.m05Tests,
      }),
    ],
  });
  const ev = (n: number) => uuid(200 + n);
  const evidence = (id: string, runId: string | null, refs: string[]) => ({
    id,
    evaluationId: E,
    submissionSha: FIXTURE_SHA,
    ...(runId
      ? { runId }
      : { source: { path: "src/order-service.ts", startLine: 12, endLine: 17 } }),
    artifactRefs: refs,
  });
  const evidences = [
    evidence(ev(1), IDS.m01Validation, [runKey(IDS.m01Validation, "actual"), diffKey("M-01")]),
    evidence(ev(2), IDS.m01Tests, [runKey(IDS.m01Tests, "actual"), diffKey("M-01")]),
    evidence(ev(3), null, [diffKey("M-01")]),
    evidence(ev(4), IDS.m02Validation, [runKey(IDS.m02Validation, "actual"), diffKey("M-02")]),
    evidence(ev(5), IDS.m02Tests, [runKey(IDS.m02Tests, "actual"), diffKey("M-02")]),
    evidence(ev(6), null, [diffKey("M-02")]),
    evidence(ev(7), IDS.baselineTests, [runKey(IDS.baselineTests, "actual")]),
    evidence(ev(8), IDS.m05Validation, [runKey(IDS.m05Validation, "actual"), diffKey("M-05")]),
    evidence(ev(9), IDS.m05Tests, [runKey(IDS.m05Tests, "actual"), diffKey("M-05")]),
  ];
  const observation: Record<string, string> = {
    G1: "검증되지 않은 요구사항: R-03, R-04 · M-01 SURVIVED(R-03): 제출 테스트가 변형에서도 모두 통과함 · M-02 SURVIVED(R-04): 제출 테스트가 변형에서도 모두 통과함",
    G2: "유효한 변형 없음: 결함을 주입해 확인할 수 없어 검토 대기 · M-03 NOT_APPLICABLE(R-05): 대상 로직 없음",
    G3: "유효한 변형을 제출 테스트가 모두 탐지함 · M-05 KILLED(R-09)",
  };
  const evidenceIds: Record<string, string[]> = {
    G1: [ev(1), ev(2), ev(3), ev(4), ev(5), ev(6), ev(7)],
    G2: [ev(7)],
    G3: [ev(8), ev(9), ev(7)],
  };
  return EvaluationReportSchema.parse({
    ...base,
    criterionResults: base.criterionResults.map((r) =>
      r.method === "MUTATION"
        ? {
            ...r,
            observation: observation[r.criterionId]!,
            evidenceIds: evidenceIds[r.criterionId]!,
            ...(r.criterionId === "G1" ? { issueId: "untested:G1" } : {}),
          }
        : r,
    ),
    evidences: [...base.evidences, ...evidences],
    executionRecords: [
      ...base.executionRecords,
      record(IDS.m01Validation, "MUTATION_VALIDATION", "ASSERTION"),
      record(IDS.m01Tests, "MUTATION_TESTS", "NONE"),
      record(IDS.m02Validation, "MUTATION_VALIDATION", "ASSERTION"),
      record(IDS.m02Tests, "MUTATION_TESTS", "NONE"),
      record(IDS.m05Validation, "MUTATION_VALIDATION", "ASSERTION"),
      record(IDS.m05Tests, "MUTATION_TESTS", "ASSERTION"),
      record(IDS.baselineTests, "SUBMITTED_TESTS", "NONE"),
    ],
  });
}

function runReport(recordRow: ExecutionRecord, actual: RunRecordReport["actual"]): RunRecordReport {
  return {
    evaluationId: E,
    runId: recordRow.id,
    record: recordRow,
    evidences: [],
    input: { kind: recordRow.kind ?? null },
    expected:
      recordRow.kind === "MUTATION_TESTS"
        ? { status: "FAILED", minFailed: 1 }
        : { verdict: "FAIL" },
    actual,
    timeline: null,
    logs: { stdout: [], stderr: [] },
  };
}

const M01_DIFF = [
  "--- a/src/order-service.ts",
  "+++ b/src/order-service.ts",
  "@@ -12,6 +12,1 @@",
  "-    if (product.stock < quantity) {",
  "-      throw new InsufficientStockError();",
  "-    }",
  "     product.stock -= quantity;",
  "",
].join("\n");

function detailFor(report: EvaluationReport, mutationId: string): MutationDetailInput {
  const exp = report.mutationExperiments.find((e) => e.mutationId === mutationId)!;
  const find = (id: string | undefined) => report.executionRecords.find((r) => r.id === id)!;
  return {
    mutationId,
    diff: exp.patchRef ? { ok: true, text: mutationId === "M-01" ? M01_DIFF : "" } : null,
    validation: exp.validationRecordId
      ? {
          ok: true,
          data: runReport(find(exp.validationRecordId), {
            caseId: "R-03-insufficient-stock",
            verdict: "FAIL",
            failureKind: "ASSERTION",
            cases: [
              {
                caseId: "R-03-insufficient-stock",
                verdict: "FAIL",
                checks: [
                  { name: "status 409", ok: false, expected: 409, actual: 201 },
                  { name: "stock unchanged", ok: false, expected: 2, actual: -1 },
                ],
              },
            ],
          }),
        }
      : null,
    tests: exp.testRecordId
      ? {
          ok: true,
          data: runReport(find(exp.testRecordId), {
            status: "PASSED",
            failureKind: "NONE",
            reason: null,
            total: 12,
            passed: 12,
            failed: 0,
            testFiles: [{ path: "test/orders.test.ts", error: null, tests: [] }],
          }),
        }
      : null,
  };
}

function render(query: Record<string, string>, withDetail = true) {
  const report = defectiveReport();
  const urlState = parseWorkbenchSearchParams(query);
  const selected = selectMutationExperiment(report, urlState);
  const view = buildWorkbenchView(
    report,
    urlState,
    (patch) => workbenchHref(report.evaluation.id, urlState, patch),
    null,
    null,
    null,
    withDetail && selected ? detailFor(report, selected.mutationId) : null,
  );
  return { report, view, html: renderToStaticMarkup(<WorkbenchShell view={view} />) };
}

/** 태그를 지운 화면 텍스트 */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
}

describe("테스트 실효성 워크벤치 (T-404)", () => {
  it("왼쪽 그룹 행: G1 0/5 실패와 검증되지 않은 요구사항 R-03·R-04, G2 ?/5 검토 대기, G3 5/5", () => {
    const { html, view } = render({});
    const panel = html.slice(
      html.indexOf('data-testid="effectiveness"'),
      html.indexOf('data-panel="replay"'),
    );
    const row = (id: string) =>
      panel.slice(
        panel.indexOf(`data-group="${id}"`),
        panel.indexOf("</li>", panel.indexOf(`data-group="${id}"`)),
      );
    expect(row("G1")).toMatch(/data-testid="group-points"[^>]*>0\/5</);
    expect(row("G1")).toContain('data-verdict="FAIL"');
    expect(row("G1")).toMatch(
      /data-testid="group-unverified"[^>]*>검증되지 않은 요구사항 R-03, R-04</,
    );
    expect(row("G1")).toContain("M-01 놓침 · M-02 놓침");
    expect(row("G2")).toMatch(/data-testid="group-points"[^>]*>\?\/5</);
    expect(row("G2")).toContain('data-review-state="PENDING"');
    expect(row("G2")).not.toContain("group-unverified");
    expect(row("G3")).toMatch(/data-testid="group-points"[^>]*>5\/5</);
    expect(row("G3")).toContain("M-05 탐지됨");
    // 4단계 전 안내는 사라진다
    expect(view.effectiveness.notImplemented).toBe(false);
    expect(panel).not.toContain("effectiveness-not-implemented");
    // 그룹 행은 기준 선택 링크다
    expect(row("G1")).toContain(`href="/evaluations/${E}?criterion=G1"`);
  });

  it("G1을 클릭하면 M-01 diff와 유효성 검증 기록, 제출 테스트 기록이 모두 열린다", () => {
    const report = defectiveReport();
    const urlState = parseWorkbenchSearchParams({ criterion: "G1" });
    // 페이지가 읽을 기록: 재생 뷰는 G1의 첫 근거(M-01 검증 기록)를, 변형 뷰는 M-01을 연다
    expect(selectReplayRunId(report, urlState)).toBe(IDS.m01Validation);
    expect(selectMutationExperiment(report, urlState)?.mutationId).toBe("M-01");

    const { html, view } = render({ criterion: "G1" });
    expect(view.mutation).not.toBeNull();
    expect(view.mutation!.selected?.mutationId).toBe("M-01");
    expect(html).toContain('data-testid="mutation-panel"');
    expect(html).toContain('data-selected-mutation="M-01"');
    // diff
    const diff = html.slice(html.indexOf('data-testid="mutation-diff"'));
    expect(diff).toContain('data-diff-line="del"');
    expect(diff).toContain("-    if (product.stock &lt; quantity) {");
    expect(html).toContain('data-testid="mutation-target"');
    // 유효성 검증 기록: 변형 위 하네스 FAIL, 실패 검사
    expect(html).toMatch(
      new RegExp(`data-testid="mutation-validation" data-run="${IDS.m01Validation}"`),
    );
    expect(html).toContain("R-03-insufficient-stock FAIL: status 409, stock unchanged");
    // 제출 테스트 기록: 변형 위에서도 통과
    expect(html).toMatch(new RegExp(`data-testid="mutation-tests" data-run="${IDS.m01Tests}"`));
    expect(visibleText(html)).toMatch(/변형 위 제출 테스트\s+PASSED/);
    // 재생 뷰의 기록 목록에 두 기록이 모두 있고 검증 기록이 선택되어 있다
    const runs = view.replay.runs.map((r) => [r.id, r.kindLabel]);
    expect(runs.slice(0, 4)).toEqual([
      [IDS.m01Validation, "mutation 검증"],
      [IDS.m01Tests, "mutation 테스트"],
      [IDS.m02Validation, "mutation 검증"],
      [IDS.m02Tests, "mutation 테스트"],
    ]);
    expect(view.replay.selectedRun?.id).toBe(IDS.m01Validation);
    // 변형 기록은 하네스 케이스 재실행 대상이 아니다
    expect(view.replay.rerunControl).toBeNull();
    // 검증되지 않은 요구사항
    expect(view.mutation!.unverifiedCriterionIds).toEqual(["R-03", "R-04"]);
  });

  it("?mutation=M-02로 다른 실험을 펼치고, 실험 링크는 그 실험의 검증 기록을 재생 뷰에 연다", () => {
    const { view } = render({ criterion: "G1", mutation: "M-02" });
    expect(view.mutation!.selected?.mutationId).toBe("M-02");
    const m02 = view.mutation!.experiments.find((e) => e.mutationId === "M-02")!;
    expect(m02.href).toBe(`/evaluations/${E}?criterion=G1&run=${IDS.m02Validation}&mutation=M-02`);
    // 그룹에 없는 변형 ID는 무시하고 첫 실험을 연다
    expect(render({ criterion: "G1", mutation: "M-05" }).view.mutation!.selected?.mutationId).toBe(
      "M-01",
    );
  });

  it("NOT_APPLICABLE뿐인 G2는 diff·기록 없이 사유를 보이고, 본문을 못 읽으면 사유를 적는다", () => {
    const g2 = render({ criterion: "G2" });
    expect(g2.view.mutation!.experiments.map((e) => [e.mutationId, e.outcomeLabel])).toEqual([
      ["M-03", "적용 불가"],
      ["M-04", "적용 불가"],
    ]);
    expect(g2.html).toContain('data-testid="mutation-diff-none"');
    expect(g2.html).toContain('data-testid="mutation-validation-none"');
    expect(g2.html).toContain("대상 로직 없음");

    const missing = render({ criterion: "G1" }, false);
    expect(missing.html).toContain('data-testid="mutation-diff-error"');
    expect(missing.html).toContain('data-testid="mutation-validation-error"');
    expect(missing.html).toContain('data-testid="mutation-tests-error"');
  });

  it("MUTATION이 아닌 기준을 고르면 변형 실험 뷰가 없다", () => {
    expect(render({ criterion: "R-05" }).view.mutation).toBeNull();
    expect(render({}).view.mutation).toBeNull();
  });

  it("UI 어디에도 '변형 생존율 n%' 같은 비율 표기가 없다", async () => {
    for (const query of [
      {},
      { criterion: "G1" },
      { criterion: "G2" },
      { criterion: "G3" },
      { criterion: "G1", mutation: "M-02" },
    ]) {
      const text = visibleText(render(query).html);
      expect(text).not.toMatch(/%/);
      expect(text).not.toMatch(/생존율|탐지율|비율/);
      expect(text).not.toMatch(/\d+\s*\/\s*\d+\s*(?:생존|탐지|놓침|살아)/);
    }
    // 소스에도 퍼센트 계산이 없다
    for (const file of [
      path.join(import.meta.dirname, "mutation-panel.tsx"),
      path.join(import.meta.dirname, "criteria-panel.tsx"),
      path.join(import.meta.dirname, "../../../lib/workbench/mutation.ts"),
    ]) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(/\*\s*100|toFixed|%`|"%"|생존율/);
    }
  });

  it("diff 줄 분류", () => {
    expect(parseDiffLines(M01_DIFF).map((l) => l.kind)).toEqual([
      "meta",
      "meta",
      "hunk",
      "del",
      "del",
      "del",
      "context",
    ]);
    expect(parseDiffLines("")).toEqual([]);
  });

  it("detail이 다른 실험의 것이면 쓰지 않는다", () => {
    const report = defectiveReport();
    const urlState = parseWorkbenchSearchParams({ criterion: "G1" });
    const view = buildMutationPanelView(
      report,
      urlState,
      (patch) => workbenchHref(E, urlState, patch),
      detailFor(report, "M-02"),
    );
    expect(view!.selected?.mutationId).toBe("M-01");
    expect(view!.diff).toEqual({ ok: false, message: "diff 본문을 읽지 않았습니다" });
  });
});
