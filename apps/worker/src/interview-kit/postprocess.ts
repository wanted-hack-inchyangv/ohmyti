/**
 * INTERVIEW_KIT 후처리 (TICKET.md T-702). 결정적이며 계획 밖의 값을 만들지 않는다.
 *
 * - 슬롯 ID 대조: 계획에 없는 슬롯(`UNKNOWN_SLOT`)·같은 슬롯의 두 번째 항목(`DUPLICATE_SLOT`)·스키마에 맞지 않는 항목
 *   (`SCHEMA_INVALID`)은 버린다.
 * - `lintInterviewQuestion` 위반이 있는 항목은 통째로 버린다(`LINT_VIOLATION`, 걸린 규칙만 남긴다).
 * - 근거 참조·역량·우선순위·시간은 LLM 출력이 아니라 계획의 값을 쓴다.
 * - 문장이 없는 슬롯은 유형별 기본 질문(`source: TEMPLATE`)으로 채운다. 이력서 연결 슬롯은 맥락 연결 단계의 질문을 쓰고,
 *   그 질문이 검사에 걸리면 기본 질문으로 바꾼다.
 */
import {
  INTERVIEW_KIT_SCHEMA_VERSION,
  InterviewKitSchema,
  lintInterviewQuestion,
  maskSensitive,
  type InterviewKit,
  type InterviewKitDropped,
  type InterviewKitGeneration,
  type InterviewLintRule,
  type InterviewQuestion,
} from "@ohmyti/core";
import type { InterviewSlotPlan } from "./plan";
import { isInvalidKitItem, LLM_SLOT_KINDS, type InterviewKitItem } from "./prompt";
import { templateQuestion, type KitQuestionText } from "./templates";

function uniqueRules(rules: readonly InterviewLintRule[]): InterviewLintRule[] {
  return [...new Set(rules)].sort();
}

export interface AcceptedKitText {
  accepted: Map<string, KitQuestionText>;
  dropped: InterviewKitDropped[];
}

/** LLM 출력 항목을 슬롯 대조·검사해 받아들일 문장과 버린 항목으로 나눈다 */
export function acceptKitItems(
  items: readonly unknown[],
  plan: InterviewSlotPlan,
  secrets: readonly string[] = [],
): AcceptedKitText {
  const slots = new Map(
    plan.slots.filter((slot) => LLM_SLOT_KINDS.includes(slot.kind)).map((slot) => [slot.id, slot]),
  );
  const accepted = new Map<string, KitQuestionText>();
  const dropped: InterviewKitDropped[] = [];
  const seen = new Set<string>();
  const mask = (text: string) => maskSensitive(text.trim(), secrets);
  items.forEach((raw, index) => {
    if (isInvalidKitItem(raw)) {
      dropped.push({ index, slotId: raw.invalidItem.slotId, reason: "SCHEMA_INVALID", rules: [] });
      return;
    }
    const item = raw as InterviewKitItem;
    const slot = slots.get(item.slotId);
    if (!slot) {
      dropped.push({ index, slotId: item.slotId, reason: "UNKNOWN_SLOT", rules: [] });
      return;
    }
    // 같은 슬롯의 두 번째 항목은 앞 항목이 받아들여졌든 검사에서 버려졌든 쓰지 않는다
    if (seen.has(slot.id)) {
      dropped.push({ index, slotId: item.slotId, reason: "DUPLICATE_SLOT", rules: [] });
      return;
    }
    seen.add(slot.id);
    const text: KitQuestionText = {
      question: mask(item.question),
      intent: mask(item.intent),
      probes: item.probes.map(mask),
      positiveSignals: item.positiveSignals.map(mask),
      concernSignals: item.concernSignals.map(mask),
    };
    const violations = lintInterviewQuestion({ ...text, refs: slot.refs });
    if (violations.length > 0) {
      dropped.push({
        index,
        slotId: slot.id,
        reason: "LINT_VIOLATION",
        rules: uniqueRules(violations.map((v) => v.rule)),
      });
      return;
    }
    accepted.set(slot.id, text);
  });
  return { accepted, dropped };
}

/** 계획과 받아들인 문장으로 키트를 조립한다. 스키마 검증을 통과한 값만 돌려준다 */
export function assembleInterviewKit(input: {
  evaluationId: string;
  plan: InterviewSlotPlan;
  accepted: ReadonlyMap<string, KitQuestionText>;
  dropped: readonly InterviewKitDropped[];
  generation: Omit<InterviewKitGeneration, "slotCount" | "templateCount" | "dropped">;
}): InterviewKit {
  const dropped: InterviewKitDropped[] = [...input.dropped];
  const questions: InterviewQuestion[] = input.plan.slots.map((slot) => {
    const template = templateQuestion(slot);
    let text: KitQuestionText = template;
    let source: InterviewQuestion["source"] = "TEMPLATE";
    if (slot.resumeBridge) {
      const bridged = { ...template, question: slot.resumeBridge.question };
      const violations = lintInterviewQuestion({ ...bridged, refs: slot.refs });
      if (violations.length === 0) {
        text = bridged;
        source = "LLM";
      } else {
        dropped.push({
          index: null,
          slotId: slot.id,
          reason: "LINT_VIOLATION",
          rules: uniqueRules(violations.map((v) => v.rule)),
        });
      }
    } else {
      const written = input.accepted.get(slot.id);
      if (written) {
        text = written;
        source = "LLM";
      }
    }
    return {
      id: slot.id,
      kind: slot.kind,
      competency: slot.competency,
      priority: slot.priority,
      minutes: slot.minutes,
      question: text.question,
      intent: text.intent,
      probes: [...text.probes],
      positiveSignals: [...text.positiveSignals],
      concernSignals: [...text.concernSignals],
      refs: slot.refs,
      source,
    };
  });
  return InterviewKitSchema.parse({
    schemaVersion: INTERVIEW_KIT_SCHEMA_VERSION,
    evaluationId: input.evaluationId,
    questions,
    plans: input.plan.plans,
    generation: {
      ...input.generation,
      slotCount: questions.length,
      templateCount: questions.filter((q) => q.source === "TEMPLATE").length,
      dropped,
    },
  });
}
