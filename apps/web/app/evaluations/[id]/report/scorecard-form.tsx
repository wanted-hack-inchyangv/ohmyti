"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import {
  ANCHOR_LABELS,
  SCORECARD_INTERVIEWER_MAX,
  SCORECARD_NOTE_MAX,
  type AnchorValue,
  type Competency,
  type HiringReport,
  type InterviewScorecard,
} from "@ohmyti/core";
import { buttonClass } from "@/components/ui";
import { saveScorecardAction } from "@/lib/scorecards/actions";
import type { InterviewGuideQuestionView } from "@/lib/reports/hiring-report-view";

/**
 * 면접관 스코어카드 입력 폼 (TICKET.md T-707, PRD 14.3의 8절).
 *
 * - 값은 면접관이 직접 고르고 적는다. 화면은 어떤 칸도 미리 채우지 않는다 (G-01, G-08).
 * - 저장은 새 기록을 쌓는 방식이라 같은 면접관이 다시 저장해도 이전 기록이 남는다.
 * - 평균·합산·등급을 만들지 않는다. 여러 면접관의 기록을 나란히 보일 뿐이다 (G-13, PRD 14.4).
 * - 인쇄물에는 손으로 적는 빈 양식과 저장된 기록만 싣고 입력 폼은 감춘다(`data-print-hide`).
 */

const ANCHOR_VALUES: readonly AnchorValue[] = [1, 2, 3, 4];

type CompetencyRow = HiringReport["scorecard"]["competencies"][number];

const inputClass =
  "w-full rounded-lg border border-neutral-300 bg-surface px-3 py-2 text-[13px] text-ink outline-none placeholder:text-neutral-400 hover:border-neutral-400 focus:border-primary focus:ring-2 focus:ring-primary/15";

interface Draft {
  value: AnchorValue | null;
  note: string;
}

