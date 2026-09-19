/**
 * 테스트 실효성 그룹의 변형 실험 뷰 (TICKET.md T-404). 왼쪽 패널에서 MUTATION 기준(G1~G3)을 고르면 중앙에
 * 그룹의 실험 목록, 선택한 실험의 diff, 유효성 검증 기록(MUTATION_VALIDATION)과 제출 테스트 기록(MUTATION_TESTS)을 함께 보여 준다.
 *
 * 이 모듈은 값을 옮기기만 한다:
 * - 실험 결과(`outcome`)·사유는 리포트의 `mutationExperiments`(워커가 저장한 값) 그대로다.
 * - "검증되지 않은 요구사항"은 SURVIVED 실험의 `targetCriterionId`를 rubric 순서로 나열한 것이다.
 * - 개수나 비율을 계산하지 않는다(비율 표기를 만들지 않는다, 티켓 인수 기준).
 * - 두 기록의 요약은 기록 본문(`readRunRecord` 결과)의 필드를 그대로 옮긴다.
 */
import type {
  EvaluationReport,
  MutationExperiment,
  MutationOutcome,
  RunRecordReport,
  SourceLocation,
} from "@ohmyti/core";
import type { RunRecordInput } from "./replay";
import type { WorkbenchUrlState } from "./state";

export const MUTATION_OUTCOME_LABEL: Record<MutationOutcome, string> = {
  KILLED: "탐지됨",
  SURVIVED: "놓침",
  EQUIVALENT: "등가 변형",
  NOT_APPLICABLE: "적용 불가",
  BUILD_FAIL: "빌드 실패",
  ENV_ERROR: "환경 오류",
  TIMEOUT: "시간 초과",
};

export const MUTATION_OUTCOME_DESCRIPTION: Record<MutationOutcome, string> = {
  KILLED: "결함을 주입하자 제출 테스트가 실패했습니다",
  SURVIVED: "결함을 주입했는데도 제출 테스트가 모두 통과했습니다",
  EQUIVALENT: "변형 후에도 하네스가 통과해 유효한 결함이 아닙니다",
  NOT_APPLICABLE: "변형을 적용할 대상이 없거나 원본부터 동작이 실패했습니다",
  BUILD_FAIL: "변형이 컴파일되지 않거나 서비스가 뜨지 않았습니다",
  ENV_ERROR: "실행 환경 오류로 판정하지 못했습니다",
  TIMEOUT: "시간 제한에 걸려 판정하지 못했습니다",
};

export interface MutationExperimentView {
  mutationId: string;
  targetCriterionId: string;
  outcome: MutationOutcome;
  outcomeLabel: string;
  outcomeDescription: string;
  reason: string | null;
  target: SourceLocation | null;
  validationRunId: string | null;
  testRunId: string | null;
  hasDiff: boolean;
  selected: boolean;
  href: string;
}

export interface MutationDiffLineView {
  kind: "meta" | "hunk" | "add" | "del" | "context";
  text: string;
}

export type MutationDiffView =
  { ok: true; lines: MutationDiffLineView[]; empty: boolean } | { ok: false; message: string };

export interface MutationRecordField {
  label: string;
  value: string;
}

export type MutationRecordView =
  | {
      ok: true;
      runId: string;
      shortId: string;
      kindLabel: string;
      href: string;
      fields: MutationRecordField[];
      /** 검증 기록: 실패한 케이스·검사, 테스트 기록: 실패한 테스트 이름 (기록 순) */
      failures: string[];
    }
  | { ok: false; runId: string; message: string };

/** 페이지가 선택한 실험에 대해 읽어 넘기는 원문 */
export interface MutationDetailInput {
  mutationId: string;
  /** diff 아티팩트 본문. 실험에 diff가 없으면 null */
  diff: { ok: true; text: string } | { ok: false; message: string } | null;
  validation: RunRecordInput | null;
  tests: RunRecordInput | null;
}

