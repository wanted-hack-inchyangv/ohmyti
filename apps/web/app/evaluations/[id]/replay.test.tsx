import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maskSensitive, type ExecutionRecord, type RunRecordReport } from "@ohmyti/core";
import {
  buildReplayBody,
  groupTimeline,
  runsForCriterion,
  selectReplayRunId,
  type RunRecordInput,
} from "@/lib/workbench/replay";
import { createReplayPlayer } from "@/lib/workbench/replay-player";
import {
  parseWorkbenchSearchParams,
  workbenchHref,
  type WorkbenchUrlState,
} from "@/lib/workbench/state";
import { buildWorkbenchView } from "@/lib/workbench/view";
import {
  DEFECTIVE_SAMPLE_VERDICTS,
  FIXTURE_EVALUATION_ID,
  FIXTURE_RUN_ID,
  reportFixture,
  type ReportFixtureOptions,
} from "@/lib/workbench/fixtures";
import {
  R05_ACTUAL,
  R05_CASE_ID,
  R05_EXPECTED,
  R05_TIMELINE,
  r05RunRecordFixture,
} from "@/lib/workbench/replay-fixtures";
import { formatTimestamp } from "./replay-panel";
import { WorkbenchShell } from "./workbench-shell";

/**
 * 실패 재생 뷰 (T-303). 정적 HTML을 렌더링해 실행 기록 목록·기대/실제 비교·타임라인이 `runs/[runId]` 본문
 * (`r05RunRecordFixture`: 결함 샘플 C와 같은 동작의 실제 하네스 결과)에서 그대로 오는지 검사한다.
 */

const RERUN_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_RUN_ID = "88888888-8888-4888-8888-888888888888";

function build(
  query: Record<string, string>,
  runRecord: RunRecordInput | null,
  options: ReportFixtureOptions = {},
) {
  const report = reportFixture(options);
  const urlState: WorkbenchUrlState = parseWorkbenchSearchParams(query);
  const view = buildWorkbenchView(
    report,
    urlState,
    (patch) => workbenchHref(report.evaluation.id, urlState, patch),
    runRecord,
  );
  return { report, view, html: renderToStaticMarkup(<WorkbenchShell view={view} />) };
}

