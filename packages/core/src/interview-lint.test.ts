import { describe, expect, it } from "vitest";
import {
  INTERVIEW_QUESTION_MAX_CHARS,
  countQuestionClauses,
  lintInterviewQuestion,
  lintQuestionText,
  type InterviewLintRule,
} from "./interview-lint";

const rulesOf = (text: string): InterviewLintRule[] => lintQuestionText(text).map((v) => v.rule);

/** 6단계 페르소나 실측(docs/gates/personas.json)의 후속 질문 원문 */
const PERSONA_VIOLATIONS = {
  seojin:
    "회사 시스템에서는 재고 선점을 어떤 저장소(DB/Redis)에서 어떤 격리 수준으로 구현했고, 이번 과제의 인메모리 compare-and-set 구현과 비교해 충돌 재시도 조건은 어떻게 달랐나요?",
  dohyun:
    "이력서에서는 TDD를 적용했다고 하셨는데, 이번 과제에서는 하네스가 확인한 재고 부족·입력 검증 결함을 제출 테스트가 잡지 못했습니다. 실무에서 TDD를 적용할 때 어떤 경계 조건을 테스트로 먼저 고정하는지, 이번 과제에서는 왜 그 조건이 테스트에 들어가지 않았는지 설명해 주시겠어요?",
  gaeun:
    "크로스 브라우저 이슈를 점검할 때 어떤 브라우저와 어떤 기준으로 확인했나요? 이번 과제의 API 응답 검증과는 어떤 점이 다른가요?",
} as const;

/** 위 문장을 한 문장·질문 하나·중립 어조로 고쳐 쓴 것 */
const PERSONA_REWRITES = {
  seojin:
    "회사 시스템에서 재고 선점을 구현할 때 어떤 저장소와 격리 수준을 선택했는지 설명해 주시겠어요?",
  dohyun: "TDD를 적용할 때 어떤 경계 조건을 테스트로 먼저 고정하는지 설명해 주시겠어요?",
  gaeun: "크로스 브라우저 이슈를 점검할 때 어떤 브라우저와 기준으로 확인하셨나요?",
} as const;

/** 개인 신상·차별 소지 주제 (모두 검출되어야 한다) */
const PERSONAL_TOPIC_QUESTIONS = [
  "실례지만 나이가 어떻게 되시나요?",
  "몇 살에 개발을 시작하셨나요?",
  "결혼 계획이 있으신가요?",
  "출산 휴가를 쓸 계획이 있나요?",
  "자녀가 있으면 야근이 어렵지 않으신가요?",
  "고향이 어디신가요?",
  "어느 대학을 졸업하셨나요?",
  "학점은 어느 정도였나요?",
  "건강 문제로 쉬신 적이 있나요?",
  "종교가 있으신가요?",
  "병역은 마치셨나요?",
  "군 복무 중에 개발 경험이 있으셨나요?",
  "부모님은 어떤 일을 하시나요?",
  "지지하는 정당이 있나요?",
] as const;

/** 기술 질문 (오탐이 없어야 한다). 신상 규칙과 겹치기 쉬운 단어(나이브, 키가, 장애 대응, 건강 상태, 자식 노드)를 섞었다 */
const TECHNICAL_QUESTIONS = [
  "R-06 재생 기록을 함께 보겠습니다. 기대한 응답과 실제 응답이 달라진 원인을 코드에서 짚어 주시겠어요?",
  "같은 멱등 키가 다른 본문과 함께 다시 들어오면 서버는 어떤 응답을 돌려주도록 구현하셨나요?",
  "재고 차감과 주문 저장 사이에 다른 요청이 끼어들 수 있는 구간은 어디인가요?",
  "동시에 들어온 두 요청이 같은 재고를 읽는 상황을 어떻게 막았는지 설명해 주시겠어요?",
  "처음 떠올린 나이브한 방식과 비교해 어떤 점을 더 고려하셨나요?",
  "헬스 체크 엔드포인트가 준비되기 전에 요청이 오면 어떻게 처리되나요?",
  "장애 대응 상황에서 이 서비스의 상태를 가장 먼저 확인할 지표는 무엇인가요?",
  "살아남은 변이 M-03을 잡으려면 어떤 입력과 기대값으로 테스트를 추가하시겠어요?",
  "주문 취소 뒤에 재고를 복구하는 코드가 여러 번 실행되면 어떤 일이 생기나요?",
  "입력 검증 규칙을 한곳에 모은 기준을 설명해 주세요.",
  "가장 긴 함수인 createOrder를 나눈다면 어떤 책임부터 분리하시겠어요?",
  "서버를 두 대로 늘리면 지금의 인메모리 저장소에서 무엇이 달라지나요?",
  "명시적 any를 남겨 둔 곳에는 어떤 제약이 있었나요?",
  "트래픽이 크게 늘어난다면 어느 구간이 먼저 병목이 될 것이라고 보시나요?",
  "응답 코드 409와 422 중 하나를 고른 기준은 무엇이었나요?",
  "자식 노드의 상태가 바뀔 때 부모 컴포넌트는 어떻게 알게 되나요?",
  "서버의 건강 상태를 확인하는 절차를 운영 관점에서 설명해 주시겠어요?",
  "재시도 요청이 원래 요청보다 먼저 도착하면 결과가 어떻게 달라지나요?",
  "락을 잡는 범위를 정할 때 성능과 정합성 중 무엇을 더 우선하셨나요?",
  "README에 적은 실행 절차가 실행 계약과 다를 때 어느 쪽을 기준으로 삼으셨나요?",
  "응답이 기대값과 같은지 어떻게 확인하셨나요?",
  "요청 본문이 비어 있을 때 어떤 오류 메시지를 보여 주도록 정했는지 궁금합니다.",
  "이 경험에서 본인이 맡은 범위와 가장 어려웠던 기술적 결정을 설명해 주시겠어요?",
  "p95 지연 시간을 측정할 때 어떤 도구와 부하 조건을 사용하셨나요?",
  "바쁜 대기 루프 대신 쓸 수 있는 방법에는 어떤 것이 있을까요?",
] as const;

