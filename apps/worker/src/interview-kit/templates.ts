/**
 * 슬롯 유형별 기본 질문 (TICKET.md T-702, `source: TEMPLATE`). LLM을 부르지 못했거나 LLM 문장이 검사에서 버려진 슬롯을 채운다.
 *
 * - 모든 문장은 `lintInterviewQuestion`을 통과해야 한다(테스트로 고정). 주 질문은 도입 한 문장 + 질문 하나다.
 * - 문장에 넣는 값은 기업이 승인한 rubric의 기준 ID·제목·그룹 이름과 고정 시나리오 문장뿐이다. 제출물에서 나온 문자열
 *   (관측·함수 이름·경로)은 넣지 않는다. 화면이 근거 참조(`refs`)로 그 값을 보여 준다.
 * - 꼬리 질문은 사실 → 원리 → 트레이드오프 순서다. 신호는 관찰할 수 있는 행동으로 적는다.
 */
import type { InterviewQuestion } from "@ohmyti/core";
import type { InterviewSlot } from "./plan";

export type KitQuestionText = Pick<
  InterviewQuestion,
  "question" | "intent" | "probes" | "positiveSignals" | "concernSignals"
>;

function criterionIds(slot: InterviewSlot): string {
  return slot.brief.criteria.map((c) => c.id).join("·");
}

function criterionLabel(slot: InterviewSlot): string {
  return slot.brief.criteria.map((c) => `${c.id} ${c.title}`).join(", ");
}

function failureDebrief(slot: InterviewSlot): KitQuestionText {
  const lead = slot.brief.criteria[0]?.id ?? "실패한 기준";
  return {
    question: `${lead} 재생 기록을 함께 보겠습니다. 기대한 응답과 실제 응답이 달라진 원인을 코드에서 짚어 주시겠어요?`,
    intent: `${criterionLabel(slot)}의 재생 기록에서 출발해 원인 코드 위치까지 스스로 좁혀 가는 과정을 확인한다.`,
    probes: [
      "재생 기록에서 가장 먼저 확인할 요청과 응답은 무엇인가요?",
      "그 응답이 판정 조건과 달라지는 지점은 어느 코드 경로에 있나요?",
      "이 원인을 고치는 방법이 여러 가지라면 어떤 기준으로 하나를 고르시겠어요?",
    ],
    positiveSignals: [
      "재생 기록의 기대값과 실제값에서 출발해 원인 코드 위치를 스스로 좁힌다.",
      "고치는 방법과 함께 같은 결함을 다시 잡을 테스트를 구체적인 입력으로 말한다.",
    ],
    concernSignals: [
      "재생 기록을 보지 않고 추측으로 원인을 말한다.",
      "판정 조건과 실제 동작의 차이를 구분해 말하지 않는다.",
    ],
  };
}

function testDesign(slot: InterviewSlot): KitQuestionText {
  if (slot.brief.signal) {
    return {
      question:
        "제출 테스트에서 약한 단언으로 분류된 곳을 함께 보겠습니다. 이 단언을 더 구체적인 기대값으로 바꾼다면 어떻게 쓰시겠어요?",
      intent:
        "제출 테스트의 단언이 무엇을 보장하는지 이해하고, 동작을 구분하는 기대값으로 바꿀 수 있는지 확인한다.",
      probes: [
        "지금 단언이 통과하는 응답에는 어떤 것들이 있나요?",
        "구체적인 기대값을 쓰면 어떤 결함을 추가로 잡을 수 있나요?",
        "기대값을 자세히 적을수록 테스트 유지 비용은 어떻게 달라지나요?",
      ],
      positiveSignals: [
        "단언이 통과시키는 잘못된 응답의 예를 구체적으로 든다.",
        "상태 코드와 응답 본문의 필드처럼 확인할 값을 구체적으로 정한다.",
      ],
      concernSignals: [
        "테스트 개수나 통과 여부만으로 충분하다고 답한다.",
        "단언이 보장하는 범위와 보장하지 않는 범위를 구분하지 않는다.",
      ],
    };
  }
  const group = slot.brief.groupName ?? "이 요구사항";
  const mutations = slot.brief.mutations.map((m) => m.id).join("·");
  return {
    question: `${group} 그룹에서 살아남은 변이를 함께 보겠습니다. 이 변이를 잡으려면 어떤 테스트를 추가하시겠어요?`,
    intent: `살아남은 변이(${mutations})를 근거로, 테스트가 놓친 동작을 찾아 구체적인 테스트로 옮길 수 있는지 확인한다.`,
    probes: [
      "이 변이가 바꾼 동작은 무엇인가요?",
      "지금 테스트가 이 변화를 알아차리지 못하는 이유는 어느 단언에 있나요?",
      "테스트를 더 쓰는 비용과 얻는 확신 사이에서 어디까지 쓰시겠어요?",
    ],
    positiveSignals: [
      "변이가 바꾼 동작을 구체적인 입력과 기대값으로 설명한다.",
      "추가할 테스트가 어떤 결함을 잡는지 요구사항과 연결해 말한다.",
    ],
    concernSignals: [
      "테스트 개수나 커버리지 수치만으로 충분하다고 답한다.",
      "변이가 바꾼 동작을 구체적인 입력으로 설명하지 않는다.",
    ],
  };
}

