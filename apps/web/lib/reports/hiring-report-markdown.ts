/**
 * 채용 리포트의 Markdown 직렬화 (TICKET.md T-705, PRD 14.3). 회의 자료로 붙여 넣을 수 있는 한 건의 문서다.
 *
 * - 조립된 리포트(`HiringReport`)의 값만 옮긴다. 여기서 점수를 다시 만들거나 판단 문장을 더하지 않는다.
 * - 합격·탈락·추천·순위·등급·레벨 표현을 쓰지 않는다 (PRD 14.4, `findForbiddenReportExpressions`가 검사한다).
 * - 스코어카드는 사람이 기입하는 빈 칸이며 시스템이 값을 채우지 않는다.
 */
import {
  ANCHOR_LABELS,
  COMPETENCIES,
  INTERVIEW_QUESTION_KIND_LABELS,
  type Competency,
  type HiringReport,
  type ObservationRef,
  type ReviewState,
  type RubricArea,
  type Verdict,
} from "@ohmyti/core";

/** 표시 문구. 화면(T-301·T-706)과 같은 말을 쓴다 */
const VERDICT_LABEL: Record<Verdict, string> = {
  PASS: "통과",
  FAIL: "실패",
  PARTIAL: "부분",
  INCONCLUSIVE: "미확정",
};

const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  NOT_REQUIRED: "자동 판정",
  PENDING: "검토 대기",
  CONFIRMED: "사람 확인",
};

const AREA_LABEL: Record<RubricArea, string> = {
  REQUIRED_FEATURES: "요구 기능",
  EDGE_AND_FAILURE: "경계·실패",
  TEST_EFFECTIVENESS: "테스트 실효성",
  DESIGN: "설계·변경 용이성",
  REPRODUCIBILITY_AND_DOCS: "실행 재현성·문서",
};

const CONTEXT_STATUS_LABEL: Record<HiringReport["resumeLinks"]["links"][number]["status"], string> =
  {
    EVIDENCE_FOUND: "근거 있음",
    NEEDS_CHECK: "확인 필요",
    NO_DATA: "자료 없음",
  };

const NO_DATA_LINE = "자료 없음";

/** 역량 → 한국어 이름. 저장된 스코어카드(T-707)가 쓴다 */
const COMPETENCY_NAME: Record<Competency, string> = Object.fromEntries(
  Object.entries(COMPETENCIES).map(([key, info]) => [key, info.name]),
) as Record<Competency, string>;

/** 근거 참조 한 줄. 화면의 딥링크는 T-706이 붙이며 Markdown은 저장된 식별자만 적는다 */
export function formatRef(ref: ObservationRef): string {
  switch (ref.kind) {
    case "CRITERION":
      return `기준 ${ref.criterionId}`;
    case "EXECUTION_RECORD":
      return `실행 기록 ${ref.runId}`;
    case "SOURCE":
      return `코드 ${ref.location.path}:${ref.location.startLine}-${ref.location.endLine}`;
    case "MUTATION":
      return `변이 ${ref.mutationId}`;
    case "CONTEXT_LINK":
      return `이력서 연결 ${ref.contextLinkId}`;
  }
}

function refsLine(refs: readonly ObservationRef[]): string {
  return refs.length === 0 ? "근거 없음" : refs.map(formatRef).join(", ");
}