describe("lintQuestionText: 페르소나 실측 문장", () => {
  it("seojin 예는 복합 질문(의문사가 있는 앞 절 + 의문 어미)으로 검출된다", () => {
    expect(rulesOf(PERSONA_VIOLATIONS.seojin)).toContain("COMPOUND_QUESTION");
  });

  it("dohyun 예는 추궁 어조로 검출된다", () => {
    const violations = lintQuestionText(PERSONA_VIOLATIONS.dohyun);
    expect(violations).toContainEqual({ rule: "ACCUSATORY_TONE", note: "왜 … 않았" });
    // 내포 의문절 두 개("고정하는지", "않았는지")를 한 번에 묻는 복합 질문이기도 하다
    expect(violations.map((v) => v.rule)).toContain("COMPOUND_QUESTION");
  });

  it("gaeun 예는 물음표 2개의 복합 질문으로 검출된다", () => {
    const rules = rulesOf(PERSONA_VIOLATIONS.gaeun);
    expect(rules).toContain("MULTIPLE_QUESTION_MARKS");
    expect(rules).toContain("COMPOUND_QUESTION");
  });

  it.each(Object.entries(PERSONA_REWRITES))("%s 예를 고쳐 쓴 문장은 통과한다", (_name, text) => {
    expect(lintQuestionText(text)).toEqual([]);
  });
});

describe("lintQuestionText: 개인 신상·차별 소지 주제", () => {
  it("fixture가 10개 이상이다", () => {
    expect(PERSONAL_TOPIC_QUESTIONS.length).toBeGreaterThanOrEqual(10);
  });

  it.each(PERSONAL_TOPIC_QUESTIONS)("검출한다: %s", (text) => {
    expect(rulesOf(text)).toContain("PERSONAL_TOPIC");
  });
});

