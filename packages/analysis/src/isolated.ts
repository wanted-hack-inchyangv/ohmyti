/**
 * 관련 함수 그래프 분석(TICKET.md T-304)과 설계 신호 추출(T-605)을 자식 프로세스에서 실행한다. 진입점은 `child.ts`.
 *
 * - 개발·테스트(이 파일이 `.ts`로 실행될 때)는 `child.ts`를 `--import tsx`로 띄운다 (tsx는 이 패키지의 devDependency).
 * - 워커 번들(`dist/index.js`)에서는 옆의 `analysis-child.js`(esbuild가 따로 묶은 파일)를 띄운다.
 * - 제한 시간·종료 코드·IPC 오류는 모두 `status: "unavailable"` 결과로 바꾼다. 던지지 않는다.
 */
import {
  DESIGN_SIGNALS_ANALYZER_VERSION,
  FUNCTION_GRAPH_ANALYZER_VERSION,
  type DesignSignals,
} from "@ohmyti/core";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildRequest, ChildResponse, IsolatedAnalysisInput } from "./child";
import type { AnalyzeFunctionGraphInput, AnalyzeFunctionGraphResult } from "./function-graph";
import { isSourcePath } from "./project";

/** 번들에서의 자식 파일 이름 (`apps/worker/scripts/build.mjs`의 entry 이름과 같아야 한다) */
export const CHILD_BUNDLE_NAME = "analysis-child.js";
export const CHILD_SOURCE_NAME = "child.ts";

export const ISOLATED_DEFAULTS = {
  /** 자식 프로세스 벽시계 상한 */
  timeoutMs: 120_000,
  /** 자식 힙 상한 (MiB). 큰 프로젝트가 워커 컨테이너 전체를 OOM으로 몰지 않게 한다 */
  maxOldSpaceMb: 1024,
} as const;

export interface IsolatedOptions {
  timeoutMs?: number | undefined;
  maxOldSpaceMb?: number | undefined;
}

function unavailable(reason: string): AnalyzeFunctionGraphResult {
  return {
    analysis: { status: "unavailable", analyzerVersion: FUNCTION_GRAPH_ANALYZER_VERSION, reason },
    handlerSnippets: new Map(),
  };
}

/** 이 모듈이 TS 소스로 실행 중인지 (tsx·vitest) */
function runningFromSource(): boolean {
  return import.meta.url.endsWith(".ts");
}

/** 자식 진입 파일과 실행 인자 */
export function childEntry(): { modulePath: string; execArgv: string[]; cwd: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (runningFromSource()) {
    return {
      modulePath: path.join(here, CHILD_SOURCE_NAME),
      // `--import tsx`는 cwd 기준으로 풀린다. 이 패키지 디렉터리에는 tsx가 devDependency로 있다
      execArgv: ["--import", "tsx"],
      cwd: here,
    };
  }
  return { modulePath: path.join(here, CHILD_BUNDLE_NAME), execArgv: [], cwd: process.cwd() };
}

async function readAllFiles(
  files: AnalyzeFunctionGraphInput["files"],
  withTsconfig: boolean,
): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [];
  const wanted = (p: string) => isSourcePath(p) || (withTsconfig && p === "tsconfig.json");
  for (const relativePath of (await files.listFiles()).filter(wanted).sort()) {
    const text = await files.readText(relativePath);
    if (text !== null) entries.push([relativePath, text]);
  }
  return entries;
}

/**
 * 요청 하나를 자식 프로세스에 보내고 응답 하나를 받는다. 제한 시간·종료 코드·IPC 오류·예외 응답은 모두 `fallback(사유)`로 바꾼다.
 * 던지지 않는다.
 */
function runInChild<T>(
  request: ChildRequest,
  pick: (response: ChildResponse) => T | null,
  fallback: (reason: string) => T,
  options: IsolatedOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? ISOLATED_DEFAULTS.timeoutMs;
  const maxOldSpaceMb = options.maxOldSpaceMb ?? ISOLATED_DEFAULTS.maxOldSpaceMb;
  const entry = childEntry();
  let child: ChildProcess;
  try {
    child = fork(entry.modulePath, [], {
      cwd: entry.cwd,
      execArgv: [...entry.execArgv, `--max-old-space-size=${maxOldSpaceMb}`],
      env: { ...process.env, OHMYTI_ANALYSIS_CHILD: "1" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
  } catch (error) {
    return Promise.resolve(
      fallback(
        `분석 프로세스를 띄우지 못함: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4000) stderr += chunk.toString("utf8");
  });
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (result: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(fallback(`분석 시간 초과 (${timeoutMs}ms)`));
    }, timeoutMs);
    child.once("message", (message: ChildResponse) => {
      if (message.type === "error") {
        finish(fallback(`분석 중 오류: ${message.message}`));
        return;
      }
      finish(pick(message) ?? fallback("분석 프로세스가 결과 형식이 아닌 응답을 보냄"));
    });
    child.once("error", (error) => {
      finish(fallback(`분석 프로세스 오류: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      const tail = stderr.trim().split("\n").slice(-3).join(" · ");
      finish(
        fallback(
          `분석 프로세스가 결과 없이 종료됨 (code ${code ?? "null"}, signal ${signal ?? "null"})${tail ? `: ${tail}` : ""}`,
        ),
      );
    });
    child.send(request, (error) => {
      if (error) finish(fallback(`분석 입력 전달 실패: ${error.message}`));
    });
  });
}

export interface IsolatedAnalysisOutput extends AnalyzeFunctionGraphResult {
  /** 입력의 `designSignals`가 true일 때만 있다. 자식 프로세스 실패는 같은 사유의 `unavailable`이다 */
  designSignals?: DesignSignals | undefined;
}

/**
 * 관련 함수 그래프를 자식 프로세스에서 분석한다. `designSignals: true`면 같은 자식 프로세스에서 설계 신호(T-605)도 추출한다
 * (프로세스 기동 비용을 한 번만 낸다).
 */
export async function analyzeFunctionGraphIsolated(
  input: AnalyzeFunctionGraphInput & { designSignals?: boolean | undefined },
  options: IsolatedOptions = {},
): Promise<IsolatedAnalysisOutput> {
  const withSignals = input.designSignals === true;
  const payload: IsolatedAnalysisInput = {
    files: await readAllFiles(input.files, withSignals),
    cases: input.cases,
    nodeModulesDir: input.nodeModulesDir,
    limits: input.limits,
    maxSubgraphNodes: input.maxSubgraphNodes,
    designSignals: withSignals,
  };
  const fallback = (reason: string): IsolatedAnalysisOutput => ({
    ...unavailable(reason),
    ...(withSignals
      ? {
          designSignals: {
            status: "unavailable",
            analyzerVersion: DESIGN_SIGNALS_ANALYZER_VERSION,
            reason,
          },
        }
      : {}),
  });
  return runInChild(
    { type: "analyze", input: payload },
    (response) =>
      response.type === "result"
        ? {
            analysis: response.result.analysis,
            handlerSnippets: new Map(response.result.handlerSnippets),
            ...(withSignals ? { designSignals: response.result.designSignals } : {}),
          }
        : null,
    fallback,
    options,
  );
}
