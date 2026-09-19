/**
 * REQUIREMENT_VERIFY 관측 → ExecutionRecord·Evidence·CriterionResult 계획 (TICKET.md T-205). 순수 함수다.
 *
 * - 기동 관측 1건 + 하네스 케이스마다 1건 → `execution_records`(HARNESS), 제출 테스트 1건 → `execution_records`(SUBMITTED_TESTS).
 *   각 기록의 input/expected/actual(+timeline)은 `evaluations/<id>/runs/<runId>/*.json`에 둔다 (`artifactKeys.runRecord`).
 * - 기록마다 Evidence 1건(`runId`, `testId` = caseId, `artifactRefs` = 기록 본문 + 서비스 로그).
 * - EXECUTION 기준 판정은 `deriveCriteria`(T-110·T-204와 같은 접기 규칙)에서 가져오고 여기서는 근거·issueId·observation만 붙인다.
 *   STATIC(README)은 `ReadmeCheck`, 기준에 `staticChecks`(T-405)가 있으면 `package.json` 검사도 모두 통과해야 PASS다. MUTATION은 INCONCLUSIVE 자리 표시(TEST_EFFECTIVENESS 뒤 T-404가 교체), HUMAN_REVIEW는 INCONCLUSIVE·PENDING.
 * - `observation`은 데이터에서 만든 템플릿 문장이고 `interpretation`은 두지 않는다. LLM은 관여하지 않는다 (G-01).
 * - `issueId`: FAIL 기준은 실패한 케이스 ID(정렬·`+` 연결)에서 만든다. 같은 케이스에서 파생된 판정은 같은 issueId를 갖고,
 *   그 기준들이 rubric `independentReasons`에 없으면 `aggregateScore`가 `DuplicateDeductionError`로 거부한다 (G-12).
 * - `functionGraph`(T-304)가 있으면 케이스 루트 라우트의 핸들러 위치를 `kind: STATIC_RELATION` 근거로 만들어 그 케이스를
 *   참조하는 EXECUTION 기준의 `evidenceIds` 뒤에 붙인다. 근거의 `runId`는 케이스 기록이고 `artifactRefs`는 그래프 아티팩트다.
 *   판정·점수·issueId에는 영향이 없다.
 */
import {
  aggregateScore,
  type CriterionResult,
  type ExecutionContract,
  type FailureKind,
  type ReviewState,
  type Rubric,
  type ScoreSummary,
  type Verdict,
} from "@ohmyti/core";
import {
  CONTRACT_AREA,
  deriveCriteria,
  getCaseSet,
  type CaseResult,
  type DerivedCriterion,
  type HarnessReport,
} from "@ohmyti/harness";
import type {
  NewCriterionResult,
  NewEvidence,
  NewExecutionRecord,
  EvaluationScore,
} from "@ohmyti/db";
import type {
  ProcessExit,
  ServiceLogsRef,
  ServiceStartupObservation,
  SubmittedTestResult,
} from "@ohmyti/runner";
import { artifactKeys } from "@ohmyti/storage";
import type { StaticRelationInput } from "./function-graph";
import { describeReadmeCheck, type ReadmeCheck } from "./readme-check";
import { evaluateStaticChecks, type PackageManifest } from "./static-checks";

/** TEST_EFFECTIVENESS 단계가 끝나기 전 MUTATION 기준의 자리 표시 observation. T-404가 그룹 판정으로 바꾼다 */
export const MUTATION_PENDING_OBSERVATION = "테스트 실효성 판정 전(TEST_EFFECTIVENESS 단계 대기)";
/** HUMAN_REVIEW 기준의 observation */
export const HUMAN_REVIEW_PENDING_OBSERVATION =
  "사람 확인 대기: 설계 기준은 코드 근거와 함께 사람이 판정한다 (AI 초안은 4단계 T-407)";
/** 검사 규칙이 없는 STATIC 기준의 observation */
export const STATIC_RULE_MISSING_OBSERVATION = "이 정적 기준에 대응하는 검사 규칙이 없음";

/** observation에 넣는 값 문자열 상한 */
const VALUE_MAX_CHARS = 120;