/** 표 칸에 넣을 때 줄바꿈과 세로줄을 지운다 */
function cell(value: string | null): string {
  if (!value) return "-";
  return value
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function keyObservationLines(
  items: readonly HiringReport["keyObservations"]["defects"][number][],
  emptyLine: string,
): string[] {
  if (items.length === 0) return [emptyLine];
  return items.flatMap((item, index) => {
    const lines = [
      `${index + 1}. **${item.title}** (${item.criterionId} · ${VERDICT_LABEL[item.verdict]})`,
      `   - 관측: ${cell(item.observation)}`,
    ];
    if (item.impact) lines.push(`   - 영향: ${cell(item.impact)}`);
    if (item.aiDraft) lines.push(`   - AI 초안: ${cell(item.aiDraft)}`);
    lines.push(`   - 근거: ${refsLine(item.refs)}`);
    return lines;
  });
}

export function hiringReportToMarkdown(report: HiringReport): string {
  const lines: string[] = [];
  const push = (...added: string[]) => lines.push(...added);

  push(`# 채용 리포트 · ${report.assignment.title}`, "");
  push(
    `- 과제: ${report.assignment.name} v${report.assignment.version}`,
    `- 평가 ID: ${report.evaluationId}`,
    `- 제출 코드: ${report.audit.submissionSha}`,
  );
  if (report.isSample) push("- 표시: 저장된 실행 (샘플의 사전 계산 결과입니다)");
  push("");

  // 1. 한눈 요약
  push("## 1. 한눈 요약", "");
  const score = report.summary.score;
  push(`- 점수: ${score ? score.display : "판정이 아직 저장되지 않았습니다"}`);
  const counts = report.summary.verdictCounts;
  push(
    `- 판정 분포: 통과 ${counts.PASS} · 실패 ${counts.FAIL} · 부분 ${counts.PARTIAL} · 미확정 ${counts.INCONCLUSIVE}`,
  );
  push(
    `- 검토 대기: ${
      report.summary.pendingReview.length === 0
        ? "없음"
        : report.summary.pendingReview.map((c) => `${c.criterionId} ${c.title}`).join(", ")
    }`,
    "",
  );
  if (score?.byArea && score.byArea.length > 0) {
    push("| 영역 | 점수 | 배점 | 검토 대기 |", "| --- | --- | --- | --- |");
    for (const area of score.byArea) {
      const earned = area.pendingPoints > 0 ? `${area.min}~${area.max}` : String(area.earned);
      push(`| ${AREA_LABEL[area.area]} | ${earned} | ${area.total} | ${area.pendingPoints} |`);
    }
    push("");
  }

  // 2. 핵심 관측
  push("## 2. 핵심 관측", "", "### 확인된 강점", "");
  push(
    ...keyObservationLines(
      report.keyObservations.strengths,
      "관측으로 확인된 강점 항목이 없습니다.",
    ),
    "",
  );
  push("### 확인된 결함", "");
  push(
    ...keyObservationLines(report.keyObservations.defects, "관측으로 확인된 결함이 없습니다."),
    "",
  );

  // 3. 역량별 관측
  push("## 3. 역량별 관측", "");
  for (const competency of report.competencies) {
    push(`### ${competency.name}`, "");
    if (competency.criteria.length === 0) {
      push(
        competency.interviewOnly
          ? "- 과제로 관측 불가: 면접에서 확인"
          : "- 이 역량에 매핑된 기준의 판정이 없습니다.",
      );
    } else {
      const c = competency.verdictCounts;
      push(
        `- 판정 분포: 통과 ${c.PASS} · 실패 ${c.FAIL} · 부분 ${c.PARTIAL} · 미확정 ${c.INCONCLUSIVE}`,
      );
      for (const criterion of competency.criteria) {
        push(
          `- ${criterion.criterionId} ${criterion.title}: ${VERDICT_LABEL[criterion.verdict]} (${REVIEW_STATE_LABEL[criterion.reviewState]}) · 근거: ${refsLine(criterion.refs)}`,
        );
      }
    }
    // 질문 참조는 슬롯 ID 대신 키트와 같은 번호와 주 질문 문장으로 적는다 (T-706)
    if (competency.kitQuestions.length > 0) {
      push("- 면접에서 확인할 질문");
      for (const question of competency.kitQuestions) {
        push(`  - Q${question.number}. ${cell(question.question)}`);
      }
    } else if (competency.interviewOnly) {
      push(
        `- 면접에서 확인할 질문: ${
          report.interviewGuide.status === "NO_DATA"
            ? "인터뷰 키트 없음"
            : "이 역량을 확인하는 키트 질문이 없습니다."
        }`,
      );
    }
    push("");
  }

  // 4. 요구사항별 결과
  push("## 4. 요구사항별 결과", "");
  push("| 기준 | 영역 | 판정 | 점수 | 검토 상태 | 관측 |", "| --- | --- | --- | --- | --- | --- |");
  for (const criterion of report.requirements.criteria) {
    const points = `${criterion.earnedPoints ?? "?"}/${criterion.maxPoints}`;
    push(
      `| ${criterion.criterionId} ${cell(criterion.title)} | ${AREA_LABEL[criterion.area]} | ${VERDICT_LABEL[criterion.verdict]} | ${points} | ${REVIEW_STATE_LABEL[criterion.reviewState]} | ${cell(criterion.observation)} |`,
    );
  }
  push("");

  push("### 테스트 실효성", "");
  if (report.requirements.testEffectiveness.length === 0) {
    push(NO_DATA_LINE, "");
  } else {
    for (const group of report.requirements.testEffectiveness) {
      // 0건인 결과는 적지 않는다 (실험이 하나도 없으면 "없음")
      const outcomes = Object.entries(group.outcomes)
        .filter(([, count]) => count > 0)
        .map(([outcome, count]) => `${outcome} ${count}`)
        .join(", ");
      push(
        `- ${group.groupId} ${group.name}: ${group.verdict ? VERDICT_LABEL[group.verdict] : "판정 없음"} · 변이 결과 ${outcomes || "없음"}`,
      );
    }
    push("");
  }

  push("### 설계 검토 (AI 초안)", "");
  if (report.requirements.designReview.status === "NO_DATA") {
    push(NO_DATA_LINE, "");
  } else {
    if (report.requirements.designReview.items.length === 0) {
      push("- 설계 검토 초안이 없습니다.");
    }
    for (const item of report.requirements.designReview.items) {
      push(`- ${item.criterionId}: ${cell(item.rationale)} · 근거: ${refsLine(item.refs)}`);
    }
    const signals = report.requirements.designReview.signals;
    if (signals && signals.status === "ok") {
      push(
        `- 코드 신호: 소스 파일 ${signals.sourceFiles}개 · 테스트 파일 ${signals.testFiles}개 · 명시적 any ${signals.explicitAny.count}곳`,
      );
    }
    push("");
  }

  // 5. 이력서 주장과 근거
  push("## 5. 이력서 주장과 근거", "");
  if (report.resumeLinks.status === "NO_DATA") {
    push("맥락 연결 자료가 없습니다.", "");
  } else if (report.resumeLinks.status === "NO_RESUME") {
    push("이력서가 제출되지 않아 연결할 주장이 없습니다.", "");
  } else {
    push("| 주장 | 상태 | 근거 | 과제 관측 | 면접 질문 |", "| --- | --- | --- | --- | --- |");
    for (const link of report.resumeLinks.links) {
      const evidence = link.evidence.map((e) => `${e.summary} (${e.url})`).join("; ");
      const observation = link.observation
        ? `${link.observation.criterionId ? `${link.observation.criterionId} · ` : ""}${link.observation.summary}`
        : "";
      push(
        `| ${cell(link.claim)} | ${CONTEXT_STATUS_LABEL[link.status]} | ${cell(evidence)} | ${cell(observation)} | ${cell(link.question)} |`,
      );
    }
    push("");
  }

  // 6. 면접 안내
  push("## 6. 면접 안내 (필수 질문)", "");
  if (report.interviewGuide.status === "NO_DATA") {
    push("인터뷰 키트가 없습니다.", "");
  } else {
    if (report.interviewGuide.llm && report.interviewGuide.llm !== "OK") {
      push(
        `- 질문 문장 생성: ${report.interviewGuide.llm}${report.interviewGuide.llmReason ? ` (${report.interviewGuide.llmReason})` : ""}. 준비된 기본 질문으로 채웠습니다.`,
        "",
      );
    }
    if (report.interviewGuide.mustQuestions.length === 0) {
      push("필수 질문이 없습니다.", "");
    } else {
      for (const question of report.interviewGuide.mustQuestions) {
        push(
          `- Q${question.number}. [${INTERVIEW_QUESTION_KIND_LABELS[question.kind]} · ${question.minutes}분${question.source === "TEMPLATE" ? " · 기본 질문" : ""}] ${cell(question.question)}`,
        );
      }
      push("");
    }
  }

  // 7. 평가 범위와 한계
  push("## 7. 평가 범위와 한계", "");
  push("### 미평가 영역", "");
  if (report.scope.unassessedAreas.length === 0) push("- 기록된 미평가 영역이 없습니다.");
  for (const area of report.scope.unassessedAreas) push(`- ${cell(area)}`);
  push("", "### 미확정 기준", "");
  if (report.scope.inconclusive.length === 0) push("- 미확정 기준이 없습니다.");
  for (const item of report.scope.inconclusive) {
    // 환경 장애는 제출 코드의 결함과 구분해 먼저 적고 (G-11), 그 밖에는 저장된 사유만 적는다
    const parts = [
      ...(item.environmental ? ["실행 환경 장애이며 제출 코드의 결함이 아닙니다"] : []),
      ...(item.reason ? [cell(item.reason)] : []),
    ];
    push(
      `- ${item.criterionId} ${item.title}: ${parts.length > 0 ? parts.join(" · ") : "사유가 기록되지 않았습니다"}`,
    );
  }
  push("", "### 사람 검토 대기", "");
  if (report.scope.pendingReview.length === 0) push("- 검토 대기 기준이 없습니다.");
  for (const item of report.scope.pendingReview) push(`- ${item.criterionId} ${item.title}`);
  push("", "### LLM 사용 범위", "");
  if (report.scope.llmUsage.length === 0) push("- LLM을 쓴 단계 기록이 없습니다.");
  for (const usage of report.scope.llmUsage) {
    push(
      `- ${usage.stage}: ${usage.state}${usage.model ? ` · 모델 ${usage.model}` : ""}${usage.promptVersion ? ` · 프롬프트 ${usage.promptVersion}` : ""}${usage.reason ? ` · ${cell(usage.reason)}` : ""}`,
    );
  }
  push("", "### 지원 범위", "");
  for (const scope of report.scope.supportScope) push(`- ${scope}`);
  push("");

  // 8. 면접관 스코어카드 (사람이 기입한다)
  push("## 8. 면접관 스코어카드 (사람이 기입합니다)", "");
  push(
    `- 척도: ${Object.entries(ANCHOR_LABELS)
      .map(([value, label]) => `${value} ${label}`)
      .join(" · ")}`,
    "",
  );
  for (const competency of report.scorecard.competencies) {
    push(
      `### ${competency.name}${competency.interviewOnly ? " (면접에서만 확인)" : ""}`,
      "",
      `- 정의: ${competency.definition}`,
    );
    for (const anchor of competency.anchors) {
      push(`- ${anchor.value} ${anchor.label}: ${anchor.behavior}`);
    }
    push("- 기입: [ ] 1 [ ] 2 [ ] 3 [ ] 4", "- 메모:", "");
  }
  push("### 면접관 최종 의견", "", "- 메모:", "");

  // 8-1. 저장된 스코어카드 (T-707). 면접관이 적은 값 그대로이며 평균·합산을 만들지 않는다
  push("### 저장된 스코어카드", "");
  if (report.scorecard.saved.length === 0) {
    push("- 저장된 스코어카드가 없습니다.", "");
  } else {
    push(
      "- 면접관이 기입한 기록입니다. 시스템은 값을 제안하지 않으며 평균과 합산을 내지 않습니다.",
      "",
    );
    for (const card of report.scorecard.saved) {
      push(
        `#### ${cell(card.interviewer)} · ${card.createdAt}${card.latest ? "" : " (이전 기록)"}`,
        "",
      );
      const filled = card.competencies.filter((c) => c.value !== null || c.note !== null);
      if (filled.length === 0) push("- 역량 기입 없음");
      for (const entry of filled) {
        const name = COMPETENCY_NAME[entry.competency];
        const value =
          entry.value === null ? "미기입" : `${entry.value} ${ANCHOR_LABELS[entry.value]}`;
        push(`- ${name}: ${value}${entry.note ? ` · ${cell(entry.note)}` : ""}`);
      }
      for (const note of card.questionNotes) {
        push(
          `- 질문 ${note.number === null ? note.questionId : `Q${note.number}`}: ${cell(note.note)}`,
        );
      }
      push(`- 최종 의견: ${card.finalNote === null ? NO_DATA_LINE : cell(card.finalNote)}`, "");
    }
  }

  // 9. 감사 정보
  push("## 9. 감사 정보", "");
  push(
    `- 기준 버전: ${report.audit.rubricVersion}`,
    `- 하네스 버전: ${report.audit.harnessVersion}`,
    `- 환경 다이제스트: ${report.audit.environmentDigest}`,
    `- 제출 SHA: ${report.audit.submissionSha}`,
    `- 저장소: ${report.audit.repoUrl}`,
    `- 평가 종료 시각: ${report.audit.finishedAt ?? "기록 없음"}`,
  );
  for (const stage of report.audit.llmStages) {
    push(
      `- ${stage.stage} 모델: ${stage.model ?? "없음"}${stage.promptVersion ? ` · 프롬프트 ${stage.promptVersion}` : ""}${stage.aiReviewId ? ` · 호출 기록 ${stage.aiReviewId}` : ""}`,
    );
  }
  push(
    `- 사람 수정 이력: ${report.audit.humanEdits.count}건${report.audit.humanEdits.lastAt ? ` (마지막 ${report.audit.humanEdits.lastAt})` : ""}`,
    "",
  );

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
