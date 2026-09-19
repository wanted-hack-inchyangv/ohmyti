/**
 * 4단계 게이트 (TICKET.md T-408)의 대조 로직. DB·러너 없이 결과만 받아 판단하므로 단위 테스트로 고정한다.
 * 실행과 기록은 `cli.ts`가 한다.
 *
 * - 샘플별 대조: 기준 판정·배점·검토 상태·mutation 결과·제출 테스트(`compareValidationSample`)와 점수 표시
 *   (`scoreDisplay.beforeHumanReview`)를 기대 결과표와 맞춘다.
 * - 대안 구현 B: 사람 검토(HUMAN_REVIEW) 기준을 뺀 모든 기준이 PASS 만점이고 테스트 실효성 그룹(G1~G3) 합계가 만점이다.
 * - 적대 샘플 D: 점수 표시 문자열과 기준별 `earned_points`가 결함 구현 C와 완전히 같다 (README·주석의 지시가 점수를 바꾸지 못한다, G-06).
 */
import {
  compareValidationSample,
  MutationOutcomeSchema,
  type Rubric,
  type ValidationMismatch,
  type ValidationSampleActual,
  type ValidationSampleKind,
} from "@ohmyti/core";
import { z } from "zod";

export const GATE_SAMPLE_IDS = ["A", "B", "C", "D"] as const;
export type GateSampleId = (typeof GATE_SAMPLE_IDS)[number];

export const GATE_SAMPLE_KIND: Record<GateSampleId, ValidationSampleKind> = {
  A: "CORRECT",
  B: "ALTERNATIVE",
  C: "DEFECTIVE",
  D: "ADVERSARIAL",
};

/** `samples/order-api/expected-matrix.json` 중 게이트가 쓰는 부분 (전체 스키마는 `scripts/samples-check.ts`) */
export const GateMatrixSchema = z.looseObject({
  rubricVersion: z.string(),
  reviewedBy: z.string().nullable(),
  samples: z.array(
    z.looseObject({
      id: z.enum(GATE_SAMPLE_IDS),
      name: z.string().min(1),
      dir: z.string().min(1),
      criteria: z.record(
        z.string().min(1),
        z.looseObject({
          verdict: z.string(),
          earnedPoints: z.number().nullable(),
          reviewState: z.string().optional(),
        }),
      ),
      mutations: z.record(z.string().min(1), MutationOutcomeSchema),
      submittedTests: z.looseObject({
        status: z.string(),
        total: z.int().optional(),
        files: z.int().optional(),
      }),
      scoreDisplay: z.looseObject({ beforeHumanReview: z.string().min(1) }),
    }),
  ),
});
export type GateMatrix = z.infer<typeof GateMatrixSchema>;
export type GateMatrixSample = GateMatrix["samples"][number];

export interface GateCheck {
  id: string;
  title: string;
  pass: boolean;
  /** 사람이 읽는 한 줄 요약 */
  detail: string;
  /** 실패 시 원인 목록 (불일치 문장) */
  problems: string[];
}

function check(id: string, title: string, detail: string, problems: string[]): GateCheck {
  return { id, title, pass: problems.length === 0, detail, problems };
}

/** 샘플 하나를 기대 결과표와 대조한다 (기준·mutation·제출 테스트 + 점수 표시 문자열) */
export function compareSampleWithMatrix(
  sampleId: GateSampleId,
  expected: GateMatrixSample,
  actual: ValidationSampleActual,
): { mismatches: ValidationMismatch[]; problems: string[] } {
  const mismatches = compareValidationSample(
    { id: sampleId, name: expected.name, kind: GATE_SAMPLE_KIND[sampleId], submissionSha: "-" },
    {
      criteria: expected.criteria,
      mutations: expected.mutations,
      submittedTests: expected.submittedTests,
    },
    actual,
  );
  const problems = mismatches.map((m) => `${sampleId} ${m.message}`);
  if (actual.scoreDisplay !== expected.scoreDisplay.beforeHumanReview) {
    problems.push(
      `${sampleId} 점수 표시: 기대 "${expected.scoreDisplay.beforeHumanReview}", 실제 "${actual.scoreDisplay ?? "없음"}"`,
    );
  }
  return { mismatches, problems };
}

export function checkMatrix(
  matrix: GateMatrix,
  actuals: Record<GateSampleId, ValidationSampleActual>,
): GateCheck {
  const problems: string[] = [];
  for (const id of GATE_SAMPLE_IDS) {
    const expected = matrix.samples.find((s) => s.id === id);
    if (!expected) {
      problems.push(`${id}: 기대 결과표에 샘플이 없습니다`);
      continue;
    }
    problems.push(...compareSampleWithMatrix(id, expected, actuals[id]).problems);
  }
  return check(
    "MATRIX",
    "A/B/C/D 전체 파이프라인 결과 = 기대 결과표 (기준·그룹·mutation·제출 테스트·점수 표시)",
    problems.length === 0 ? "4개 샘플 모두 일치" : `불일치 ${problems.length}건`,
    problems,
  );
}

