/**
 * `pnpm demo:seed` (T-505): 샘플 체험(`/demo`)의 저장된 실행을 실제 파이프라인으로 만든다. 하드코딩한 결과는 없다.
 *
 * 1. `db:seed:sample`과 같은 함수로 샘플 과제를 현재 하네스 버전으로 승인해 둔다(이미 있으면 그대로).
 * 2. 예시 이력서(`samples/order-api/demo/resume.txt`, 가상 인물)를 PDF로 만들어 `demo/resume.pdf`에 두고,
 *    페르소나 4종의 `samples/personas/<핸들>/resume.pdf`를 `demo/resumes/<핸들>.pdf`에 올린다(T-902 `예시 이력서 사용`).
 * 3. 샘플 A/B/C/D마다 `is_sample` + `demo_sample_id` 제출을 만든다. 저장된 샘플 스냅샷(`demo/samples/<id>/`)이 있으면
 *    제출 키로 복사하고 SHA를 고정해 둔다(워커의 REPO_CHECK가 GitHub를 부르지 않고 재사용한다). 없으면 공개 샘플 저장소
 *    (`samples/order-api/sample-repos.json`)의 고정 커밋을 워커가 GitHub에서 수집하고, 끝난 뒤 그 스냅샷을 저장된 샘플
 *    스냅샷으로 복사해 둔다.
 * 4. `EVALUATE_SUBMISSION` job을 넣고 워커가 전체 파이프라인(저장소 확인 → … → 맥락 연결)을 끝낼 때까지 기다린다.
 *    기본은 로컬 스택 워커(`E2E_WORKER_PORT`)가 떠 있으면 재사용하고, 없으면 같은 설정으로 직접 띄웠다가 끝나면 내린다.
 * 5. 각 샘플 평가에 실행 기록·mutation 실험·ai_reviews 행이 실제로 있는지 확인한다. 하나라도 없으면 종료 코드 1이다.
 *
 * 스토어: 기본은 로컬 스택과 같은 fs 스토어(`stackArtifactRoot()`, Playwright 웹 서버와 같은 경로)다. 배포 환경을 채울 때는
 * `--env-store --external-worker`로 환경변수의 스토어(`ARTIFACT_STORE`)를 쓰고 이미 떠 있는 워커(Railway)를 기다린다.
 *
 * 사용: `pnpm demo:seed [--env-store] [--external-worker] [--samples A,B,C,D] [--timeout-ms 2400000]`
 * 필요: `DATABASE_URL`(마이그레이션 적용 후), LLM을 쓰려면 워커 환경의 `DEEP_SEEK_API_KEY` (`.env.local`·`.env` 자동 로드)
 */
import { buildTextPdf } from "@ohmyti/context/testing";
import {
  aiReviews,
  createDb,
  createSubmission,
  DEMO_SAMPLE_IDS,
  enqueueSubmissionEvaluation,
  executionRecords,
  findLatestEvaluation,
  getSubmission,
  installWorkerWakeHook,
  isDemoSampleId,
  mutationExperiments,
  pinSubmissionSnapshot,
  requireDatabaseUrl,
  upsertSubmissionContext,
  type Database,
  type DemoSampleId,
} from "@ohmyti/db";
import {
  ARTIFACT_CONTENT_TYPES,
  artifactKeys,
  createArtifactStore,
  type ArtifactStore,
} from "@ohmyti/storage";
import { eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import "./load-env";
import { seedSampleAssignment, DEFAULT_GATE_JSON } from "./db-seed-sample";
import { SAMPLE_DIR } from "./samples-check";
import {
  isHttpUp,
  stackArtifactRoot,
  stackPorts,
  startWorker,
  workerHealthUrl,
  type ManagedProcess,
} from "./stack-local";

export const DEMO_RESUME_FILE = path.join(SAMPLE_DIR, "demo", "resume.txt");
/** 페르소나 예시 이력서 원본 (T-902) */
export const PERSONA_DIR = path.join(SAMPLE_DIR, "..", "personas");
export const PERSONA_RESUME_HANDLES = ["seojin", "taeyun", "gaeun", "dohyun"] as const;

/** `samples/personas/<핸들>/resume.pdf` → `demo/resumes/<핸들>.pdf`. 없는 파일은 건너뛰고 올린 핸들을 돌려준다 */
export async function uploadPersonaResumes(store: ArtifactStore): Promise<string[]> {
  const uploaded: string[] = [];
  for (const handle of PERSONA_RESUME_HANDLES) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(PERSONA_DIR, handle, "resume.pdf"));
    } catch {
      continue;
    }
    await store.put(artifactKeys.personaResume(handle), bytes, {
      contentType: ARTIFACT_CONTENT_TYPES.resume,
    });
    uploaded.push(handle);
  }
  return uploaded;
}
export const SAMPLE_REPOS_FILE = path.join(SAMPLE_DIR, "sample-repos.json");
export const DEMO_SEED_DEFAULTS = {
  timeoutMs: 40 * 60_000,
  pollMs: 3_000,
} as const;