function decode(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** `data-testid="…"` 요소들의 텍스트 (등장 순) */
function textsOf(html: string, testId: string): string[] {
  return [...html.matchAll(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`, "g"))].map((m) =>
    decode(m[1]!),
  );
}

function replayHtml(html: string): string {
  const start = html.indexOf('data-panel="replay"');
  const end = html.indexOf('data-panel="evidence"');
  return html.slice(start, end);
}

const ok = (data: RunRecordReport): RunRecordInput => ({ ok: true, data });

describe("ReplayPanel: 실행 기록 본문", () => {
  it("C의 R-05를 열면 stateAfter 열에 재고 2 → 1 → 0, 기대 1, 실제 0이 보인다", () => {
    const record = r05RunRecordFixture();
    const { html } = build({ criterion: "R-05" }, ok(record));
    const panel = replayHtml(html);

    // 타임라인의 stateAfter 열: 관측 스텝 3개의 재고가 순서대로 2, 1, 0
    const states = textsOf(panel, "timeline-state-after").filter((t) => t !== "");
    expect(states.map((t) => t.match(/stock: (\d+)/)?.[1])).toEqual(["2", "1", "0"]);
    const observed = R05_TIMELINE.filter((e) => e.kind === "observeState").map(
      (e) => e.stateAfter.stock,
    );
    expect(observed).toEqual([2, 1, 0]);

    // 기대/실제 비교 행: p1After.stock 기대 1, 실제 0, 실패
    expect(panel).toMatch(
      /data-check="p1After\.stock" data-ok="false"[\s\S]*?data-testid="check-expected">1<[\s\S]*?data-testid="check-actual">[\s\S]*?>0</,
    );
    expect(panel).toContain('data-testid="comparison-summary">검사 8개 · 실패 2개<');
  });

  it("화면의 모든 값이 runs/[runId] 본문에서 온다: 타임라인 status·path·elapsed·stateAfter가 기록과 같다", () => {
    const record = r05RunRecordFixture();
    const { html } = build({ criterion: "R-05" }, ok(record));
    const panel = replayHtml(html);

    const rows = [
      ...panel.matchAll(
        /data-timeline-row="(\d+)" data-kind="([a-zA-Z]+)"(?: data-status="(\d+)")?/g,
      ),
    ];
    expect(rows.map((m) => Number(m[1]))).toEqual(R05_TIMELINE.map((e) => e.seq));
    expect(rows.map((m) => m[2])).toEqual(R05_TIMELINE.map((e) => e.kind));
    expect(rows.map((m) => Number(m[3]))).toEqual(R05_TIMELINE.map((e) => e.response.status));
    expect(textsOf(panel, "timeline-status").map(Number)).toEqual(
      R05_TIMELINE.map((e) => e.response.status),
    );
    for (const entry of R05_TIMELINE) {
      expect(panel).toContain(`title="${entry.request.method} ${entry.request.path}"`);
      expect(panel).toContain(`>${entry.elapsedMs} ms<`);
    }
    expect(textsOf(panel, "timeline-state-after").filter((t) => t !== "")).toEqual(
      R05_TIMELINE.filter((e) => e.kind === "observeState").map((e) =>
        Object.entries(e.stateAfter)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join(" · "),
      ),
    );

    // 행을 펼치면 요청·응답 헤더와 본문이 기록 그대로 보인다
    const second = R05_TIMELINE[4];
    expect(decode(panel)).toContain(
      `<dt class="text-neutral-500">idempotency-key</dt><dd class="break-all">${second.request.headers["idempotency-key"]}</dd>`,
    );
    expect(decode(panel)).toContain(JSON.stringify(second.request.body, null, 2));
    expect(decode(panel)).toContain(JSON.stringify(second.response.body, null, 2));

    // 배지·라벨: 저장된 실행 + 시각, 관측
    expect(panel).toContain(`저장된 실행 · ${formatTimestamp(record.record.startedAt!)}`);
    expect(panel).toContain('data-testid="observed-label"');
    // 추정 문구(interpretation)는 이 패널에 두지 않는다. "관측" 라벨의 설명("추정 아님")만 허용
    expect(panel.replace("(추정 아님)", "")).not.toMatch(/추정|interpretation/);
    // 러너 로그 키
    expect(panel).toContain("stdout · logs/service/stdout.txt");
  });

  it("기대/실제 값이 T-207 리포트(run 본문)의 expected·actual과 동일하고 통과/실패는 기록의 checks[].ok를 그대로 쓴다", () => {
    const record = r05RunRecordFixture();
    const { html } = build({ criterion: "R-05" }, ok(record));
    const panel = replayHtml(html);

    // 실패한 검사 = 기록의 expected/actual 맵 (하네스가 남긴 값)
    for (const [name, expectedValue] of Object.entries(R05_EXPECTED.expected)) {
      const actualValue = (R05_ACTUAL.actual as Record<string, unknown>)[name];
      const row = panel.match(
        new RegExp(
          `data-check="${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}" data-ok="false"[\\s\\S]*?</tr>`,
        ),
      )![0];
      expect(decode(row)).toContain(
        `data-testid="check-expected">${JSON.stringify(expectedValue)}<`,
      );
      expect(decode(row)).toMatch(
        new RegExp(`data-testid="check-actual">.*>${JSON.stringify(actualValue)}<`),
      );
    }
    // 원문 JSON은 본문을 그대로 직렬화한 것
    expect(decode(textsOf(panel, "expected-json")[0]!)).toBe(
      JSON.stringify(record.expected, null, 2),
    );
    expect(decode(textsOf(panel, "actual-json")[0]!)).toBe(JSON.stringify(record.actual, null, 2));
    // 통과한 검사 수 = 기록의 ok=true 수
    const okRows = panel.match(/data-ok="true"/g) ?? [];
    expect(okRows).toHaveLength(R05_ACTUAL.checks.filter((c) => c.ok).length);

    // 값이 달라도 기록이 ok=true면 통과로 보인다 (화면이 다시 비교하지 않는다는 증거)
    const tampered = r05RunRecordFixture({
      actual: {
        ...R05_ACTUAL,
        checks: R05_ACTUAL.checks.map((c) => (c.name === "p1After.stock" ? { ...c, ok: true } : c)),
      },
    });
    const body = buildReplayBody(tampered).body;
    const check = body.checks.find((c) => c.name === "p1After.stock")!;
    expect(check).toMatchObject({ ok: true, expected: 1, actual: 0 });
    expect(body.failedCheckNames).toEqual(["second.body.id == first.body.id"]);
  });

  it("요청·응답 본문에 마스킹 전 비밀값이 없다: 하네스가 가린 값만 보이고 마스킹을 다시 적용해도 HTML이 그대로다", () => {
    const record = r05RunRecordFixture();
    const { html } = build({ criterion: "R-05" }, ok(record));
    expect(html).toContain("session=[TOKEN]");
    expect(html).not.toContain("sk-abcdefghijklmnop");
    expect(maskSensitive(html)).toBe(html);

    // 대조군: 가리지 않은 값이 기록에 있으면 화면은 그대로 보여 준다. 마스킹은 기록 시점(T-107)의 책임이므로
    // 이 검사는 화면이 아니라 저장된 기록에 비밀값이 없음을 확인하는 것이다
    const raw = structuredClone(R05_TIMELINE) as unknown as Array<{
      response: { headers: Record<string, string> };
    }>;
    raw[0]!.response.headers["authorization"] = "Bearer sk-rawsecretvalue0001";
    const leaked = r05RunRecordFixture({ timeline: raw as unknown as RunRecordReport["timeline"] });
    const leakedHtml = build({ criterion: "R-05" }, ok(leaked)).html;
    expect(maskSensitive(leakedHtml)).not.toBe(leakedHtml);
  });

  it("fail 토큰은 실패한 검사의 결과 배지·실제값에만 쓰이고 FAIL 래퍼 뒤에 온다", () => {
    const record = r05RunRecordFixture();
    const { html } = build({ criterion: "R-05" }, ok(record));
    const tags = [...html.matchAll(/<([a-z][a-z0-9]*)((?:\s+[^>]*)?)>/g)].map((m) => ({
      attrs: m[2] ?? "",
    }));
    const FAIL_CLASS = /(?:^|\s)(?:bg|text|border|ring)-fail(?:\/\d+)?(?:\s|$|")/;
    let failCount = 0;
    tags.forEach((tag, i) => {
      if (!FAIL_CLASS.test(tag.attrs)) return;
      failCount += 1;
      expect(tag.attrs).toContain('data-tone="fail"');
      expect(tags[i - 1]!.attrs).toContain('data-verdict="FAIL"');
    });
    // 왼쪽 R-05 카드 1 + 오른쪽 근거 패널의 판정 배지 1(T-306) + 실패한 검사 2개 × (실제값 강조 + 결과 배지)
    expect(failCount).toBe(1 + 1 + 2 * 2);
    // 통과한 검사 행에는 fail 토큰이 없다
    for (const row of replayHtml(html).match(/data-ok="true"[\s\S]*?<\/tr>/g) ?? []) {
      expect(row).not.toMatch(FAIL_CLASS);
    }
  });

  it("타임라인이 없는 기록(기동·제출 테스트)은 값을 나란히 놓고 타임라인 없음을 안내한다", () => {
    const generic = r05RunRecordFixture({
      expected: { outcome: "HEALTHY", healthStatus: 200 },
      actual: { startup: { outcome: "HEALTHY", elapsedMs: 812 }, serviceExit: null, failure: null },
      timeline: null,
    });
    const { html } = build({ criterion: "R-05" }, ok(generic));
    const panel = replayHtml(html);
    expect(panel).toContain("기록 값 나란히 보기 (검사 판정 없음)");
    expect(panel).toContain('data-check="outcome"');
    expect(panel).toContain('data-check="startup"');
    expect(panel).not.toContain("data-ok=");
    expect(panel).toContain('data-testid="timeline-empty"');
    expect(panel).not.toContain('data-testid="replay-button"');
  });

  it("본문을 읽지 못하면 사유를 보이고, 기록이 선택되지 않으면 본문 영역이 없다", () => {
    const failed = build(
      { criterion: "R-05" },
      { ok: false, code: "ARTIFACT_NOT_FOUND", message: "actual 아티팩트가 없습니다" },
    );
    const panel = replayHtml(failed.html);
    expect(panel).toContain('data-testid="replay-body-error"');
    expect(panel).toContain("ARTIFACT_NOT_FOUND: actual 아티팩트가 없습니다");
    expect(panel).not.toContain('data-testid="run-body"');

    // 근거가 없는 기준(PASS·HUMAN_REVIEW)은 실행 기록 없음
    const none = build({ criterion: "R-12" }, null);
    expect(replayHtml(none.html)).toContain('data-testid="run-list-empty"');
    expect(none.view.selectedRun).toBeNull();
  });
});

describe("실행 기록 목록과 선택", () => {
  function withRerun(): { report: ReturnType<typeof reportFixture>; rerun: ExecutionRecord } {
    const report = reportFixture({ verdicts: DEFECTIVE_SAMPLE_VERDICTS });
    const original = report.executionRecords[0]!;
    const rerun: ExecutionRecord = {
      ...original,
      id: RERUN_ID,
      kind: "RERUN",
      startedAt: "2026-09-18T10:00:00.000Z",
    };
    const other: ExecutionRecord = { ...original, id: OTHER_RUN_ID, kind: "SUBMITTED_TESTS" };
    report.executionRecords.push(rerun, other);
    report.evidences.push({
      id: "99999999-9999-4999-8999-999999999999",
      evaluationId: FIXTURE_EVALUATION_ID,
      submissionSha: original.submissionSha,
      runId: RERUN_ID,
      testId: R05_CASE_ID,
      artifactRefs: [],
    });
    for (const result of report.criterionResults) {
      if (result.criterionId === "R-05")
        result.evidenceIds.push("99999999-9999-4999-8999-999999999999");
    }
    return { report, rerun };
  }

  it("선택 기준의 근거가 가리키는 기록을 원본 → 재실행 순으로 나열하고, ?run=이 없으면 첫 기록을 고른다", () => {
    const { report } = withRerun();
    const runs = runsForCriterion(report, "R-05");
    expect(runs.map((r) => r.record.id)).toEqual([FIXTURE_RUN_ID, RERUN_ID]);
    const none = parseWorkbenchSearchParams({ criterion: "R-05" });
    expect(selectReplayRunId(report, none)).toBe(FIXTURE_RUN_ID);
    expect(
      selectReplayRunId(report, parseWorkbenchSearchParams({ criterion: "R-05", run: RERUN_ID })),
    ).toBe(RERUN_ID);
    expect(selectReplayRunId(report, parseWorkbenchSearchParams({}))).toBeNull();
    expect(selectReplayRunId(report, parseWorkbenchSearchParams({ criterion: "R-01" }))).toBeNull();

    const urlState = parseWorkbenchSearchParams({ criterion: "R-05" });
    const view = buildWorkbenchView(report, urlState, (patch) =>
      workbenchHref(report.evaluation.id, urlState, patch),
    );
    const html = replayHtml(renderToStaticMarkup(<WorkbenchShell view={view} />));
    const items = [
      ...html.matchAll(
        /data-run="([^"]+)" data-run-selected="(true|false)"(?: data-testid="selected-run")? data-origin="(original|rerun)"/g,
      ),
    ];
    expect(items.map((m) => [m[1], m[2], m[3]])).toEqual([
      [FIXTURE_RUN_ID, "true", "original"],
      [RERUN_ID, "false", "rerun"],
    ]);
    expect(html).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&amp;run=${RERUN_ID}"`,
    );
    expect(html).toContain("2026-09-18 10:00:00Z");
    expect(view.replay.runs[1]).toMatchObject({
      originLabel: "재실행",
      isRerun: true,
      kindLabel: "재실행",
    });
  });

  it("?run=이 다른 기준의 기록이면 기록은 보여 주되 근거가 아님을 안내한다", () => {
    const { report } = withRerun();
    const urlState = parseWorkbenchSearchParams({ criterion: "R-05", run: OTHER_RUN_ID });
    const view = buildWorkbenchView(report, urlState, (patch) =>
      workbenchHref(report.evaluation.id, urlState, patch),
    );
    expect(view.replay.selectedRunOutsideCriterion).toBe(true);
    expect(view.replay.selectedRun?.id).toBe(OTHER_RUN_ID);
    expect(view.selectedRun?.id).toBe(OTHER_RUN_ID);
    const html = renderToStaticMarkup(<WorkbenchShell view={view} />);
    expect(html).toContain('data-testid="run-outside-criterion"');
  });
});

