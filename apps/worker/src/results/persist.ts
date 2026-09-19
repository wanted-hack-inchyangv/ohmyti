/**
 * 판정 저장 실행 (TICKET.md T-205): 계획(`buildRequirementResults`)의 아티팩트를 스토어에 쓰고 DB에 한 트랜잭션으로 기록한다.
 *
 * 멱등성: 아티팩트 키는 runId(UUID)를 포함하므로 재시도는 새 키를 쓰고, DB는 이미 판정이 있으면 쓰지 않는다
 * (`persistEvaluationResults` → `EvaluationResultsExistError`). 오케스트레이터는 `hasCriterionResults`로 먼저 확인한다.
 * 재시도에서 단계는 끝났지만 판정이 없을 때는 `loadRequirementResultsSource`가 단계 원문 아티팩트에서 입력을 되살린다.
 */
import type { EvaluationStageRecord, ExecutionContract, FailureKind, Rubric } from "@ohmyti/core";
import { HarnessReportSchema, type HarnessReport } from "@ohmyti/harness";
import { persistEvaluationResults, type Database, type EvaluationResults } from "@ohmyti/db";
import {
  SubmittedTestResultSchema,
  type ProcessExit,
  type ServiceLogsRef,
  type ServiceStartupObservation,
  type SubmittedTestResult,
} from "@ohmyti/runner";
import { ARTIFACT_CONTENT_TYPES, artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logger";
import type {
  RequirementVerifyDetail,
  RequirementVerifyOutcome,
} from "../pipeline/requirement-verify";
import {
  buildRequirementResults,
  scoreFieldsOf,
  type RequirementResultsPlan,
  type RequirementResultsSource,
} from "./build";
import type { FunctionGraphRunResult } from "./function-graph";
import type { ReadmeCheck } from "./readme-check";
import type { PackageManifest } from "./static-checks";

export interface PersistRequirementResultsInput {
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
  /** 루트 package.json (T-405 `staticChecks`) */
  packageManifest?: PackageManifest | undefined;
  /** 관련 함수 그래프 분석 결과 (T-304). 있으면 아티팩트로 저장하고 정적 관계 근거를 만든다 */
  functionGraph?: FunctionGraphRunResult | undefined;
}

export interface PersistRequirementResultsDeps {
  db: Database;
  store: ArtifactStore;
  logger?: Logger | undefined;
  newId?: (() => string) | undefined;
}

/** `stage_log.detail.results`에 남기는 요약 */
export interface RequirementResultsSummary {
  executionRecords: number;
  evidences: number;
  criterionResults: number;
  score: {
    earned: number;
    min: number;
    max: number;
    pendingPoints: number;
    display: string;
  };
  readme: { path: string | null; pass: boolean };
  /** 관련 함수 그래프 분석 요약 (T-304). 분석을 돌리지 않았으면 없다 */
  functionGraph?:
    | { artifactKey: string; status: "ok"; routes: number; cases: number; staticRelations: number }
    | { artifactKey: string; status: "unavailable"; reason: string }
    | undefined;
  [key: string]: unknown;
}

export interface PersistRequirementResultsResult {
  plan: RequirementResultsPlan;
  saved: EvaluationResults;
  summary: RequirementResultsSummary;
}

export async function persistRequirementResults(
  input: PersistRequirementResultsInput,
  deps: PersistRequirementResultsDeps,
): Promise<PersistRequirementResultsResult> {
  const graphKey = artifactKeys.functionGraph(input.evaluation.id);
  const plan = buildRequirementResults({
    ...input,
    functionGraph: input.functionGraph
      ? { artifactKey: graphKey, staticRelations: input.functionGraph.staticRelations }
      : undefined,
    newId: deps.newId ?? randomUUID,
  });
  if (input.functionGraph) {
    // 분석 결과는 상태와 무관하게 저장한다 ("분석 불가"도 화면이 사유와 함께 보여 준다)
    await deps.store.put(graphKey, JSON.stringify(input.functionGraph.analysis, null, 2), {
      contentType: ARTIFACT_CONTENT_TYPES.functionGraph,
    });
  }
  for (const artifact of plan.artifacts) {
    await deps.store.put(artifact.key, JSON.stringify(artifact.body, null, 2), {
      contentType: ARTIFACT_CONTENT_TYPES.runRecord,
    });
  }
  const saved = await persistEvaluationResults(deps.db, {
    evaluationId: input.evaluation.id,
    executionRecords: plan.executionRecords,
    evidences: plan.evidences,
    criterionResults: plan.criterionResults,
    score: scoreFieldsOf(plan.score),
  });
  const summary: RequirementResultsSummary = {
    executionRecords: saved.executionRecords.length,
    evidences: saved.evidences.length,
    criterionResults: saved.criterionResults.length,
    score: { ...scoreFieldsOf(plan.score), display: plan.score.display },
    readme: { path: input.readme.path, pass: input.readme.pass },
  };
  if (input.functionGraph) {
    const { analysis, staticRelations } = input.functionGraph;
    summary.functionGraph =
      analysis.status === "ok"
        ? {
            artifactKey: graphKey,
            status: "ok",
            routes: analysis.routes.length,
            cases: analysis.cases.length,
            staticRelations: staticRelations.length,
          }
        : { artifactKey: graphKey, status: "unavailable", reason: analysis.reason };
  }
  deps.logger?.info(
    {
      evaluationId: input.evaluation.id,
      ...summary,
      verdicts: saved.criterionResults.map((r) => `${r.criterionId}=${r.verdict}`),
    },
    "요구사항 판정을 저장했습니다",
  );
  return { plan, saved, summary };
}

/** 방금 실행한 단계 결과에서 저장 입력을 만든다 */
export function sourceFromOutcome(outcome: RequirementVerifyOutcome): RequirementResultsSource {
  return {
    startup: outcome.startup,
    serviceExit: outcome.serviceExit,
    serviceLogs: outcome.detail.service?.logs ?? null,
    harness: outcome.harness,
    tests: outcome.tests,
    failure:
      outcome.state === "FAILED"
        ? { kind: outcome.failureKind, reason: outcome.reason ?? outcome.failureKind }
        : null,
    stageArtifacts: outcome.detail.artifacts,
  };
}

export class StageArtifactMissingError extends Error {
  constructor(readonly key: string) {
    super(`단계 원문 아티팩트가 없습니다: ${key}`);
    this.name = "StageArtifactMissingError";
  }
}

async function readJson(store: ArtifactStore, key: string): Promise<unknown> {
  const object = await store.get(key);
  if (!object) throw new StageArtifactMissingError(key);
  return JSON.parse(Buffer.from(object.body).toString("utf8"));
}

/**
 * 끝난 REQUIREMENT_VERIFY 단계 기록(`detail.artifacts`)에서 저장 입력을 되살린다 (재시도 경로).
 * 제출 테스트 원문(`tests`)은 항상 있어야 하고, 나머지는 단계가 남긴 것만 읽는다.
 */
export async function loadRequirementResultsSource(
  store: ArtifactStore,
  stage: EvaluationStageRecord,
): Promise<RequirementResultsSource> {
  const detail = (stage.detail ?? {}) as Partial<RequirementVerifyDetail>;
  const artifacts = detail.artifacts ?? {};
  if (!artifacts.tests) {
    throw new StageArtifactMissingError(
      `REQUIREMENT_VERIFY tests (evaluation stage ${stage.state})`,
    );
  }
  const tests: SubmittedTestResult = SubmittedTestResultSchema.parse(
    await readJson(store, artifacts.tests),
  );
  const startup = artifacts.startup
    ? ((await readJson(store, artifacts.startup)) as ServiceStartupObservation)
    : null;
  const serviceExit = artifacts.serviceExit
    ? ((await readJson(store, artifacts.serviceExit)) as ProcessExit)
    : null;
  const harness: HarnessReport | null = artifacts.harness
    ? HarnessReportSchema.parse(await readJson(store, artifacts.harness))
    : null;
  const serviceLogs: ServiceLogsRef | null = detail.service?.logs ?? null;
  const failureKind: FailureKind = detail.failureKind ?? "NONE";
  return {
    startup,
    serviceExit,
    serviceLogs,
    harness,
    tests,
    failure:
      stage.state === "FAILED" && failureKind !== "NONE"
        ? { kind: failureKind, reason: stage.reason ?? failureKind }
        : null,
    stageArtifacts: artifacts,
  };
}
