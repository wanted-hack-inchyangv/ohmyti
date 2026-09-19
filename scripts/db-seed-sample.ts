/**
 * `pnpm db:seed:sample` (T-201): 샘플 과제 "주문·재고 API" v1을 DB에 등록하고 승인한다.
 *
 * - 과제 → 버전 v1(DRAFT) → VALIDATING → APPROVED(`approved_by = 'seed'`). `validation_result`에는
 *   `pnpm gate:phase1`이 만든 `docs/gates/phase1.json`(샘플별 기대·실제 대조, 결정성 결과)을 넣는다.
 *   게이트 결과가 통과가 아니면 승인하지 않는다 (G-09: 검증한 척 승인하지 않는다).
 * - 명세 원문(SPEC.md)은 Artifact Store `assignments/<id>/specs/<sha256>.md`에, 샘플 A/B/C/D 스냅샷은
 *   `assignments/<id>/versions/1/samples/<id>/snapshot.tar.gz`에 넣고 `validation_samples`에 등록한다.
 *   `human_reviewed_by`·`human_reviewed_at`은 `expected-matrix.json`의 `reviewedBy`·`reviewedAt`이다.
 * - 채용 리포트 프로필(T-705)은 `report-profile.json`을 그대로 `assignment_versions.report_profile`에 넣는다. rubric 본문·
 *   rubricVersion 해시와 무관한 표시용 자료라 승인된 버전에도 매 실행마다 덮어쓴다 (RETIRED 버전은 건드리지 않는다).
 * - 멱등: 과제는 이름으로, 버전은 rubric 내용 해시(`rubric_version`의 뒷부분)로 찾아 있으면 다시 만들지 않는다.
 *   샘플은 (버전, 이름) 단위로 upsert한다. 승인된 버전의 본문은 건드리지 않는다 (DB 트리거가 막는다).
 * - 하네스 버전이 바뀌면(T-308): 같은 내용의 APPROVED 버전을 RETIRED로 내리고 다음 번호의 버전을 만들어
 *   현재 하네스로 다시 승인한다. 워커는 승인 하네스와 자기 하네스가 다르면 제출을 거절하므로 워커 배포 전에 실행한다.
 *
 * 사용: `pnpm db:seed:sample [--gate docs/gates/phase1.json] [--approved-by seed]`
 * 환경변수: `DATABASE_URL`, `ARTIFACT_STORE`(fs|blob) 등 스토어 설정 (`.env.local` 자동 로드)
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  ExecutionContractSchema,
  ReportProfileSchema,
  RubricSchema,
  type AssignmentVersionStatus,
  type ReportProfile,
  type Rubric,
} from "@ohmyti/core";
import {
  approveAssignmentVersion,
  assignments,
  createAssignment,
  createAssignmentVersion,
  createDb,
  listAssignmentVersions,
  requireDatabaseUrl,
  retireAssignmentVersion,
  rubricContentDigest,
  setAssignmentVersionReportProfile,
  specDigestOf,
  startAssignmentVersionValidation,
  validationSamples,
  type Database,
} from "@ohmyti/db";
import { DEFAULT_CASE_SET, getCaseSet, harnessVersionOf } from "@ohmyti/harness";
import { packDirectoryToTarGz } from "@ohmyti/runner";
import {
  ARTIFACT_CONTENT_TYPES,
  artifactKeys,
  createArtifactStore,
  type ArtifactStore,
} from "@ohmyti/storage";
import { asc, eq } from "drizzle-orm";
import "./load-env";
import { ExpectedMatrixSchema, SAMPLE_DIR, type ExpectedSample } from "./samples-check";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SAMPLE_ASSIGNMENT_NAME = "주문·재고 API";
export const SAMPLE_ASSIGNMENT_DESCRIPTION =
  "TypeScript 주문·재고 API 과제 (samples/order-api). 멱등 주문 생성, 재고 차감·복구, 동시성, 실행 계약을 판정한다.";
/** 첫 버전 번호. 하네스가 바뀌면 이전 버전을 RETIRED로 내리고 다음 번호를 만든다 */
export const SAMPLE_VERSION_NUMBER = 1;
export const DEFAULT_GATE_JSON = path.join(repoRoot, "docs", "gates", "phase1.json");
export const DEFAULT_APPROVED_BY = "seed";

/** 샘플 ID → validation_samples.kind (PRD 2장 W3) */
export const SAMPLE_KIND_BY_ID = {
  A: "CORRECT",
  B: "ALTERNATIVE",
  C: "DEFECTIVE",
  D: "ADVERSARIAL",
} as const;