export interface RequirementResultsSource {
  startup: ServiceStartupObservation | null;
  serviceExit: ProcessExit | null;
  serviceLogs: ServiceLogsRef | null;
  harness: HarnessReport | null;
  tests: SubmittedTestResult;
  /** 단계가 제출물 탓으로 FAILED면 그 종류·사유 (환경 장애는 단계 밖에서 처리된다) */
  failure: { kind: FailureKind; reason: string } | null;
  /** `evaluations/<id>/stages/REQUIREMENT_VERIFY/*.json` 키 */
  stageArtifacts: {
    startup?: string | undefined;
    harness?: string | undefined;
    tests?: string | undefined;
    serviceExit?: string | undefined;
  };
}

export interface RequirementResultsInput {
  evaluation: {
    id: string;
    submissionSha: string;
    rubricVersion: string;
    harnessVersion: string;
    environmentDigest: string;
  };
  rubric: Rubric;
  contract: ExecutionContract;
  caseSet: string;
  snapshotRef: string;
  source: RequirementResultsSource;
  readme: ReadmeCheck;
  /** `staticChecks`가 있는 STATIC 기준(T-405)이 읽는 루트 package.json. 없으면 그 기준은 검사 불가로 FAIL이다 */
  packageManifest?: PackageManifest | undefined;
  /** 관련 함수 그래프 분석(T-304)의 정적 관계 근거 입력과 아티팩트 키. 없으면 정적 관계 근거를 만들지 않는다 */
  functionGraph?:
    { artifactKey: string; staticRelations: readonly StaticRelationInput[] } | undefined;
  /** UUID 생성기 (테스트에서 고정한다) */
  newId: () => string;
}

export interface PlannedArtifact {
  key: string;
  body: unknown;
}

export interface RequirementResultsPlan {
  artifacts: PlannedArtifact[];
  executionRecords: NewExecutionRecord[];
  evidences: NewEvidence[];
  criterionResults: NewCriterionResult[];
  /** `aggregateScore` 결과. `evaluations` 점수 필드에는 `earned·min·max·pendingPoints`와 영역 소계 `byArea`를 쓴다 */
  score: ScoreSummary;
  /** `deriveCriteria` 결과 (EXECUTION 기준). 단계 detail과 대조용 */
  derived: DerivedCriterion[];
}

export function scoreFieldsOf(score: ScoreSummary): EvaluationScore {
  return {
    earned: score.earned,
    min: score.min,
    max: score.max,
    pendingPoints: score.pendingPoints,
    byArea: score.byArea,
  };
}

interface RecordBundle {
  record: NewExecutionRecord;
  evidence: NewEvidence;
}

function reviewStateFor(verdict: Verdict): ReviewState {
  return verdict === "INCONCLUSIVE" ? "PENDING" : "NOT_REQUIRED";
}

function compactValue(value: unknown): string {
  const text = value === undefined ? "undefined" : JSON.stringify(value);
  return text.length > VALUE_MAX_CHARS ? `${text.slice(0, VALUE_MAX_CHARS)}…` : text;
}

/** 서비스가 스스로 끝났을 때(크래시·수명 제한)만 종료 코드를 기록에 남긴다. 러너가 정상 종료한 경우는 null */
function serviceExitCode(serviceExit: ProcessExit | null): number | null {
  if (!serviceExit || serviceExit.stoppedByCaller) return null;
  return serviceExit.exitCode;
}

function serviceLogRefs(logs: ServiceLogsRef | null): string[] {
  return logs ? [logs.stdout, logs.stderr] : [];
}

function defined<T>(items: readonly (T | undefined)[]): T[] {
  return items.filter((item): item is T => item !== undefined);
}