export interface MutationPanelView {
  criterionId: string;
  groupId: string;
  groupName: string;
  experiments: MutationExperimentView[];
  /** rubric 그룹에 있지만 실험 기록이 없는 변형 (단계 미실행·전제 조건 미충족) */
  missingMutationIds: string[];
  selected: MutationExperimentView | null;
  /** SURVIVED 실험의 대상 요구사항 (rubric 순서, 중복 제거) */
  unverifiedCriterionIds: string[];
  diff: MutationDiffView | null;
  validation: MutationRecordView | null;
  tests: MutationRecordView | null;
}

type MutationReportSource = Pick<
  EvaluationReport,
  "rubric" | "mutationExperiments" | "criterionResults"
>;

/** 선택한 기준이 MUTATION이면 그 그룹과 실험 (rubric 그룹 `mutationIds` 순) */
function groupOf(report: MutationReportSource, criterionId: string | null) {
  if (!criterionId) return null;
  const criterion = report.rubric.criteria.find((c) => c.id === criterionId);
  if (!criterion || criterion.method !== "MUTATION" || !criterion.groupId) return null;
  const group = report.rubric.groups.find((g) => g.id === criterion.groupId);
  if (!group) return null;
  const byId = new Map(report.mutationExperiments.map((e) => [e.mutationId, e]));
  const experiments = group.mutationIds
    .map((id) => byId.get(id))
    .filter((e): e is MutationExperiment => e !== undefined);
  return { criterion, group, experiments };
}

/**
 * 중앙에 펼칠 실험. `?mutation=`이 그룹의 실험이면 그것, 아니면 기록이나 diff가 있는 첫 실험, 그것도 없으면 첫 실험.
 * 페이지는 이 실험의 diff·두 기록을 읽어 `buildMutationPanelView`에 넘긴다
 */
export function selectMutationExperiment(
  report: MutationReportSource,
  urlState: Pick<WorkbenchUrlState, "criterionId" | "mutationId">,
): MutationExperiment | null {
  const found = groupOf(report, urlState.criterionId);
  if (!found) return null;
  const { experiments } = found;
  return (
    experiments.find((e) => e.mutationId === urlState.mutationId) ??
    experiments.find((e) => e.validationRecordId || e.testRecordId || e.patchRef) ??
    experiments[0] ??
    null
  );
}

export function parseDiffLines(text: string): MutationDiffLineView[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line): MutationDiffLineView => {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) return { kind: "meta", text: line };
    if (line.startsWith("@@")) return { kind: "hunk", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line };
    if (line.startsWith("-")) return { kind: "del", text: line };
    return { kind: "context", text: line };
  });
}

const SHORT_ID = 8;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "없음";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** 유효성 검증 기록 요약: 변형 위 하네스 판정, 대상 케이스별 판정, 실패한 검사 이름 */
function validationFields(run: RunRecordReport): {
  fields: MutationRecordField[];
  failures: string[];
} {
  const actual = asObject(run.actual) ?? {};
  const cases = Array.isArray(actual.cases) ? actual.cases.map(asObject) : [];
  const fields: MutationRecordField[] = [
    { label: "변형 위 하네스 판정", value: text(actual.verdict) },
    { label: "실패 종류", value: text(actual.failureKind) },
  ];
  if (actual.serviceFailure) fields.push({ label: "서비스", value: text(actual.serviceFailure) });
  const failures: string[] = [];
  for (const c of cases) {
    if (!c) continue;
    const checks = Array.isArray(c.checks) ? c.checks.map(asObject) : [];
    const failed = checks
      .filter((check) => check && check.ok === false)
      .map((check) => text(check!.name));
    if (c.verdict !== "PASS") {
      failures.push(
        `${text(c.caseId)} ${text(c.verdict)}${failed.length > 0 ? `: ${failed.join(", ")}` : c.reason ? `: ${text(c.reason)}` : ""}`,
      );
    }
  }
  return { fields, failures };
}