/** `docs/gates/phase1.json`에서 승인 판단에 필요한 최소 형태. 나머지 필드는 그대로 보존한다 */
export const GateJsonSchema = z
  .looseObject({
    gate: z.literal("phase1"),
    ok: z.boolean(),
    rubricVersion: z.string().min(1),
    harnessVersion: z.string().min(1).nullable(),
    environmentDigest: z.string().min(1).nullable(),
    comparisons: z.array(z.looseObject({ sampleId: z.string().min(1) })),
  })
  .readonly();
export type GateJson = z.infer<typeof GateJsonSchema>;

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

export interface SeedSampleOptions {
  db: Database;
  store: ArtifactStore;
  sampleDir?: string | undefined;
  gateJsonPath?: string | undefined;
  approvedBy?: string | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface SeedSampleResult {
  assignmentId: string;
  assignmentVersionId: string;
  rubricVersion: string;
  harnessVersion: string;
  status: AssignmentVersionStatus;
  specRef: string;
  versionNumber: number;
  /** 이번 실행에서 새로 만든 것 */
  created: { assignment: boolean; version: boolean; approved: boolean };
  /** 하네스가 바뀌어 RETIRED로 내린 이전 버전 */
  retiredVersionId: string | null;
  /** 저장한 채용 리포트 프로필의 기준 수 (T-705). RETIRED 버전이면 null */
  reportProfileCriteria: number | null;
  samples: { id: string; name: string; kind: string; snapshotRef: string; submissionSha: string }[];
}

/**
 * 디렉터리 내용의 sha1(40자 hex). 상대 경로 정렬 순으로 `경로\0크기\0본문`을 이어 붙인다.
 * 샘플은 git 커밋이 아니므로 `submission_sha` 자리에는 이 내용 해시를 둔다. `node_modules`와 심볼릭 링크는 뺀다.
 */
export async function directoryContentSha(dir: string): Promise<string> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(dir);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha1");
  for (const file of files) {
    const relative = path.relative(dir, file).split(path.sep).join("/");
    const body = await readFile(file);
    hash.update(`${relative}\0${body.byteLength}\0`);
    hash.update(body);
  }
  return hash.digest("hex");
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

/** 샘플 하나의 `validation_samples.expected` 본문 (기대 결과표에서 코드 위치 정보를 뺀 판정 부분) */
export function expectedPayload(sample: ExpectedSample) {
  return {
    criteria: sample.criteria,
    mutations: sample.mutations,
    submittedTests: sample.submittedTests,
    scoreDisplay: sample.scoreDisplay,
    description: sample.description,
    ticket: sample.ticket,
    dir: sample.dir,
  };
}

export async function seedSampleAssignment(options: SeedSampleOptions): Promise<SeedSampleResult> {
  const { db, store } = options;
  const log = options.log ?? (() => {});
  const sampleDir = options.sampleDir ?? SAMPLE_DIR;
  const approvedBy = options.approvedBy ?? DEFAULT_APPROVED_BY;

  // 1. 입력 읽기
  const spec = await readFile(path.join(sampleDir, "SPEC.md"), "utf8");
  const rubric: Rubric = RubricSchema.parse(await readJson(path.join(sampleDir, "rubric.v1.json")));
  const contract = ExecutionContractSchema.parse(
    await readJson(path.join(sampleDir, "execution-contract.json")),
  );
  const matrix = ExpectedMatrixSchema.parse(
    await readJson(path.join(sampleDir, "expected-matrix.json")),
  );
  const reportProfile: ReportProfile = ReportProfileSchema.parse(
    await readJson(path.join(sampleDir, "report-profile.json")),
  );
  const rubricCriterionIds = new Set(rubric.criteria.map((c) => c.id));
  const unknownProfileCriteria = reportProfile.criteria
    .map((entry) => entry.criterionId)
    .filter((criterionId) => !rubricCriterionIds.has(criterionId));
  if (unknownProfileCriteria.length > 0) {
    throw new SeedError(
      `report-profile.json이 rubric에 없는 기준을 참조합니다: ${unknownProfileCriteria.join(", ")}`,
    );
  }
  const gatePath = options.gateJsonPath ?? DEFAULT_GATE_JSON;
  let gateRaw: unknown;
  try {
    gateRaw = await readJson(gatePath);
  } catch (error) {
    throw new SeedError(
      `게이트 결과 ${path.relative(repoRoot, gatePath)}를 읽을 수 없습니다. 먼저 pnpm gate:phase1을 실행하세요 (${(error as Error).message})`,
    );
  }
  const gate = GateJsonSchema.parse(gateRaw);
  const harnessVersion = harnessVersionOf(getCaseSet(DEFAULT_CASE_SET));

  if (!gate.ok) {
    throw new SeedError(
      "게이트 결과가 통과가 아니므로 승인하지 않습니다. pnpm gate:phase1을 다시 실행하세요",
    );
  }
  if (gate.harnessVersion !== harnessVersion) {
    throw new SeedError(
      `게이트 결과의 harnessVersion(${gate.harnessVersion})이 현재 하네스(${harnessVersion})와 다릅니다. pnpm gate:phase1을 다시 실행하세요`,
    );
  }
  if (gate.rubricVersion !== rubric.version || matrix.rubricVersion !== rubric.version) {
    throw new SeedError(
      `rubric.v1.json(${rubric.version})·expected-matrix(${matrix.rubricVersion})·게이트(${gate.rubricVersion})의 rubricVersion이 서로 다릅니다`,
    );
  }
  const sampleIds = new Set(gate.comparisons.map((c) => c.sampleId));
  for (const sample of matrix.samples) {
    if (!sampleIds.has(sample.id)) {
      throw new SeedError(`게이트 결과에 샘플 ${sample.id} 대조가 없습니다`);
    }
  }

  // 2. 과제 (이름으로 멱등)
  const [existingAssignment] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.name, SAMPLE_ASSIGNMENT_NAME))
    .orderBy(asc(assignments.createdAt))
    .limit(1);
  const assignment =
    existingAssignment ??
    (await createAssignment(db, {
      name: SAMPLE_ASSIGNMENT_NAME,
      description: SAMPLE_ASSIGNMENT_DESCRIPTION,
    }));
  const createdAssignment = !existingAssignment;
  log(`${createdAssignment ? "과제 생성" : "과제 재사용"}: ${assignment.name} (${assignment.id})`);

  // 3. 명세 원문 → 스토어 (같은 키 덮어쓰기라 멱등)
  const specDigest = specDigestOf(spec);
  const specRef = artifactKeys.assignmentSpec(assignment.id, specDigest);
  await store.put(specRef, spec, { contentType: ARTIFACT_CONTENT_TYPES.assignmentSpec });

  // 4. 버전 (rubric 내용 digest + 하네스 버전으로 멱등). 같은 내용의 최신 버전이 다른 하네스로 승인돼 있으면
  //    승인 버전은 불변이므로(T-201 트리거) RETIRED로 내리고 다음 번호의 버전을 만들어 현재 하네스로 다시 검증·승인한다.
  //    워커는 승인 하네스 버전과 자기 하네스가 다르면 제출을 거절하므로(HARNESS_VERSION_MISMATCH) 하네스가 바뀐 배포 전에 실행한다.
  const contentDigest = rubricContentDigest(rubric);
  const versions = await listAssignmentVersions(db, assignment.id);
  const sameContent = versions
    .filter((v) => v.rubricVersion.endsWith(`-${contentDigest.slice(0, 8)}`))
    .sort((a, b) => b.version - a.version);
  let version = sameContent.find((v) => v.status !== "RETIRED") ?? null;
  let createdVersion = false;
  let retiredVersionId: string | null = null;
  if (!version) {
    const others = versions.filter((v) => v.status !== "RETIRED");
    if (others.length > 0 && sameContent.length === 0) {
      throw new SeedError(
        `과제에 다른 내용의 버전(${others.map((v) => v.rubricVersion).join(", ")})이 이미 있고 rubric.v1.json의 내용(${contentDigest.slice(0, 8)})과 다릅니다. 시드는 샘플 rubric만 관리하므로 새 버전은 화면에서 만드세요`,
      );
    }
  } else if (version.harnessVersion !== harnessVersion) {
    if (version.status !== "APPROVED") {
      throw new SeedError(
        `버전 v${version.version}(${version.status})의 하네스(${version.harnessVersion})가 현재 하네스(${harnessVersion})와 다릅니다. 승인 전 버전은 화면에서 정리한 뒤 다시 실행하세요`,
      );
    }
    const retired = await retireAssignmentVersion(db, version.id);
    retiredVersionId = retired.id;
    log(
      `버전 폐기: v${retired.version} ${retired.rubricVersion} (하네스 ${retired.harnessVersion} → ${harnessVersion}, RETIRED)`,
    );
    version = null;
  }
  if (!version) {
    const nextNumber = Math.max(SAMPLE_VERSION_NUMBER, ...versions.map((v) => v.version + 1));
    version = await createAssignmentVersion(db, {
      assignmentId: assignment.id,
      title: `${SAMPLE_ASSIGNMENT_NAME} v${nextNumber}`,
      specRef,
      specDigest,
      rubric,
      executionContract: contract,
      harnessVersion,
    });
    if (version.version !== nextNumber) {
      throw new SeedError(
        `버전 번호가 어긋났습니다: 기대 v${nextNumber}, 실제 v${version.version}`,
      );
    }
    createdVersion = true;
  }
  log(
    `${createdVersion ? "버전 생성" : "버전 재사용"}: v${version.version} ${version.rubricVersion} (${version.status}, 하네스 ${version.harnessVersion})`,
  );

  // 5. 승인: DRAFT → VALIDATING → APPROVED. 이미 승인됐으면 그대로 둔다
  let approved = false;
  if (version.status === "DRAFT") {
    version = await startAssignmentVersionValidation(db, version.id);
  }
  if (version.status === "VALIDATING") {
    version = await approveAssignmentVersion(db, {
      id: version.id,
      approvedBy,
      validationResult: gate,
    });
    approved = true;
    log(`승인: approved_by=${approvedBy}, validation_result=${path.relative(repoRoot, gatePath)}`);
  } else if (version.status === "RETIRED") {
    log("버전이 RETIRED라 승인 상태를 바꾸지 않습니다");
  }

  // 6. 채용 리포트 프로필 (T-705). rubric 본문·rubricVersion과 무관하므로 승인된 버전에도 매 실행마다 최신 내용으로 덮어쓴다
  if (version.status === "RETIRED") {
    log("버전이 RETIRED라 리포트 프로필을 바꾸지 않습니다");
  } else {
    await setAssignmentVersionReportProfile(db, version.id, reportProfile);
    log(
      `리포트 프로필 저장: profileVersion ${reportProfile.profileVersion}, 기준 ${reportProfile.criteria.length}개`,
    );
  }

  // 7. 검증 샘플 A/B/C/D (버전·이름으로 upsert)
  const samples: SeedSampleResult["samples"] = [];
  for (const sample of matrix.samples) {
    const dir = path.join(sampleDir, sample.dir);
    if (!(await stat(dir)).isDirectory()) throw new SeedError(`샘플 디렉터리가 없습니다: ${dir}`);
    const kind = SAMPLE_KIND_BY_ID[sample.id];
    const snapshotRef = artifactKeys.validationSampleSnapshot(
      assignment.id,
      version.version,
      sample.id,
    );
    const [tarGz, submissionSha] = await Promise.all([
      packDirectoryToTarGz(dir),
      directoryContentSha(dir),
    ]);
    await store.put(snapshotRef, tarGz, { contentType: ARTIFACT_CONTENT_TYPES.snapshot });

    const values = {
      assignmentVersionId: version.id,
      name: sample.name,
      kind,
      snapshotRef,
      submissionSha,
      expected: expectedPayload(sample),
      humanReviewedBy: matrix.reviewedBy,
      humanReviewedAt: matrix.reviewedAt ? new Date(matrix.reviewedAt) : null,
    };
    await db
      .insert(validationSamples)
      .values(values)
      .onConflictDoUpdate({
        target: [validationSamples.assignmentVersionId, validationSamples.name],
        set: {
          kind: values.kind,
          snapshotRef: values.snapshotRef,
          submissionSha: values.submissionSha,
          expected: values.expected,
          humanReviewedBy: values.humanReviewedBy,
          humanReviewedAt: values.humanReviewedAt,
          updatedAt: new Date(),
        },
      });
    samples.push({ id: sample.id, name: sample.name, kind, snapshotRef, submissionSha });
    log(
      `샘플 ${sample.id} ${kind}: ${sample.name} → ${snapshotRef} (sha ${submissionSha.slice(0, 12)}…, 검토자 ${matrix.reviewedBy ?? "없음"})`,
    );
  }

  return {
    assignmentId: assignment.id,
    assignmentVersionId: version.id,
    rubricVersion: version.rubricVersion,
    harnessVersion,
    status: version.status,
    versionNumber: version.version,
    specRef,
    created: { assignment: createdAssignment, version: createdVersion, approved },
    retiredVersionId,
    reportProfileCriteria: version.status === "RETIRED" ? null : reportProfile.criteria.length,
    samples,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      gate: { type: "string", default: DEFAULT_GATE_JSON },
      "approved-by": { type: "string", default: DEFAULT_APPROVED_BY },
    },
    strict: true,
  });

  const store = createArtifactStore(process.env);
  const handle = createDb({ url: requireDatabaseUrl(), max: 2 });
  try {
    const result = await seedSampleAssignment({
      db: handle.db,
      store,
      gateJsonPath: path.resolve(values.gate),
      approvedBy: values["approved-by"],
      log: (line) => console.log(`  ${line}`),
    });
    console.log(
      `db:seed:sample OK — ${SAMPLE_ASSIGNMENT_NAME} v${result.versionNumber} ${result.rubricVersion} ${result.status} (하네스 ${result.harnessVersion}), 샘플 ${result.samples.length}개, 스토어 ${store.kind}`,
    );
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message =
      error instanceof SeedError ? error.message : ((error as Error).stack ?? String(error));
    console.error(`db:seed:sample 오류: ${message}`);
    process.exit(1);
  });
}