export function buildRequirementResults(input: RequirementResultsInput): RequirementResultsPlan {
  const { evaluation, rubric, contract, source, readme } = input;
  const artifacts: PlannedArtifact[] = [];
  const executionRecords: NewExecutionRecord[] = [];
  const evidences: NewEvidence[] = [];
  const criterionResults: NewCriterionResult[] = [];
  const caseDefinitions = new Map(getCaseSet(input.caseSet).map((c) => [c.id, c]));

  const recordBase = {
    evaluationId: evaluation.id,
    submissionSha: evaluation.submissionSha,
    rubricVersion: evaluation.rubricVersion,
    harnessVersion: evaluation.harnessVersion,
    environmentDigest: evaluation.environmentDigest,
  };

  const addRecord = (
    kind: NewExecutionRecord["kind"],
    parts: { input: unknown; expected: unknown; actual: unknown; timeline?: unknown },
    fields: Pick<NewExecutionRecord, "exitCode" | "failureKind"> &
      Partial<Pick<NewExecutionRecord, "startedAt" | "finishedAt" | "durationMs">>,
    evidence: { testId?: string | undefined; extraRefs: readonly string[] },
  ): RecordBundle => {
    const runId = input.newId();
    const key = (part: "input" | "expected" | "actual" | "timeline") =>
      artifactKeys.runRecord(evaluation.id, runId, part);
    artifacts.push({ key: key("input"), body: parts.input });
    artifacts.push({ key: key("expected"), body: parts.expected });
    artifacts.push({ key: key("actual"), body: parts.actual });
    const refs = [key("input"), key("expected"), key("actual")];
    if (parts.timeline !== undefined) {
      artifacts.push({ key: key("timeline"), body: parts.timeline });
      refs.push(key("timeline"));
    }
    const record: NewExecutionRecord = {
      id: runId,
      ...recordBase,
      kind,
      inputRef: key("input"),
      expectedRef: key("expected"),
      actualRef: key("actual"),
      exitCode: fields.exitCode,
      failureKind: fields.failureKind,
      startedAt: fields.startedAt,
      finishedAt: fields.finishedAt,
      durationMs: fields.durationMs,
    };
    const ev: NewEvidence = {
      id: input.newId(),
      evaluationId: evaluation.id,
      submissionSha: evaluation.submissionSha,
      runId,
      testId: evidence.testId,
      artifactRefs: [...refs, ...evidence.extraRefs],
    };
    executionRecords.push(record);
    evidences.push(ev);
    return { record, evidence: ev };
  };

  // ── 기동 관측 (R-10의 근거. 기동 실패면 모든 EXECUTION 기준의 근거) ──────────────
  const healthy = source.startup?.outcome === "HEALTHY";
  const startupBundle = addRecord(
    "HARNESS",
    {
      input: {
        kind: "SERVICE_STARTUP",
        startCommand: contract.startCommand,
        portEnv: contract.portEnv,
        healthPath: contract.healthPath,
        healthTimeoutMs: contract.healthTimeoutMs,
        templateName: contract.templateName,
        nodeVersion: contract.nodeVersion,
      },
      expected: { outcome: "HEALTHY", healthStatus: 200 },
      actual: {
        startup: source.startup,
        serviceExit: source.serviceExit
          ? {
              exitCode: source.serviceExit.exitCode,
              signal: source.serviceExit.signal,
              stoppedByCaller: source.serviceExit.stoppedByCaller,
              timedOut: source.serviceExit.timedOut,
              durationMs: source.serviceExit.durationMs,
              startedAt: source.serviceExit.startedAt,
              finishedAt: source.serviceExit.finishedAt,
            }
          : null,
        failure: source.failure,
      },
    },
    {
      exitCode: serviceExitCode(source.serviceExit),
      failureKind: healthy ? "NONE" : "SUBMISSION",
      startedAt: source.serviceExit?.startedAt,
      finishedAt: source.serviceExit?.finishedAt,
      durationMs: source.startup?.elapsedMs,
    },
    {
      extraRefs: defined([source.stageArtifacts.startup, source.stageArtifacts.serviceExit]).concat(
        serviceLogRefs(source.serviceLogs),
      ),
    },
  );

  // ── 하네스 케이스 ───────────────────────────────────────────────────────────────
  const caseBundles = new Map<string, { result: CaseResult; bundle: RecordBundle }>();
  for (const result of source.harness?.results ?? []) {
    const bundle = addRecord(
      "HARNESS",
      {
        input: {
          kind: "HARNESS_CASE",
          caseId: result.caseId,
          criterionIds: result.criterionIds,
          caseSet: input.caseSet,
          harnessVersion: evaluation.harnessVersion,
          requestTimeoutMs: source.harness?.requestTimeoutMs ?? null,
          resetPath: contract.resetPath ?? null,
          definition: caseDefinitions.get(result.caseId) ?? null,
        },
        expected: {
          caseId: result.caseId,
          expected: result.expected,
          checks: result.checks.map((c) => ({ name: c.name, expected: c.expected })),
        },
        actual: {
          caseId: result.caseId,
          verdict: result.verdict,
          failureKind: result.failureKind,
          reason: result.reason ?? null,
          actual: result.actual,
          checks: result.checks,
        },
        timeline: result.timeline,
      },
      {
        exitCode: serviceExitCode(source.serviceExit),
        failureKind: result.failureKind,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt)),
      },
      {
        testId: result.caseId,
        extraRefs: defined([source.stageArtifacts.harness]).concat(
          serviceLogRefs(source.serviceLogs),
        ),
      },
    );
    caseBundles.set(result.caseId, { result, bundle });
  }

  // ── 정적 관계 근거 (T-304): 케이스 루트 라우트의 핸들러 위치. 케이스 기록을 runId로 참조한다 ──
  const staticEvidenceIdsByCase = new Map<string, string[]>();
  for (const relation of input.functionGraph?.staticRelations ?? []) {
    const bundle = caseBundles.get(relation.caseId);
    if (!bundle) continue;
    const ev: NewEvidence = {
      id: input.newId(),
      evaluationId: evaluation.id,
      submissionSha: evaluation.submissionSha,
      kind: "STATIC_RELATION",
      runId: bundle.bundle.record.id,
      testId: relation.caseId,
      source: relation.source,
      snippet: relation.snippet,
      artifactRefs: [input.functionGraph!.artifactKey],
    };
    evidences.push(ev);
    const list = staticEvidenceIdsByCase.get(relation.caseId) ?? [];
    list.push(ev.id);
    staticEvidenceIdsByCase.set(relation.caseId, list);
  }

  // ── 제출 테스트 ─────────────────────────────────────────────────────────────────
  const tests = source.tests;
  const testsBundle = addRecord(
    "SUBMITTED_TESTS",
    {
      input: {
        kind: "SUBMITTED_TESTS",
        framework: tests.framework,
        typecheck: tests.typecheck ? { argv: tests.typecheck.argv } : null,
        run: tests.run ? { argv: tests.run.argv } : null,
      },
      expected: { status: "PASSED", failed: 0 },
      actual: {
        status: tests.status,
        failureKind: tests.failureKind,
        reason: tests.reason,
        total: tests.total,
        passed: tests.passed,
        failed: tests.failed,
        skipped: tests.skipped,
        durationMs: tests.durationMs,
        resultFileCollected: tests.resultFileCollected,
        truncated: tests.truncated,
        typecheck: tests.typecheck,
        run: tests.run,
        testFiles: tests.testFiles,
      },
    },
    {
      exitCode: tests.run?.exitCode ?? tests.typecheck?.exitCode ?? null,
      failureKind: tests.failureKind,
      durationMs: Math.round(tests.durationMs),
    },
    {
      extraRefs: defined([source.stageArtifacts.tests]).concat(
        tests.run ? [tests.run.logsRef.stdout, tests.run.logsRef.stderr] : [],
        tests.typecheck ? [tests.typecheck.logsRef.stdout, tests.typecheck.logsRef.stderr] : [],
      ),
    },
  );

  // ── 기준별 판정 ─────────────────────────────────────────────────────────────────
  const derived = deriveCriteria(rubric, source.harness, source.startup);
  const derivedById = new Map(derived.map((d) => [d.criterionId, d]));
  const startupText = describeStartup(source);
  const testsText = describeTests(tests);

  for (const criterion of rubric.criteria) {
    const base = {
      evaluationId: evaluation.id,
      criterionId: criterion.id,
      rubricVersion: evaluation.rubricVersion,
      maxPoints: criterion.maxPoints,
      method: criterion.method,
    };

    if (criterion.method === "EXECUTION") {
      const d = derivedById.get(criterion.id);
      if (!d) continue;
      const cases = d.caseIds
        .map((id) => caseBundles.get(id))
        .filter((c): c is { result: CaseResult; bundle: RecordBundle } => c !== undefined);
      const evidenceIds = cases.map((c) => c.bundle.evidence.id);
      const isContract = criterion.area === CONTRACT_AREA;
      if (isContract || !healthy) evidenceIds.unshift(startupBundle.evidence.id);
      // 정적 관계 근거는 실행 근거 뒤에 둔다 (첫 근거가 실행 기록이어야 재생 뷰의 기본 선택이 유지된다)
      for (const c of cases)
        evidenceIds.push(...(staticEvidenceIdsByCase.get(c.result.caseId) ?? []));
      const failedCases = cases
        .filter((c) => c.result.verdict === "FAIL")
        .map((c) => c.result.caseId);
      const issueId =
        d.verdict === "FAIL"
          ? failedCases.length > 0
            ? `case:${[...failedCases].sort().join("+")}`
            : "service-startup"
          : undefined;
      const observation = [
        ...(isContract || !healthy ? [startupText] : []),
        ...(healthy && cases.length > 0
          ? cases.map((c) => describeCase(c.result))
          : healthy
            ? [d.reason ?? "기준을 참조하는 하네스 케이스가 없음"]
            : ["하네스 미실행"]),
      ].join(" · ");
      criterionResults.push({
        ...base,
        earnedPoints: d.earnedPoints,
        verdict: d.verdict,
        evidenceIds,
        issueId,
        observation,
        reviewState: reviewStateFor(d.verdict),
      });
      continue;
    }

    if (criterion.method === "STATIC") {
      const staticChecks = criterion.staticChecks
        ? evaluateStaticChecks(
            criterion.staticChecks,
            input.packageManifest ?? {
              path: null,
              parseError: null,
              declared: new Map(),
              lines: [],
            },
          )
        : null;
      const staticEvidence: NewEvidence | null = staticChecks
        ? {
            id: input.newId(),
            evaluationId: evaluation.id,
            submissionSha: evaluation.submissionSha,
            source: staticChecks.source ?? undefined,
            snippet: staticChecks.snippet ?? undefined,
            artifactRefs: [input.snapshotRef],
          }
        : null;
      if (staticEvidence) evidences.push(staticEvidence);
      const staticText = staticChecks?.outcomes.map((o) => o.observation).join(" · ");
      if (criterion.area !== CONTRACT_AREA && staticChecks && staticEvidence) {
        criterionResults.push({
          ...base,
          earnedPoints: staticChecks.pass ? criterion.maxPoints : 0,
          verdict: staticChecks.pass ? "PASS" : "FAIL",
          evidenceIds: [staticEvidence.id],
          issueId: staticChecks.pass ? undefined : `static:${criterion.id}`,
          observation: staticText!,
          reviewState: "NOT_REQUIRED",
        });
        continue;
      }
      if (criterion.area !== CONTRACT_AREA) {
        criterionResults.push({
          ...base,
          earnedPoints: null,
          verdict: "INCONCLUSIVE",
          evidenceIds: [],
          observation: STATIC_RULE_MISSING_OBSERVATION,
          reviewState: "PENDING",
        });
        continue;
      }
      const readmeEvidence: NewEvidence = {
        id: input.newId(),
        evaluationId: evaluation.id,
        submissionSha: evaluation.submissionSha,
        source: readme.source ?? undefined,
        snippet: readme.snippet ?? undefined,
        artifactRefs: [input.snapshotRef],
      };
      evidences.push(readmeEvidence);
      const pass = readme.pass && (staticChecks?.pass ?? true);
      const verdict: Verdict = pass ? "PASS" : "FAIL";
      criterionResults.push({
        ...base,
        earnedPoints: pass ? criterion.maxPoints : 0,
        verdict,
        evidenceIds: staticEvidence ? [readmeEvidence.id, staticEvidence.id] : [readmeEvidence.id],
        issueId: pass ? undefined : readme.pass ? `static:${criterion.id}` : "readme",
        observation: [
          describeReadmeCheck(readme, contract),
          ...(staticText ? [staticText] : []),
        ].join(" · "),
        reviewState: "NOT_REQUIRED",
      });
      continue;
    }

    if (criterion.method === "MUTATION") {
      criterionResults.push({
        ...base,
        earnedPoints: null,
        verdict: "INCONCLUSIVE",
        evidenceIds: [testsBundle.evidence.id],
        observation: `${MUTATION_PENDING_OBSERVATION} · ${testsText}`,
        reviewState: "PENDING",
      });
      continue;
    }

    // HUMAN_REVIEW
    criterionResults.push({
      ...base,
      earnedPoints: null,
      verdict: "INCONCLUSIVE",
      evidenceIds: [],
      observation: HUMAN_REVIEW_PENDING_OBSERVATION,
      reviewState: "PENDING",
    });
  }

  const score = aggregateScore(
    criterionResults.map((r): CriterionResult => toCoreResult(r)),
    rubric,
  );
  return { artifacts, executionRecords, evidences, criterionResults, score, derived };
}