export function ScorecardForm({
  evaluationId,
  competencies,
  questions,
}: {
  evaluationId: string;
  competencies: readonly CompetencyRow[];
  questions: readonly InterviewGuideQuestionView[];
}) {
  const router = useRouter();
  const formId = useId();
  const [interviewer, setInterviewer] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [questionNotes, setQuestionNotes] = useState<Record<string, string>>({});
  const [finalNote, setFinalNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function draftOf(competency: Competency): Draft {
    return drafts[competency] ?? { value: null, note: "" };
  }

  function reset() {
    setDrafts({});
    setQuestionNotes({});
    setFinalNote("");
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (interviewer.trim() === "") {
      setError("면접관 이름을 입력하세요.");
      return;
    }
    const entries = competencies.map((row) => {
      const draft = draftOf(row.competency);
      return { competency: row.competency, value: draft.value, note: draft.note };
    });
    const notes = questions
      .map((question) => ({
        questionId: question.questionId,
        number: question.number,
        note: (questionNotes[question.questionId] ?? "").trim(),
      }))
      .filter((note) => note.note !== "");
    const filled =
      finalNote.trim() !== "" ||
      notes.length > 0 ||
      entries.some((entry) => entry.value !== null || entry.note.trim() !== "");
    if (!filled) {
      setError("척도나 메모를 하나 이상 적어야 저장할 수 있습니다.");
      return;
    }
    startTransition(async () => {
      const result = await saveScorecardAction(evaluationId, {
        interviewer,
        competencies: entries,
        questionNotes: notes,
        finalNote,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setMessage(
        `${result.data.saved.interviewer}의 스코어카드를 저장했습니다. 이전 기록은 이력으로 남습니다.`,
      );
      reset();
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      data-print-hide
      data-testid="scorecard-form"
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3 print:hidden"
      noValidate
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-[13px] font-bold text-ink">스코어카드 기록</h3>
        <p className="text-[12px] text-neutral-500">
          면접을 마친 뒤 직접 기입합니다. 시스템은 값을 제안하지 않으며 평균과 합산을 내지 않습니다.
          저장하면 이전 기록이 이력으로 남습니다.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-[12px]">
        <span className="font-semibold text-neutral-800">면접관</span>
        <input
          name="interviewer"
          type="text"
          value={interviewer}
          maxLength={SCORECARD_INTERVIEWER_MAX}
          onChange={(e) => setInterviewer(e.target.value)}
          placeholder="이름"
          data-testid="scorecard-interviewer"
          className={`${inputClass} sm:max-w-xs`}
        />
      </label>

      <div className="flex flex-col gap-2">
        {competencies.map((row) => {
          const draft = draftOf(row.competency);
          return (
            <fieldset
              key={row.competency}
              data-scorecard-input={row.competency}
              className="flex flex-col gap-1.5 rounded-lg border border-neutral-200 p-2.5"
            >
              <legend className="px-1 text-[12px] font-semibold text-neutral-800">
                {row.name}
                {row.interviewOnly ? " · 면접에서만 확인" : ""}
              </legend>
              <div className="flex flex-wrap items-center gap-3 text-[12px] text-neutral-700">
                {ANCHOR_VALUES.map((value) => (
                  <label key={value} className="flex cursor-pointer items-center gap-1">
                    <input
                      type="radio"
                      name={`${formId}-${row.competency}`}
                      value={value}
                      checked={draft.value === value}
                      onChange={() =>
                        setDrafts((prev) => ({
                          ...prev,
                          [row.competency]: { ...draft, value },
                        }))
                      }
                      className="accent-primary"
                    />
                    {value} {ANCHOR_LABELS[value]}
                  </label>
                ))}
                <button
                  type="button"
                  className="text-[12px] text-neutral-500 underline"
                  onClick={() =>
                    setDrafts((prev) => ({ ...prev, [row.competency]: { ...draft, value: null } }))
                  }
                >
                  선택 지우기
                </button>
              </div>
              <input
                type="text"
                value={draft.note}
                maxLength={SCORECARD_NOTE_MAX}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [row.competency]: { ...draft, note: e.target.value },
                  }))
                }
                placeholder="관찰한 내용 메모"
                className={inputClass}
              />
            </fieldset>
          );
        })}
      </div>

      {questions.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="scorecard-question-notes">
          <h4 className="text-[12px] font-semibold text-neutral-800">질문별 메모</h4>
          {questions.map((question) => (
            <label key={question.questionId} className="flex flex-col gap-1 text-[12px]">
              <span className="text-neutral-600">
                {question.label} {question.question}
              </span>
              <input
                type="text"
                value={questionNotes[question.questionId] ?? ""}
                maxLength={SCORECARD_NOTE_MAX}
                onChange={(e) =>
                  setQuestionNotes((prev) => ({ ...prev, [question.questionId]: e.target.value }))
                }
                placeholder="답변에서 관찰한 내용"
                className={inputClass}
              />
            </label>
          ))}
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-[12px]">
        <span className="font-semibold text-neutral-800">면접관 최종 의견</span>
        <textarea
          rows={3}
          value={finalNote}
          maxLength={SCORECARD_NOTE_MAX}
          onChange={(e) => setFinalNote(e.target.value)}
          data-testid="scorecard-final-note"
          className={inputClass}
        />
      </label>

      {error ? (
        <p
          className="rounded-lg bg-neutral-100 px-3 py-2 text-[12px] text-neutral-800"
          role="alert"
          data-testid="scorecard-error"
        >
          {error}
        </p>
      ) : null}
      {message ? (
        <p
          className="rounded-lg bg-primary/5 px-3 py-2 text-[12px] text-neutral-800"
          role="status"
          data-testid="scorecard-saved"
        >
          {message}
        </p>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          data-testid="scorecard-submit"
          className={buttonClass("primary", "sm")}
        >
          {pending ? "저장 중…" : "스코어카드 저장"}
        </button>
      </div>
    </form>
  );
}

/** 저장된 스코어카드 목록. 면접관이 여러 명이면 나란히 보이며 합산하지 않는다 */
export function SavedScorecards({
  saved,
  competencyNames,
}: {
  saved: readonly InterviewScorecard[];
  competencyNames: Readonly<Record<string, string>>;
}) {
  if (saved.length === 0) {
    return (
      <p className="text-[12px] text-neutral-500" data-testid="scorecard-saved-empty">
        저장된 스코어카드가 없습니다.
      </p>
    );
  }
  return (
    <div
      className="flex flex-col gap-2 sm:grid sm:grid-cols-2 print:grid print:grid-cols-2 print:gap-1.5"
      data-testid="scorecard-saved-list"
    >
      {saved.map((card) => {
        const filled = card.competencies.filter((c) => c.value !== null || c.note !== null);
        return (
          <article
            key={card.id}
            data-scorecard-saved={card.id}
            data-interviewer={card.interviewer}
            data-latest={card.latest ? "true" : "false"}
            className="report-card flex flex-col gap-1 rounded-lg border border-neutral-200 p-3 text-[12px]"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h4 className="text-[13px] font-bold text-ink">
                {card.interviewer}
                {card.latest ? "" : " · 이전 기록"}
              </h4>
              <span className="text-neutral-500">{card.createdAt}</span>
            </div>
            {filled.length === 0 ? (
              <p className="text-neutral-500">역량 기입 없음</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-neutral-700">
                {filled.map((entry) => (
                  <li key={entry.competency} data-competency={entry.competency}>
                    {competencyNames[entry.competency] ?? entry.competency}:{" "}
                    {entry.value === null
                      ? "미기입"
                      : `${entry.value} ${ANCHOR_LABELS[entry.value]}`}
                    {entry.note ? ` · ${entry.note}` : ""}
                  </li>
                ))}
              </ul>
            )}
            {card.questionNotes.length > 0 ? (
              <ul className="flex flex-col gap-0.5 text-neutral-700">
                {card.questionNotes.map((note) => (
                  <li key={note.questionId}>
                    질문 {note.number === null ? note.questionId : `Q${note.number}`}: {note.note}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-neutral-700">
              최종 의견: {card.finalNote === null ? "적지 않음" : card.finalNote}
            </p>
          </article>
        );
      })}
    </div>
  );
}
