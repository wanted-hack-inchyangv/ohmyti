/**
 * 실패 재생 뷰의 표시 모델 (TICKET.md T-303). 선택한 기준의 근거가 가리키는 실행 기록 목록과, 선택한 기록의 본문
 * (`GET /api/evaluations/[id]/runs/[runId]`와 같은 `readRunRecord` 결과)을 화면에 맞는 형태로 옮긴다.
 *
 * 이 모듈은 값을 해석하지 않는다:
 * - 기대·실제 비교의 통과/실패는 기록의 `checks[].ok`를 그대로 쓴다 (`expected === actual`을 다시 비교하지 않는다).
 * - 타임라인의 status·elapsedMs·stateAfter는 기록 값 그대로다. 동시 요청 묶음은 같은 `stepIndex`의 항목을 모을 뿐이다.
 * - 값의 문자열 표시(`formatInlineValue`)는 JSON 직렬화이며 어떤 연산도 하지 않는다.
 * 테스트가 소스에서 `fetch(`·`.reduce(`·산술 연산이 없음을 대조한다.
 */
import {
  HarnessCaseActualSchema,
  HarnessCaseExpectedSchema,
  RerunActualSchema,
  ReplayTimelineSchema,
  type ApiErrorCode,
  type Evidence,
  type ExecutionRecord,
  type ExecutionRecordKind,
  type FailureKind,
  type JobStatus,
  type JsonValue,
  type ReplayEntryKind,
  type ReplayTimelineEntry,
  type RerunJobSummary,
  type RerunStatusReport,
  type RunRecordReport,
} from "@ohmyti/core";
import type { CenterPane, WorkbenchUrlState } from "./state";

export const RECORD_KIND_LABEL: Record<ExecutionRecordKind, string> = {
  HARNESS: "하네스 케이스",
  SUBMITTED_TESTS: "제출 테스트",
  MUTATION_VALIDATION: "mutation 검증",
  MUTATION_TESTS: "mutation 테스트",
  RERUN: "재실행",
};

export const FAILURE_KIND_LABEL: Record<FailureKind, string> = {
  NONE: "실패 없음",
  ASSERTION: "검사 실패",
  SUBMISSION: "제출 코드 오류",
  ENVIRONMENT: "환경 장애",
  TIMEOUT: "시간 초과",
};

export const ENTRY_KIND_LABEL: Record<ReplayEntryKind, string> = {
  reset: "초기화",
  request: "요청",
  observeState: "상태 관측",
  parallel: "동시 요청",
};

export const SHORT_RUN_ID_LENGTH = 8;

/** 기록 하나의 목록 항목. `kind === "RERUN"`이면 재실행, 아니면 원본이다 (G-03: 재실행은 새 레코드) */
export interface ReplayRunView {
  id: string;
  shortId: string;
  kind: ExecutionRecordKind | null;
  kindLabel: string;
  isRerun: boolean;
  originLabel: "원본" | "재실행";
  /** 이 기록을 참조하는 근거의 `testId` (하네스 케이스 ID). 없으면 null */
  testId: string | null;
  failureKind: FailureKind;
  failureKindLabel: string;
  /** 기록의 `startedAt` 또는 `finishedAt` 중 있는 값. 둘 다 없으면 null */
  recordedAt: string | null;
  durationMs: number | null;
  selected: boolean;
  href: string;
}

/** 기대/실제 비교 행. `ok`는 기록의 검사 결과 그대로다 */
export interface ReplayCheckView {
  name: string;
  /** 기록에 통과/실패가 있으면 그 값, 일반 기록(기동·제출 테스트)이면 null */
  ok: boolean | null;
  expected: JsonValue;
  actual: JsonValue;
  expectedDisplay: string;
  actualDisplay: string;
}

export interface ReplayTimelineRowView {
  seq: number;
  stepIndex: number;
  kind: ReplayEntryKind;
  kindLabel: string;
  capture: string | null;
  method: string;
  path: string;
  /** 응답이 없으면(전송 오류) null */
  status: number | null;
  error: { kind: string; message: string } | null;
  elapsedMs: number;
  /** observeState 항목의 상태 본문. 없으면 undefined */
  stateAfter: JsonValue | undefined;
  stateAfterDisplay: string | null;
  requestHeaders: Record<string, string>;
  requestBody: JsonValue;
  requestBodyDisplay: string;
  responseHeaders: Record<string, string> | null;
  responseBody: JsonValue;
  responseBodyDisplay: string | null;
}