const TERMINAL = new Set(["COMPLETED", "FAILED", "UNSUPPORTED", "DELETED"]);

export const SampleReposSchema = z.looseObject({
  samples: z.record(
    z.string(),
    z.strictObject({ url: z.url(), sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  ),
});

export interface DemoSampleSource {
  id: DemoSampleId;
  repoUrl: string;
  sha: string;
}

export async function readDemoSampleSources(
  file: string = SAMPLE_REPOS_FILE,
): Promise<DemoSampleSource[]> {
  const parsed = SampleReposSchema.parse(JSON.parse(await readFile(file, "utf8")));
  return DEMO_SAMPLE_IDS.map((id) => {
    const entry = parsed.samples[id];
    if (!entry) throw new Error(`${file}에 샘플 ${id}의 저장소가 없습니다`);
    return { id, repoUrl: entry.url, sha: entry.sha };
  });
}

/** PDF 한 줄 길이 (Helvetica 11pt, A4 폭 안). 긴 줄은 단어 단위로 나눈다 */
const PDF_LINE_CHARS = 90;
const PDF_LINES_PER_PAGE = 48;

export function wrapLine(line: string, width: number = PDF_LINE_CHARS): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (current && current.length + 1 + word.length > width) {
      out.push(current);
      current = `  ${word}`;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out;
}

/** 예시 이력서 텍스트 → 텍스트 층이 있는 PDF. 워커가 실제 추출 경로(T-501)로 읽는다 */
export function demoResumePdf(text: string): Uint8Array {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .trimEnd()
    .split("\n")
    .flatMap((line) => wrapLine(line));
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += PDF_LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + PDF_LINES_PER_PAGE));
  }
  return buildTextPdf(pages);
}

const StoredManifestSchema = z.looseObject({ submissionSha: z.string() });

/** 저장된 샘플 스냅샷이 있고 manifest의 SHA가 `sha`와 같으면 true */
export async function hasStoredDemoSnapshot(
  store: ArtifactStore,
  sampleId: DemoSampleId,
  sha: string,
): Promise<boolean> {
  const manifest = await store.get(artifactKeys.demoSampleManifest(sampleId));
  if (!manifest || !(await store.exists(artifactKeys.demoSampleSnapshot(sampleId)))) return false;
  const parsed = StoredManifestSchema.safeParse(
    JSON.parse(Buffer.from(manifest.body).toString("utf8")),
  );
  return parsed.success && parsed.data.submissionSha === sha;
}

async function copyObject(
  store: ArtifactStore,
  from: string,
  to: string,
  contentType: string,
): Promise<void> {
  const object = await store.get(from);
  if (!object) throw new Error(`스토어에 ${from}이(가) 없습니다`);
  await store.put(to, object.body, { contentType });
}

export interface SeededDemoSubmission {
  sampleId: DemoSampleId;
  submissionId: string;
  /** 저장된 샘플 스냅샷을 복사했다 (false면 워커가 GitHub에서 수집한다) */
  fromStoredSnapshot: boolean;
}

