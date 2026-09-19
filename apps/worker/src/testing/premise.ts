/**
 * 통합 테스트의 전제 단언 (T-607). `beforeAll`에서 실제 파이프라인으로 준비한 결과가 전제와 다르면
 * 뒤쪽 단언이 원인 없이 실패하는 대신, 여기서 관측·사유를 담아 즉시 실패시킨다.
 * 부하로 하네스 요청이 제한 시간을 넘겨 INCONCLUSIVE가 되는 경우처럼 환경 원인을 메시지에서 바로 읽기 위한 것이다.
 */
import type { EvaluationStageRecord, Verdict } from "@ohmyti/core";
import type { EvaluationResults } from "@ohmyti/db";

/** 판정 하나의 관측과 근거 실행 기록 요약 */
export function explainCriterion(results: EvaluationResults, criterionId: string): string {
  const result = results.criterionResults.find((c) => c.criterionId === criterionId);
  if (!result) return `${criterionId}: 판정 없음`;
  const lines = [
    `${criterionId}: verdict ${result.verdict}, earnedPoints ${result.earnedPoints ?? "null"}/${result.maxPoints}`,
    `  관측: ${result.observation}`,
  ];
  if (result.interpretation) lines.push(`  해석: ${result.interpretation}`);
  // 정적 관계 근거도 같은 실행 기록을 가리키므로 실행 기록 단위로 한 번만 적는다
  const seenRuns = new Set<string>();
  for (const evidenceId of result.evidenceIds) {
    const evidence = results.evidences.find((e) => e.id === evidenceId);
    if (!evidence?.runId || seenRuns.has(evidence.runId)) continue;
    seenRuns.add(evidence.runId);
    const record = results.executionRecords.find((r) => r.id === evidence.runId);
    if (!record) continue;
    lines.push(
      `  근거 ${evidence.testId ?? "-"}: ${record.kind} failureKind ${record.failureKind}, exit ${record.exitCode ?? "null"}, ${record.durationMs ?? "?"}ms`,
    );
  }
  return lines.join("\n");
}

/** 기준별 판정이 기대와 다르면 해당 기준의 관측·근거를 담아 던진다 */
export function assertPremiseVerdicts(
  results: EvaluationResults,
  expected: Readonly<Record<string, Verdict>>,
  context: string,
): void {
  const mismatched = Object.entries(expected).filter(
    ([criterionId, verdict]) =>
      results.criterionResults.find((c) => c.criterionId === criterionId)?.verdict !== verdict,
  );
  if (mismatched.length === 0) return;
  const detail = mismatched
    .map(([criterionId, verdict]) => `기대 ${verdict}\n${explainCriterion(results, criterionId)}`)
    .join("\n");
  throw new Error(`전제 불일치 (${context}): 준비한 평가의 판정이 전제와 다릅니다\n${detail}`);
}

/** 단계 기록 요약. 제출 상태가 COMPLETED가 아닐 때의 단언 메시지에 쓴다 */
export function describeStageLog(stageLog: readonly EvaluationStageRecord[]): string {
  return stageLog
    .map((s) => `${s.stage} ${s.state}${s.reason ? ` (${s.reason})` : ""}`)
    .join(" · ");
}
