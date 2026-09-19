/**
 * AI 기준 초안 1회 실행 CLI (T-406 사람 확인 준비). 워커와 같은 프롬프트·스키마·변환으로 명세 하나의 초안을 만들고,
 * `validateRubric()` 결과와 사용량을 JSON으로 남긴다. DB·큐를 거치지 않으므로 `ai_reviews`에는 기록하지 않는다.
 *
 *   pnpm --filter @ohmyti/worker exec tsx src/rubric-draft/cli.ts <spec.md> [--out <result.json>]
 *
 * LLM 설정은 워커와 같다(`LLM_PROVIDER`, `DEEP_SEEK_API_KEY`, `LLM_MODEL` …, 저장소 루트 `.env.local`·`.env`).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NewAiReview } from "@ohmyti/db";
import { RecordingLlmClient } from "@ohmyti/llm";
import { loadEnv } from "../env";
import { createWorkerLlmClient } from "../llm";
import { DEFAULT_MUTATION_CATALOG_HINTS } from "./handler";
import { generateRubricDraft, RUBRIC_DRAFT_PROMPT } from "./generate";

async function main(argv: string[]): Promise<number> {
  const [specPath, flag, outPath] = argv;
  if (!specPath || (flag !== undefined && (flag !== "--out" || !outPath))) {
    console.error("사용법: tsx src/rubric-draft/cli.ts <spec.md> [--out <result.json>]");
    return 1;
  }
  loadEnv();
  const spec = await readFile(path.resolve(process.cwd(), specPath), "utf8");
  const base = createWorkerLlmClient(process.env);
  // DB 대신 메모리 기록처로 호출 기록(모델·사용량·비용)을 받아 결과 파일에 남긴다
  let recorded: NewAiReview | null = null;
  const llm = new RecordingLlmClient(base, (row) => {
    recorded = row;
    return Promise.resolve();
  });
  const startedAt = new Date();
  const result = await generateRubricDraft({
    llm,
    spec,
    catalog: DEFAULT_MUTATION_CATALOG_HINTS,
  });
  const finishedAt = new Date();
  const called = recorded as NewAiReview | null;
  const record = {
    kind: "rubric_draft_run",
    specPath,
    provider: base.provider,
    requestedModel: base.model,
    promptVersion: RUBRIC_DRAFT_PROMPT.promptVersion,
    startedAt: startedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    call: called
      ? {
          model: called.model,
          inputDigest: called.inputDigest,
          usage: called.usage,
          costUsd: called.costUsd,
        }
      : null,
    result,
  };
  const json = `${JSON.stringify(record, null, 2)}\n`;
  if (outPath) await writeFile(path.resolve(process.cwd(), outPath), json);
  else process.stdout.write(json);
  if (result.status === "OK") {
    const total = result.rubric.criteria.reduce((sum, c) => sum + c.maxPoints, 0);
    console.error(
      `초안 기준 ${result.rubric.criteria.length}개 · 배점 합계 ${total} · validateRubric 오류 ${result.validationErrors.length}건`,
    );
    return 0;
  }
  console.error(`초안 실패: ${result.code} ${result.message}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
