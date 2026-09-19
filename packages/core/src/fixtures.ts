import type { Rubric } from "./rubric";
import type { RubricDraftOutput } from "./rubric-draft";

/** 부록 A 초안을 그대로 옮긴 테스트용 기준. T-101에서 확정본이 samples/에 생긴다. */
export function sampleRubric(): Rubric {
  return {
    version: "sample-v1",
    criteria: [
      c("R-01", "REQUIRED_FEATURES", 8, "EXECUTION", "정상 주문 201, 응답 스키마, 재고 차감"),
      c("R-02", "REQUIRED_FEATURES", 6, "EXECUTION", "상품·주문 조회 200, 미존재 404"),
      c(
        "R-05",
        "REQUIRED_FEATURES",
        14,
        "EXECUTION",
        "같은 키 + 같은 본문 재전송 → 같은 orderId, 201, 재고 1회만 차감",
      ),
      c("R-06", "REQUIRED_FEATURES", 6, "EXECUTION", "같은 키 + 다른 본문 → 422, 새 주문 없음"),
      c("R-09", "REQUIRED_FEATURES", 6, "EXECUTION", "취소 시 재고 복구, 이중 취소 409"),
      c("R-03", "EDGE_AND_FAILURE", 7, "EXECUTION", "재고 부족 409, 재고 불변"),
      c("R-04", "EDGE_AND_FAILURE", 6, "EXECUTION", "입력 검증 400 (누락, 0·음수·비정수, 키 누락)"),
      c("R-07", "EDGE_AND_FAILURE", 6, "EXECUTION", "같은 키 10건 동시 → 주문 1건, 재고 1회 차감"),
      c(
        "R-08",
        "EDGE_AND_FAILURE",
        6,
        "EXECUTION",
        "다른 키 10건 동시(재고 5) → 성공 5·실패 5, 재고 0, 음수 없음",
      ),
      {
        ...c("G1", "TEST_EFFECTIVENESS", 5, "MUTATION", "R-03·R-04 그룹 mutation 탐지"),
        groupId: "G1",
      },
      {
        ...c("G2", "TEST_EFFECTIVENESS", 5, "MUTATION", "R-05·R-06 그룹 mutation 탐지"),
        groupId: "G2",
      },
      { ...c("G3", "TEST_EFFECTIVENESS", 5, "MUTATION", "R-09 그룹 mutation 탐지"), groupId: "G3" },
      {
        ...c("R-12", "DESIGN", 10, "HUMAN_REVIEW", "계층 분리, 멱등성 저장소 추상화, 변경 용이성"),
        allowPartial: true,
      },
      c(
        "R-10",
        "REPRODUCIBILITY_AND_DOCS",
        6,
        "EXECUTION",
        "실행 계약: 시작 명령, 포트 환경변수, 헬스 10초, 리셋",
      ),
      c("R-11", "REPRODUCIBILITY_AND_DOCS", 4, "STATIC", "README 존재, 실행 방법·포트 언급"),
    ],
    groups: [
      {
        id: "G1",
        name: "경계·검증",
        criterionIds: ["R-03", "R-04"],
        mutationIds: ["M-01", "M-02"],
      },
      { id: "G2", name: "멱등성", criterionIds: ["R-05", "R-06"], mutationIds: ["M-03", "M-04"] },
      { id: "G3", name: "취소", criterionIds: ["R-09"], mutationIds: ["M-05"] },
    ],
    partialRules: [
      {
        criterionId: "R-12",
        subCriteria: [
          { id: "R-12a", description: "계층 분리", points: 4 },
          { id: "R-12b", description: "멱등성 저장소 추상화", points: 3 },
          { id: "R-12c", description: "변경 용이성", points: 3 },
        ],
      },
    ],
    independentReasons: [
      {
        criterionIds: ["R-05", "R-06", "R-07"],
        reason: "같은 근본 원인(멱등성 저장소 부재)에서 실패할 수 있으나 관측 가능한 위반이 다르다",
      },
    ],
  };
}

function c(
  id: string,
  area: Rubric["criteria"][number]["area"],
  maxPoints: number,
  method: Rubric["criteria"][number]["method"],
  condition: string,
): Rubric["criteria"][number] {
  return { id, area, title: id, maxPoints, method, condition, allowPartial: false };
}

/**
 * `rubricFromDraftOutput()`의 역변환. 테스트와 E2E의 Fake LLM이 "AI 초안" 응답으로 쓴다 (T-406).
 * `rubricFromDraftOutput(rubricToDraftOutput(r))`는 `version`을 빼고 `r`과 같다.
 */
export function rubricToDraftOutput(rubric: Rubric, notes: string[] = []): RubricDraftOutput {
  const partial = new Map(rubric.partialRules.map((r) => [r.criterionId, r.subCriteria]));
  return {
    criteria: rubric.criteria.map((criterion) => ({
      id: criterion.id,
      area: criterion.area,
      title: criterion.title,
      maxPoints: criterion.maxPoints,
      method: criterion.method,
      condition: criterion.condition,
      groupId: criterion.groupId ?? null,
      subCriteria: (partial.get(criterion.id) ?? []).map((sub) => ({
        id: sub.id,
        description: sub.description,
        maxPoints: sub.points,
      })),
    })),
    groups: rubric.groups.map((g) => ({ ...g })),
    independentReasons: rubric.independentReasons.map((r) => ({ ...r })),
    notes,
  };
}

/** 부록 A 기준을 AI 초안 응답 모양으로 옮긴 것 (validateRubric 통과) */
export function sampleRubricDraftOutput(): RubricDraftOutput {
  return rubricToDraftOutput(sampleRubric(), ["명세에 인증 요구가 없어 기준에 넣지 않았다"]);
}
