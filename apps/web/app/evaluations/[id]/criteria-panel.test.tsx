import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { aggregateScore, type CriterionResult, type Verdict } from "@ohmyti/core";
import {
  parseWorkbenchSearchParams,
  workbenchHref,
  type CriteriaFilter,
  type WorkbenchUrlState,
} from "@/lib/workbench/state";
import { buildWorkbenchView, matchesFilter, RUBRIC_AREA_ORDER } from "@/lib/workbench/view";
import {
  DEFAULT_BY_AREA,
  DEFECTIVE_SAMPLE_VERDICTS,
  FIXTURE_EVALUATION_ID,
  reportFixture,
  type ReportFixtureOptions,
} from "@/lib/workbench/fixtures";
import { moveFocus } from "./criteria-keyboard-nav";
import { WorkbenchShell } from "./workbench-shell";

/**
 * 요구사항·점수 패널 (T-302). 정적 HTML을 렌더링해 영역 그룹·소계·필터 개수·테스트 실효성 섹션을 검사한다.
 * 소계 합 = 헤더 점수 검사는 워커와 같은 `aggregateScore`로 만든 픽스처(`aggregate: true`)를 쓴다.
 */

function build(query: Record<string, string> = {}, options: ReportFixtureOptions = {}) {
  const report = reportFixture(options);
  const urlState: WorkbenchUrlState = parseWorkbenchSearchParams(query);
  const view = buildWorkbenchView(report, urlState, (patch) =>
    workbenchHref(report.evaluation.id, urlState, patch),
  );
  return { report, view, html: renderToStaticMarkup(<WorkbenchShell view={view} />) };
}

/** `data-testid="…"` 요소의 텍스트 (첫 일치) */
function textOf(html: string, testId: string): string | null {
  const match = html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`));
  return match ? match[1]! : null;
}

/** `data-testid` 요소의 글자 전체 (안쪽 태그를 벗긴 textContent). 점수는 큰 숫자·만점·나머지 문구로 나뉘어 그려진다 */
function elementText(html: string, testId: string): string | null {
  const open = html.match(new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>`));
  if (!open || open.index === undefined) return null;
  const tag = open[1]!;
  let depth = 1;
  let i = open.index + open[0].length;
  const start = i;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = i;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      i = m.index;
      break;
    }
  }
  return html.slice(start, i).replace(/<[^>]*>/g, "");
}

function panelHtml(html: string): string {
  const start = html.indexOf('data-panel="criteria"');
  const end = html.indexOf('data-panel="replay"');
  return html.slice(start, end);
}

function countOf(html: string, filter: CriteriaFilter): number {
  const match = html.match(new RegExp(`data-filter="${filter}" data-count="(\\d+)"`));
  return Number(match![1]);
}

const DEFECTIVE: ReportFixtureOptions = { verdicts: DEFECTIVE_SAMPLE_VERDICTS, aggregate: true };