describe("타임라인 묶음과 중앙 탭", () => {
  it("동시 요청 스텝은 같은 stepIndex의 항목을 한 줄로 묶고 재생 순서는 줄 단위다", () => {
    const base = R05_TIMELINE[0];
    const entries = [
      { ...base, seq: 0, stepIndex: -1, kind: "reset" as const },
      ...[1, 2, 3].map((seq) => ({
        ...base,
        seq,
        stepIndex: 0,
        kind: "parallel" as const,
        capture: `same[${seq - 1}]`,
        request: { ...base.request, method: "POST" as const, path: "/orders" },
        response: { ...base.response, status: seq === 1 ? 201 : 409 },
      })),
      { ...base, seq: 4, stepIndex: 1, kind: "observeState" as const, stateAfter: { stock: 1 } },
    ];
    const groups = groupTimeline(entries);
    expect(groups.map((g) => [g.key, g.parallel, g.rows.length, g.label])).toEqual([
      ["seq-0", false, 1, null],
      ["parallel-0", true, 3, "동시 요청 3건 · same"],
      ["seq-4", false, 1, null],
    ]);
    const record = r05RunRecordFixture({
      timeline: entries as unknown as RunRecordReport["timeline"],
    });
    const body = buildReplayBody(record).body;
    expect(body.replaySeqs).toEqual([0, 1, 4]);
    const html = replayHtml(build({ criterion: "R-05" }, ok(record)).html);
    expect(html).toContain('data-timeline-group="0" data-kind="parallel"');
    expect(html).toContain("201, 409, 409");
    expect(html.match(/data-replay-seq="/g)).toHaveLength(3);
  });

  it("중앙 하단 탭은 코드 근거(기본)·함수 그래프이며 ?pane=으로 전환한다", () => {
    const code = build({ criterion: "R-05" }, null);
    let panel = replayHtml(code.html);
    expect(panel).toContain('data-pane="code" role="tab" aria-selected="true"');
    expect(panel).toContain('data-testid="center-pane-code"');
    expect(panel).toContain('data-testid="code-evidence"'); // T-305 코드 근거 뷰어
    expect(panel).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&amp;pane=graph" data-pane="graph"`,
    );
    const graph = build({ criterion: "R-05", pane: "graph" }, null);
    panel = replayHtml(graph.html);
    expect(panel).toContain('data-pane="graph" role="tab" aria-selected="true"');
    expect(panel).toContain('data-testid="graph-panel"');
    expect(panel).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05" data-pane="code"`,
    );
  });

  it("formatTimestamp는 시간대 변환 없이 문자열만 다듬는다", () => {
    expect(formatTimestamp("2026-09-18T09:01:00.250Z")).toBe("2026-09-18 09:01:00Z");
    expect(formatTimestamp("2026-09-18T18:01:00.000+09:00")).toBe("2026-09-18 18:01:00+09:00");
  });
});