/** 타임라인 표의 한 줄. 동시 요청 스텝은 같은 `stepIndex`의 항목을 하나로 묶는다 */
export interface ReplayTimelineGroupView {
  key: string;
  parallel: boolean;
  /** 묶음 제목 (`동시 요청 10건 · same`). 단일 항목은 null */
  label: string | null;
  rows: ReplayTimelineRowView[];
}

/** RERUN 기록의 원본 비교 (워커가 `actual.json`의 `rerun`에 기록한 값 그대로. 화면은 다시 비교하지 않는다) */
export interface ReplayRerunComparisonView {
  originalRunId: string;
  originalHref: string;
  outcome: "same" | "different";
  outcomeLabel: "원본과 동일" | "원본과 상이";
  sameVerdict: boolean;
  sameActual: boolean;
  sameChecks: boolean;
  differingChecks: string[];
}

export type RerunStatusKind = "queued" | "running" | "failed" | "succeeded";

export const RERUN_STATUS_LABEL: Record<RerunStatusKind, string> = {
  queued: "대기 중",
  running: "실행 중",
  failed: "재실행 실패",
  succeeded: "재실행 완료",
};

export interface ReplayRerunJobView {
  id: string;
  status: JobStatus;
  kind: RerunStatusKind;
  label: string;
  attempts: number;
  maxAttempts: number;
  /** 실패 사유 (job `lastError`). 재시도 대기 중이면 직전 시도의 사유 */
  lastError: string | null;
  /** `lastError`가 워커의 거부(`NonRetryableJobError`, `CODE: 사유`)면 그 코드 */
  rejectionCode: string | null;
  createdAt: string;
  updatedAt: string;
  /** 진행 중(QUEUED·RUNNING)이면 화면이 폴링한다 */
  active: boolean;
}

/** 중앙 패널 `재실행` 버튼의 상태 (선택한 기록이 하네스 케이스일 때) */
export interface ReplayRerunControlView {
  evaluationId: string;
  caseId: string;
  /** 케이스의 원본 기록 (RERUN이 아닌 기록). 실패 시 "원본 기록 열기" 링크 */
  originalRunId: string | null;
  originalHref: string | null;
  limit: number;
  used: number;
  remaining: number;
  /** 버튼 활성 여부. 상한 초과·상태 조회 실패·활성 job이면 false */
  enabled: boolean;
  disabledReason: string | null;
  /** 이 케이스의 가장 최근 job */
  latestJob: ReplayRerunJobView | null;
  /** 폴링 URL (`GET /api/evaluations/[id]/reruns`) */
  statusUrl: string;
}

export interface ReplayBodyView {
  runId: string;
  /** 하네스 케이스 기록이면 `harness-case`, 그 밖(기동·제출 테스트 등)은 `generic` */
  kind: "harness-case" | "generic";
  caseId: string | null;
  /** 하네스 케이스 기록의 verdict·사유 (기록 값 그대로) */
  verdict: string | null;
  reason: string | null;
  checks: ReplayCheckView[];
  /** `checks` 중 `ok === false`인 이름 (기록 순) */
  failedCheckNames: string[];
  /** 일반 기록: expected·actual JSON 원문 */
  expectedDisplay: string;
  actualDisplay: string;
  timeline: ReplayTimelineGroupView[] | null;
  /** 재생 순서: 표의 줄(묶음)마다 첫 항목의 seq */
  replaySeqs: number[];
  logs: RunRecordReport["logs"];
  recordedAt: string | null;
  /** RERUN 기록이면 원본 비교. 원본·다른 기록이면 null */
  rerun: ReplayRerunComparisonView | null;
}

export interface ReplayView {
  /** 선택한 기준의 근거가 가리키는 기록 (근거 순, 원본 먼저) */
  runs: ReplayRunView[];
  selectedRun: ReplayRunView | null;
  /** `?run=`이 이 기준의 근거가 아닌 다른 기록이면 true (기록은 보여 주되 안내한다) */
  selectedRunOutsideCriterion: boolean;
  body: ReplayBodyView | null;
  /** 본문을 읽지 못한 이유 (아티팩트 유실 등). 본문이 있으면 null */
  bodyError: { code: ApiErrorCode; message: string } | null;
  /** 본문 형태가 재생용 스키마와 맞지 않을 때 원문 JSON. 본문이 맞으면 null */
  bodyShapeIssue: string | null;
  pane: CenterPane;
  hrefForPane: (pane: CenterPane) => string;
  hrefForRun: (runId: string) => string;
  /** `재실행` 버튼 상태 (T-307). 선택 기록이 하네스 케이스가 아니면 null */
  rerunControl: ReplayRerunControlView | null;
}