describe("CriteriaPanel", () => {
  it("영역별 그룹을 RubricArea 순서로 나열하고 그룹 안 기준은 rubric 순서다", () => {
    const { report, html } = build();
    const panel = panelHtml(html);
    const areas = [...panel.matchAll(/data-area="([A-Z_]+)"/g)].map((m) => m[1]);
    expect(areas).toEqual(RUBRIC_AREA_ORDER);
    // 각 영역의 기준은 rubric 순서 그대로이며, 모든 기준이 정확히 한 번 나온다
    const ids = [...panel.matchAll(/data-criterion="([^"]+)"/g)].map((m) => m[1]);
    const expected = RUBRIC_AREA_ORDER.flatMap((area) =>
      report.rubric.criteria.filter((c) => c.area === area).map((c) => c.id),
    );
    expect(ids).toEqual(expected);
    expect(ids).toHaveLength(report.rubric.criteria.length);
    expect(new Set(ids).size).toBe(ids.length);
    // 영역 제목과 기준 수
    expect(panel).toContain('요구 기능<span class="ml-1 font-normal text-neutral-400">5</span>');
    expect(panel).toContain('경계·실패<span class="ml-1 font-normal text-neutral-400">4</span>');
  });

  it("기준 카드는 ID·제목·earned/max 또는 ?/max·verdict 배지·method·검토 상태를 보인다", () => {
    const { html } = build({ criterion: "R-05" });
    const panel = panelHtml(html);
    // PASS: earned/max
    expect(panel).toMatch(
      /data-criterion="R-01" data-verdict="PASS"[\s\S]*?정상 주문[\s\S]*?>8\/8</,
    );
    // FAIL: 0/max (0점은 확정 점수)
    expect(panel).toMatch(/data-criterion="R-05" data-verdict="FAIL"[\s\S]*?>0\/14</);
    // INCONCLUSIVE·판정 없음: ?/max (0점과 구분, G-04)
    expect(panel).toMatch(/data-criterion="R-12" data-verdict="INCONCLUSIVE"[\s\S]*?>\?\/10</);
    expect(panel).toMatch(/data-criterion="R-02" class[\s\S]*?>\?\/6</);
    expect(panel).not.toMatch(/>-\/\d+</);
    // method·검토 상태
    expect(panel).toContain("설계·변경 용이성 · 사람 검토");
    expect(panel).toContain("실행 재현성·문서 · 정적");
    expect(panel).toMatch(/data-criterion="R-12"[\s\S]*?data-review-state="PENDING"/);
    // 선택 카드 하나
    expect(panel.match(/data-selected="true"/g)).toHaveLength(1);
    expect(panel).toContain('data-criterion="R-05" data-verdict="FAIL" aria-current="true"');
  });

  it("필터 개수가 데이터의 verdict 분포와 일치한다", () => {
    const cases: Array<Record<string, Verdict>> = [
      DEFECTIVE_SAMPLE_VERDICTS,
      { "R-01": "PASS", "R-05": "FAIL", G1: "INCONCLUSIVE", "R-12": "INCONCLUSIVE" },
      {},
      { "R-01": "FAIL", "R-02": "FAIL", "R-03": "PARTIAL" },
    ];
    for (const verdicts of cases) {
      const { report, view, html } = build({}, { verdicts });
      const distribution = { FAIL: 0, INCONCLUSIVE: 0, none: 0 };
      for (const criterion of report.rubric.criteria) {
        const result = report.criterionResults.find((r) => r.criterionId === criterion.id);
        if (!result) distribution.none += 1;
        else if (result.verdict === "FAIL") distribution.FAIL += 1;
        else if (result.verdict === "INCONCLUSIVE") distribution.INCONCLUSIVE += 1;
      }
      expect(view.filter.counts, JSON.stringify(verdicts)).toEqual({
        all: report.rubric.criteria.length,
        fail: distribution.FAIL,
        inconclusive: distribution.INCONCLUSIVE + distribution.none,
      });
      expect(countOf(html, "all")).toBe(view.filter.counts.all);
      expect(countOf(html, "fail")).toBe(view.filter.counts.fail);
      expect(countOf(html, "inconclusive")).toBe(view.filter.counts.inconclusive);
      // 화면에 보이는 개수가 필터 개수와 같다
      for (const filter of ["fail", "inconclusive"] as const) {
        const filtered = build({ filter }, { verdicts });
        const shown = [...panelHtml(filtered.html).matchAll(/data-criterion="([^"]+)"/g)];
        expect(shown, `${filter} ${JSON.stringify(verdicts)}`).toHaveLength(
          view.filter.counts[filter],
        );
      }
    }
  });

  it("필터 링크는 filter 키만 바꾸고 선택·run·tab을 유지하며, 빈 영역은 안내를 보인다", () => {
    const { html, view } = build({ criterion: "R-05", tab: "github", filter: "fail" }, DEFECTIVE);
    expect(html).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&amp;tab=github" data-filter="all"`,
    );
    expect(html).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&amp;tab=github&amp;filter=fail" data-filter="fail" data-count="3" aria-current="true"`,
    );
    expect(html).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&amp;tab=github&amp;filter=inconclusive" data-filter="inconclusive"`,
    );
    // 실패만: R-05·R-06·R-07만 보이고 실패 없는 영역은 안내
    const ids = [...panelHtml(html).matchAll(/data-criterion="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["R-05", "R-06", "R-07"]);
    expect(html).toContain('data-testid="area-empty-TEST_EFFECTIVENESS"');
    expect(html).toContain('data-testid="area-empty-DESIGN"');
    expect(html).toContain("필터에 해당하는 기준이 없습니다");
    expect(html).toContain('경계·실패<span class="ml-1 font-normal text-neutral-400">1/4</span>');
    // 필터가 걸려도 선택 상태는 유지된다
    expect(view.selectedCriterion?.id).toBe("R-05");
    expect(html).toContain('data-selected-criterion="R-05"');
    // 카드 링크도 filter를 유지한다
    expect(html).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-06&amp;tab=github&amp;filter=fail" data-criterion-link="R-06"`,
    );
    expect(matchesFilter(view.criteria[0]!, "all")).toBe(true);
  });

  it("소계 합이 헤더 점수와 같다 (워커와 같은 aggregateScore로 저장한 값)", () => {
    const { report, view, html } = build({}, DEFECTIVE);
    const score = report.score!;
    expect(score.display).toBe("49~74/100 · 25점 검토 대기");
    expect(elementText(html, "score-display")).toBe(score.display);

    const subtotals = view.areaGroups.map((g) => g.subtotal!);
    expect(subtotals).toHaveLength(5);
    const sum = (key: "earned" | "min" | "max" | "pendingPoints" | "total") =>
      subtotals.reduce((acc, s) => acc + s[key], 0);
    expect(sum("earned")).toBe(score.earned);
    expect(sum("min")).toBe(score.min);
    expect(sum("max")).toBe(score.max);
    expect(sum("pendingPoints")).toBe(score.pendingPoints);
    expect(sum("total")).toBe(score.total);

    // 화면의 소계 문자열·data 속성은 저장된 byArea 그대로다
    for (const stored of score.byArea!) {
      const testId = `subtotal-${stored.area}`;
      expect(html).toContain(
        `data-testid="${testId}" data-earned="${stored.earned}" data-min="${stored.min}" data-max="${stored.max}" data-pending="${stored.pendingPoints}" data-total="${stored.total}"`,
      );
    }
    expect(textOf(html, "subtotal-REQUIRED_FEATURES")).toBe("20/40");
    expect(textOf(html, "subtotal-EDGE_AND_FAILURE")).toBe("19/25");
    expect(textOf(html, "subtotal-TEST_EFFECTIVENESS")).toBe("0~15/15");
    expect(textOf(html, "subtotal-DESIGN")).toBe("0~10/10");
    expect(textOf(html, "subtotal-REPRODUCIBILITY_AND_DOCS")).toBe("10/10");

    // 집계 엔진의 영역 소계와 저장된 소계가 같다 (기본 픽스처의 손으로 쓴 소계도 합이 맞는다)
    expect(aggregateScore(report.criterionResults, report.rubric).byArea).toEqual(score.byArea);
    const fixedSum = DEFAULT_BY_AREA.reduce((acc, s) => acc + s.earned, 0);
    expect(fixedSum).toBe(54);
  });

  it("소계는 저장된 값을 옮기고 필터로 기준이 가려져도 바뀌지 않는다", () => {
    const full = build({}, DEFECTIVE);
    const filtered = build({ filter: "fail" }, DEFECTIVE);
    expect(filtered.view.areaGroups.map((g) => g.subtotal)).toEqual(
      full.view.areaGroups.map((g) => g.subtotal),
    );
    // 저장된 값이 결과와 어긋나도 화면은 저장된 값을 보인다 (재계산하지 않는다)
    const { html } = build(
      {},
      {
        score: {
          earned: 1,
          min: 1,
          max: 2,
          pendingPoints: 1,
          total: 100,
          display: "1~2/100 · 1점 검토 대기",
          byArea: [{ area: "DESIGN", earned: 1, min: 1, max: 2, pendingPoints: 1, total: 10 }],
        },
      },
    );
    expect(textOf(html, "subtotal-DESIGN")).toBe("1~2/10");
    expect(textOf(html, "subtotal-REQUIRED_FEATURES")).toBe("소계 없음");
  });

  it("영역 소계가 저장되지 않은 평가(0005 이전)와 판정 저장 전 평가는 소계 없음으로 표시한다", () => {
    const legacy = build(
      {},
      {
        score: {
          earned: 54,
          min: 54,
          max: 69,
          pendingPoints: 15,
          total: 100,
          display: "54~69/100 · 15점 검토 대기",
          byArea: null,
        },
      },
    );
    expect(legacy.view.subtotalsMissing).toBe(true);
    expect(legacy.html).toContain('data-testid="subtotals-missing"');
    expect(legacy.html.match(/소계 없음/g)).toHaveLength(5);

    const before = build({}, { score: null });
    expect(before.view.subtotalsMissing).toBe(false);
    expect(before.html).not.toContain('data-testid="subtotals-missing"');
    expect(before.html.match(/소계 없음/g)).toHaveLength(5);
  });

  it("4단계 전에는 실효성 그룹이 검토 대기 · 미구현으로 표시되고 점수가 ?다", () => {
    const { view, html } = build({}, DEFECTIVE);
    expect(view.effectiveness.notImplemented).toBe(true);
    expect(view.effectiveness.groups.map((g) => g.id)).toEqual(["G1", "G2", "G3"]);
    expect(html).toContain('data-testid="effectiveness" data-not-implemented="true"');
    expect(html).toContain('data-testid="effectiveness-not-implemented"');
    for (const group of view.effectiveness.groups) {
      expect(group.criterion?.id).toBe(group.id);
      expect(group.criterion?.pointsDisplay).toBe("?/5");
      expect(group.criterion?.reviewState).toBe("PENDING");
      expect(group.statusLabel).toBe("미구현");
      const row = html.match(
        new RegExp(`data-group="${group.id}" data-criterion="${group.id}"[\\s\\S]*?</li>`),
      )![0];
      expect(row).toContain('data-testid="group-points">?/5<');
      expect(row).toContain('data-review-state="PENDING"');
      expect(row).toContain(">검토 대기<");
      expect(row).toContain('data-testid="group-status">미구현<');
      expect(row).toContain(`data-criterion-link="${group.id}"`);
    }
    expect(html).toContain("기준 R-03, R-04 · 변형 M-01, M-02");
    expect(html).toContain("기준 R-09 · 변형 M-05");
    // 실효성 영역은 그룹 행이 기준 카드를 대신하므로 G1~G3이 두 번 나오지 않는다
    expect(html.match(/data-criterion="G1"/g)).toHaveLength(1);
  });

  it("단계가 미구현이 아니면 그룹 상태는 판정 관측을 보이고, 그룹 기준이 없으면 판정 없음이다", () => {
    const implemented = build(
      {},
      {
        verdicts: DEFECTIVE_SAMPLE_VERDICTS,
        stages: [{ stage: "TEST_EFFECTIVENESS", state: "DONE" }],
      },
    );
    expect(implemented.view.effectiveness.notImplemented).toBe(false);
    expect(implemented.view.effectiveness.groups[0]!.statusLabel).toBe("G1 관측");
    expect(implemented.html).not.toContain('data-testid="effectiveness-not-implemented"');

    const noResults = build({}, { verdicts: {}, stages: [] });
    expect(noResults.view.effectiveness.groups[0]!.statusLabel).toBe("판정 없음");
    expect(noResults.html).toContain('data-testid="group-points">?/5<');
  });

  it("G1 카드를 선택하면 그룹 행이 선택되고 중앙·오른쪽 패널 제목이 바뀐다", () => {
    const { html } = build({ criterion: "G1" }, DEFECTIVE);
    expect(html).toContain(
      'data-group="G1" data-criterion="G1" data-verdict="INCONCLUSIVE" aria-current="true" data-selected="true"',
    );
    expect(html.match(/data-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="replay-criterion">G1<');
    expect(html).toContain("G1의 근거");
  });

  it("키보드 상하 이동은 포커스를 이전·다음 카드 링크로 옮긴다", () => {
    const links = [{}, {}, {}] as unknown as HTMLAnchorElement[];
    expect(moveFocus(links, -1, "ArrowDown")).toBe(0);
    expect(moveFocus(links, 0, "ArrowDown")).toBe(1);
    expect(moveFocus(links, 2, "ArrowDown")).toBe(2);
    expect(moveFocus(links, -1, "ArrowUp")).toBe(2);
    expect(moveFocus(links, 1, "ArrowUp")).toBe(0);
    expect(moveFocus(links, 0, "ArrowUp")).toBe(0);
    expect(moveFocus(links, 1, "Home")).toBe(0);
    expect(moveFocus(links, 0, "End")).toBe(2);
    expect(moveFocus(links, 0, "Enter")).toBe(-1);
    expect(moveFocus([], 0, "ArrowDown")).toBe(-1);
    const { html } = build();
    expect(html).toContain('data-testid="criteria-keyboard-nav"');
    expect(html.match(/data-criterion-link="/g)).toHaveLength(15);
  });

  it("fail 토큰은 FAIL 카드에만, pending 토큰은 INCONCLUSIVE·PENDING에만 쓰이고 홍보 수치가 없다", () => {
    const { html } = build({ filter: "fail" }, DEFECTIVE);
    const panel = panelHtml(html);
    const failTags = panel.match(/data-tone="fail"/g) ?? [];
    expect(failTags).toHaveLength(3);
    expect(panel.match(/data-verdict="FAIL" class="contents"/g)).toHaveLength(3);
    expect(panel).not.toMatch(/정확도|비용 절감|%/);
  });

  it("결과가 없는 CriterionResult 타입도 미확정으로 센다", () => {
    const { view } = build({}, { verdicts: {} });
    expect(view.criteria.every((c) => c.unresolved)).toBe(true);
    expect(view.filter.counts).toEqual({ all: 15, fail: 0, inconclusive: 15 });
    const partial: CriterionResult["verdict"] = "PARTIAL";
    const withPartial = build({}, { verdicts: { "R-01": partial } });
    expect(withPartial.view.filter.counts.inconclusive).toBe(14);
  });
});

describe("요구사항·점수 패널 코드에 점수 계산 로직이 없다", () => {
  it("criteria-panel·keyboard-nav가 aggregateScore를 부르지 않고 배점을 더하지 않는다", async () => {
    for (const name of ["criteria-panel.tsx", "criteria-keyboard-nav.tsx"]) {
      const source = await readFile(path.join(import.meta.dirname, name), "utf8");
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, name).not.toMatch(/aggregateScore/);
      expect(code, name).not.toMatch(/formatS(tored)?coreDisplay/);
      expect(code, name).not.toMatch(/\.reduce\(/);
      expect(code, name).not.toMatch(/maxPoints\s*[-+]|earnedPoints\s*[-+]|pendingPoints\s*[-+]/);
      expect(code, name).not.toMatch(/\bfetch\(/);
    }
  });
});
