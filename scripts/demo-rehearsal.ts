/**
 * 데모 리허설 (T-507 → T-907에서 9단계 플로우로 갱신).
 *
 * `docs/demo.md`의 대본을 순서대로 따라가며 화면마다 데스크톱(1600px)·모바일(390px) 스크린샷을 `docs/demo/`에 남기고,
 * 기대 문구가 보이는지 기록한다(`docs/demo/rehearsal.md`). 아무것도 제출하거나 바꾸지 않고 저장된 실행만 연다.
 *
 * 이 스크립트는 사람이 하는 리허설의 준비 작업이다. 화면이 PRD 7장 표와 같은지, 90초 안에 설명할 수 있는지는 사람이
 * 스크린샷과 실제 화면으로 확인한다.
 *
 * 사용: `pnpm demo:rehearsal --base-url https://ohmyti.vercel.app [--out docs/demo]`
 * 환경변수: `APP_ACCESS_PASSWORD`(접근 비밀번호를 켠 환경) 또는 `--password`. 배포 기본값은 `APP_ACCESS_MODE=public`이라 생략한다.
 */
import { chromium, type Page } from "@playwright/test";
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
  /** 캡처 전에 누를 요소의 test id (T-906 `예시 명세로 채우기` 등) */
  clickTestId?: string;
}

export interface StepResult extends RehearsalStep {
  /** 데스크톱·모바일 스크린샷 파일 이름 */
  files: { desktop: string; mobile: string };
  status: number | null;
  missing: string[];
  loadMs: number;
}

/**
 * `docs/demo.md`의 9단계 플로우를 URL 단계로 옮긴다 (T-907).
 * `c`는 샘플 C의 저장된 평가 ID다. 홈 → 샘플 체험 → (샘플 C `확인할 것` 링크) 워크벤치 → 변이 실험 →
 * 채점 요청 프리필 → 페르소나 프리필 → 과제 만들기 순이다.
 */
