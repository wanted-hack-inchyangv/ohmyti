"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { buttonClass } from "@/components/ui";
import { submitReviewAction } from "@/lib/reviews/actions";
import type { ReviewActionsView } from "@/lib/workbench/evidence-panel";

/**
 * 검토 액션 (TICKET.md T-306): 확인(CONFIRM)·점수 수정(OVERRIDE)·이의 제기(DISPUTE)·설계 점수 확정(APPROVE_DESIGN).
 * 브라우저 `confirm()` 대신 `<dialog>` 모달을 쓴다. 입력은 브라우저에서 한 번 검사하고 서버 액션(`applyReviewAction`)이 다시 검사한다.
 * 성공하면 `router.refresh()`로 서버 컴포넌트를 다시 그려 헤더 점수·판정 배지·이력이 저장값으로 갱신된다. 삭제 액션은 없다.
 */

export type ReviewActionKind = "CONFIRM" | "OVERRIDE" | "DISPUTE" | "APPROVE_DESIGN";

export const ACTION_LABEL: Record<ReviewActionKind, string> = {
  CONFIRM: "확인",
  OVERRIDE: "점수 수정",
  DISPUTE: "이의 제기",
  APPROVE_DESIGN: "설계 점수 확정",
};

const ACTION_DESCRIPTION: Record<ReviewActionKind, string> = {
  CONFIRM: "판정과 점수를 그대로 두고 사람이 확인했다고 기록합니다.",
  OVERRIDE:
    "점수를 직접 정합니다. 배점 이하의 정수만 받으며 사유와 검토자가 필요합니다. 원래 값은 이력에 남습니다.",
  DISPUTE: "점수는 두고 이의 메모를 남깁니다. 기준은 다시 검토 대기가 됩니다.",
  APPROVE_DESIGN:
    "충족한 하위 기준을 고르면 rubric 배점 합으로 점수를 확정합니다. 확정 전까지는 미확정 배점입니다.",
};

interface FieldErrors {
  reviewer?: string;
  reason?: string;
  earnedPoints?: string;
}

/** 서버(`ReviewActionInputSchema`·`planReviewAction`)와 같은 규칙으로 브라우저에서 먼저 검사한다 */
export function validateReviewFields(
  kind: ReviewActionKind,
  values: {
    reviewer: string;
    reason: string;
    earnedPoints: string;
    maxPoints: number;
    deduction: boolean;
  },
): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.reviewer.trim()) errors.reviewer = "검토자를 입력하세요";
  if ((kind === "OVERRIDE" || kind === "DISPUTE") && !values.reason.trim()) {
    errors.reason = kind === "DISPUTE" ? "이의 메모를 입력하세요" : "사유를 입력하세요";
  }
  if (kind === "APPROVE_DESIGN" && values.deduction && !values.reason.trim()) {
    errors.reason = "감점하려면 사유를 입력하세요";
  }
  if (kind === "OVERRIDE") {
    const raw = values.earnedPoints.trim();
    const n = Number(raw);
    if (raw === "" || !Number.isInteger(n)) errors.earnedPoints = "점수는 정수여야 합니다";
    else if (n < 0) errors.earnedPoints = "점수는 음수일 수 없습니다";
    else if (n > values.maxPoints)
      errors.earnedPoints = `점수는 배점(${values.maxPoints}) 이하여야 합니다`;
  }
  return errors;
}

// 입력 오류 테두리는 진한 회색이다. 빨강(fail)은 실제 FAIL 판정에만 쓴다 (T-301 토큰 규칙)
const inputClass =
  "w-full rounded-lg border border-neutral-300 bg-surface px-3 py-2.5 text-[15px] text-ink outline-none placeholder:text-neutral-400 hover:border-neutral-400 focus:border-primary focus:ring-2 focus:ring-primary/15 aria-[invalid=true]:border-ink aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-ink";