/** 샘플 하나의 제출을 만들고 job을 넣는다 */
export async function createDemoSeedSubmission(
  deps: { db: Database; store: ArtifactStore },
  input: { assignmentVersionId: string; source: DemoSampleSource; resumeRef: string },
): Promise<SeededDemoSubmission> {
  const { db, store } = deps;
  const { source } = input;
  const stored = await hasStoredDemoSnapshot(store, source.id, source.sha);
  const submission = await createSubmission(db, {
    assignmentVersionId: input.assignmentVersionId,
    repoUrl: source.repoUrl,
    repoRef: source.sha,
    demoSampleId: source.id,
  });
  if (stored) {
    const snapshotRef = artifactKeys.snapshot(submission.id);
    await copyObject(
      store,
      artifactKeys.demoSampleSnapshot(source.id),
      snapshotRef,
      ARTIFACT_CONTENT_TYPES.snapshot,
    );
    await copyObject(
      store,
      artifactKeys.demoSampleManifest(source.id),
      artifactKeys.snapshotManifest(submission.id),
      ARTIFACT_CONTENT_TYPES.snapshotManifest,
    );
    await pinSubmissionSnapshot(db, submission.id, { submissionSha: source.sha, snapshotRef });
  }
  const resumeRef = artifactKeys.resume(submission.id);
  await copyObject(store, input.resumeRef, resumeRef, ARTIFACT_CONTENT_TYPES.resume);
  await upsertSubmissionContext(db, submission.id, { resumeRef, githubLogin: null });
  await enqueueSubmissionEvaluation(db, submission.id);
  return { sampleId: source.id, submissionId: submission.id, fromStoredSnapshot: stored };
}

/** 워커가 GitHub에서 수집한 제출 스냅샷을 저장된 샘플 스냅샷으로 복사한다 */
export async function saveDemoSnapshot(
  store: ArtifactStore,
  sampleId: DemoSampleId,
  submissionId: string,
): Promise<void> {
  await copyObject(
    store,
    artifactKeys.snapshot(submissionId),
    artifactKeys.demoSampleSnapshot(sampleId),
    ARTIFACT_CONTENT_TYPES.snapshot,
  );
  await copyObject(
    store,
    artifactKeys.snapshotManifest(submissionId),
    artifactKeys.demoSampleManifest(sampleId),
    ARTIFACT_CONTENT_TYPES.snapshotManifest,
  );
}

export interface DemoEvaluationCheck {
  sampleId: DemoSampleId;
  submissionId: string;
  submissionStatus: string;
  evaluationId: string | null;
  score: string | null;
  executionRecords: number;
  mutationExperiments: number;
  aiReviews: Record<string, number>;
  problems: string[];
}

/** 인수 기준: 평가에 실행 기록·mutation 실험·ai_reviews 행이 실제로 있다 */
export async function inspectDemoEvaluation(
  db: Database,
  seeded: SeededDemoSubmission,
): Promise<DemoEvaluationCheck> {
  const submission = await getSubmission(db, seeded.submissionId);
  const evaluation = await findLatestEvaluation(db, seeded.submissionId);
  const problems: string[] = [];
  if (submission?.status !== "COMPLETED") {
    problems.push(`제출 상태가 ${submission?.status ?? "없음"}입니다`);
  }
  if (!evaluation) {
    problems.push("평가가 없습니다");
    return {
      sampleId: seeded.sampleId,
      submissionId: seeded.submissionId,
      submissionStatus: submission?.status ?? "MISSING",
      evaluationId: null,
      score: null,
      executionRecords: 0,
      mutationExperiments: 0,
      aiReviews: {},
      problems,
    };
  }
  const count = sql<number>`count(*)::int`;
  const [[records], [mutations], reviews] = await Promise.all([
    db
      .select({ n: count })
      .from(executionRecords)
      .where(eq(executionRecords.evaluationId, evaluation.id)),
    db
      .select({ n: count })
      .from(mutationExperiments)
      .where(eq(mutationExperiments.evaluationId, evaluation.id)),
    db
      .select({ kind: aiReviews.kind, n: count })
      .from(aiReviews)
      .where(eq(aiReviews.evaluationId, evaluation.id))
      .groupBy(aiReviews.kind),
  ]);
  const aiByKind = Object.fromEntries(reviews.map((r) => [r.kind, r.n]));
  if (!records?.n) problems.push("실행 기록이 없습니다");
  if (!mutations?.n) problems.push("mutation 실험이 없습니다");
  if (reviews.length === 0) problems.push("ai_reviews 행이 없습니다");
  if (!evaluation.finishedAt) problems.push("평가가 끝나지 않았습니다");
  const score =
    evaluation.scoreMin === null
      ? null
      : evaluation.pendingPoints
        ? `${evaluation.scoreMin}~${evaluation.scoreMax} (검토 대기 ${evaluation.pendingPoints})`
        : String(evaluation.scoreEarned);
  return {
    sampleId: seeded.sampleId,
    submissionId: seeded.submissionId,
    submissionStatus: submission?.status ?? "MISSING",
    evaluationId: evaluation.id,
    score,
    executionRecords: records?.n ?? 0,
    mutationExperiments: mutations?.n ?? 0,
    aiReviews: aiByKind,
    problems,
  };
}