function toCoreResult(r: NewCriterionResult): CriterionResult {
  return {
    criterionId: r.criterionId,
    rubricVersion: r.rubricVersion,
    maxPoints: r.maxPoints,
    earnedPoints: r.earnedPoints,
    verdict: r.verdict,
    method: r.method,
    evidenceIds: r.evidenceIds,
    ...(r.issueId !== undefined ? { issueId: r.issueId } : {}),
    observation: r.observation,
    reviewState: r.reviewState,
    ...(r.satisfiedSubCriterionIds !== undefined
      ? { satisfiedSubCriterionIds: r.satisfiedSubCriterionIds }
      : {}),
  };
}

/** 기동 관측 문장 */
export function describeStartup(source: RequirementResultsSource): string {
  const s = source.startup;
  if (!s) {
    return `기동 실패: ${source.failure?.reason ?? "기동 관측 없음"}`;
  }
  if (s.outcome === "HEALTHY") {
    return `기동 HEALTHY: ${s.healthPath} ${s.lastHealthStatus ?? "응답 없음"} (${s.elapsedMs}ms, 시도 ${s.healthAttempts}회)`;
  }
  const exit = source.serviceExit;
  const exitText =
    exit && !exit.stoppedByCaller
      ? `, 종료 코드 ${exit.exitCode ?? "null"}${exit.signal ? ` (${exit.signal})` : ""}`
      : "";
  return `기동 실패(${s.outcome}): ${s.reason ?? "사유 없음"} (${s.elapsedMs}ms, ${s.healthPath} 시도 ${s.healthAttempts}회, 마지막 상태 ${s.lastHealthStatus ?? "응답 없음"}${exitText})`;
}