/** 제출 테스트 기록 요약: 상태, 기록된 통과·실패 건수, 실패한 테스트 이름 */
function testsFields(run: RunRecordReport): { fields: MutationRecordField[]; failures: string[] } {
  const actual = asObject(run.actual) ?? {};
  const fields: MutationRecordField[] = [
    { label: "변형 위 제출 테스트", value: text(actual.status) },
    { label: "통과", value: `${text(actual.passed)}건` },
    { label: "실패", value: `${text(actual.failed)}건` },
  ];
  if (actual.reason) fields.push({ label: "사유", value: text(actual.reason) });
  const failures: string[] = [];
  const files = Array.isArray(actual.testFiles) ? actual.testFiles.map(asObject) : [];
  for (const file of files) {
    if (!file) continue;
    if (file.error) failures.push(`${text(file.path)}: ${text(file.error)}`);
    const tests = Array.isArray(file.tests) ? file.tests.map(asObject) : [];
    for (const test of tests) {
      if (test && test.status === "failed")
        failures.push(`${text(file.path)} › ${text(test.fullName)}`);
    }
  }
  return { fields, failures };
}

function recordView(
  runId: string | null,
  input: RunRecordInput | null,
  href: (runId: string) => string,
  summarize: (run: RunRecordReport) => { fields: MutationRecordField[]; failures: string[] },
  kindLabel: string,
): MutationRecordView | null {
  if (!runId) return null;
  if (!input) return { ok: false, runId, message: "기록 본문을 읽지 않았습니다" };
  if (!input.ok) return { ok: false, runId, message: `${input.code}: ${input.message}` };
  const { fields, failures } = summarize(input.data);
  return {
    ok: true,
    runId,
    shortId: runId.slice(0, SHORT_ID),
    kindLabel,
    href: href(runId),
    fields,
    failures,
  };
}

export function buildMutationPanelView(
  report: MutationReportSource,
  urlState: WorkbenchUrlState,
  href: (patch: Partial<WorkbenchUrlState>) => string,
  detail: MutationDetailInput | null,
): MutationPanelView | null {
  const found = groupOf(report, urlState.criterionId);
  if (!found) return null;
  const { criterion, group, experiments } = found;
  const selectedExperiment = selectMutationExperiment(report, urlState);
  const views = experiments.map((e): MutationExperimentView => ({
    mutationId: e.mutationId,
    targetCriterionId: e.targetCriterionId,
    outcome: e.outcome,
    outcomeLabel: MUTATION_OUTCOME_LABEL[e.outcome],
    outcomeDescription: MUTATION_OUTCOME_DESCRIPTION[e.outcome],
    reason: e.reason ?? null,
    target: e.target ?? null,
    validationRunId: e.validationRecordId ?? null,
    testRunId: e.testRecordId ?? null,
    hasDiff: e.patchRef !== undefined,
    selected: e.mutationId === selectedExperiment?.mutationId,
    // 다른 실험을 고르면 그 실험의 검증 기록을 재생 뷰에 연다
    href: href({ mutationId: e.mutationId, runId: e.validationRecordId ?? null }),
  }));
  const survivedTargets = new Set(
    experiments.filter((e) => e.outcome === "SURVIVED").map((e) => e.targetCriterionId),
  );
  const order = report.rubric.criteria.map((c) => c.id);
  const unverified = [
    ...order.filter((id) => survivedTargets.has(id)),
    ...[...survivedTargets].filter((id) => !order.includes(id)),
  ];
  const selected = views.find((v) => v.selected) ?? null;
  const matching = detail && selected && detail.mutationId === selected.mutationId ? detail : null;
  let diff: MutationDiffView | null = null;
  if (selected?.hasDiff) {
    if (!matching?.diff) diff = { ok: false, message: "diff 본문을 읽지 않았습니다" };
    else if (!matching.diff.ok) diff = { ok: false, message: matching.diff.message };
    else {
      const lines = parseDiffLines(matching.diff.text);
      diff = { ok: true, lines, empty: lines.length === 0 };
    }
  }
  const runHref = (runId: string) => href({ runId });
  return {
    criterionId: criterion.id,
    groupId: group.id,
    groupName: group.name,
    experiments: views,
    missingMutationIds: group.mutationIds.filter(
      (id) => !experiments.some((e) => e.mutationId === id),
    ),
    selected,
    unverifiedCriterionIds: unverified,
    diff,
    validation: recordView(
      selected?.validationRunId ?? null,
      matching?.validation ?? null,
      runHref,
      validationFields,
      "유효성 검증 기록",
    ),
    tests: recordView(
      selected?.testRunId ?? null,
      matching?.tests ?? null,
      runHref,
      testsFields,
      "제출 테스트 기록",
    ),
  };
}