async function waitForSubmissions(
  db: Database,
  seeded: readonly SeededDemoSubmission[],
  options: { timeoutMs: number; pollMs: number; worker: ManagedProcess | null },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const last = new Map<string, string>();
  for (;;) {
    let done = 0;
    for (const item of seeded) {
      const submission = await getSubmission(db, item.submissionId);
      const evaluation = await findLatestEvaluation(db, item.submissionId);
      const running = evaluation?.stageLog.find((r) => r.state === "RUNNING")?.stage;
      const line = `${submission?.status ?? "MISSING"}${running ? ` · ${running}` : ""}`;
      if (last.get(item.submissionId) !== line) {
        console.log(`  [${item.sampleId}] ${line}`);
        last.set(item.submissionId, line);
      }
      if (!submission || TERMINAL.has(submission.status)) done += 1;
    }
    if (done === seeded.length) return;
    if (options.worker?.exited()) {
      throw new Error(`워커가 종료 코드 ${options.worker.exitCode()}로 먼저 끝났습니다`);
    }
    if (Date.now() > deadline) {
      throw new Error(`${options.timeoutMs}ms 안에 샘플 평가가 끝나지 않았습니다`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

function parseSamples(value: string | undefined): DemoSampleId[] {
  if (!value) return [...DEMO_SAMPLE_IDS];
  const ids = value.split(",").map((v) => v.trim().toUpperCase());
  for (const id of ids) {
    if (!isDemoSampleId(id)) throw new Error(`알 수 없는 샘플 ID: ${id} (A·B·C·D)`);
  }
  return ids as DemoSampleId[];
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "env-store": { type: "boolean", default: false },
      "external-worker": { type: "boolean", default: false },
      samples: { type: "string" },
      "timeout-ms": { type: "string" },
    },
    strict: true,
  });
  const timeoutMs = values["timeout-ms"]
    ? Number(values["timeout-ms"])
    : DEMO_SEED_DEFAULTS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("--timeout-ms는 1 이상의 정수여야 합니다");
  }
  const sampleIds = parseSamples(values.samples);
  const envStore = values["env-store"];
  if (envStore && !values["external-worker"]) {
    throw new Error(
      "--env-store는 배포 환경용이라 --external-worker와 함께 씁니다 (로컬 워커는 스택 fs 스토어를 씁니다)",
    );
  }
  const storeEnv = envStore
    ? process.env
    : { ...process.env, ARTIFACT_STORE: "fs", ARTIFACT_FS_ROOT: stackArtifactRoot() };
  const store = createArtifactStore(storeEnv);
  const handle = createDb({ url: requireDatabaseUrl(), max: 2 });
  // 배포된 워커는 큐가 비면 폴링을 멈춘다. WORKER_WAKE_URL이 있으면 적재할 때마다 깨운다.
  if (values["external-worker"]) installWorkerWakeHook();
  let worker: ManagedProcess | null = null;
  try {
    const db = handle.db;
    const seed = await seedSampleAssignment({
      db,
      store,
      gateJsonPath: DEFAULT_GATE_JSON,
      log: () => undefined,
    });
    console.log(
      `demo:seed — 과제 v${seed.versionNumber} ${seed.rubricVersion} ${seed.status} (하네스 ${seed.harnessVersion}), 스토어 ${store.kind}`,
    );

    const resumeRef = artifactKeys.demoResume();
    await store.put(resumeRef, demoResumePdf(await readFile(DEMO_RESUME_FILE, "utf8")), {
      contentType: ARTIFACT_CONTENT_TYPES.resume,
    });
    const personas = await uploadPersonaResumes(store);
    console.log(`  예시 이력서: demo/resume.pdf + 페르소나 ${personas.length}개 (${personas.join(", ") || "없음"})`);

    if (!values["external-worker"]) {
      const ports = stackPorts();
      if (await isHttpUp(workerHealthUrl(ports))) {
        console.log(`  스택 워커(${workerHealthUrl(ports)})를 재사용합니다`);
      } else {
        console.log("  워커를 띄웁니다 (SANDBOX_RUNNER=local, 스택 fs 스토어)");
        worker = await startWorker({
          env: { ...process.env, LOG_LEVEL: process.env.DEMO_SEED_WORKER_LOG_LEVEL ?? "warn" },
        });
      }
    } else {
      console.log("  외부 워커가 job을 처리하기를 기다립니다");
    }

    const sources = (await readDemoSampleSources()).filter((s) => sampleIds.includes(s.id));
    const seeded: SeededDemoSubmission[] = [];
    for (const source of sources) {
      const item = await createDemoSeedSubmission(
        { db, store },
        { assignmentVersionId: seed.assignmentVersionId, source, resumeRef },
      );
      seeded.push(item);
      console.log(
        `  [${item.sampleId}] 제출 ${item.submissionId} (${item.fromStoredSnapshot ? "저장된 샘플 스냅샷" : `GitHub ${source.repoUrl}@${source.sha.slice(0, 12)} 수집`})`,
      );
    }

    await waitForSubmissions(db, seeded, {
      timeoutMs,
      pollMs: DEMO_SEED_DEFAULTS.pollMs,
      worker,
    });

    for (const item of seeded) {
      if (item.fromStoredSnapshot) continue;
      const submission = await getSubmission(db, item.submissionId);
      if (submission?.submissionSha) {
        await saveDemoSnapshot(store, item.sampleId, item.submissionId);
        console.log(`  [${item.sampleId}] 수집한 스냅샷을 저장된 샘플 스냅샷으로 복사했습니다`);
      }
    }

    const checks = await Promise.all(seeded.map((item) => inspectDemoEvaluation(db, item)));
    console.log("");
    console.log("샘플 | 제출 상태 | 평가 | 점수 | 실행 기록 | mutation 실험 | ai_reviews");
    for (const c of checks) {
      const ai = Object.entries(c.aiReviews)
        .map(([kind, n]) => `${kind} ${n}`)
        .join(", ");
      console.log(
        `${c.sampleId} | ${c.submissionStatus} | ${c.evaluationId ?? "-"} | ${c.score ?? "-"} | ${c.executionRecords} | ${c.mutationExperiments} | ${ai || "-"}`,
      );
    }
    const failed = checks.filter((c) => c.problems.length > 0);
    for (const c of failed) console.error(`샘플 ${c.sampleId}: ${c.problems.join("; ")}`);
    if (failed.length > 0) return 1;
    console.log(`demo:seed OK — 샘플 ${checks.length}개의 저장된 실행을 만들었습니다 (/demo)`);
    return 0;
  } finally {
    await worker?.stop();
    await handle.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`demo:seed 오류: ${(error as Error).stack ?? String(error)}`);
      process.exit(1);
    });
}
