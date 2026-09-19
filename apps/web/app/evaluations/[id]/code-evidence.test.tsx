import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Evidence, SourceLocation } from "@ohmyti/core";
import {
  buildCodeEvidenceView,
  containsLocation,
  githubBlobUrl,
  parseGitHubRepo,
  PINNED_SHA_PATTERN,
  snippetLines,
} from "@/lib/workbench/code-evidence";
import {
  FIXTURE_EVALUATION_ID,
  FIXTURE_RUN_ID,
  FIXTURE_SHA,
  reportFixture,
  type ReportFixtureOptions,
} from "@/lib/workbench/fixtures";
import { parseWorkbenchSearchParams, workbenchHref } from "@/lib/workbench/state";
import { buildWorkbenchView } from "@/lib/workbench/view";
import { WorkbenchShell } from "./workbench-shell";

/**
 * 코드 근거 뷰어 (T-305). 샘플 A 스냅샷의 실제 파일 줄을 근거 스니펫으로 넣어(워커가 저장하는 형태) 정적 HTML을 렌더링하고,
 * 링크가 고정 SHA만 쓰는지·스니펫이 파일 줄과 같은지·빈 상태·라벨을 검사한다.
 */

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const SAMPLE_A = path.join(repoRoot, "samples/order-api/impl-a");
/** 샘플 A의 `POST /orders` 핸들러 위치 (T-304 완료 기록: `src/http/routes.ts:25-28`) */
const HANDLER_SOURCE: SourceLocation = { path: "src/http/routes.ts", startLine: 25, endLine: 28 };
const README_SOURCE: SourceLocation = { path: "README.md", startLine: 3, endLine: 9 };
const STATIC_EVIDENCE_ID = "2d5b1a2e-0000-4000-8000-00000000a304";
const README_EVIDENCE_ID = "2d5b1a2e-0000-4000-8000-00000000a205";
const LLM_EVIDENCE_ID = "2d5b1a2e-0000-4000-8000-00000000a407";

async function sampleLines(source: SourceLocation): Promise<string[]> {
  const text = await readFile(path.join(SAMPLE_A, source.path), "utf8");
  return text.split(/\r?\n/).slice(source.startLine - 1, source.endLine);
}