/** 페이지가 `readRerunStatus`로 읽어 넘기는 재실행 상태. 읽지 못했으면 `ok: false` */
export type RerunStatusInput =
  { ok: true; data: RerunStatusReport } | { ok: false; code: string; message: string };

export type RunRecordInput =
  { ok: true; data: RunRecordReport } | { ok: false; code: ApiErrorCode; message: string };

/** 값을 한 줄로 표시한다. 객체는 `key: value · key: value`, 그 밖은 JSON 그대로 */
export function formatInlineValue(value: JsonValue | undefined, maxLength = 160): string {
  if (value === undefined) return "";
  let text: string;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    text = Object.entries(value)
      .map(([key, v]) => `${key}: ${JSON.stringify(v)}`)
      .join(" · ");
    if (text === "") text = "{}";
  } else {
    text = JSON.stringify(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** 요청·응답 본문 표시용 JSON. 문자열 본문은 그대로, null은 `(없음)` */
export function formatBody(value: JsonValue): string {
  if (value === null) return "(없음)";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function recordedAtOf(record: ExecutionRecord): string | null {
  return record.startedAt ?? record.finishedAt ?? null;
}

function runView(
  record: ExecutionRecord,
  testId: string | null,
  selected: boolean,
  href: string,
): ReplayRunView {
  const isRerun = record.kind === "RERUN";
  return {
    id: record.id,
    shortId: record.id.slice(0, SHORT_RUN_ID_LENGTH),
    kind: record.kind ?? null,
    kindLabel: record.kind ? RECORD_KIND_LABEL[record.kind] : "기록",
    isRerun,
    originLabel: isRerun ? "재실행" : "원본",
    testId,
    failureKind: record.failureKind,
    failureKindLabel: FAILURE_KIND_LABEL[record.failureKind],
    recordedAt: recordedAtOf(record),
    durationMs: record.durationMs ?? null,
    selected,
    href,
  };
}

/** 재생 뷰가 리포트에서 읽는 부분 (`EvaluationReport`의 세 배열) */
export type RunRecordSource = {
  criterionResults: Array<{ criterionId: string; evidenceIds: string[] }>;
  evidences: Evidence[];
  executionRecords: ExecutionRecord[];
};

/**
 * 선택한 기준의 근거 → 실행 기록 (근거 순, 중복 제거). 원본을 앞에, 재실행을 뒤에 둔다.
 * 기준에 결과가 없거나 근거가 없으면 빈 배열이다.
 */
export function runsForCriterion(
  report: RunRecordSource,
  criterionId: string | null,
): Array<{ record: ExecutionRecord; testId: string | null }> {
  if (!criterionId) return [];
  const result = report.criterionResults.find((r) => r.criterionId === criterionId);
  if (!result) return [];
  const evidenceById = new Map(report.evidences.map((e) => [e.id, e]));
  const recordById = new Map(report.executionRecords.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const runs: Array<{ record: ExecutionRecord; testId: string | null }> = [];
  for (const evidenceId of result.evidenceIds) {
    const evidence: Evidence | undefined = evidenceById.get(evidenceId);
    if (!evidence?.runId || seen.has(evidence.runId)) continue;
    const record = recordById.get(evidence.runId);
    if (!record) continue;
    seen.add(record.id);
    runs.push({ record, testId: evidence.testId ?? null });
  }
  return [
    ...runs.filter((r) => r.record.kind !== "RERUN"),
    ...runs.filter((r) => r.record.kind === "RERUN"),
  ];
}

/**
 * 화면이 본문을 읽을 기록 ID. `?run=`이 이 평가의 기록이면 그것, 아니면 선택한 기준의 첫 기록(원본).
 * 페이지는 이 ID로 `readRunRecord`를 부른 뒤 `buildReplayView`에 넘긴다
 */
export function selectReplayRunId(
  report: RunRecordSource,
  urlState: WorkbenchUrlState,
): string | null {
  if (urlState.runId && report.executionRecords.some((r) => r.id === urlState.runId)) {
    return urlState.runId;
  }
  const runs = runsForCriterion(report, urlState.criterionId);
  return runs[0]?.record.id ?? null;
}

function timelineRow(entry: ReplayTimelineEntry): ReplayTimelineRowView {
  return {
    seq: entry.seq,
    stepIndex: entry.stepIndex,
    kind: entry.kind,
    kindLabel: ENTRY_KIND_LABEL[entry.kind],
    capture: entry.capture ?? null,
    method: entry.request.method,
    path: entry.request.path,
    status: entry.response ? entry.response.status : null,
    error: entry.error ? { kind: entry.error.kind, message: entry.error.message } : null,
    elapsedMs: entry.elapsedMs,
    stateAfter: entry.stateAfter,
    stateAfterDisplay: entry.stateAfter === undefined ? null : formatInlineValue(entry.stateAfter),
    requestHeaders: entry.request.headers,
    requestBody: entry.request.body,
    requestBodyDisplay: formatBody(entry.request.body),
    responseHeaders: entry.response ? entry.response.headers : null,
    responseBody: entry.response ? entry.response.body : null,
    responseBodyDisplay: entry.response ? formatBody(entry.response.body) : null,
  };
}

/** 타임라인 항목을 표 줄로 묶는다. 같은 `stepIndex`의 `parallel` 항목은 한 묶음이다 (seq 순 유지) */
export function groupTimeline(entries: ReplayTimelineEntry[]): ReplayTimelineGroupView[] {
  const groups: ReplayTimelineGroupView[] = [];
  const parallelByStep = new Map<number, ReplayTimelineGroupView>();
  // 하네스가 seq 순으로 기록하므로 순서를 바꾸지 않는다
  for (const entry of entries) {
    const row = timelineRow(entry);
    if (entry.kind === "parallel") {
      const existing = parallelByStep.get(entry.stepIndex);
      if (existing) {
        existing.rows.push(row);
        continue;
      }
      const group: ReplayTimelineGroupView = {
        key: `parallel-${entry.stepIndex}`,
        parallel: true,
        label: "",
        rows: [row],
      };
      parallelByStep.set(entry.stepIndex, group);
      groups.push(group);
      continue;
    }
    groups.push({ key: `seq-${entry.seq}`, parallel: false, label: null, rows: [row] });
  }
  for (const group of groups) {
    if (!group.parallel) continue;
    const capture = group.rows[0]?.capture?.replace(/\[\d+\]$/, "");
    group.label = `동시 요청 ${group.rows.length}건${capture ? ` · ${capture}` : ""}`;
  }
  return groups;
}

function checkView(name: string, ok: boolean | null, expected: JsonValue, actual: JsonValue) {
  return {
    name,
    ok,
    expected,
    actual,
    expectedDisplay: formatInlineValue(expected),
    actualDisplay: formatInlineValue(actual),
  } satisfies ReplayCheckView;
}

/** 일반 기록의 expected·actual을 1단계 키로 나란히 놓는다. 통과/실패 표시는 없다(기록에 판정이 없다) */
function genericChecks(expected: JsonValue, actual: JsonValue): ReplayCheckView[] {
  const isObject = (v: JsonValue): v is { [key: string]: JsonValue } =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(expected) || !isObject(actual)) {
    return [checkView("값", null, expected, actual)];
  }
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  return keys.map((key) => checkView(key, null, expected[key] ?? null, actual[key] ?? null));
}

/** 기록 본문을 표시 모델로 옮긴다. 하네스 케이스 형태가 아니면 일반 기록으로 다룬다 */
export function buildReplayBody(
  run: RunRecordReport,
  hrefForRun: (runId: string) => string = (runId) => runId,
): {
  body: ReplayBodyView;
  shapeIssue: string | null;
} {
  const rerun = rerunComparisonOf(run, hrefForRun);
  const expectedParsed = HarnessCaseExpectedSchema.safeParse(run.expected);
  const actualParsed = HarnessCaseActualSchema.safeParse(run.actual);
  const timelineParsed =
    run.timeline === null ? null : ReplayTimelineSchema.safeParse(run.timeline);
  const recordedAt = recordedAtOf(run.record);
  const asJson = (v: JsonValue) => JSON.stringify(v, null, 2);
  const shapeIssue =
    timelineParsed && !timelineParsed.success
      ? `타임라인 형태가 재생용 스키마와 다릅니다: ${timelineParsed.error.issues[0]?.message ?? "unknown"}`
      : null;
  const timeline = timelineParsed?.success ? groupTimeline(timelineParsed.data) : null;
  // 재생은 표의 줄 단위로 진행한다. 동시 요청 묶음은 첫 항목의 seq로 한 번에 강조한다
  const replaySeqs = timeline ? timeline.map((g) => g.rows[0]!.seq) : [];

  if (expectedParsed.success && actualParsed.success) {
    const expectedByName = new Map(expectedParsed.data.checks.map((c) => [c.name, c.expected]));
    const checks = actualParsed.data.checks.map((c) =>
      checkView(c.name, c.ok, expectedByName.get(c.name) ?? c.expected, c.actual),
    );
    return {
      body: {
        runId: run.runId,
        kind: "harness-case",
        caseId: actualParsed.data.caseId,
        verdict: actualParsed.data.verdict,
        reason: actualParsed.data.reason,
        checks,
        failedCheckNames: checks.filter((c) => c.ok === false).map((c) => c.name),
        expectedDisplay: asJson(run.expected),
        actualDisplay: asJson(run.actual),
        timeline,
        replaySeqs,
        logs: run.logs,
        recordedAt,
        rerun,
      },
      shapeIssue,
    };
  }
  return {
    body: {
      runId: run.runId,
      kind: "generic",
      caseId: null,
      verdict: null,
      reason: null,
      checks: genericChecks(run.expected, run.actual),
      failedCheckNames: [],
      expectedDisplay: asJson(run.expected),
      actualDisplay: asJson(run.actual),
      timeline,
      replaySeqs,
      logs: run.logs,
      recordedAt,
      rerun,
    },
    shapeIssue,
  };
}

/** RERUN 기록의 `actual.rerun`(워커가 기록한 원본 비교)을 옮긴다. 형태가 맞지 않거나 RERUN이 아니면 null */
function rerunComparisonOf(
  run: RunRecordReport,
  hrefForRun: (runId: string) => string,
): ReplayRerunComparisonView | null {
  if (run.record.kind !== "RERUN") return null;
  const parsed = RerunActualSchema.safeParse(run.actual);
  if (!parsed.success) return null;
  const c = parsed.data.rerun;
  return {
    originalRunId: c.originalRunId,
    originalHref: hrefForRun(c.originalRunId),
    outcome: c.outcome,
    outcomeLabel: c.outcome === "same" ? "원본과 동일" : "원본과 상이",
    sameVerdict: c.sameVerdict,
    sameActual: c.sameActual,
    sameChecks: c.sameChecks,
    differingChecks: [...c.differingChecks],
  };
}

function rerunStatusKindOf(status: JobStatus): RerunStatusKind {
  switch (status) {
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "running";
    case "SUCCEEDED":
      return "succeeded";
    case "FAILED":
    case "CANCELLED":
      return "failed";
  }
}

/** 워커의 거부 사유는 `CODE: 사유` 꼴이다 (`NonRetryableJobError: ENVIRONMENT_DIGEST_MISMATCH: …`) */
const REJECTION_CODE = /(?:^|:\s*)([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):\s/;

export function rerunJobView(job: RerunJobSummary): ReplayRerunJobView {
  const kind = rerunStatusKindOf(job.status);
  const rejection = job.lastError ? REJECTION_CODE.exec(job.lastError) : null;
  return {
    id: job.id,
    status: job.status,
    kind,
    label: RERUN_STATUS_LABEL[kind],
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    rejectionCode: rejection?.[1] ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    active: kind === "queued" || kind === "running",
  };
}

/**
 * `재실행` 버튼 상태. 케이스는 선택 기록의 근거 `testId`이며, 원본은 그 케이스의 RERUN이 아닌 기록이다.
 * 활성 job이 있거나 상한을 다 썼거나 상태를 읽지 못했으면 버튼을 비활성화하고 사유를 둔다
 */
export function buildRerunControl(
  report: RunRecordSource & { evaluation: { id: string } },
  selected: { record: ExecutionRecord; testId: string | null } | null,
  status: RerunStatusInput | null,
  hrefForRun: (runId: string) => string,
): ReplayRerunControlView | null {
  if (!selected?.testId) return null;
  const caseId = selected.testId;
  const originalRunId =
    selected.record.kind !== "RERUN"
      ? selected.record.id
      : (runsForCase(report, caseId).find((r) => r.kind !== "RERUN")?.id ?? null);
  const statusUrl = `/api/evaluations/${report.evaluation.id}/reruns`;
  const base = {
    evaluationId: report.evaluation.id,
    caseId,
    originalRunId,
    originalHref: originalRunId ? hrefForRun(originalRunId) : null,
    statusUrl,
  };
  if (!status || !status.ok) {
    return {
      ...base,
      limit: 0,
      used: 0,
      remaining: 0,
      enabled: false,
      disabledReason: status
        ? `재실행 상태를 읽지 못했습니다: ${status.message}`
        : "재실행 상태를 읽지 않았습니다",
      latestJob: null,
    };
  }
  const jobsForCase = status.data.jobs.filter((j) => j.caseId === caseId).map(rerunJobView);
  const latestJob = jobsForCase.at(-1) ?? null;
  let disabledReason: string | null = null;
  if (latestJob?.active) {
    disabledReason = `이 케이스의 재실행이 ${latestJob.label}입니다`;
  } else if (!status.data.canRequest) {
    disabledReason = status.data.blockedReason;
  }
  return {
    ...base,
    limit: status.data.limit,
    used: status.data.used,
    remaining: status.data.remaining,
    enabled: disabledReason === null,
    disabledReason,
    latestJob,
  };
}

/** 케이스(`testId`)를 참조하는 근거의 기록 (근거 순, 중복 제거) */
function runsForCase(report: RunRecordSource, caseId: string): ExecutionRecord[] {
  const recordById = new Map(report.executionRecords.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const runs: ExecutionRecord[] = [];
  for (const evidence of report.evidences) {
    if (evidence.testId !== caseId || !evidence.runId || seen.has(evidence.runId)) continue;
    const record = recordById.get(evidence.runId);
    if (!record) continue;
    seen.add(record.id);
    runs.push(record);
  }
  return runs;
}

export function buildReplayView(
  report: RunRecordSource & { evaluation: { id: string } },
  urlState: WorkbenchUrlState,
  href: (patch: Partial<WorkbenchUrlState>) => string,
  runRecord: RunRecordInput | null,
  rerunStatus: RerunStatusInput | null = null,
): ReplayView {
  const selectedId = runRecord?.ok ? runRecord.data.runId : selectReplayRunId(report, urlState);
  const criterionRuns = runsForCriterion(report, urlState.criterionId);
  const runs = criterionRuns.map(({ record, testId }) =>
    runView(record, testId, record.id === selectedId, href({ runId: record.id })),
  );
  let selectedRun = runs.find((r) => r.selected) ?? null;
  let outside = false;
  if (!selectedRun && selectedId) {
    const record = report.executionRecords.find((r) => r.id === selectedId);
    if (record) {
      const evidence = report.evidences.find((e) => e.runId === record.id);
      selectedRun = runView(record, evidence?.testId ?? null, true, href({ runId: record.id }));
      outside = true;
    }
  }
  const hrefForRun = (runId: string) => href({ runId });
  let body: ReplayBodyView | null = null;
  let bodyError: ReplayView["bodyError"] = null;
  let bodyShapeIssue: string | null = null;
  if (runRecord) {
    if (runRecord.ok) {
      const built = buildReplayBody(runRecord.data, hrefForRun);
      body = built.body;
      bodyShapeIssue = built.shapeIssue;
    } else {
      bodyError = { code: runRecord.code, message: runRecord.message };
    }
  }
  return {
    runs,
    selectedRun,
    selectedRunOutsideCriterion: outside,
    body,
    bodyError,
    bodyShapeIssue,
    pane: urlState.pane,
    hrefForPane: (pane) => href({ pane }),
    hrefForRun,
    rerunControl: buildRerunControl(
      report,
      selectedRun
        ? {
            record: report.executionRecords.find((r) => r.id === selectedRun.id)!,
            testId: selectedRun.testId,
          }
        : null,
      rerunStatus,
      hrefForRun,
    ),
  };
}
