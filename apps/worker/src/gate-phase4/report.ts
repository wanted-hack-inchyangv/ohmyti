/**
 * 4단계 게이트 기록 (TICKET.md T-408). `docs/gates/phase4.md`의 표식 사이 절만 다시 쓰고, 나머지(T-406·T-407 기록과
 * 사람 검토 절)는 그대로 둔다.
 */
import type { ActualCriterionOutcome, MutationOutcome } from "@ohmyti/core";
import type { ApprovalFlowObservation, GateCheck, GateLlmSample, GateSampleId } from "./checks";

export const GATE_SECTION_START = "<!-- gate:phase4:start -->";
export const GATE_SECTION_END = "<!-- gate:phase4:end -->";

export interface GateRecord {
  kind: "phase4_gate";
  pass: boolean;
  startedAt: string;
  durationMs: number;
  environment: { node: string; platform: string; runner: string; database: string };
  llm: { mode: "real" | "fake"; provider: string; requestedModel: string };
  rubricVersion: string;
  harnessVersion: string;
  /** 기대 결과표 서명 (T-101 사람 확인). null이면 아직 서명 전 */
  matrixReviewedBy: string | null;
  checks: GateCheck[];
  samples: Array<{
    id: GateSampleId;
    name: string;
    /** 채점기 사전 검증(v1)의 샘플 상태 */
    validationStatus: string | null;
    scoreDisplay: string | null;
    expectedScoreDisplay: string;
    criteria: Record<string, ActualCriterionOutcome>;
    mutations: Record<string, MutationOutcome>;
    submittedTests: { status: string; total: number; files: number } | null;
    llm: GateLlmSample;
  }>;
  approvalFlow: ApprovalFlowObservation;
}

const cell = (value: string | number | null | undefined): string =>
  String(value ?? "-")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");

const points = (row: ActualCriterionOutcome | undefined): string =>
  row ? `${row.verdict} ${row.earnedPoints ?? "null"}` : "-";