describe("재생 버튼", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("네트워크를 차단해도 저장된 순서대로 강조하고 끝나면 활성 표시를 지운다", () => {
    vi.useFakeTimers();
    const blocked = vi.fn(() => {
      throw new Error("network blocked");
    });
    vi.stubGlobal("fetch", blocked);
    vi.stubGlobal("XMLHttpRequest", undefined);
    const record = r05RunRecordFixture();
    const seqs = buildReplayBody(record).body.replaySeqs;
    const steps: Array<number | null> = [];
    const player = createReplayPlayer({
      seqs,
      onStep: (seq) => steps.push(seq),
      stepMs: 100,
      holdMs: 300,
    });
    player.start();
    expect(player.playing).toBe(true);
    expect(steps).toEqual([seqs[0]]);
    vi.advanceTimersByTime(100 * (seqs.length - 1));
    expect(steps).toEqual(seqs);
    // 마지막 줄을 한 간격 동안 보여 준 뒤 hold 시간이 지나야 활성 표시를 지운다
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(299);
    expect(player.playing).toBe(true);
    vi.advanceTimersByTime(1);
    expect(steps).toEqual([...seqs, null]);
    expect(player.playing).toBe(false);
    expect(blocked).not.toHaveBeenCalled();

    // 중지하면 즉시 활성 표시를 지운다
    player.start();
    vi.advanceTimersByTime(100);
    player.stop();
    expect(steps.at(-1)).toBeNull();
    expect(player.playing).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(steps.filter((s) => s === null)).toHaveLength(2);
  });

  it("재생 코드는 네트워크 API를 참조하지 않고, 재생·재실행 버튼의 문구와 설명이 다르다", async () => {
    const dir = import.meta.dirname;
    for (const file of [
      path.join(dir, "../../../lib/workbench/replay-player.ts"),
      path.join(dir, "replay-timeline.tsx"),
    ]) {
      const code = (await readFile(file, "utf8"))
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(
        /\bfetch\(|XMLHttpRequest|EventSource|WebSocket|navigator\.sendBeacon/,
      );
    }
    const html = replayHtml(build({ criterion: "R-05" }, ok(r05RunRecordFixture())).html);
    expect(html).toContain('data-testid="replay-button" data-playing="false"');
    expect(html).toContain(">재생</button>");
    expect(html).toContain("저장된 기록을 순서대로 강조합니다. 네트워크 요청 없음");
    // 재실행 상태를 넘기지 않은 렌더링: 버튼은 비활성이고 문구·설명은 재생과 다르다 (T-307이 상태를 붙인다)
    expect(html).toMatch(
      /<button type="button" disabled="" aria-disabled="true" data-testid="rerun-button" data-rerun-enabled="false"/,
    );
    expect(html).toContain(">재실행</button>");
    expect(html).toContain("같은 조건으로 새 실행 기록을 만듭니다");
    expect(html).toContain("재실행 상태를 읽지 않았습니다");
  });
});

describe("재생 뷰 코드는 값을 재계산하지 않는다", () => {
  it("expected·actual을 다시 비교하거나 배점·재고를 계산하는 코드가 없다", async () => {
    const dir = import.meta.dirname;
    for (const file of [
      path.join(dir, "../../../lib/workbench/replay.ts"),
      path.join(dir, "replay-panel.tsx"),
      path.join(dir, "replay-timeline.tsx"),
    ]) {
      const code = (await readFile(file, "utf8"))
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/aggregateScore|formatScoreDisplay|\.reduce\(/);
      expect(code, file).not.toMatch(
        /expected\s*[!=]==?\s*actual|actual\s*[!=]==?\s*expected|deepEqual|isEqual\(/,
      );
      expect(code, file).not.toMatch(/stock|elapsedMs\s*[-+*/]|status\s*[-+*/]/);
      expect(code, file).not.toMatch(/\bfetch\(/);
    }
  });
});