/** B: HUMAN_REVIEW 기준을 뺀 모든 기준이 PASS 만점, R-12 같은 사람 검토 기준은 미확정 검토 대기, G1~G3 합계 만점 */
export function checkAlternative(rubric: Rubric, b: ValidationSampleActual): GateCheck {
  const problems: string[] = [];
  let groupEarned = 0;
  let groupMax = 0;
  for (const criterion of rubric.criteria) {
    const row = b.criteria[criterion.id];
    if (!row) {
      problems.push(`B ${criterion.id}: 판정 행이 없습니다`);
      continue;
    }
    if (criterion.method === "HUMAN_REVIEW") {
      if (row.verdict !== "INCONCLUSIVE" || row.earnedPoints !== null) {
        problems.push(
          `B ${criterion.id}: 사람 검토 기준은 확정 전 INCONCLUSIVE·미확정이어야 합니다 (실제 ${row.verdict}, ${row.earnedPoints ?? "미확정"})`,
        );
      }
      continue;
    }
    if (row.verdict !== "PASS" || row.earnedPoints !== criterion.maxPoints) {
      problems.push(
        `B ${criterion.id}: 기대 PASS ${criterion.maxPoints}점, 실제 ${row.verdict} ${row.earnedPoints ?? "미확정"}`,
      );
    }
    if (criterion.area === "TEST_EFFECTIVENESS") {
      groupEarned += row.earnedPoints ?? 0;
      groupMax += criterion.maxPoints;
    }
  }
  if (groupMax === 0) problems.push("B: 테스트 실효성 그룹 기준이 rubric에 없습니다");
  else if (groupEarned !== groupMax) {
    problems.push(`B 테스트 실효성 그룹: ${groupEarned}/${groupMax}`);
  }
  const reviewIds = rubric.criteria.filter((c) => c.method === "HUMAN_REVIEW").map((c) => c.id);
  return check(
    "ALTERNATIVE_B",
    "대안 구현 B: 모든 기준 PASS, G1~G3 만점",
    `사람 검토 기준(${reviewIds.join(", ") || "없음"})을 뺀 기준 모두 PASS · 테스트 실효성 ${groupEarned}/${groupMax}`,
    problems,
  );
}

/** D의 점수 표시와 기준별 earned_points가 C와 완전히 같다 */
export function checkAdversarial(c: ValidationSampleActual, d: ValidationSampleActual): GateCheck {
  const problems: string[] = [];
  if (c.scoreDisplay === null || d.scoreDisplay === null) {
    problems.push("C 또는 D의 점수 표시가 없습니다");
  } else if (c.scoreDisplay !== d.scoreDisplay) {
    problems.push(`점수 표시: C "${c.scoreDisplay}", D "${d.scoreDisplay}"`);
  }
  const ids = [...new Set([...Object.keys(c.criteria), ...Object.keys(d.criteria)])].sort();
  if (ids.length === 0) problems.push("C·D 판정 행이 없습니다");
  for (const id of ids) {
    const left = c.criteria[id];
    const right = d.criteria[id];
    if (!left || !right) {
      problems.push(`${id}: ${left ? "D" : "C"}에 판정 행이 없습니다`);
    } else if (left.earnedPoints !== right.earnedPoints) {
      problems.push(
        `${id}: earned_points C ${left.earnedPoints ?? "null"}, D ${right.earnedPoints ?? "null"}`,
      );
    }
  }
  return check(
    "ADVERSARIAL_D",
    "적대 샘플 D: 점수 표시·기준별 earned_points = C",
    `C "${c.scoreDisplay ?? "없음"}" · D "${d.scoreDisplay ?? "없음"}" · 기준 ${ids.length}개 비교`,
    problems,
  );
}

export interface GateLlmSample {
  sampleId: GateSampleId;
  evaluationId: string | null;
  reviewWriteState: string | null;
  reviewWriteReason: string | null;
  /** REVIEW_WRITE 요약의 LLM 상태 (`OK`·`NOT_RUN`·`INCONCLUSIVE`) */
  reviewWriteLlm: string | null;
  reviewWriteError: string | null;
  interpretations: Array<{
    criterionId: string;
    confidence: string;
    evidenceCount: number;
    minimalRepro: string;
  }>;
  designSuggestions: Array<{ criterionId: string; suggestedPoints: number; maxPoints: number }>;
  suggestions: string[];
  /** 후처리가 버린 참조 수 (스냅샷에 없는 위치·입력에 없는 스텝 등) */
  dropped: number;
  /** REVIEW_WRITE 전후 판정(earned_points·verdict·observation)이 같은가 */
  criteriaUnchanged: boolean | null;
  calls: Array<{ kind: string; model: string; promptVersion: string; costUsd: number }>;
}

/**
 * LLM 단계는 판정을 바꾸지 않고(G-01), 네 샘플 모두 REVIEW_WRITE가 끝나야 한다.
 * `requireCalls`(실제 LLM 모드)면 호출 기록이 샘플마다 1건 이상 있어야 한다. 제공자 오류(INCONCLUSIVE·NOT_RUN)는
 * 판정에 영향이 없으므로 게이트를 막지 않고 기록만 한다.
 */
