/**
 * 90초 데모 리허설 (T-507). `docs/demo.md` 구간별 화면 표를 순서대로 따라가며 각 화면의 스크린샷을 `docs/demo/`에 남기고,
 * 화면마다 기대 문구가 보이는지 기록한다(`docs/demo/rehearsal.md`). 아무것도 제출하거나 바꾸지 않고 저장된 실행만 연다.
 *
 * 이 스크립트는 사람이 하는 리허설의 준비 작업이다. 화면이 PRD 7장 표와 같은지, 90초 안에 설명할 수 있는지는 사람이
 * 스크린샷과 실제 화면으로 확인한다.
 *
 * 사용: `pnpm demo:rehearsal --base-url https://ohmyti.vercel.app [--out docs/demo]`
 * 환경변수: `APP_ACCESS_PASSWORD`(배포의 접근 비밀번호) 또는 `--password`. 로컬 `next dev`처럼 보호가 꺼져 있으면 생략한다.
 */
import { chromium, type Page } from "@playwright/test";
import { EvaluationReportResponseSchema } from "@ohmyti/core";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { format as prettierFormat, resolveConfig as prettierResolveConfig } from "prettier";
import "./load-env";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_REHEARSAL_OUT = path.join(repoRoot, "docs", "demo");

export interface RehearsalStep {
  segment: string;
  name: string;
  /** base URL 뒤의 경로 */
  path: string;
  /** 화면에 있어야 할 문구 */
  expectTexts: string[];
}

export interface StepResult extends RehearsalStep {
  file: string;
  status: number | null;
  missing: string[];
  loadMs: number;
}

/** `docs/demo.md` 구간별 화면 표를 URL 단계로 옮긴다. `c`는 샘플 C의 저장된 평가 ID, `r05Run`은 R-05 근거 실행 ID */
export function rehearsalSteps(c: string, r05Run: string | null): RehearsalStep[] {
  const wb = `/evaluations/${c}`;
  return [
    {
      segment: "0~15초",
      name: "01-submission-form",
      path: "/submissions/new",
      expectTexts: ["저장소"],
    },
    {
      segment: "0~15초",
      name: "02-demo",
      path: "/demo",
      expectTexts: [
        "준비된 샘플입니다. 결과와 숫자는 실제 실행에서 생성했습니다",
        "채점기 사전 검증 완료",
        "저장된 실행 · ",
      ],
    },
    {
      segment: "15~40초",
      name: "03-workbench-c",
      path: wb,
      // 점수와 검토 대기 배지는 헤더에서 따로 보인다 (재디자인 이후)
      expectTexts: ["54~69/100", "15점 검토 대기", "채점기 사전 검증 완료", "저장된 실행 · "],
    },
    {
      segment: "15~40초",
      name: "04-r05-failure",
      path: `${wb}?criterion=R-05`,
      expectTexts: ["R-05"],
    },
    {
      segment: "40~60초",
      name: "05-r05-replay",
      path: r05Run ? `${wb}?criterion=R-05&run=${r05Run}` : `${wb}?criterion=R-05`,
      expectTexts: ["p1After.stock"],
    },
    {
      segment: "40~60초",
      name: "06-code-evidence",
      path: r05Run
        ? `${wb}?criterion=R-05&run=${r05Run}&pane=code`
        : `${wb}?criterion=R-05&pane=code`,
      expectTexts: ["관측"],
    },
    {
      segment: "60~75초",
      name: "07-mutation-m01",
      path: `${wb}?criterion=G1&mutation=M-01`,
      expectTexts: ["M-01", "SURVIVED"],
    },
    {
      segment: "75~90초",
      name: "08-hiring-report",
      path: `${wb}/report`,
      expectTexts: ["한눈 요약", "54~69/100"],
    },
    {
      segment: "75~90초",
      name: "09-interview-kit",
      path: `${wb}/interview-kit`,
      expectTexts: ["인터뷰 키트", "필수"],
    },
    {
      segment: "75~90초",
      name: "10-resume-links",
      path: `${wb}?tab=resume`,
      expectTexts: ["확인 필요"],
    },
  ];
}

