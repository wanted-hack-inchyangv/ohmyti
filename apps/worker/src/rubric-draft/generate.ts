/**
 * AI 채점 기준 초안 생성 (TICKET.md T-406, 1.5의 1번 용도). 명세 → LLM → 스키마 검증 → `Rubric` 변환 → `validateRubric()`.
 *
 * - 명세는 기업이 쓴 텍스트지만 채점 규칙을 바꾸는 지시가 섞일 수 있으므로 `untrusted()` 블록으로 보낸다 (G-06).
 * - LLM은 기준의 만점(`maxPoints`)과 판정 조건 문장만 제안한다. 제출물의 점수·판정은 만들지 않는다 (G-01).
 * - 초안이 `validateRubric()`을 통과하지 못해도 버리지 않고 오류 목록과 함께 돌려준다. 사람이 고쳐 저장한다.
 */
import {
  FORBIDDEN_LIBRARY_TERMS,
  RUBRIC_TOTAL_POINTS,
  RubricDraftOutputSchema,
  RubricSchema,
  rubricFromDraftOutput,
  validateRubric,
  type Rubric,
  type RubricDraftFailureCode,
  type RubricDraftOutput,
  type RubricValidationError,
} from "@ohmyti/core";
import {
  definePrompt,
  llmStepOutcome,
  untrusted,
  type LlmClient,
  type LlmResult,
} from "@ohmyti/llm";

export const RUBRIC_DRAFT_PROMPT = definePrompt({
  purpose: "RUBRIC_DRAFT",
  id: "rubric-draft",
  version: 1,
  system: [
    "너는 코딩 과제 채점 기준(rubric) 초안을 작성하는 보조 도구다. 초안은 사람이 검토·수정·검증한 뒤에만 쓰인다.",
    "사용자 메시지에 과제 명세(untrusted 블록)와 작성 규칙, 결함 주입(mutation) 카탈로그가 주어진다.",
    "",
    "작성 규칙:",
    `1. 모든 기준의 maxPoints 합은 정확히 ${RUBRIC_TOTAL_POINTS}이다.`,
    "2. 영역(area)별 기본 배점: REQUIRED_FEATURES 40, EDGE_AND_FAILURE 25, TEST_EFFECTIVENESS 15, DESIGN 10, REPRODUCIBILITY_AND_DOCS 10. 명세가 특별히 요구하지 않으면 이 배분을 따른다.",
    "3. 테스트가 아니라 명세의 요구사항에 배점한다. 기준 하나는 관측 가능한 요구사항 하나다.",
    "4. method: EXECUTION은 실행해서 HTTP 응답·상태로 확인하는 기준, STATIC은 파일·문서 존재처럼 코드를 실행하지 않고 확인하는 기준, MUTATION은 제출 테스트의 실효성 그룹 기준, HUMAN_REVIEW는 설계처럼 사람이 확인해야 하는 기준이다.",
    "5. condition은 관측 가능한 사실(요청·응답·상태 변화)로 쓴다. 특정 라이브러리·프레임워크·도구 이름을 필수 조건으로 쓰지 않는다. 금지 예: " +
      FORBIDDEN_LIBRARY_TERMS.slice(0, 12).join(", ") +
      " 등.",
    "6. id는 R-01, R-02 …처럼 쓰고 그룹 id는 G1, G2 …로 쓴다. id는 영문·숫자·._-만 쓴다.",
    "7. TEST_EFFECTIVENESS 영역은 MUTATION 기준으로 만들고, 각 MUTATION 기준의 groupId는 groups의 id 중 하나다. 그룹의 criterionIds에는 그 그룹이 검증하는 EXECUTION 기준 id를 넣고, mutationIds에는 카탈로그에 있는 id만 넣는다(맞는 것이 없으면 빈 배열).",
    "8. 부분 점수가 필요한 기준만 subCriteria를 둔다. subCriteria의 maxPoints 합은 그 기준의 maxPoints 이하다. 필요 없으면 빈 배열이다.",
    "9. 같은 근본 원인에서 실패할 수 있지만 관측 가능한 위반이 다른 기준을 따로 감점하려면 independentReasons에 기준 id 두 개 이상과 이유를 쓴다.",
    "10. 명세가 모호하거나 가정을 둔 부분은 notes에 한 문장씩 쓴다.",
    "11. 제출물의 점수·판정·합격 여부는 쓰지 않는다.",
  ].join("\n"),
});

/** 초안 하나의 출력 토큰 상한. 기준 15개 안팎의 JSON이 들어간다 */
export const RUBRIC_DRAFT_MAX_TOKENS = 6_000;

export interface MutationCatalogHint {
  id: string;
  description: string;
}