function evidence(
  id: string,
  source: SourceLocation | undefined,
  snippet: string | undefined,
  kind?: Evidence["kind"],
): Evidence {
  return {
    id,
    evaluationId: FIXTURE_EVALUATION_ID,
    submissionSha: FIXTURE_SHA,
    ...(source ? { source } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(kind ? { kind } : {}),
    runId: FIXTURE_RUN_ID,
    testId: "R-05-case",
    artifactRefs: [`evaluations/${FIXTURE_EVALUATION_ID}/analysis/function-graph.json`],
  };
}

function build(query: Record<string, string>, options: ReportFixtureOptions = {}) {
  const report = reportFixture(options);
  const urlState = parseWorkbenchSearchParams(query);
  const view = buildWorkbenchView(report, urlState, (patch) =>
    workbenchHref(report.evaluation.id, urlState, patch),
  );
  return { report, view, html: renderToStaticMarkup(<WorkbenchShell view={view} />) };
}

/** 워커가 저장하는 형태의 정적 관계 근거: 샘플 A 파일 줄 그대로 */
async function staticRelationEvidence(): Promise<Evidence> {
  const lines = await sampleLines(HANDLER_SOURCE);
  return evidence(STATIC_EVIDENCE_ID, HANDLER_SOURCE, lines.join("\n"), "STATIC_RELATION");
}

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

describe("코드 근거 뷰어: GitHub 링크는 고정 SHA만 쓴다", () => {
  it("blob URL 형식이 `<o>/<r>/blob/<pinned_sha>/<path>#L<start>-L<end>`이고 HEAD·브랜치가 없다", () => {
    const url = githubBlobUrl("https://github.com/example/order-api", FIXTURE_SHA, HANDLER_SOURCE);
    expect(url).toBe(
      `https://github.com/example/order-api/blob/${FIXTURE_SHA}/src/http/routes.ts#L25-L28`,
    );
    expect(url).not.toMatch(/HEAD|\/main\/|\/master\//);
    // `.git`·끝 슬래시·www도 같은 링크
    for (const repo of [
      "https://github.com/example/order-api.git",
      "https://github.com/example/order-api/",
      "https://www.github.com/example/order-api",
    ]) {
      expect(githubBlobUrl(repo, FIXTURE_SHA, HANDLER_SOURCE)).toBe(url);
    }
    // 한 줄이어도 같은 형식
    expect(
      githubBlobUrl("https://github.com/example/order-api", FIXTURE_SHA, {
        path: "src/a.ts",
        startLine: 7,
        endLine: 7,
      }),
    ).toMatch(/#L7-L7$/);
  });

  it("SHA가 40자 hex가 아니면(HEAD·브랜치·짧은 SHA) 링크를 만들지 않는다", () => {
    for (const sha of ["HEAD", "main", "refs/heads/main", FIXTURE_SHA.slice(0, 12), ""]) {
      expect(PINNED_SHA_PATTERN.test(sha)).toBe(false);
      expect(githubBlobUrl("https://github.com/example/order-api", sha, HANDLER_SOURCE)).toBeNull();
    }
  });

  it("GitHub가 아닌 저장소 URL은 링크 없이 안내만 한다", async () => {
    expect(parseGitHubRepo("https://gitlab.com/example/order-api")).toBeNull();
    expect(parseGitHubRepo("not a url")).toBeNull();
    expect(parseGitHubRepo("https://github.com/example")).toBeNull();
    const report = reportFixture({
      extraEvidences: [{ criterionId: "R-05", evidence: await staticRelationEvidence() }],
    });
    report.submission.repoUrl = "https://gitlab.com/example/order-api";
    const urlState = parseWorkbenchSearchParams({ criterion: "R-05" });
    const view = buildCodeEvidenceView(report, urlState, (patch) =>
      workbenchHref(report.evaluation.id, urlState, patch),
    );
    expect(view.githubUnavailable).toBe(true);
    expect(view.items[0]!.githubUrl).toBeNull();
  });

  it("렌더링된 모든 GitHub 링크에 pinned_sha가 있고 HEAD·브랜치 이름·repoRef가 없다", async () => {
    const readmeLines = await sampleLines(README_SOURCE);
    const { report, html } = build(
      { criterion: "R-05" },
      {
        extraEvidences: [
          { criterionId: "R-05", evidence: await staticRelationEvidence() },
          {
            criterionId: "R-05",
            evidence: evidence(README_EVIDENCE_ID, README_SOURCE, readmeLines.join("\n")),
          },
          {
            criterionId: "R-05",
            evidence: evidence(
              LLM_EVIDENCE_ID,
              { path: "src/domain/order-service.ts", startLine: 10, endLine: 12 },
              "a\nb\nc",
              "LLM_INTERPRETATION",
            ),
          },
        ],
      },
    );
    report.submission.repoRef = "feature/idempotency";
    const github = hrefsOf(html).filter((h) => h.startsWith("https://github.com/"));
    expect(github.length).toBe(3);
    for (const href of github) {
      expect(href).toMatch(
        new RegExp(
          `^https://github\\.com/example/order-api/blob/${FIXTURE_SHA}/[^#]+#L\\d+-L\\d+$`,
        ),
      );
      expect(href).not.toMatch(/HEAD|\/main\/|\/master\/|feature\/idempotency|\/tree\//);
    }
    expect(github).toContain(
      `https://github.com/example/order-api/blob/${FIXTURE_SHA}/src/http/routes.ts#L25-L28`,
    );
    expect(html).not.toContain("blob/HEAD");
  });
});

describe("코드 근거 뷰어: 스니펫과 라인 번호", () => {
  it("표시된 스니펫이 스냅샷 파일의 해당 라인과 동일하고 라인 번호가 source 범위와 같다", async () => {
    const lines = await sampleLines(HANDLER_SOURCE);
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain('router.post("/orders"');
    const { view, html } = build(
      { criterion: "R-05" },
      { extraEvidences: [{ criterionId: "R-05", evidence: await staticRelationEvidence() }] },
    );
    expect(view.codeEvidence.status).toBe("ok");
    const [item] = view.codeEvidence.items;
    expect(item!.lines.map((l) => l.text)).toEqual(lines);
    expect(item!.lines.map((l) => l.number)).toEqual([25, 26, 27, 28]);
    expect(item!.lines.every((l) => l.highlighted)).toBe(true);
    expect(item!.truncated).toBe(false);
    // HTML: 줄마다 data-line 번호와 원문(HTML 이스케이프 해제 후)이 파일 줄과 같다
    const rendered = [
      ...html.matchAll(/data-line="(\d+)"[^>]*>.*?<span class="whitespace-pre">(.*?)<\/span>/g),
    ].map((m) => [Number(m[1]), unescape(m[2]!)] as const);
    expect(rendered).toEqual(lines.map((text, i) => [25 + i, text]));
    expect(html).toContain('data-source="src/http/routes.ts:25-28"');
  });

  it("잘림 표시 줄은 라인이 아니라 잘림 안내로 보이고, `?source=` 하위 범위만 강조한다", () => {
    const source = { path: "src/x.ts", startLine: 10, endLine: 14 };
    const clipped = snippetLines("l10\nl11\nl12\n…", source);
    expect(clipped.truncated).toBe(true);
    expect(clipped.lines.map((l) => l.number)).toEqual([10, 11, 12]);
    const readme = snippetLines("a\nb\n…(잘림)", { path: "README.md", startLine: 1, endLine: 30 });
    expect(readme.truncated).toBe(true);
    expect(readme.lines.length).toBe(2);
    // 잘림 표시가 아닌 마지막 줄은 그대로 라인이다
    expect(snippetLines("a\nb", source).truncated).toBe(false);
    expect(snippetLines("…", source).lines).toEqual([{ number: 10, text: "…", highlighted: true }]);
    const sub = snippetLines("l10\nl11\nl12\nl13\nl14", source, {
      path: "src/x.ts",
      startLine: 12,
      endLine: 13,
    });
    expect(sub.lines.map((l) => l.highlighted)).toEqual([false, false, true, true, false]);
    expect(containsLocation(source, { path: "src/x.ts", startLine: 12, endLine: 13 })).toBe(true);
    expect(containsLocation(source, { path: "src/y.ts", startLine: 12, endLine: 13 })).toBe(false);
    expect(containsLocation(source, { path: "src/x.ts", startLine: 9, endLine: 13 })).toBe(false);
  });

  it("그래프 노드 링크(`?source=`)가 근거 범위 안이면 그 항목을 선택·강조하고, 밖이면 위치만 보여 준다", async () => {
    const options: ReportFixtureOptions = {
      extraEvidences: [{ criterionId: "R-05", evidence: await staticRelationEvidence() }],
    };
    const inside = build({ criterion: "R-05", source: "src/http/routes.ts:26-27" }, options);
    expect(inside.view.codeEvidence.standalone).toBeNull();
    const [item] = inside.view.codeEvidence.items;
    expect(item!.selected).toBe(true);
    expect(item!.lines.map((l) => l.highlighted)).toEqual([false, true, true, false]);
    expect(inside.html).toContain('data-selected="true"');
    expect(inside.html.match(/data-highlight="true"/g)?.length).toBe(2);

    const outside = build(
      { criterion: "R-05", source: "src/domain/order-service.ts:40-52" },
      options,
    );
    const { standalone } = outside.view.codeEvidence;
    expect(standalone).not.toBeNull();
    expect(standalone!.evidenceId).toBeNull();
    expect(standalone!.snippetMissing).toBe(true);
    expect(standalone!.githubUrl).toBe(
      `https://github.com/example/order-api/blob/${FIXTURE_SHA}/src/domain/order-service.ts#L40-L52`,
    );
    expect(outside.html).toContain('data-testid="code-evidence-standalone"');
    expect(outside.html).toContain('data-testid="snippet-missing"');
    // 근거 항목은 선택되지 않는다
    expect(outside.view.codeEvidence.items[0]!.selected).toBe(false);
  });

  it("항목 링크는 `?source=`로 위치를 넣고 코드 탭을 연다", async () => {
    const { view } = build(
      { criterion: "R-05", pane: "graph" },
      { extraEvidences: [{ criterionId: "R-05", evidence: await staticRelationEvidence() }] },
    );
    expect(view.codeEvidence.items[0]!.href).toBe(
      `/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&source=src%2Fhttp%2Froutes.ts%3A25-28`,
    );
  });
});

describe("코드 근거 뷰어: 빈 상태", () => {
  it("코드 위치가 없는 근거만 있으면 `코드 위치 미확정 · 라우트 분석 결과 없음`을 보이고 오류가 없다", () => {
    // 기본 픽스처: R-05의 근거는 실행 기록 참조뿐(source 없음)
    const { view, html } = build({ criterion: "R-05" });
    expect(view.codeEvidence.status).toBe("no-location");
    expect(view.codeEvidence.evidenceCount).toBe(1);
    expect(view.codeEvidence.items).toEqual([]);
    expect(html).toContain('data-testid="code-evidence-empty"');
    expect(html).toContain("코드 위치 미확정 · 라우트 분석 결과 없음");
    expect(html).not.toContain('data-testid="code-evidence-item"');
    expect(html).not.toContain("https://github.com/example/order-api/blob");
  });

  it("근거가 없는 기준(PASS)과 기준 미선택도 빈 상태다", () => {
    const pass = build({ criterion: "R-01" });
    expect(pass.view.codeEvidence.status).toBe("no-location");
    expect(pass.view.codeEvidence.evidenceCount).toBe(0);
    expect(pass.html).toContain("코드 위치 미확정 · 라우트 분석 결과 없음");
    const none = build({});
    expect(none.view.codeEvidence.status).toBe("no-criterion");
    expect(none.html).toContain('data-testid="code-evidence-no-criterion"');
    expect(none.html).not.toContain('data-testid="code-evidence-empty"');
  });

  it("스니펫이 없는 위치 근거는 위치·링크만 보이고 원문 없음을 알린다", () => {
    const { view, html } = build(
      { criterion: "R-05" },
      {
        extraEvidences: [
          {
            criterionId: "R-05",
            evidence: evidence(STATIC_EVIDENCE_ID, HANDLER_SOURCE, undefined),
          },
        ],
      },
    );
    expect(view.codeEvidence.status).toBe("ok");
    expect(view.codeEvidence.items[0]!.snippetMissing).toBe(true);
    expect(html).toContain('data-testid="snippet-missing"');
    expect(html).not.toContain('data-testid="snippet"');
  });
});

describe("코드 근거 뷰어: 라벨", () => {
  it("라벨이 근거 kind에 따라 `관측`/`정적 관계`/`추정`으로 구분되고 `추정`만 pending 토큰이다", async () => {
    const readmeLines = await sampleLines(README_SOURCE);
    const { view, html } = build(
      { criterion: "R-05" },
      {
        extraEvidences: [
          {
            criterionId: "R-05",
            evidence: evidence(README_EVIDENCE_ID, README_SOURCE, readmeLines.join("\n")),
          },
          { criterionId: "R-05", evidence: await staticRelationEvidence() },
          {
            criterionId: "R-05",
            evidence: evidence(
              LLM_EVIDENCE_ID,
              { path: "src/domain/order-service.ts", startLine: 10, endLine: 12 },
              "a\nb\nc",
              "LLM_INTERPRETATION",
            ),
          },
        ],
      },
    );
    expect(view.codeEvidence.items.map((i) => [i.kind, i.label])).toEqual([
      [null, "관측"],
      ["STATIC_RELATION", "정적 관계"],
      ["LLM_INTERPRETATION", "추정"],
    ]);
    const labels = [...html.matchAll(/data-evidence-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["관측", "정적 관계", "추정"]);
    // 라벨 배지의 색: 관측 ink, 정적 관계 neutral, 추정 pending. pending은 추정 래퍼 뒤에만 온다
    const badges = [
      ...html.matchAll(/<span data-tone="(\w+)" data-testid="evidence-kind-label"/g),
    ].map((m) => m[1]);
    expect(badges).toEqual(["ink", "neutral", "pending"]);
    expect(html).toContain(
      '<span data-interpretation="true" class="contents"><span data-tone="pending"',
    );
    // 정적 노드에 실행을 뜻하는 문구를 붙이지 않는다
    expect(html).not.toContain("실행 경로");
  });
});

describe("코드 근거 뷰어 코드는 스냅샷·네트워크를 읽지 않고 점수를 계산하지 않는다", () => {
  it("소스에 fetch·fs·aggregateScore·reduce가 없다", async () => {
    const files = [
      path.join(import.meta.dirname, "code-evidence-panel.tsx"),
      path.join(import.meta.dirname, "../../../lib/workbench/code-evidence.ts"),
    ];
    for (const file of files) {
      const code = (await readFile(file, "utf8"))
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/fetch\(|XMLHttpRequest|node:fs|readFile/);
      expect(code, file).not.toMatch(/aggregateScore|\.reduce\(/);
      expect(code, file).not.toMatch(/\bHEAD\b|\/tree\//);
    }
  });
});

function unescape(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