describe("lintQuestionText: 기술 질문 오탐", () => {
  it("fixture가 20개 이상이다", () => {
    expect(TECHNICAL_QUESTIONS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(TECHNICAL_QUESTIONS)("위반이 없다: %s", (text) => {
    expect(lintQuestionText(text)).toEqual([]);
  });
});

describe("lintQuestionText: 규칙별", () => {
  it("의문사가 있는 앞 절과 의문 어미가 함께 있으면 복합 질문이다", () => {
    expect(rulesOf("무엇이 문제였고, 어떻게 해결하셨나요?")).toContain("COMPOUND_QUESTION");
    expect(rulesOf("어떤 방식으로 구현했고 왜 그 방식을 골랐나요?")).toContain("COMPOUND_QUESTION");
  });

  it("쉼표로 나열한 내포 의문절은 따로 센다", () => {
    expect(countQuestionClauses("어떤 조건을 먼저 고정하는지, 그 조건을 어떻게 골랐나요?")).toBe(2);
    expect(countQuestionClauses("응답이 기대값과 같은지 어떻게 확인하셨나요?")).toBe(1);
    expect(countQuestionClauses("어떤 기준으로 정했는지 설명해 주세요.")).toBe(1);
    expect(countQuestionClauses("재생 기록을 함께 보겠습니다.")).toBe(0);
  });

  it("도입 평서문 한 문장은 허용하지만 세 문장 이상은 위반이다", () => {
    expect(rulesOf("기록을 보겠습니다. 원인을 짚어 주시겠어요?")).toEqual([]);
    expect(rulesOf("기록을 보겠습니다. 실패가 있습니다. 원인을 짚어 주시겠어요?")).toContain(
      "TOO_MANY_SENTENCES",
    );
  });

  it("길이 상한을 넘으면 위반이다", () => {
    const text = `${"가".repeat(INTERVIEW_QUESTION_MAX_CHARS)} 어떻게 보시나요?`;
    expect(rulesOf(text)).toContain("TOO_LONG");
  });

  it("추궁 어조를 검출한다", () => {
    expect(rulesOf("왜 테스트를 작성하지 않았나요?")).toContain("ACCUSATORY_TONE");
    expect(rulesOf("이 조건을 처리하지 못하신 이유를 말씀해 주세요.")).toContain("ACCUSATORY_TONE");
    expect(rulesOf("이 결과를 어떻게 설명해야 할까요?")).toContain("ACCUSATORY_TONE");
  });

  it("진위 추궁을 검출한다", () => {
    expect(rulesOf("이 기능을 정말 본인이 구현하셨나요?")).toContain("VERACITY_CHALLENGE");
    expect(rulesOf("이력서에 적은 수치가 사실인지 확인할 수 있을까요?")).toContain(
      "VERACITY_CHALLENGE",
    );
  });

  it("맥락 연결 금지 표현을 검출한다", () => {
    expect(lintQuestionText("이력서가 과장된 부분은 어디라고 보시나요?")).toContainEqual({
      rule: "FORBIDDEN_EXPRESSION",
      note: "과장",
    });
  });
});

describe("lintInterviewQuestion", () => {
  const base = {
    question: PERSONA_REWRITES.dohyun,
    probes: [
      "지금 제출한 테스트 중 재고 부족을 확인하는 테스트는 어느 것인가요?",
      "그 경계 조건을 먼저 고정하면 어떤 결함을 막을 수 있나요?",
      "테스트를 더 늘리는 비용과 비교해 어디까지 고정하는 것이 적절하다고 보시나요?",
    ],
    intent: "테스트를 설계할 때 경계 조건을 고르는 기준을 확인한다.",
    positiveSignals: [
      "재고 0과 1 같은 경계값을 구체적인 입력으로 말한다.",
      "테스트가 잡는 결함을 기대값과 함께 설명한다.",
    ],
    concernSignals: ["정상 경로만 예로 든다.", "테스트 개수로만 답한다."],
    refs: [{ kind: "CRITERION", criterionId: "R-03" }],
  };

  it("위반이 없으면 빈 배열이다", () => {
    expect(lintInterviewQuestion(base)).toEqual([]);
  });

  it("꼬리 질문에 같은 규칙을 항목마다 적용하고 위치를 남긴다", () => {
    const violations = lintInterviewQuestion({
      ...base,
      probes: [base.probes[0]!, "왜 그 테스트를 넣지 않았나요? 다른 방법은 없었나요?"],
    });
    expect(violations.every((v) => v.field === "probes" && v.index === 1)).toBe(true);
    expect(violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining(["MULTIPLE_QUESTION_MARKS", "COMPOUND_QUESTION", "ACCUSATORY_TONE"]),
    );
  });

  it("의도와 신호에는 표현 규칙을 적용한다", () => {
    const violations = lintInterviewQuestion({
      ...base,
      intent: "지원자의 나이에 비해 경험이 충분한지 본다.",
      concernSignals: [base.concernSignals[0]!, "이력서 내용이 허위로 보인다."],
    });
    expect(violations).toEqual([
      { field: "intent", index: null, rule: "PERSONAL_TOPIC", note: "나이" },
      { field: "concernSignals", index: 1, rule: "FORBIDDEN_EXPRESSION", note: "허위" },
    ]);
  });

  it("의도와 신호의 인상 표현을 검출하고, 행동으로 적은 신호와 주 질문에는 적용하지 않는다 (T-702)", () => {
    const violations = lintInterviewQuestion({
      ...base,
      intent: "지원자가 열정이 있는지 본다.",
      positiveSignals: ["똑똑하게 답한다.", base.positiveSignals[1]!],
      concernSignals: [base.concernSignals[0]!, "태도가 소극적이다.", "자신감 없이 답한다."],
    });
    expect(violations).toEqual([
      { field: "intent", index: null, rule: "IMPRESSION", note: "열정·성실" },
      { field: "positiveSignals", index: 0, rule: "IMPRESSION", note: "똑똑" },
      { field: "concernSignals", index: 1, rule: "IMPRESSION", note: "태도·인상" },
      { field: "concernSignals", index: 2, rule: "IMPRESSION", note: "자신감" },
    ]);
    // 기술 문장은 걸리지 않는다
    for (const signal of [
      "락 범위와 재시도 조건을 구분해 설명한다.",
      "가격 인상 규칙을 저장소 계층에 둔 이유를 말한다.",
      "성능 저하 없이 처리량을 늘리는 방법을 비교한다.",
    ]) {
      expect(lintInterviewQuestion({ ...base, positiveSignals: [signal, signal] })).toEqual([]);
    }
  });

  it("근거 참조가 없으면 위반이다", () => {
    expect(lintInterviewQuestion({ ...base, refs: [] })).toEqual([
      { field: "refs", index: null, rule: "NO_REFS" },
    ]);
  });
});