/** 출력 형식 예시 (영역별 기본 배분을 지킨 작은 과제) */
export const RUBRIC_DRAFT_EXAMPLE: RubricDraftOutput = {
  criteria: [
    {
      id: "R-01",
      area: "REQUIRED_FEATURES",
      title: "메모 생성",
      maxPoints: 40,
      method: "EXECUTION",
      condition:
        "POST /notes에 유효한 본문을 보내면 201과 생성된 메모를 돌려주고 GET /notes/:id로 조회된다",
      groupId: null,
      subCriteria: [],
    },
    {
      id: "R-02",
      area: "EDGE_AND_FAILURE",
      title: "입력 검증",
      maxPoints: 25,
      method: "EXECUTION",
      condition:
        "제목이 비어 있거나 200자를 넘으면 400과 오류 코드를 돌려주고 메모를 만들지 않는다",
      groupId: null,
      subCriteria: [],
    },
    {
      id: "G1",
      area: "TEST_EFFECTIVENESS",
      title: "입력 검증 테스트 실효성",
      maxPoints: 15,
      method: "MUTATION",
      condition: "입력 검증을 약화한 변형을 제출 테스트가 잡는다",
      groupId: "G1",
      subCriteria: [],
    },
    {
      id: "R-03",
      area: "DESIGN",
      title: "계층 분리",
      maxPoints: 10,
      method: "HUMAN_REVIEW",
      condition: "HTTP 처리와 저장 로직이 분리되어 저장소를 바꿔도 핸들러를 고칠 필요가 없다",
      groupId: null,
      subCriteria: [],
    },
    {
      id: "R-04",
      area: "REPRODUCIBILITY_AND_DOCS",
      title: "실행 방법 문서",
      maxPoints: 10,
      method: "STATIC",
      condition: "README에 실행 명령과 포트 설정 방법이 있다",
      groupId: null,
      subCriteria: [],
    },
  ],
  groups: [{ id: "G1", name: "입력 검증", criterionIds: ["R-02"], mutationIds: [] }],
  independentReasons: [],
  notes: ["명세에 메모 삭제 규칙이 없어 기준에 넣지 않았다"],
};

export function buildRubricDraftInput(
  spec: string,
  catalog: readonly MutationCatalogHint[],
): string {
  return [
    "## 결함 주입 카탈로그 (groups.mutationIds에 쓸 수 있는 id)",
    catalog.length === 0
      ? "(없음: mutationIds는 빈 배열로 둔다)"
      : catalog.map((m) => `- ${m.id}: ${m.description}`).join("\n"),
    "",
    "## 과제 명세",
    untrusted("assignment_spec", spec),
    "",
    "위 명세로 채점 기준 초안 json을 작성한다.",
  ].join("\n");
}

export interface RubricDraftSuccess {
  status: "OK";
  rubric: Rubric;
  validationErrors: RubricValidationError[];
  notes: string[];
  droppedMutationIds: string[];
  model: string;
}

export interface RubricDraftFailure {
  status: "FAILED";
  code: RubricDraftFailureCode;
  message: string;
  errorName: string;
}

const FAILURE_BY_ERROR: Record<string, RubricDraftFailureCode> = {
  LlmOutputInvalidError: "LLM_OUTPUT_INVALID",
  LlmIncompleteOutputError: "LLM_OUTPUT_INVALID",
  LlmProviderError: "LLM_PROVIDER_ERROR",
  LlmBudgetExceededError: "LLM_NOT_RUN",
  LlmConfigError: "LLM_NOT_CONFIGURED",
};

/** LLM으로 초안을 만든다. LLM 오류는 결과 상태로 바꾸고, 그 밖의 예외는 그대로 던진다 */
export async function generateRubricDraft(input: {
  llm: LlmClient;
  spec: string;
  catalog: readonly MutationCatalogHint[];
}): Promise<RubricDraftSuccess | RubricDraftFailure> {
  const outcome = await llmStepOutcome<LlmResult<RubricDraftOutput>>(() =>
    input.llm.complete({
      purpose: RUBRIC_DRAFT_PROMPT.purpose,
      promptVersion: RUBRIC_DRAFT_PROMPT.promptVersion,
      system: RUBRIC_DRAFT_PROMPT.system,
      input: buildRubricDraftInput(input.spec, input.catalog),
      schema: RubricDraftOutputSchema,
      example: RUBRIC_DRAFT_EXAMPLE,
      maxTokens: RUBRIC_DRAFT_MAX_TOKENS,
    }),
  );
  if (outcome.status !== "OK") {
    return {
      status: "FAILED",
      code: FAILURE_BY_ERROR[outcome.errorName] ?? "LLM_PROVIDER_ERROR",
      message: outcome.reason,
      errorName: outcome.errorName,
    };
  }
  const { output, model } = outcome.value;
  const { rubric, droppedMutationIds } = rubricFromDraftOutput(output, {
    allowedMutationIds: input.catalog.map((m) => m.id),
  });
  // 변환 결과가 Rubric 형식인지 한 번 더 확인한다 (변환 코드의 결함을 저장 전에 드러낸다)
  const parsed = RubricSchema.parse(rubric);
  const validation = validateRubric(parsed);
  return {
    status: "OK",
    rubric: parsed,
    validationErrors: validation.ok ? [] : validation.errors,
    notes: output.notes,
    droppedMutationIds,
    model,
  };
}
