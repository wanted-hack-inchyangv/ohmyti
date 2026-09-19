/**
 * 역량 모델 (TICKET.md T-701, PRD 14장). 인터뷰 키트(T-702·T-704)와 채용 리포트(T-705·T-706)가 같은 분류를 쓴다.
 *
 * - 기준 → 역량 매핑의 기본값은 `RubricArea`에서 결정적으로 도출한다. 과제별 보정은 리포트 프로필(`ReportProfileSchema`)로 받으며,
 *   rubric 본문과 rubricVersion 해시는 바꾸지 않는다(결정 로그 2026-09-20 7단계 설계 원칙 5).
 * - 역량별 4단계 평가 앵커(`COMPETENCY_ANCHORS`)는 면접관이 스코어카드를 기입할 때 쓰는 기준이다. 시스템은 값을 채우지 않는다.
 * - 역량별 점수·등급을 만들지 않는다 (G-01, G-13, PRD 14.4).
 */
import { z } from "zod";
import type { Criterion } from "./rubric";
import { RubricAreaSchema, type RubricArea } from "./enums";

export const CompetencySchema = z.enum([
  "REQUIREMENTS",
  "ROBUSTNESS",
  "DATA_INTEGRITY",
  "TESTING",
  "DESIGN",
  "DEBUGGING",
  "TRADEOFFS",
  "OPERABILITY",
  "COMMUNICATION",
]);
export type Competency = z.infer<typeof CompetencySchema>;

export interface CompetencyInfo {
  /** 화면·리포트에 보이는 한국어 이름 */
  name: string;
  /** 한 줄 정의 */
  definition: string;
  /** 과제 실행만으로는 관측할 수 없어 면접에서만 확인하는 역량 */
  interviewOnly: boolean;
}

export const COMPETENCIES: Readonly<Record<Competency, CompetencyInfo>> = {
  REQUIREMENTS: {
    name: "요구사항 이해와 구현 정확성",
    definition: "명세의 동작 조건을 빠짐없이 이해하고 그대로 구현한다.",
    interviewOnly: false,
  },
  ROBUSTNESS: {
    name: "경계 조건과 실패 처리",
    definition: "잘못된 입력과 자원 부족 같은 실패 경로를 예측하고 일관되게 처리한다.",
    interviewOnly: false,
  },
  DATA_INTEGRITY: {
    name: "동시성과 데이터 정합성",
    definition: "동시에 들어오는 요청에서도 데이터가 어긋나지 않도록 보호한다.",
    interviewOnly: false,
  },
  TESTING: {
    name: "테스트 설계",
    definition: "결함을 실제로 잡아내는 테스트를 설계하고 빈틈을 스스로 찾는다.",
    interviewOnly: false,
  },
  DESIGN: {
    name: "설계와 변경 용이성",
    definition: "책임을 나누어 요구가 바뀌었을 때 고칠 곳이 좁고 분명한 구조를 만든다.",
    interviewOnly: false,
  },
  DEBUGGING: {
    name: "원인 분석",
    definition: "관측된 실패에서 근거를 따라 원인 코드까지 범위를 좁힌다.",
    interviewOnly: true,
  },
  TRADEOFFS: {
    name: "트레이드오프 판단과 확장",
    definition: "선택지의 비용과 이점을 기준을 세워 비교하고 조건이 바뀌면 판단을 조정한다.",
    interviewOnly: true,
  },
  OPERABILITY: {
    name: "운영과 관측 가능성",
    definition: "배포 뒤에 문제를 알아차리고 영향을 확인해 복구할 수 있게 만든다.",
    interviewOnly: true,
  },
  COMMUNICATION: {
    name: "문서화와 설명",
    definition: "실행 방법과 설계 의도, 알려진 한계를 다른 사람이 이해할 수 있게 전달한다.",
    interviewOnly: false,
  },
};

/** 채점 기준 영역 → 기본 역량 (리포트 프로필이 기준별로 보정할 수 있다) */
export const AREA_DEFAULT_COMPETENCY: Readonly<Record<RubricArea, Competency>> = {
  REQUIRED_FEATURES: "REQUIREMENTS",
  EDGE_AND_FAILURE: "ROBUSTNESS",
  TEST_EFFECTIVENESS: "TESTING",
  DESIGN: "DESIGN",
  REPRODUCIBILITY_AND_DOCS: "COMMUNICATION",
};