export function rehearsalSteps(c: string): RehearsalStep[] {
  const wb = `/evaluations/${c}`;
  return [
    {
      segment: "도입",
      name: "01-home",
      path: "/",
      expectTexts: ["샘플 체험"],
    },
    {
      segment: "샘플 이해",
      name: "02-demo",
      path: "/demo",
      expectTexts: [
        "준비된 샘플입니다. 결과와 숫자는 실제 실행에서 생성했습니다",
        "채점기 사전 검증 완료",
        "추천 체험 순서",
        "어떤 구현인가",
        "이 샘플로 확인할 것",
        "지원자 맥락 예시",
        "저장된 실행 · ",
      ],
    },
    {
      segment: "워크벤치",
      name: "03-workbench-r05",
      path: `${wb}?criterion=R-05`,
      expectTexts: ["R-05", "54~69/100", "15점 검토 대기", "저장된 실행 · "],
    },
    {
      segment: "워크벤치",
      name: "04-mutation-m01",
      path: `${wb}?criterion=G1&mutation=M-01`,
      expectTexts: ["M-01", "SURVIVED"],
    },
    {
      segment: "채점 요청",
      name: "05-submission-sample-c",
      path: "/submissions/new?sample=C",
      expectTexts: [
        "예시로 채우기",
        "ohmyti-sample-c",
        "고정 커밋으로 채점",
        "이대로 제출합니다",
        "채점 입력에는 들어가지 않으며",
      ],
    },
    {
      segment: "채점 요청",
      name: "06-submission-persona",
      path: "/submissions/new?persona=dohyun",
      expectTexts: ["dohyun-order-api", "예시 이력서 사용", "wanted-hack-inchyangv"],
    },
    {
      segment: "과제 만들기",
      name: "07-assignment-example",
      path: "/assignments/new",
      clickTestId: "fill-example-spec",
      expectTexts: ["주문·재고 API", "Idempotency-Key", "AI 초안 생성"],
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
    "# 데모 리허설 기록 (T-907, 9단계 플로우)",
    "",
    "`pnpm demo:rehearsal`이 `docs/demo.md`의 대본을 순서대로 열어 남긴 데스크톱(1600px)·모바일(390px) 스크린샷과 문구 확인 결과다. 저장된 실행만 열고 아무것도 바꾸지 않는다. 화면이 PRD 7장 표와 같은지와 대본 진행은 사람이 확인한다(아래 체크리스트).",
    "",
    `- 대상: ${baseUrl}`,
    `- 실행: ${startedAt}`,
    `- 샘플 C 저장된 평가: \`${evaluationId}\``,
    `- 자동 문구 확인: ${results.every((r) => r.missing.length === 0 && r.status === 200) ? "모두 통과" : "누락 있음"}`,
    "",
    "| 구간 | 화면 | 경로 | HTTP | 로드 | 기대 문구 | 데스크톱 | 모바일 |",
    "|---|---|---|---:|---:|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.segment} | ${r.name} | \`${r.path}\` | ${r.status ?? "-"} | ${(r.loadMs / 1000).toFixed(1)}s | ${
          r.missing.length === 0 ? "✓" : `✗ 없음: ${r.missing.join(", ")}`
        } | [${r.files.desktop}](./${r.files.desktop}) | [${r.files.mobile}](./${r.files.mobile}) |`,
    ),
    "",
    "## 사람 확인",
    "",
    "- [ ] 리허설 진행자·일시:",
    "- [ ] 화면이 `docs/demo.md`의 기대 화면(PRD 7장 표)과 같다",
    "- [ ] 90초 대본을 90초 안에, 3분 확장 대본을 3분 안에 설명했다 (실제 소요:  초 /  초)",
    "- [ ] 모바일(390px)에서 가로 스크롤이나 잘린 카드가 없다",
    "- [ ] 화면에 홍보 수치·실시간 성공 표현·가짜 진행률이 없다",
    "",
  ];
  return lines.join("\n");
}

const DESKTOP = { width: 1600, height: 1000 } as const;
const MOBILE = { width: 390, height: 844 } as const;

async function capture(
  page: Page,
  baseUrl: string,
  step: RehearsalStep,
  outDir: string,
): Promise<StepResult> {
  const started = Date.now();
  await page.setViewportSize(DESKTOP);
  const response = await page.goto(new URL(step.path, baseUrl).toString(), {
    waitUntil: "networkidle",
  });
  const loadMs = Date.now() - started;
  if (step.clickTestId) {
    await page.getByTestId(step.clickTestId).click();
    await page.waitForTimeout(300);
  }
  // 입력란에 채운 값은 innerText에 없으므로 함께 모은다 (T-906 `예시 명세로 채우기`)
  const fields = await page.locator("input, textarea").all();
  const values = await Promise.all(fields.map((field) => field.inputValue()));
  const body = [await page.locator("body").innerText(), ...values].join("\n");
  const missing = step.expectTexts.filter((text) => !body.includes(text));
  const files = { desktop: `${step.name}-desktop.png`, mobile: `${step.name}-mobile.png` };
  await page.screenshot({ path: path.join(outDir, files.desktop), fullPage: true });
  await page.setViewportSize(MOBILE);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, files.mobile), fullPage: true });
  return { ...step, files, status: response?.status() ?? null, missing, loadMs };
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
    const context = await browser.newContext({ viewport: DESKTOP });
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

    // 샘플 C 카드의 `확인할 것` 링크가 실제로 워크벤치의 R-05로 가는지 먼저 확인한다 (T-901)
    const checkHref = await page.getByTestId("demo-check-C-R-05").getAttribute("href");
    if (checkHref !== `/evaluations/${evaluationId}?criterion=R-05`) {
      throw new Error(`샘플 C의 확인할 것 링크가 기대와 다릅니다: ${checkHref ?? "없음"}`);
    }

    const startedAt = new Date().toISOString();
    const results: StepResult[] = [];
    for (const step of rehearsalSteps(evaluationId)) {
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