export function ReviewActions({ actions }: { actions: ReviewActionsView }) {
  const [open, setOpen] = useState<ReviewActionKind | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const kinds: ReviewActionKind[] = actions.canApproveDesign
    ? ["APPROVE_DESIGN", "CONFIRM", "OVERRIDE", "DISPUTE"]
    : ["CONFIRM", "OVERRIDE", "DISPUTE"];
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="review-actions">
      <p className="text-sm font-bold text-ink">사람 검토</p>
      <div className="flex flex-wrap gap-2">
        {kinds.map((kind, index) => (
          <button
            key={kind}
            type="button"
            onClick={() => {
              setLastMessage(null);
              setOpen(kind);
            }}
            data-testid={`review-action-${kind}`}
            className={buttonClass(index === 0 ? "primary" : "secondary", "sm")}
          >
            {ACTION_LABEL[kind]}
          </button>
        ))}
      </div>
      {lastMessage ? (
        <p
          className="rounded-lg bg-primary/5 px-3 py-2 text-[13px] text-neutral-800"
          data-testid="review-result"
          role="status"
        >
          {lastMessage}
        </p>
      ) : null}
      {open ? (
        <ReviewDialog
          kind={open}
          actions={actions}
          onClose={() => setOpen(null)}
          onApplied={(message) => {
            setLastMessage(message);
            setOpen(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ReviewDialog({
  kind,
  actions,
  onClose,
  onApplied,
}: {
  kind: ReviewActionKind;
  actions: ReviewActionsView;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const router = useRouter();
  const [reviewer, setReviewer] = useState("");
  const [reason, setReason] = useState("");
  const [earnedPoints, setEarnedPoints] = useState(
    actions.earnedPoints === null ? "" : String(actions.earnedPoints),
  );
  const [satisfied, setSatisfied] = useState<string[]>(
    actions.subCriteria.filter((s) => s.satisfied).map((s) => s.id),
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // 모달 안의 미리보기 합계다. 확정 점수는 서버(`planReviewAction`·`aggregateScore`)가 rubric으로 다시 계산한다
  const approvePoints = actions.subCriteria
    .filter((s) => satisfied.includes(s.id))
    .map((s) => s.points)
    .reduce((a, b) => a + b, 0);
  const deduction = kind === "APPROVE_DESIGN" && approvePoints < actions.maxPoints;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validateReviewFields(kind, {
      reviewer,
      reason,
      earnedPoints,
      maxPoints: actions.maxPoints,
      deduction,
    });
    setFieldErrors(errors);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;
    const input =
      kind === "OVERRIDE"
        ? { kind, reviewer, reason, earnedPoints: Number(earnedPoints) }
        : kind === "APPROVE_DESIGN"
          ? { kind, reviewer, reason, satisfiedSubCriterionIds: satisfied }
          : { kind, reviewer, reason };
    startTransition(async () => {
      const result = await submitReviewAction(
        { evaluationId: actions.evaluationId, criterionId: actions.criterionId },
        input,
      );
      if (!result.ok) {
        setServerError(result.message);
        return;
      }
      onApplied(
        `${ACTION_LABEL[kind]} 저장됨 · ${actions.criterionId} ${result.data.criterion.earnedPoints ?? "?"}/${actions.maxPoints} · 점수 ${result.data.score.display}`,
      );
      router.refresh();
    });
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby={titleId}
      data-testid="review-dialog"
      data-review-kind={kind}
      className="m-auto w-[30rem] max-w-[calc(100vw-2rem)] rounded-xl border-0 bg-surface p-0 text-ink shadow-[0_16px_48px_rgba(23,23,25,0.16)] backdrop:bg-ink/40"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4 p-6" noValidate>
        <div className="flex flex-col gap-1.5">
          <h3 id={titleId} className="text-lg font-bold tracking-tight">
            {ACTION_LABEL[kind]} · {actions.criterionId}
          </h3>
          <p className="text-sm leading-relaxed text-neutral-600">{ACTION_DESCRIPTION[kind]}</p>
        </div>

        {kind === "APPROVE_DESIGN" ? (
          <fieldset className="flex flex-col gap-2" data-testid="sub-criteria">
            <legend className="mb-2 text-sm font-semibold text-neutral-800">
              충족한 하위 기준 · 합계 {approvePoints}/{actions.maxPoints}
            </legend>
            {actions.subCriteria.map((sub) => (
              <label
                key={sub.id}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-neutral-200 px-3 py-2.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <input
                  type="checkbox"
                  name="satisfied"
                  value={sub.id}
                  checked={satisfied.includes(sub.id)}
                  onChange={(e) =>
                    setSatisfied((prev) =>
                      e.target.checked ? [...prev, sub.id] : prev.filter((id) => id !== sub.id),
                    )
                  }
                  className="mt-1 accent-primary"
                />
                <span>
                  <code className="font-mono text-[13px]">{sub.id}</code> · {sub.points}점 ·{" "}
                  {sub.description}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {kind === "OVERRIDE" ? (
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-semibold text-neutral-800">
              새 점수 (0 ~ {actions.maxPoints})
            </span>
            <input
              name="earnedPoints"
              type="number"
              inputMode="numeric"
              min={0}
              max={actions.maxPoints}
              step={1}
              value={earnedPoints}
              onChange={(e) => setEarnedPoints(e.target.value)}
              aria-invalid={fieldErrors.earnedPoints ? "true" : undefined}
              className={inputClass}
            />
            {fieldErrors.earnedPoints ? (
              <span className="text-[13px] font-medium text-ink" data-testid="error-earnedPoints">
                {fieldErrors.earnedPoints}
              </span>
            ) : null}
          </label>
        ) : null}

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold text-neutral-800">검토자</span>
          <input
            name="reviewer"
            type="text"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            aria-invalid={fieldErrors.reviewer ? "true" : undefined}
            className={inputClass}
            placeholder="이름 또는 이메일"
          />
          {fieldErrors.reviewer ? (
            <span className="text-[13px] font-medium text-ink" data-testid="error-reviewer">
              {fieldErrors.reviewer}
            </span>
          ) : null}
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold text-neutral-800">
            {kind === "DISPUTE" ? "이의 메모" : "사유"}
            {kind === "OVERRIDE" || kind === "DISPUTE" || deduction ? " (필수)" : " (선택)"}
          </span>
          <textarea
            name="reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={fieldErrors.reason ? "true" : undefined}
            className={inputClass}
          />
          {fieldErrors.reason ? (
            <span className="text-[13px] font-medium text-ink" data-testid="error-reason">
              {fieldErrors.reason}
            </span>
          ) : null}
        </label>

        {serverError ? (
          <p
            className="rounded-lg bg-neutral-100 px-3 py-2 text-[13px] text-neutral-800"
            data-testid="review-server-error"
            role="alert"
          >
            {serverError}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className={buttonClass("secondary", "md")}
            disabled={pending}
          >
            취소
          </button>
          <button
            type="submit"
            className={buttonClass("primary", "md")}
            disabled={pending}
            data-testid="review-submit"
          >
            {pending ? "저장 중…" : `${ACTION_LABEL[kind]} 저장`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