/** 4단계 앵커의 값. 1 미흡 · 2 보완 필요 · 3 충족 · 4 탁월 */
export const AnchorValueSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type AnchorValue = z.infer<typeof AnchorValueSchema>;

export const ANCHOR_LABELS: Readonly<Record<AnchorValue, string>> = {
  1: "미흡",
  2: "보완 필요",
  3: "충족",
  4: "탁월",
};

export const CompetencyAnchorSchema = z.strictObject({
  value: AnchorValueSchema,
  label: z.string().min(1),
  /** 관찰 가능한 행동으로 적은 기준 */
  behavior: z.string().min(1),
});
export type CompetencyAnchor = z.infer<typeof CompetencyAnchorSchema>;

function anchors(
  behaviors: readonly [string, string, string, string],
): readonly CompetencyAnchor[] {
  return behaviors.map((behavior, index) => {
    const value = (index + 1) as AnchorValue;
    return { value, label: ANCHOR_LABELS[value], behavior };
  });
}

/**
 * 역량별 4단계 평가 앵커. 면접관이 스코어카드에 기입할 때 쓰며 시스템은 값을 고르지 않는다.
 * 단계마다 면접에서 관찰할 수 있는 행동으로 적는다.
 */
export const COMPETENCY_ANCHORS: Readonly<Record<Competency, readonly CompetencyAnchor[]>> = {
  REQUIREMENTS: anchors([
    "명세의 필수 동작을 설명하지 못하거나, 구현과 명세가 다르다는 점을 알아차리지 못한다.",
    "명세의 주요 동작은 설명하지만, 실패한 요구사항이 어느 조건을 어겼는지 스스로 짚지 못한다.",
    "요구사항마다 입력과 출력 조건을 설명하고, 실패한 요구사항이 어느 조건을 어겼는지 짚는다.",
    "명세의 모호한 부분을 먼저 찾아 가정을 밝히고, 그 가정이 구현과 테스트에 어떻게 반영되었는지 설명한다.",
  ]),
  ROBUSTNESS: anchors([
    "잘못된 입력이나 자원 부족 같은 실패 경로를 떠올리지 못한다.",
    "실패 경로를 물으면 떠올리지만, 처리 방식과 응답 형식을 구체적으로 말하지 못한다.",
    "경계값과 실패 경로를 스스로 나열하고, 각각의 응답 코드와 상태 변화를 설명한다.",
    "재시도 중 실패나 부분 실패처럼 실패가 겹치는 상황까지 다루고, 상태가 일관되게 남는 근거를 설명한다.",
  ]),
  DATA_INTEGRITY: anchors([
    "동시에 들어온 요청 때문에 상태가 어긋날 수 있다는 점을 인식하지 못한다.",
    "경쟁 조건이 생길 수 있다는 점은 알지만, 어느 구간에서 생기는지 짚지 못한다.",
    "경쟁이 생기는 구간과 그 구간을 보호하는 방법(락, 원자적 연산, 유일성 제약)을 코드 위치와 함께 설명한다.",
    "저장소가 바뀌거나 인스턴스가 늘어날 때 보호 방법이 깨지는 조건을 짚고, 대안을 비교해 설명한다.",
  ]),
  TESTING: anchors([
    "작성한 테스트가 어떤 결함을 잡는지 설명하지 못한다.",
    "정상 경로 테스트는 설명하지만, 살아남은 변이가 드러낸 빈틈을 스스로 찾지 못한다.",
    "살아남은 변이나 약한 단언을 보고, 추가할 테스트를 구체적인 입력과 기대값으로 말한다.",
    "테스트의 우선순위를 정하는 기준을 설명하고, 테스트 비용과 결함을 잡는 범위의 균형을 논한다.",
  ]),
  DESIGN: anchors([
    "코드 구조를 그렇게 나눈 이유를 설명하지 못한다.",
    "구조는 설명하지만, 요구가 바뀌면 어디를 고쳐야 하는지 분명히 말하지 못한다.",
    "책임을 나눈 기준을 설명하고, 요구 변경 하나에 대해 고칠 위치를 코드에서 짚는다.",
    "현재 구조의 한계를 스스로 짚고, 다른 구조와 비교해 선택에 따르는 비용을 설명한다.",
  ]),
  DEBUGGING: anchors([
    "재생 기록을 보고도 실패 원인을 추정하지 못한다.",
    "원인 후보를 말하지만, 근거를 대지 못하고 추측에 머문다.",
    "재생 기록의 기대값·실제값에서 원인 코드 위치까지 스스로 좁힌다.",
    "원인을 좁힌 뒤, 같은 원인으로 생길 수 있는 다른 결함과 재발을 막는 방법까지 제시한다.",
  ]),
  TRADEOFFS: anchors([
    "선택지 사이의 차이를 설명하지 못하고 한 가지 방법만 제시한다.",
    "선택지를 나열하지만, 무엇을 기준으로 골라야 하는지 말하지 못한다.",
    "정합성, 성능, 복잡도 같은 판단 기준을 밝히고, 과제 조건에서 그 방법을 고른 이유를 설명한다.",
    "트래픽 증가나 다중 인스턴스처럼 조건이 바뀌면 선택이 어떻게 달라지는지 근거와 함께 설명한다.",
  ]),
  OPERABILITY: anchors([
    "배포한 뒤에 문제가 생기면 어떻게 알아차릴지 설명하지 못한다.",
    "로그를 남긴다고 답하지만, 무엇을 기록하고 어떻게 찾을지는 구체적으로 말하지 못한다.",
    "문제를 알아차릴 신호(로그, 지표, 상태 확인)와 확인 순서를 구체적으로 설명한다.",
    "운영 중에 데이터가 어긋났을 때 영향 범위를 확인하고 복구하는 절차까지 설명한다.",
  ]),
  COMMUNICATION: anchors([
    "실행 방법이나 설계 의도를 문서나 말로 전달하지 못한다.",
    "설명은 하지만 전제가 빠져 있어서 듣는 사람이 여러 번 다시 물어야 한다.",
    "실행 방법과 가정, 알려진 한계를 순서대로 설명하고, 질문에는 근거를 들어 답한다.",
    "듣는 사람의 배경에 맞추어 설명 수준을 조절하고, 확인하지 못한 부분은 모른다고 구분해 말한다.",
  ]),
};