export function renderRehearsal(
  baseUrl: string,
  startedAt: string,
  evaluationId: string,
  results: readonly StepResult[],
): string {
  const lines = [
    "# 90초 데모 리허설 기록 (T-507)",
    "",
    "`pnpm demo:rehearsal`이 `docs/demo.md` 구간별 화면 표를 순서대로 열어 남긴 스크린샷과 문구 확인 결과다. 저장된 실행만 열고 아무것도 바꾸지 않는다. 화면이 PRD 7장 표와 같은지와 90초 진행은 사람이 확인한다(아래 체크리스트).",
    "",
    `- 대상: ${baseUrl}`,
    `- 실행: ${startedAt}`,
    `- 샘플 C 저장된 평가: \`${evaluationId}\``,
    `- 자동 문구 확인: ${results.every((r) => r.missing.length === 0 && r.status === 200) ? "모두 통과" : "누락 있음"}`,
    "",
    "| 구간 | 화면 | 경로 | HTTP | 로드 | 기대 문구 | 스크린샷 |",
    "|---|---|---|---:|---:|---|---|",
    ...results.map(
      (r) =>
        `| ${r.segment} | ${r.name} | \`${r.path}\` | ${r.status ?? "-"} | ${(r.loadMs / 1000).toFixed(1)}s | ${
          r.missing.length === 0 ? "✓" : `✗ 없음: ${r.missing.join(", ")}`
        } | [${r.file}](./${r.file}) |`,
    ),
    "",
    "## 사람 확인",
    "",
    "- [ ] 리허설 진행자·일시:",
    "- [ ] 구간별 화면이 `docs/demo.md` 기대 화면(PRD 7장 표)과 같다",
    "- [ ] 다섯 구간을 90초 안에 설명했다 (실제 소요:  초)",
    "- [ ] 화면에 홍보 수치나 실시간 성공 표현이 없다",
    "",
  ];
  return lines.join("\n");
}

async function capture(
  page: Page,
  baseUrl: string,
  step: RehearsalStep,
  outDir: string,
): Promise<StepResult> {
  const started = Date.now();
  const response = await page.goto(new URL(step.path, baseUrl).toString(), {
    waitUntil: "networkidle",
  });
  const loadMs = Date.now() - started;
  const body = await page.locator("body").innerText();
  const missing = step.expectTexts.filter((text) => !body.includes(text));
  const file = `${step.name}.png`;
  await page.screenshot({ path: path.join(outDir, file), fullPage: true });
  return { ...step, file, status: response?.status() ?? null, missing, loadMs };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "base-url": { type: "string" },
      password: { type: "string" },
      out: { type: "string", default: DEFAULT_REHEARSAL_OUT },
    },
    strict: true,
  });
  const baseUrl = values["base-url"];
  if (!baseUrl) {
    console.error("사용법: demo:rehearsal --base-url <url> [--password <pw>] [--out docs/demo]");
    process.exit(1);
  }
  const password = values.password ?? process.env.APP_ACCESS_PASSWORD;
  const outDir = path.resolve(values.out);
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    if (password) {
      const login = await context.request.post(new URL("/api/login", baseUrl).toString(), {
        data: { password, next: "/" },
        headers: { accept: "application/json" },
      });
      if (login.status() !== 200) throw new Error(`로그인 실패: HTTP ${login.status()}`);
    }
    const page = await context.newPage();
    await page.goto(new URL("/demo", baseUrl).toString());
    const href = await page.getByTestId("demo-saved-link-C").getAttribute("href");
    const evaluationId = href?.split("/").pop();
    if (!evaluationId)
      throw new Error("샘플 C의 저장된 실행이 없습니다. demo:seed를 먼저 실행하세요");

    const res = await context.request.get(
      new URL(`/api/evaluations/${evaluationId}`, baseUrl).toString(),
      { headers: { accept: "application/json" } },
    );
    const parsed = EvaluationReportResponseSchema.parse(await res.json());
    if (!parsed.ok) throw new Error(`리포트 조회 실패: ${parsed.code}`);
    const report = parsed.data;
    const r05 = report.criterionResults.find((r) => r.criterionId === "R-05");
    const r05Run =
      report.evidences.find((e) => r05?.evidenceIds.includes(e.id) && e.runId)?.runId ?? null;

    const startedAt = new Date().toISOString();
    const results: StepResult[] = [];
    for (const step of rehearsalSteps(evaluationId, r05Run)) {
      const result = await capture(page, baseUrl, step, outDir);
      results.push(result);
      console.log(
        `  ${result.segment} ${result.name}: HTTP ${result.status} ${(result.loadMs / 1000).toFixed(1)}s ${result.missing.length === 0 ? "OK" : `없음 ${result.missing.join(", ")}`}`,
      );
    }
    const mdPath = path.join(outDir, "rehearsal.md");
    const markdown = await prettierFormat(
      renderRehearsal(baseUrl, startedAt, evaluationId, results),
      { ...((await prettierResolveConfig(mdPath)) ?? {}), parser: "markdown" },
    );
    await writeFile(mdPath, markdown, "utf8");
    const ok = results.every((r) => r.missing.length === 0 && r.status === 200);
    console.log(
      `demo:rehearsal ${ok ? "OK" : "누락 있음"} — ${path.relative(process.cwd(), mdPath)}`,
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`demo:rehearsal 오류: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
  });
}