export function checkLlm(samples: GateLlmSample[], requireCalls: boolean): GateCheck {
  const problems: string[] = [];
  for (const s of samples) {
    if (s.reviewWriteState !== "DONE") {
      problems.push(`${s.sampleId} REVIEW_WRITE 상태 ${s.reviewWriteState ?? "없음"}`);
    }
    if (s.criteriaUnchanged !== true) {
      problems.push(`${s.sampleId} REVIEW_WRITE 전후 판정이 달라졌거나 확인하지 못했습니다`);
    }
    if (requireCalls && s.calls.length === 0) {
      problems.push(`${s.sampleId} LLM 호출 기록(ai_reviews)이 없습니다`);
    }
  }
  const calls = samples.reduce((n, s) => n + s.calls.length, 0);
  const cost = samples.reduce((sum, s) => sum + s.calls.reduce((a, c) => a + c.costUsd, 0), 0);
  return check(
    "LLM",
    "LLM 단계(mutation 위치 제안·근거 리뷰)가 판정을 바꾸지 않는다",
    `호출 ${calls}건 · 비용 $${cost.toFixed(6)} · REVIEW_WRITE ${samples.map((s) => `${s.sampleId}=${s.reviewWriteLlm ?? "-"}`).join(" ")}`,
    problems,
  );
}

export interface ApprovalFlowObservation {
  /** v1 검증 결과 pass */
  v1Pass: boolean;
  /** v1 검증 불일치 (`샘플 이름 + 메시지`). pass면 빈 배열 */
  v1Mismatches: string[];
  v1StatusAfterValidation: string;
  /** 샘플 서명이 없을 때 승인 차단 코드 */
  unsignedBlockers: string[];
  /** 승인자 이름이 공백일 때 차단 코드 */
  blankApproverBlockers: string[];
  approvedStatus: string | null;
  /** v2(R-11에 express 의존성 정적 검사 추가) 검증 결과 */
  v2Pass: boolean | null;
  v2Status: string | null;
  v2Mismatches: Array<{
    sample: string;
    ref: string;
    field: string | null;
    expected: unknown;
    actual: unknown;
  }>;
  v2Blockers: string[];
  v1StatusAfterV2: string | null;
}

export function checkApprovalFlow(o: ApprovalFlowObservation): GateCheck {
  const problems: string[] = [];
  if (!o.v1Pass) {
    problems.push(
      "v1 검증이 pass가 아닙니다",
      ...o.v1Mismatches.map((m) => `v1 검증 불일치: ${m}`),
    );
  }
  if (o.v1StatusAfterValidation !== "VALIDATING") {
    problems.push(`v1 검증 뒤 상태 ${o.v1StatusAfterValidation} (기대 VALIDATING)`);
  }
  if (!o.unsignedBlockers.includes("SAMPLE_NOT_REVIEWED")) {
    problems.push(
      `샘플 서명 없는 승인이 SAMPLE_NOT_REVIEWED로 막히지 않았습니다: [${o.unsignedBlockers.join(", ")}]`,
    );
  }
  if (o.blankApproverBlockers.join(",") !== "APPROVER_MISSING") {
    problems.push(
      `승인자 공백 차단 코드 [${o.blankApproverBlockers.join(", ")}] (기대 APPROVER_MISSING)`,
    );
  }
  if (o.approvedStatus !== "APPROVED")
    problems.push(`v1 승인 뒤 상태 ${o.approvedStatus ?? "없음"}`);
  if (o.v2Pass !== false) problems.push("v2(express 필수) 검증이 불일치를 내지 않았습니다");
  if (o.v2Status !== "DRAFT") problems.push(`v2 검증 뒤 상태 ${o.v2Status ?? "없음"} (기대 DRAFT)`);
  const v2Samples = [...new Set(o.v2Mismatches.map((m) => m.sample))];
  if (v2Samples.join(",") !== "B") {
    problems.push(`v2 불일치 샘플 [${v2Samples.join(", ")}] (기대 B만)`);
  }
  if (!o.v2Blockers.includes("VALIDATION_FAILED")) {
    problems.push(`v2 승인이 VALIDATION_FAILED로 막히지 않았습니다: [${o.v2Blockers.join(", ")}]`);
  }
  if (o.v1StatusAfterV2 !== "APPROVED")
    problems.push(`v2 차단 뒤 v1 상태 ${o.v1StatusAfterV2 ?? "없음"}`);
  return check(
    "APPROVAL_FLOW",
    "rubric 검증·승인 흐름: v1 통과·서명 없으면 차단·승인, v2(express 필수) B 불일치로 차단",
    `v1 ${o.v1Pass ? "pass" : "fail"} → ${o.approvedStatus ?? "-"} · v2 불일치 ${o.v2Mismatches.length}건(${v2Samples.join(", ") || "-"}) → 차단 [${o.v2Blockers.join(", ")}]`,
    problems,
  );
}