function designTradeoff(slot: InterviewSlot): KitQuestionText {
  const signal = slot.brief.signal;
  const question = signal
    ? `코드 신호의 '${signal.label}' 항목을 함께 보겠습니다. 이 부분을 지금 구조로 작성한 기준은 무엇이었나요?`
    : `${criterionIds(slot)} 설계 검토 항목을 함께 보겠습니다. 모듈과 책임을 나눈 기준은 무엇이었나요?`;
  return {
    question,
    intent: signal
      ? `관측된 코드 신호(${signal.label})를 근거로 구조를 정한 기준과 변경 비용에 대한 판단을 확인한다.`
      : `${criterionLabel(slot)} 항목에서 구조를 정한 기준과 변경 비용에 대한 판단을 확인한다.`,
    probes: [
      "이 코드가 맡고 있는 책임을 나누어 설명해 주시겠어요?",
      "요구사항이 하나 바뀌면 이 구조에서 어느 부분을 고치게 되나요?",
      "구조를 더 나누면 얻는 것과 잃는 것은 무엇인가요?",
    ],
    positiveSignals: [
      "코드의 책임을 함수와 파일 단위로 나누어 설명한다.",
      "구조를 바꿀 때의 비용과 이득을 요구사항 변경 예시로 비교한다.",
    ],
    concernSignals: [
      "구조를 정한 이유를 설명하지 않고 선호로만 답한다.",
      "변경 예시를 들 때 영향 범위를 짚지 않는다.",
    ],
  };
}

function strengthDepth(slot: InterviewSlot): KitQuestionText {
  const criterion = slot.brief.criteria[0];
  const label = criterion ? `${criterion.id} ${criterion.title}` : "이 요구사항";
  return {
    question: `${label} 기준은 통과했습니다. 이 요구사항을 보장하는 코드가 어떻게 동작하는지 설명해 주시겠어요?`,
    intent: `통과한 ${label} 기준을 지원자가 직접 설명할 수 있는지, 경계 조건에서 깨지는 조건까지 알고 있는지 확인한다.`,
    probes: [
      "이 경우를 처리하는 코드는 어느 파일과 함수에 있나요?",
      "그 처리가 올바르게 동작하는 원리는 무엇인가요?",
      "다른 구현 방식과 비교하면 지금 방식의 장단점은 무엇인가요?",
    ],
    positiveSignals: [
      "처리 코드의 위치를 스스로 찾고 동작 순서를 정확히 설명한다.",
      "이 처리가 깨지는 입력이나 동시 요청 조건을 스스로 말한다.",
    ],
    concernSignals: [
      "통과한 결과만 말하고 코드의 동작 원리를 설명하지 않는다.",
      "다른 구현 방식과의 차이를 구체적으로 비교하지 않는다.",
    ],
  };
}

function extension(slot: InterviewSlot): KitQuestionText {
  const situation = slot.brief.scenario?.situation ?? "요구사항이 바뀌는 상황";
  return {
    question: `${situation}을 가정해 보겠습니다. 지금 구현에서 가장 먼저 바꿔야 할 부분은 어디인가요?`,
    intent: `요구사항이 바뀌었을 때 현재 구현(${criterionIds(slot)})에서 영향을 받는 부분과 필요한 보장을 판단하는지 확인한다.`,
    probes: [
      "지금 구현에서 그 상황의 영향을 받는 상태는 무엇인가요?",
      "그 상태를 안전하게 다루려면 어떤 보장이 필요한가요?",
      "그 보장을 얻는 방법들 가운데 어떤 기준으로 하나를 고르시겠어요?",
    ],
    positiveSignals: [
      "영향을 받는 상태와 코드 위치를 구체적으로 짚는다.",
      "선택지마다 비용과 보장 수준을 비교해 하나를 고른다.",
    ],
    concernSignals: [
      "특정 기술 이름만 말하고 필요한 보장을 설명하지 않는다.",
      "현재 구현이 받는 영향을 구체적으로 짚지 않는다.",
    ],
  };
}

/** 이력서 연결 슬롯의 의도·꼬리 질문·신호. 주 질문은 맥락 연결의 질문을 그대로 쓰고, 검사에 걸리면 `question`으로 바꾼다 */
function resumeBridge(): KitQuestionText {
  return {
    question: "이력서에 적은 이 경험에서 맡은 역할과 내린 결정을 구체적으로 설명해 주시겠어요?",
    intent: "이력서 주장과 과제 관측을 이어서, 비슷한 문제를 어떤 조건에서 다뤘는지 확인한다.",
    probes: [
      "그 경험에서 사용한 방식은 무엇이었나요?",
      "그 방식이 필요했던 조건은 무엇이었나요?",
      "이번 과제의 조건이라면 같은 방식을 고르시겠어요?",
    ],
    positiveSignals: [
      "경험의 조건과 본인이 맡은 범위를 구분해 말한다.",
      "과제와 경험의 조건 차이를 스스로 비교한다.",
    ],
    concernSignals: [
      "본인이 맡은 범위와 팀의 결과를 구분하지 않는다.",
      "경험의 조건을 구체적으로 설명하지 않는다.",
    ],
  };
}

/** 슬롯의 기본 질문 */
export function templateQuestion(slot: InterviewSlot): KitQuestionText {
  switch (slot.kind) {
    case "FAILURE_DEBRIEF":
      return failureDebrief(slot);
    case "TEST_DESIGN":
      return testDesign(slot);
    case "DESIGN_TRADEOFF":
      return designTradeoff(slot);
    case "STRENGTH_DEPTH":
      return strengthDepth(slot);
    case "EXTENSION":
      return extension(slot);
    case "RESUME_BRIDGE":
      return resumeBridge();
  }
}
