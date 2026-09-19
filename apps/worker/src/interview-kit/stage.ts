/**
 * INTERVIEW_KIT 단계 (TICKET.md T-702, PRD 14.2). 평가 파이프라인의 마지막 단계다.
 *
 * 입력 수집(`facts.ts`) → 질문 계획(`plan.ts`, 결정적) → LLM 1회로 슬롯별 문장 작성(`prompt.ts`) → 슬롯 대조·검사(`postprocess.ts`)
 * → 문장이 없는 슬롯은 기본 질문 → 아티팩트 `evaluations/<id>/interview-kit.json` 저장.
 *
 * - 점수·판정을 읽기만 한다. 판정 행과 평가 합계를 쓰지 않고, 키트는 판정 digest 대상이 아니다 (G-01).
 * - 예산 초과·설정 없음·결과 미확정은 CONTEXT_LINK와 같은 사유 문구로 단계 DONE + 사유이며, 이때도 기본 질문 키트를 저장한다 (G-14).
 * - 단계 기록에는 생성 요약(슬롯 수, 기본 질문 수, LLM 상태, 버린 항목과 사유)만 남기고 문장은 아티팩트에만 둔다.
 */
import { ARTIFACT_CONTENT_TYPES, artifactKeys, type ArtifactStore } from "@ohmyti/storage";
import {
  CONTEXT_LINK_BUDGET_EXCEEDED_REASON,
  CONTEXT_LINK_INCONCLUSIVE_REASON,
  CONTEXT_LINK_LLM_CONFIG_REASON,
  CONTEXT_LINK_LLM_NOT_CONFIGURED_REASON,
  type EvaluationStageRecord,
  type ExecutionContract,
  type InterviewKit,
  type InterviewKitDropped,
  type InterviewKitGeneration,
  type Rubric,
} from "@ohmyti/core";
import { listAiReviews, type Database } from "@ohmyti/db";
import {
  llmInputDigest,
  llmStepOutcome,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
} from "@ohmyti/llm";
import type { Logger } from "../logger";
import { collectInterviewKitFacts } from "./facts";
import { planInterviewSlots } from "./plan";
import { acceptKitItems, assembleInterviewKit } from "./postprocess";
import {
  buildInterviewKitInput,
  INTERVIEW_KIT_EXAMPLE,
  INTERVIEW_KIT_MAX_TOKENS,
  INTERVIEW_KIT_PROMPT,
  InterviewKitLenientOutputSchema,
  LLM_SLOT_KINDS,
  type InterviewKitOutput,
} from "./prompt";
import type { KitQuestionText } from "./templates";

export interface InterviewKitStageInput {
  evaluationId: string;
  submissionId: string;
  rubric: Rubric;
  contract: ExecutionContract;
  /** 과제 버전의 제목과 명세 원문 아티팩트 */
  spec: { title: string; specRef: string };
  stageLog: readonly EvaluationStageRecord[];
}

export interface InterviewKitStageDeps {
  db: Database;
  store: ArtifactStore;
  logger: Logger;
  /** evaluation 예산·기록을 감싼 LLM 클라이언트. 없으면 기본 질문만으로 키트를 만든다 */
  llm?: LlmClient | undefined;
  secrets?: readonly string[] | undefined;
}

export type InterviewKitStageSummary = InterviewKitGeneration & {
  artifactKey: string;
  /** 우선순위별 질문 수 */
  priorities: { MUST: number; SHOULD: number; OPTIONAL: number };
};

export interface InterviewKitStageOutcome {
  state: "DONE";
  /** LLM을 부르지 못했거나 결과가 미확정일 때의 사유 */
  reason?: string | undefined;
  detail: InterviewKitStageSummary;
  kit: InterviewKit;
}

