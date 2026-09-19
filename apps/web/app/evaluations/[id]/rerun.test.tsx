import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ExecutionRecord, JsonValue, RerunJobSummary, RerunStatusReport } from "@ohmyti/core";
import {
  buildRerunControl,
  rerunJobView,
  type RerunStatusInput,
  type RunRecordInput,
} from "@/lib/workbench/replay";
import { parseWorkbenchSearchParams, workbenchHref } from "@/lib/workbench/state";
import { buildWorkbenchView } from "@/lib/workbench/view";
import {
  DEFECTIVE_SAMPLE_VERDICTS,
  FIXTURE_EVALUATION_ID,
  FIXTURE_RUN_ID,
  reportFixture,
} from "@/lib/workbench/fixtures";
import { R05_ACTUAL, R05_CASE_ID, r05RunRecordFixture } from "@/lib/workbench/replay-fixtures";
import { WorkbenchShell } from "./workbench-shell";

/**
 * 재실행 UI (T-307). 정적 HTML로 `재실행` 버튼·상태·원본 비교가 `GET /api/evaluations/[id]/reruns` 상태와
 * RERUN 기록 본문(`actual.rerun`)에서 그대로 오는지 검사한다. 폴링·서버 액션은 호출하지 않는다.
 */

// 활성 job이 있으면 폴러가 `useRouter`를 쓴다. 정적 렌더링에는 앱 라우터 문맥이 없으므로 대체한다
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const RERUN_ID = "77777777-7777-4777-8777-777777777777";
const RERUN_EVIDENCE_ID = "99999999-9999-4999-8999-999999999999";
const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function job(overrides: Partial<RerunJobSummary> = {}): RerunJobSummary {
  return {
    id: JOB_ID,
    caseId: R05_CASE_ID,
    status: "QUEUED",
    attempts: 0,
    maxAttempts: 2,
    lastError: null,
    createdAt: "2026-09-18T11:00:00.000Z",
    updatedAt: "2026-09-18T11:00:00.000Z",
    ...overrides,
  };
}

function status(jobs: RerunJobSummary[], limit = 20): RerunStatusInput {
  const used = jobs.length;
  const remaining = Math.max(0, limit - used);
  const data: RerunStatusReport = {
    evaluationId: FIXTURE_EVALUATION_ID,
    limit,
    used,
    remaining,
    canRequest: remaining > 0,
    blockedReason:
      remaining > 0 ? null : `이 평가의 재실행 상한 ${limit}회를 모두 썼습니다 (${used}회)`,
    jobs,
  };
  return { ok: true, data };
}

/** 결함 샘플 리포트 + R-05 근거가 원본 하네스 기록을 가리키게. `withRerun`이면 RERUN 기록도 근거에 붙인다 */
function report(withRerun = false) {
  const r = reportFixture({ verdicts: DEFECTIVE_SAMPLE_VERDICTS, evidenceTestId: R05_CASE_ID });
  if (withRerun) {
    const original = r.executionRecords[0]!;
    const rerun: ExecutionRecord = {
      ...original,
      id: RERUN_ID,
      kind: "RERUN",
      startedAt: "2026-09-18T11:00:05.000Z",
    };
    r.executionRecords.push(rerun);
    r.evidences.push({
      id: RERUN_EVIDENCE_ID,
      evaluationId: FIXTURE_EVALUATION_ID,
      submissionSha: original.submissionSha,
      runId: RERUN_ID,
      testId: R05_CASE_ID,
      artifactRefs: [],
    });
    r.criterionResults.find((c) => c.criterionId === "R-05")!.evidenceIds.push(RERUN_EVIDENCE_ID);
  }
  return r;
}

function build(
  query: Record<string, string>,
  runRecord: RunRecordInput | null,
  rerunStatus: RerunStatusInput | null,
  withRerun = false,
) {
  const r = report(withRerun);
  const urlState = parseWorkbenchSearchParams(query);
  const view = buildWorkbenchView(
    r,
    urlState,
    (patch) => workbenchHref(r.evaluation.id, urlState, patch),
    runRecord,
    null,
    rerunStatus,
  );
  const html = renderToStaticMarkup(<WorkbenchShell view={view} />);
  const start = html.indexOf('data-testid="rerun-controls"');
  const end = html.indexOf('data-testid="timeline-rows"');
  return { view, html, controls: start >= 0 ? html.slice(start, end) : "" };
}