/** 비개발자가 읽는 영향 문장 상한 */
export const REPORT_IMPACT_MAX_CHARS = 300;

/** 리포트 프로필의 기준 하나: 역량 보정과 영향 문장 */
export const ReportProfileCriterionSchema = z.strictObject({
  /** rubric 기준 ID (그룹을 참조하는 MUTATION 기준 포함) */
  criterionId: z.string().min(1),
  /** 없으면 `AREA_DEFAULT_COMPETENCY`를 쓴다 */
  competency: CompetencySchema.optional(),
  /** 비개발자가 읽는 영향 문장. 예: "같은 주문 요청이 다른 내용으로 다시 오면 새 주문이 만들어져 중복 결제로 이어질 수 있다" */
  impact: z.string().min(1).max(REPORT_IMPACT_MAX_CHARS).optional(),
});
export type ReportProfileCriterion = z.infer<typeof ReportProfileCriterionSchema>;

/**
 * 과제별 리포트 프로필. rubric 본문과 분리해 두므로 rubricVersion 해시와 승인·검증에 영향이 없다.
 * 저장 위치와 로딩은 T-705가 정한다.
 */
export const ReportProfileSchema = z
  .strictObject({
    profileVersion: z.int().min(1),
    criteria: z.array(ReportProfileCriterionSchema),
  })
  .superRefine((profile, ctx) => {
    const seen = new Set<string>();
    profile.criteria.forEach((entry, index) => {
      if (seen.has(entry.criterionId)) {
        ctx.addIssue({
          code: "custom",
          path: ["criteria", index, "criterionId"],
          message: `기준 ID가 중복되었습니다: ${entry.criterionId}`,
        });
      }
      seen.add(entry.criterionId);
    });
  });
export type ReportProfile = z.infer<typeof ReportProfileSchema>;

/** 기준의 역량. 프로필 보정이 있으면 그 값, 없으면 영역 기본값 */
export function competencyForCriterion(
  criterion: Pick<Criterion, "id" | "area">,
  profile?: ReportProfile | null,
): Competency {
  const override = profile?.criteria.find((entry) => entry.criterionId === criterion.id);
  return override?.competency ?? AREA_DEFAULT_COMPETENCY[RubricAreaSchema.parse(criterion.area)];
}

/** 기준의 영향 문장. 프로필에 없으면 null이며 문장을 지어내지 않는다 (G-09) */
export function impactForCriterion(
  criterionId: string,
  profile?: ReportProfile | null,
): string | null {
  return profile?.criteria.find((entry) => entry.criterionId === criterionId)?.impact ?? null;
}