export async function runInterviewKitStage(
  input: InterviewKitStageInput,
  deps: InterviewKitStageDeps,
): Promise<InterviewKitStageOutcome> {
  const { db, store, logger } = deps;
  const facts = await collectInterviewKitFacts(input, { db, store });
  const plan = planInterviewSlots(facts);
  const llmSlots = plan.slots.filter((slot) => LLM_SLOT_KINDS.includes(slot.kind));

  let generation: Omit<InterviewKitGeneration, "slotCount" | "templateCount" | "dropped"> = {
    llm: "NOT_CONFIGURED",
    llmReason: CONTEXT_LINK_LLM_NOT_CONFIGURED_REASON,
    promptVersion: INTERVIEW_KIT_PROMPT.promptVersion,
    model: null,
    aiReviewId: null,
    inputDigest: null,
  };
  let accepted = new Map<string, KitQuestionText>();
  let dropped: InterviewKitDropped[] = [];

  if (deps.llm && llmSlots.length > 0) {
    const llm = deps.llm;
    const request: LlmRequest<InterviewKitOutput> = {
      purpose: INTERVIEW_KIT_PROMPT.purpose,
      promptVersion: INTERVIEW_KIT_PROMPT.promptVersion,
      system: INTERVIEW_KIT_PROMPT.system,
      input: buildInterviewKitInput({ spec: facts.spec, slots: llmSlots }),
      schema: InterviewKitLenientOutputSchema,
      example: INTERVIEW_KIT_EXAMPLE,
      maxTokens: INTERVIEW_KIT_MAX_TOKENS,
    };
    const outcome = await llmStepOutcome<LlmResult<InterviewKitOutput>>(() =>
      llm.complete(request),
    );
    if (outcome.status === "NOT_RUN") {
      generation = {
        ...generation,
        llm: "NOT_RUN",
        llmReason:
          outcome.errorName === "LlmBudgetExceededError"
            ? CONTEXT_LINK_BUDGET_EXCEEDED_REASON
            : CONTEXT_LINK_LLM_CONFIG_REASON,
      };
    } else if (outcome.status === "INCONCLUSIVE") {
      generation = {
        ...generation,
        llm: "INCONCLUSIVE",
        llmReason: CONTEXT_LINK_INCONCLUSIVE_REASON,
        inputDigest: llmInputDigest(request),
      };
    } else {
      // 방금 호출의 기록 (RecordingLlmClient가 남긴 마지막 행). 기록하지 않는 클라이언트면 없다
      const reviews = await listAiReviews(db, {
        evaluationId: input.evaluationId,
        kind: "INTERVIEW_KIT",
      });
      const latest = reviews.at(-1) ?? null;
      const processed = acceptKitItems(outcome.value.output.questions, plan, deps.secrets ?? []);
      accepted = processed.accepted;
      dropped = processed.dropped;
      generation = {
        ...generation,
        llm: "OK",
        llmReason: null,
        model: outcome.value.model,
        aiReviewId:
          latest && latest.promptVersion === INTERVIEW_KIT_PROMPT.promptVersion ? latest.id : null,
        inputDigest: llmInputDigest(request),
      };
    }
  }

  const kit = assembleInterviewKit({
    evaluationId: input.evaluationId,
    plan,
    accepted,
    dropped,
    generation,
  });
  const artifactKey = artifactKeys.interviewKit(input.evaluationId);
  await store.put(artifactKey, JSON.stringify(kit, null, 2), {
    contentType: ARTIFACT_CONTENT_TYPES.interviewKit,
  });
  const priorities = { MUST: 0, SHOULD: 0, OPTIONAL: 0 };
  for (const question of kit.questions) priorities[question.priority] += 1;
  const detail: InterviewKitStageSummary = { ...kit.generation, artifactKey, priorities };
  logger.info(
    {
      slots: detail.slotCount,
      templates: detail.templateCount,
      priorities,
      llm: detail.llm,
      dropped: detail.dropped.map((d) => `${d.slotId ?? d.index}:${d.reason}`),
    },
    "인터뷰 키트",
  );
  return {
    state: "DONE",
    ...(generation.llmReason ? { reason: generation.llmReason } : {}),
    detail,
    kit,
  };
}
