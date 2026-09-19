import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { verdictTone, reviewStateTone } from "@/components/ui";
import {
  parseWorkbenchSearchParams,
  workbenchHref,
  type WorkbenchUrlState,
} from "@/lib/workbench/state";
import { buildWorkbenchHeader, buildWorkbenchView } from "@/lib/workbench/view";
import {
  FIXTURE_EVALUATION_ID,
  FIXTURE_RUN_ID,
  FIXTURE_SHA,
  reportFixture,
} from "@/lib/workbench/fixtures";
import { WorkbenchShell } from "./workbench-shell";

function render(
  query: Record<string, string> = {},
  options: Parameters<typeof reportFixture>[0] = {},
): string {
  const report = reportFixture(options);
  const urlState: WorkbenchUrlState = parseWorkbenchSearchParams(query);
  const view = buildWorkbenchView(report, urlState, (patch) =>
    workbenchHref(report.evaluation.id, urlState, patch),
  );
  return renderToStaticMarkup(<WorkbenchShell view={view} />);
}

/** 정적 HTML의 여는 태그를 순서대로 (태그 이름, 속성 문자열) 쌍으로 뽑는다 */
function openingTags(html: string): { tag: string; attrs: string; index: number }[] {
  return [...html.matchAll(/<([a-z][a-z0-9]*)((?:\s+[^>]*)?)>/g)].map((m) => ({
    tag: m[1]!,
    attrs: m[2] ?? "",
    index: m.index,
  }));
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

const FAIL_CLASS = /(?:^|\s)(?:bg|text|border|ring)-fail(?:\/\d+)?(?:\s|$|")/;
const PENDING_CLASS = /(?:^|\s)(?:bg|text|border|ring)-pending(?:\/\d+)?(?:\s|$|")/;

describe("WorkbenchShell", () => {
  it("헤더 값이 리포트(T-207 API 응답)에서 그대로 온다", () => {
    const report = reportFixture({ isSample: true });
    const header = buildWorkbenchHeader(report);
    expect(header.scoreDisplay).toBe(report.score!.display);
    expect(header.pendingPoints).toBe(report.score!.pendingPoints);
    expect(header.submissionSha).toBe(report.evaluation.submissionSha);
    expect(header.shortSha).toBe(FIXTURE_SHA.slice(0, 12));
    expect(header.rubricVersion).toBe(report.evaluation.rubricVersion);
    expect(header.isSample).toBe(true);

    const html = render({}, { isSample: true });
    expect(elementText(html, "score-display")).toBe("54~69/100 · 15점 검토 대기");
    expect(html).toContain("15점 검토 대기</span></span>");
    expect(html).toContain(`title="${FIXTURE_SHA}">${FIXTURE_SHA.slice(0, 12)}<`);
    expect(html).toContain(
      `<code class="font-mono text-[13px] text-neutral-800">${report.evaluation.rubricVersion}</code>`,
    );
    expect(html).toContain('data-testid="sample-badge"');
    expect(html).toContain("저장된 실행");
    expect(html).toContain('aria-label="제출 SHA 전체 복사"');
  });

  it("점수가 저장되기 전이면 판정 저장 전 배지를 보이고 검토 대기·샘플 배지는 없다", () => {
    const html = render({}, { score: null });
    expect(html).toContain('data-testid="score-missing"');
    expect(html).not.toContain('data-testid="score-display"');
    expect(html).not.toContain('data-testid="pending-badge"');
    expect(html).not.toContain('data-testid="sample-badge"');
  });

  it("검토 대기 0점이면 검토 대기 배지가 없다", () => {
    const html = render(
      {},
      {
        score: {
          earned: 87,
          min: 87,
          max: 87,
          pendingPoints: 0,
          total: 100,
          display: "87/100",
          byArea: null,
        },
      },
    );
    expect(elementText(html, "score-display")).toBe("87/100");
    expect(html).not.toContain('data-testid="pending-badge"');
  });

  it("fail 토큰은 verdict FAIL 요소에만, pending 토큰은 INCONCLUSIVE·PENDING 요소에만 쓰인다", () => {
    const html = render({ criterion: "R-05" });
    const tags = openingTags(html);
    expect(tags.length).toBeGreaterThan(20);

    // 토큰 클래스를 가진 태그는 모두 Badge(data-tone)이며, 바로 앞 태그가 verdict·reviewState 래퍼다
    let failCount = 0;
    let pendingCount = 0;
    tags.forEach((tag, i) => {
      const hasFail = FAIL_CLASS.test(tag.attrs);
      const hasPending = PENDING_CLASS.test(tag.attrs);
      if (!hasFail && !hasPending) return;
      const previous = tags[i - 1];
      expect(previous, tag.attrs).toBeDefined();
      if (hasFail) {
        failCount += 1;
        expect(tag.attrs).toContain('data-tone="fail"');
        expect(previous!.attrs, tag.attrs).toContain('data-verdict="FAIL"');
      }
      if (hasPending) {
        pendingCount += 1;
        expect(tag.attrs).toContain('data-tone="pending"');
        // T-305: LLM 추정 근거 라벨(`추정`)도 사람 확인 전의 미확정이라 pending 토큰을 쓴다
        expect(previous!.attrs, tag.attrs).toMatch(
          /data-verdict="INCONCLUSIVE"|data-review-state="PENDING"|data-interpretation="true"/,
        );
      }
    });
    // R-05 FAIL: 왼쪽 카드 하나 + 오른쪽 근거 패널 판정 배지 하나(T-306).
    // INCONCLUSIVE 둘(G1·R-12) + 각각의 PENDING 배지 둘 + 헤더 검토 대기 배지 하나
    expect(failCount).toBe(2);
    expect(pendingCount).toBe(5);

    // 반대 방향: FAIL·INCONCLUSIVE·PENDING 래퍼 뒤에는 반드시 해당 토큰 배지가 온다
    tags.forEach((tag, i) => {
      const next = tags[i + 1];
      if (/data-verdict="FAIL"/.test(tag.attrs) && /class="contents"/.test(tag.attrs)) {
        expect(next!.attrs).toMatch(FAIL_CLASS);
      }
      if (
        /data-verdict="INCONCLUSIVE"|data-review-state="PENDING"/.test(tag.attrs) &&
        /class="contents"/.test(tag.attrs)
      ) {
        expect(next!.attrs).toMatch(PENDING_CLASS);
      }
      if (/data-verdict="(PASS|PARTIAL)"/.test(tag.attrs) && /class="contents"/.test(tag.attrs)) {
        expect(next!.attrs).not.toMatch(FAIL_CLASS);
        expect(next!.attrs).not.toMatch(PENDING_CLASS);
      }
    });
    // 흰 배경·차콜 본문 토큰을 쓴다
    expect(html).toContain("bg-surface text-ink");
  });

  it("verdict·reviewState → 색 매핑", () => {
    expect(verdictTone("FAIL")).toBe("fail");
    expect(verdictTone("INCONCLUSIVE")).toBe("pending");
    expect(verdictTone("PASS")).toBe("ink");
    expect(verdictTone("PARTIAL")).toBe("neutral");
    expect(reviewStateTone("PENDING")).toBe("pending");
    expect(reviewStateTone("NOT_REQUIRED")).toBe("neutral");
    expect(reviewStateTone("CONFIRMED")).toBe("neutral");
  });

  it("?criterion=R-05로 열면 해당 기준이 선택된 상태로 렌더링된다", () => {
    const html = render({ criterion: "R-05" });
    expect(html).toContain('data-selected-criterion="R-05"');
    expect(html).toMatch(
      /<div data-criterion="R-05" data-verdict="FAIL" aria-current="true" data-selected="true"/,
    );
    expect(html.match(/data-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="replay-criterion">R-05<');
    // 오른쪽 근거 패널(T-306)도 같은 기준을 보인다
    expect(html).toContain('data-panel="evidence" data-evidence-status="ok"');
    expect(html).toContain('data-testid="evidence-issue-id">case:R-05-case<');
    expect(html).not.toContain('data-testid="unknown-criterion"');
    // 다른 기준 링크는 criterion만 바꾼다
    expect(html).toContain(`href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-01"`);
  });

  it("선택이 없으면 안내 빈 상태를, rubric에 없는 기준이면 찾을 수 없음을 보인다", () => {
    const none = render();
    expect(none).not.toContain("data-selected-criterion=");
    expect(none).not.toContain('data-selected="true"');
    expect(none).toContain("기준을 선택하세요");

    const unknown = render({ criterion: "R-99" });
    expect(unknown).toContain('data-testid="unknown-criterion"');
    expect(unknown).toContain("R-99");
    expect(unknown).not.toContain('data-selected="true"');
  });

  it("rubric의 기준을 순서대로 모두 나열하고 결과가 없는 기준은 판정 없음이다", () => {
    const html = render();
    const ids = [...html.matchAll(/data-criterion="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(reportFixture().rubric.criteria.map((c) => c.id));
    expect(html).toContain("15개 기준");
    expect(html).toContain("판정 없음");
    expect(html).toMatch(/<div data-criterion="R-02" class="[^"]*"><a /);
    // 점수 표기는 저장된 earnedPoints/maxPoints 그대로 (INCONCLUSIVE·판정 없음은 "?")
    expect(html).toContain(">?/5<");
    expect(html).toContain("8/8");
    expect(html).toContain("0/14");
  });

  it("run·tab 딥링크를 반영하고 탭 링크는 토글한다", () => {
    const html = render({ criterion: "R-05", run: FIXTURE_RUN_ID, tab: "resume" });
    expect(html).toContain(`data-selected-run="${FIXTURE_RUN_ID}"`);
    expect(html).toContain('data-testid="selected-run"');
    expect(html).toContain('data-tab="resume" aria-selected="true"');
    expect(html).toContain('data-testid="tab-panel-resume"');
    expect(html).toContain("맥락을 읽지 않았습니다");
    // 하단 탭 4개 + 중앙 하단 탭 2개(코드 근거·함수 그래프, T-303)
    expect(html.match(/role="tab"/g)).toHaveLength(6);
    expect(html.match(/data-tab="[a-z]+" aria-selected=/g)).toHaveLength(4);
    // 활성 탭 링크는 탭을 닫고, 다른 탭 링크는 criterion·run을 유지한다
    expect(html).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&amp;run=${FIXTURE_RUN_ID}" data-tab="resume"`,
    );
    expect(html).toContain(
      `href="/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&amp;run=${FIXTURE_RUN_ID}&amp;tab=github" data-tab="github"`,
    );

    const unknownRun = render({ run: "99999999-9999-4999-8999-999999999999" });
    expect(unknownRun).toContain('data-testid="unknown-run"');
    expect(unknownRun).not.toContain("data-selected-run=");
  });

  it("세 열과 하단 탭 4개 자리가 있고 홍보 수치·진행률이 없다", () => {
    const html = render();
    expect(html).toContain('data-panel="criteria"');
    expect(html).toContain('data-panel="replay"');
    expect(html).toContain('data-panel="evidence"');
    expect(html).toContain('data-panel="tabs"');
    expect(html).toContain("grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]");
    expect(html).not.toMatch(/정확도|비용 절감|%/);
  });

  it("샘플 평가는 `저장된 실행 · <시각>`을, 기준 버전 승인 정보는 `채점기 사전 검증 완료` 배지를 보인다 (T-505)", () => {
    const report = reportFixture({ isSample: true });
    expect(buildWorkbenchHeader(report).sampleLabel).toBe("저장된 실행 · 2026-09-18 18:05 KST");
    expect(buildWorkbenchHeader(reportFixture()).sampleLabel).toBeNull();
    const view = buildWorkbenchView(report, parseWorkbenchSearchParams({}), (patch) =>
      workbenchHref(report.evaluation.id, parseWorkbenchSearchParams({}), patch),
    );
    const html = renderToStaticMarkup(
      <WorkbenchShell
        view={view}
        approval={{
          validated: true,
          label: "채점기 사전 검증 완료",
          detail: "v2 · 1단계 게이트(샘플 A/B/C/D 판별) 통과",
          pendingHumanReview: true,
        }}
      />,
    );
    expect(html).toContain("저장된 실행 · 2026-09-18 18:05 KST</span>");
    expect(html).toContain('data-testid="approval-badge" data-validated="true"');
    expect(html).toContain("채점기 사전 검증 완료</span>");
    expect(html).toContain("샘플 검토 대기</span>");
    // 배지를 읽지 못했으면 헤더에서 빠진다
    expect(render({}, { isSample: true })).not.toContain('data-testid="approval-badge"');
  });
});

describe("워크벤치 코드에 점수 계산 로직이 없다", () => {
  const files = [
    path.join(import.meta.dirname, "workbench-shell.tsx"),
    path.join(import.meta.dirname, "page.tsx"),
    path.join(import.meta.dirname, "../../../lib/workbench/view.ts"),
    path.join(import.meta.dirname, "../../../lib/workbench/state.ts"),
  ];

  it("aggregateScore·formatScoreDisplay를 부르지 않고 배점을 더하지 않는다", async () => {
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/aggregateScore/);
      expect(code, file).not.toMatch(/\bformatScoreDisplay\b/);
      expect(code, file).not.toMatch(/formatStoredScoreDisplay/);
      expect(code, file).not.toMatch(/\.reduce\(/);
      expect(code, file).not.toMatch(/maxPoints\s*[-+]|earnedPoints\s*[-+]|pendingPoints\s*[-+]/);
    }
  });

  it("페이지는 API와 같은 readEvaluationReport로 리포트를 읽는다", async () => {
    const page = await readFile(path.join(import.meta.dirname, "page.tsx"), "utf8");
    expect(page).toMatch(
      /import \{[^}]*\breadEvaluationReport\b[^}]*\breadRunRecord\b[^}]*\} from "@\/lib\/reports\/service"/,
    );
    const route = await readFile(
      path.join(import.meta.dirname, "../../api/evaluations/[id]/route.ts"),
      "utf8",
    );
    expect(route).toContain('import { readEvaluationReport } from "@/lib/reports/service"');
  });
});