export function renderGateMarkdown(record: GateRecord): string {
  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);
  const llmLabel =
    record.llm.mode === "real"
      ? `실제 LLM (${record.llm.provider}, 요청 모델 \`${record.llm.requestedModel}\`)`
      : `Fake LLM (\`DEEP_SEEK_API_KEY\` 없음 또는 \`--fake\`). 실제 LLM 결과가 아니다`;

  push(
    GATE_SECTION_START,
    "",
    "# 4단계 게이트 (T-408)",
    "",
    "`pnpm gate:phase4`가 자동으로 쓰는 절이다. 다시 실행하면 이 절(표식 사이)과 `phase4-gate.json`을 덮어쓴다.",
    "",
    `- 결과: **${record.pass ? "통과" : "실패"}** · 실행 ${record.startedAt} · 소요 ${(record.durationMs / 1000).toFixed(1)}초`,
    `- 환경: 로컬 스택 (${record.environment.database}, 러너 ${record.environment.runner}, fs 아티팩트 스토어) · Node ${record.environment.node} · ${record.environment.platform}`,
    `- LLM: ${llmLabel}`,
    `- rubric \`${record.rubricVersion}\` · 하네스 \`${record.harnessVersion}\``,
    `- 기대 결과표 서명: ${record.matrixReviewedBy ?? "없음 (T-101 사람 확인 대기). 승인 흐름 확인은 임시 DB 안에서 픽스처 서명으로 한다"}`,
    "- 원본: [`phase4-gate.json`](./phase4-gate.json)",
    ...(record.environment.platform.startsWith("darwin")
      ? [
          "- macOS 주의: 샘플의 제출 테스트(supertest)가 `::`의 임시 포트에 앱을 띄울 때, 다른 프로세스가 같은 포트를 `127.0.0.1`로 쓰고 있으면 요청이 그 프로세스로 가서 테스트가 가끔 실패한다(T-405 완료 기록). 이때 제출 테스트 FAILED나 변형 KILLED 불일치로 드러나며, Linux(Railway·CI)에서는 생기지 않는다",
        ]
      : []),
    "",
    "## 대조 결과",
    "",
    "| 항목 | 결과 | 내용 |",
    "| --- | --- | --- |",
    ...record.checks.map(
      (c) => `| ${cell(c.title)} | ${c.pass ? "통과" : "실패"} | ${cell(c.detail)} |`,
    ),
    "",
  );
  const problems = record.checks.flatMap((c) => c.problems.map((p) => `- ${c.id}: ${p}`));
  if (problems.length > 0) push("실패 원인:", "", ...problems, "");

  const mutationIds = [...new Set(record.samples.flatMap((s) => Object.keys(s.mutations)))].sort();
  push(
    "## 샘플별 결과 (승인된 v1에 실제 제출로 채점)",
    "",
    `| 샘플 | 점수 표시 | 기대 점수 표시 | 채점기 검증 | G1 | G2 | G3 | ${mutationIds.join(" | ")} | 제출 테스트 |`,
    `| --- | --- | --- | --- | --- | --- | --- | ${mutationIds.map(() => "---").join(" | ")} | --- |`,
    ...record.samples.map(
      (s) =>
        `| ${s.id} ${cell(s.name)} | ${cell(s.scoreDisplay)} | ${cell(s.expectedScoreDisplay)} | ${cell(s.validationStatus)} | ${points(s.criteria.G1)} | ${points(s.criteria.G2)} | ${points(s.criteria.G3)} | ${mutationIds.map((m) => cell(s.mutations[m])).join(" | ")} | ${s.submittedTests ? `${s.submittedTests.status} ${s.submittedTests.total}건·${s.submittedTests.files}파일` : "-"} |`,
    ),
    "",
  );

  const criterionIds = Object.keys(record.samples[0]?.criteria ?? {});
  push(
    "## 기준별 판정 (verdict earned_points)",
    "",
    `| 기준 | ${record.samples.map((s) => s.id).join(" | ")} | C = D |`,
    `| --- | ${record.samples.map(() => "---").join(" | ")} | --- |`,
    ...criterionIds.map((id) => {
      const c = record.samples.find((s) => s.id === "C")?.criteria[id];
      const d = record.samples.find((s) => s.id === "D")?.criteria[id];
      const same = c && d && c.earnedPoints === d.earnedPoints ? "같음" : "다름";
      return `| ${id} | ${record.samples.map((s) => points(s.criteria[id])).join(" | ")} | ${same} |`;
    }),
    "",
  );

  push(
    "## LLM 단계 (mutation 위치 제안 · 근거 리뷰)",
    "",
    "LLM 출력은 점수와 PASS/FAIL에 쓰이지 않는다(G-01). `판정 불변`은 REVIEW_WRITE 직전과 끝난 뒤의 판정 행(verdict·earned_points·observation)을 비교한 결과다.",
    "",
    "| 샘플 | 호출 (종류 · 모델) | 비용 USD | REVIEW_WRITE | 추정 원인 | 설계 제안 | 개선 제안 | 버린 참조 | 판정 불변 |",
    "| --- | --- | ---: | --- | --- | --- | --- | ---: | --- |",
    ...record.samples.map(({ id, llm }) => {
      const calls = llm.calls.map((c) => `${c.kind} · ${c.model}`).join(", ") || "없음";
      const cost = llm.calls.reduce((sum, c) => sum + c.costUsd, 0).toFixed(6);
      const review = `${llm.reviewWriteState ?? "-"}${llm.reviewWriteLlm ? ` · ${llm.reviewWriteLlm}` : ""}${llm.reviewWriteError ? ` (${llm.reviewWriteError})` : ""}${llm.reviewWriteReason ? ` (${llm.reviewWriteReason})` : ""}`;
      const causes =
        llm.interpretations.map((i) => `${i.criterionId} ${i.confidence}`).join(", ") || "없음";
      const design =
        llm.designSuggestions
          .map((d) => `${d.criterionId} 제안 ${d.suggestedPoints}/${d.maxPoints}`)
          .join(", ") || "없음";
      return `| ${id} | ${cell(calls)} | ${cost} | ${cell(review)} | ${cell(causes)} | ${cell(design)} | ${llm.suggestions.length}건 | ${llm.dropped} | ${llm.criteriaUnchanged === null ? "확인 못 함" : llm.criteriaUnchanged ? "예" : "아니오"} |`;
    }),
    "",
  );
  const repro = record.samples.flatMap(({ id, llm }) =>
    llm.interpretations.map(
      (i) =>
        `| ${id} | ${i.criterionId} | ${i.confidence} | ${i.evidenceCount} | ${cell(i.minimalRepro)} |`,
    ),
  );
  if (repro.length > 0) {
    push(
      "추정 원인의 최소 재현 설명 (LLM 출력, 사람 검토 전):",
      "",
      "| 샘플 | 기준 | 확신 | 근거 수 | 최소 재현 설명 |",
      "| --- | --- | --- | ---: | --- |",
      ...repro,
      "",
    );
  }
  const suggestions = record.samples.flatMap(({ id, llm }) =>
    llm.suggestions.map((title) => `- ${id}: ${title}`),
  );
  if (suggestions.length > 0) {
    push("명세 외 개선 제안 (점수와 무관):", "", ...suggestions, "");
  }

  const f = record.approvalFlow;
  push(
    "## rubric 검증·승인 흐름",
    "",
    `1. v1 채점기 검증(\`VALIDATE_RUBRIC\` job, 검증 샘플 4개): ${f.v1Pass ? "pass" : "fail"} → 상태 ${f.v1StatusAfterValidation}`,
    ...f.v1Mismatches.map((m) => `   - ${m}`),
    `2. 샘플 서명 없이 승인 확인: 차단 [${f.unsignedBlockers.join(", ")}]`,
    `3. 임시 DB에서 샘플 4개에 픽스처 서명 → 승인자 이름 공백: 차단 [${f.blankApproverBlockers.join(", ")}]`,
    `4. 승인자 이름 입력: ${f.approvedStatus ?? "-"}`,
    `5. v2(R-11에 \`DEPENDENCY_DECLARED express\` 정적 검사 추가, LLM 없이 검증): ${f.v2Pass === null ? "-" : f.v2Pass ? "pass" : "불일치"} → 상태 ${f.v2Status ?? "-"}`,
    ...f.v2Mismatches.map(
      (m) =>
        `   - ${m.sample} ${m.ref} ${m.field ?? ""}: 기대 ${JSON.stringify(m.expected)}, 실제 ${JSON.stringify(m.actual)}`,
    ),
    `6. v2 승인 시도: 차단 [${f.v2Blockers.join(", ")}] · v1 상태 ${f.v1StatusAfterV2 ?? "-"}`,
    "",
    GATE_SECTION_END,
  );
  return `${lines.join("\n")}\n`;
}

/** 표식 사이 절을 바꾼다. 표식이 없으면 문서 끝에 구분선과 함께 붙인다 */
export function replaceGateSection(existing: string, section: string): string {
  const start = existing.indexOf(GATE_SECTION_START);
  const end = existing.indexOf(GATE_SECTION_END);
  if (start >= 0 && end > start) {
    return (
      existing.slice(0, start) + section.trimEnd() + existing.slice(end + GATE_SECTION_END.length)
    );
  }
  const body = existing.trimEnd();
  return body.length === 0 ? section : `${body}\n\n---\n\n${section}`;
}