/** 케이스 결과 문장. FAIL이면 실패한 검사의 기대·실제 값을 나열한다 */
export function describeCase(result: CaseResult): string {
  const total = result.checks.length;
  if (result.verdict === "PASS") {
    return `하네스 케이스 ${result.caseId} PASS: 검사 ${total}개 모두 통과`;
  }
  if (result.verdict === "FAIL") {
    const failed = result.checks.filter((c) => !c.ok);
    const details = failed.map(
      (c) => `${c.name}: 기대 ${compactValue(c.expected)}, 실제 ${compactValue(c.actual)}`,
    );
    const head = `하네스 케이스 ${result.caseId} FAIL(${result.failureKind}): 검사 ${total}개 중 ${failed.length}개 실패`;
    const reason = result.reason ? ` (${result.reason})` : "";
    return details.length > 0 ? `${head}${reason} · ${details.join(" · ")}` : `${head}${reason}`;
  }
  return `하네스 케이스 ${result.caseId} ${result.verdict}(${result.failureKind}): ${result.reason ?? "사유 없음"}`;
}

/** 제출 테스트 문장 */
export function describeTests(tests: SubmittedTestResult): string {
  const files = tests.testFiles.length;
  if (tests.status === "PASSED" || tests.status === "FAILED") {
    return `제출 테스트 ${tests.status}: ${tests.passed}/${tests.total}건 통과, 실패 ${tests.failed}건, 건너뜀 ${tests.skipped}건 (${files}개 파일, ${tests.framework.framework})`;
  }
  return `제출 테스트 ${tests.status}(${tests.failureKind}): ${tests.reason ?? "사유 없음"}`;
}