const ok = (data: ReturnType<typeof r05RunRecordFixture>): RunRecordInput => ({ ok: true, data });
const originalHref = `/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&amp;run=${FIXTURE_RUN_ID}`;

describe("재실행 버튼 상태 (buildRerunControl)", () => {
  it("job이 없고 상한이 남았으면 버튼이 활성이고 케이스·원본 기록·폴링 URL이 채워진다", () => {
    const { view, controls } = build({ criterion: "R-05" }, ok(r05RunRecordFixture()), status([]));
    const control = view.replay.rerunControl!;
    expect(control).toMatchObject({
      evaluationId: FIXTURE_EVALUATION_ID,
      caseId: R05_CASE_ID,
      originalRunId: FIXTURE_RUN_ID,
      enabled: true,
      disabledReason: null,
      latestJob: null,
      limit: 20,
      used: 0,
      remaining: 20,
      statusUrl: `/api/evaluations/${FIXTURE_EVALUATION_ID}/reruns`,
    });
    expect(controls).toMatch(
      /<button type="button" data-testid="rerun-button" data-rerun-enabled="true"/,
    );
    expect(controls).toContain(">재실행</button>");
    expect(controls).toContain("같은 조건으로 새 실행 기록을 만듭니다 · 0/20회 사용");
    expect(controls).not.toContain('data-testid="rerun-status"');
  });

  it("워커가 없어 QUEUED면 `대기 중`을 표시하고 버튼은 비활성이며 성공으로 보이지 않는다", () => {
    const { controls } = build({ criterion: "R-05" }, ok(r05RunRecordFixture()), status([job()]));
    expect(controls).toContain('data-rerun-status="queued"');
    expect(controls).toContain('data-testid="rerun-status-label">대기 중<');
    expect(controls).toContain("시도 0/2 · 워커가 처리하면 갱신됩니다");
    expect(controls).toMatch(/data-testid="rerun-button" data-rerun-enabled="false"/);
    expect(controls).not.toContain("재실행 완료");
    expect(controls).not.toContain("재실행 실패");
    // RUNNING도 진행 중이다 (재시도 대기 중이면 직전 사유를 같이 보인다)
    const running = build(
      { criterion: "R-05" },
      ok(r05RunRecordFixture()),
      status([
        job({ status: "RUNNING", attempts: 2, lastError: "PipelineEnvironmentError: 1차 실패" }),
      ]),
    ).controls;
    expect(running).toContain('data-testid="rerun-status-label">실행 중<');
    expect(running).toContain(
      'data-testid="rerun-retry-reason">직전 시도 실패: PipelineEnvironmentError: 1차 실패<',
    );
  });

  it("job이 FAILED(ENVIRONMENT)면 `재실행 실패`·사유·원본 기록 열기 링크를 보이고 새 요청은 가능하다", () => {
    const failed = job({
      status: "FAILED",
      attempts: 2,
      lastError: "RunnerEnvironmentError: 템플릿 node_modules를 열 수 없습니다",
    });
    const { view, controls } = build(
      { criterion: "R-05" },
      ok(r05RunRecordFixture()),
      status([failed]),
    );
    expect(controls).toContain('data-rerun-status="failed"');
    expect(controls).not.toContain('data-rerun-rejected="true"');
    expect(controls).toContain('data-testid="rerun-status-label">재실행 실패<');
    expect(controls).toContain(
      'data-testid="rerun-failure-reason">RunnerEnvironmentError: 템플릿 node_modules를 열 수 없습니다<',
    );
    expect(controls).toContain(`href="${originalHref}"`);
    expect(controls).toContain('data-testid="rerun-original-link">원본 기록 열기<');
    expect(controls).not.toContain("재실행 완료");
    expect(view.replay.rerunControl).toMatchObject({ enabled: true, used: 1, remaining: 19 });
    expect(controls).toMatch(/data-testid="rerun-button" data-rerun-enabled="true"/);
  });

  it("워커가 조건 불일치로 거부하면(환경 digest) `재실행 거부 (코드)`와 사유가 보인다", () => {
    const rejected = job({
      status: "FAILED",
      attempts: 1,
      lastError:
        "NonRetryableJobError: ENVIRONMENT_DIGEST_MISMATCH: 평가의 실행 환경 digest는 aaaa인데 현재 템플릿(order-api-ts, local)의 digest는 bbbb입니다. 템플릿이 바뀌어 같은 환경을 다시 만들 수 없습니다",
    });
    const { controls } = build(
      { criterion: "R-05" },
      ok(r05RunRecordFixture()),
      status([rejected]),
    );
    expect(controls).toContain('data-rerun-rejected="true"');
    expect(controls).toContain(
      'data-testid="rerun-status-label">재실행 거부 (ENVIRONMENT_DIGEST_MISMATCH)<',
    );
    expect(controls).toContain("템플릿이 바뀌어 같은 환경을 다시 만들 수 없습니다");
    expect(controls).toContain('data-testid="rerun-original-link">원본 기록 열기<');
    // 거부 코드 추출 규칙: `CODE_WITH_UNDERSCORE: ` 만 코드로 본다
    expect(rerunJobView(rejected).rejectionCode).toBe("ENVIRONMENT_DIGEST_MISMATCH");
    expect(
      rerunJobView(job({ status: "FAILED", lastError: "ENVIRONMENT: heartbeat가 끊겨 회수" }))
        .rejectionCode,
    ).toBeNull();
    expect(
      rerunJobView(job({ status: "FAILED", lastError: "RunnerEnvironmentError: x" })).rejectionCode,
    ).toBeNull();
  });

  it("상한(20)을 다 쓰면 버튼이 비활성이고 사유가 보인다", () => {
    const jobs = Array.from({ length: 20 }, (_, i) =>
      job({
        id: `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        caseId: i === 19 ? R05_CASE_ID : "R-01-normal-order",
        status: "SUCCEEDED",
        attempts: 1,
      }),
    );
    const { view, controls } = build(
      { criterion: "R-05" },
      ok(r05RunRecordFixture()),
      status(jobs),
    );
    expect(view.replay.rerunControl).toMatchObject({
      enabled: false,
      used: 20,
      remaining: 0,
      disabledReason: "이 평가의 재실행 상한 20회를 모두 썼습니다 (20회)",
    });
    expect(controls).toMatch(/data-testid="rerun-button" data-rerun-enabled="false"/);
    expect(controls).toContain(
      'data-testid="rerun-disabled-reason">이 평가의 재실행 상한 20회를 모두 썼습니다 (20회)<',
    );
    expect(controls).toContain('data-testid="rerun-status-label">재실행 완료<');
  });

  it("상태를 읽지 못했거나(오류) 하네스 케이스 기록이 아니면 버튼이 비활성이다", () => {
    const errored = build({ criterion: "R-05" }, ok(r05RunRecordFixture()), {
      ok: false,
      code: "INTERNAL",
      message: "connection refused",
    });
    expect(errored.view.replay.rerunControl).toMatchObject({
      enabled: false,
      disabledReason: "재실행 상태를 읽지 못했습니다: connection refused",
    });
    expect(errored.controls).toContain("재실행 상태를 읽지 못했습니다: connection refused");
    // 근거에 testId가 없는 기록(제출 테스트 등)은 재실행 대상이 아니다
    const r = report();
    const control = buildRerunControl(
      r,
      { record: r.executionRecords[0]!, testId: null },
      status([]),
      (id) => id,
    );
    expect(control).toBeNull();
  });

  it("케이스의 최근 job만 본다 (다른 케이스의 활성 job은 이 버튼을 막지 않는다)", () => {
    const other = job({ id: JOB_ID_2, caseId: "R-01-normal-order", status: "RUNNING" });
    const mine = job({ status: "SUCCEEDED", attempts: 1 });
    const { view } = build({ criterion: "R-05" }, ok(r05RunRecordFixture()), status([mine, other]));
    expect(view.replay.rerunControl).toMatchObject({
      enabled: true,
      latestJob: { id: JOB_ID, kind: "succeeded" },
      used: 2,
    });
  });
});

describe("RERUN 기록의 원본 비교", () => {
  function rerunRecord(comparison: Record<string, JsonValue>) {
    const base = r05RunRecordFixture();
    return ok({
      ...base,
      runId: RERUN_ID,
      record: { ...base.record, id: RERUN_ID, kind: "RERUN" },
      actual: { ...R05_ACTUAL, rerun: comparison },
    });
  }
  const same = {
    originalRunId: FIXTURE_RUN_ID,
    jobId: JOB_ID,
    sameVerdict: true,
    sameActual: true,
    sameChecks: true,
    differingChecks: [],
    outcome: "same",
  };

  it("워커가 기록한 `actual.rerun`이 same이면 `원본과 동일` 배지와 원본 링크를 보인다", () => {
    const { view, html } = build(
      { criterion: "R-05", run: RERUN_ID },
      rerunRecord(same),
      status([]),
      true,
    );
    expect(view.replay.body?.rerun).toEqual({
      originalRunId: FIXTURE_RUN_ID,
      originalHref: `/evaluations/${FIXTURE_EVALUATION_ID}?criterion=R-05&run=${FIXTURE_RUN_ID}`,
      outcome: "same",
      outcomeLabel: "원본과 동일",
      sameVerdict: true,
      sameActual: true,
      sameChecks: true,
      differingChecks: [],
    });
    expect(html).toContain('data-testid="rerun-comparison" data-outcome="same"');
    expect(html).toContain("원본과 동일");
    expect(html).toContain(`data-testid="rerun-comparison-original-link">원본 기록 열기<`);
    expect(html).toContain(
      `href="${originalHref}" class="font-semibold text-primary hover:underline" data-testid="rerun-comparison-original-link"`,
    );
    // 재실행 기록을 선택해도 재실행 버튼의 원본은 RERUN이 아닌 기록이다
    expect(view.replay.rerunControl).toMatchObject({
      caseId: R05_CASE_ID,
      originalRunId: FIXTURE_RUN_ID,
    });
    // 기록 목록: 원본 → 재실행, 선택은 재실행
    expect(html).toMatch(/data-run="[^"]+" data-run-selected="false"[^>]*data-origin="original"/);
    expect(html).toMatch(
      new RegExp(`data-run="${RERUN_ID}" data-run-selected="true"[^>]*data-origin="rerun"`),
    );
  });

  it("different면 `원본과 상이`와 달라진 검사 이름을 보인다. 원본·일반 기록에는 비교가 없다", () => {
    const different = {
      ...same,
      sameVerdict: false,
      sameActual: false,
      sameChecks: false,
      differingChecks: ["p1After.stock", "second.body.id == first.body.id"],
      outcome: "different",
    };
    const { view, html } = build(
      { criterion: "R-05", run: RERUN_ID },
      rerunRecord(different),
      status([]),
      true,
    );
    expect(view.replay.body?.rerun?.outcomeLabel).toBe("원본과 상이");
    expect(html).toContain('data-testid="rerun-comparison" data-outcome="different"');
    expect(html).toContain(
      "달라진 검사: p1After.stock, second.body.id == first.body.id · verdict 다름",
    );

    const original = build({ criterion: "R-05" }, ok(r05RunRecordFixture()), status([]), true);
    expect(original.view.replay.body?.rerun).toBeNull();
    expect(original.html).not.toContain('data-testid="rerun-comparison"');
    // RERUN인데 `rerun` 필드가 없거나 형태가 다르면 비교 없이 보여 준다 (오류 없음)
    const malformed = build(
      { criterion: "R-05", run: RERUN_ID },
      rerunRecord({ outcome: "same" }),
      status([]),
      true,
    );
    expect(malformed.view.replay.body?.rerun).toBeNull();
  });
});

describe("재실행 코드는 값을 계산하지 않는다", () => {
  it("표시 모델·컨트롤은 원본 비교를 다시 하지 않고 점수를 계산하지 않는다", async () => {
    const dir = import.meta.dirname;
    for (const file of [
      path.join(dir, "../../../lib/workbench/replay.ts"),
      path.join(dir, "rerun-controls.tsx"),
    ]) {
      const code = (await readFile(file, "utf8"))
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/aggregateScore|formatScoreDisplay|canonicalJson|deepEqual/);
      expect(code, file).not.toMatch(/expected\s*[!=]==?\s*actual|actual\s*[!=]==?\s*expected/);
    }
    // 재생 코드는 여전히 네트워크를 쓰지 않는다 (폴링은 rerun-controls.tsx에만 있다)
    const timeline = await readFile(path.join(dir, "replay-timeline.tsx"), "utf8");
    expect(timeline).not.toMatch(/\bfetch\(/);
  });
});
