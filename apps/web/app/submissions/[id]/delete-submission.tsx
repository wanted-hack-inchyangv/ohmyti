"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { buttonClass, inputClassName } from "@/components/ui";
import { requestDeletionAction } from "@/lib/submissions/actions";
import type { DeletionRequested, SubmissionActionResult } from "@/lib/submissions/service";

interface DeleteSubmissionProps {
  submissionId: string;
  /** 실행 중인 제출이면 확인 문구에 "진행 중인 채점을 중단합니다"를 덧붙인다 */
  running: boolean;
}

/** 삭제하면 함께 지우는 자료 (T-506 범위). 화면 문구와 워커 동작이 같아야 한다 */
export const DELETION_TARGETS = [
  "저장소 사본(스냅샷)",
  "이력서 원본과 추출 텍스트",
  "채점 결과·근거·검토 이력",
  "실행 기록과 재현 자료(mutation 실험, AI 리뷰, 맥락 연결 포함)",
] as const;

/**
 * 제출 삭제 버튼과 확인 모달 (T-506). 검토자 이름을 입력해야 삭제를 요청할 수 있다.
 * 요청하면 제출은 곧바로 "삭제됨"이 되고 진행 중 채점은 취소되며, 워커가 자료를 지운다. 되돌릴 수 없다.
 */
export function DeleteSubmission({ submissionId, running }: DeleteSubmissionProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, startDelete] = useTransition();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function onConfirm() {
    setError(null);
    startDelete(async () => {
      let result: SubmissionActionResult<DeletionRequested>;
      try {
        result = await requestDeletionAction(submissionId, name);
      } catch {
        setError("삭제 요청을 보내지 못했습니다. 잠시 후 다시 시도해 주세요");
        return;
      }
      if (!result.ok) {
        setError(`${result.code}: ${result.message}`);
        return;
      }
      setOpen(false);
      // 같은 URL을 다시 그리면 404와 "삭제됨" 안내가 나온다
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        data-testid="delete-submission-button"
        className={`${buttonClass("ghost", "md")} self-start text-neutral-600`}
      >
        제출 삭제
      </button>
      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        aria-labelledby="delete-submission-title"
        data-testid="delete-submission-dialog"
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border-0 bg-surface p-0 text-ink shadow-[0_16px_48px_rgba(23,23,25,0.18)] backdrop:bg-ink/50"
      >
        <form
          method="dialog"
          className="flex flex-col gap-4 p-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== "" && !deleting) onConfirm();
          }}
        >
          <h2 id="delete-submission-title" className="text-xl font-bold tracking-tight">
            이 제출을 삭제할까요?
          </h2>
          <div className="flex flex-col gap-2">
            <p className="text-[15px] text-neutral-700">
              다음 자료를 함께 지우며 되돌릴 수 없습니다.
            </p>
            <ul className="flex flex-col gap-1.5 rounded-lg bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
              {DELETION_TARGETS.map((target) => (
                <li key={target} className="flex gap-2">
                  <span aria-hidden="true" className="text-neutral-400">
                    ·
                  </span>
                  {target}
                </li>
              ))}
            </ul>
          </div>
          {running ? (
            <p className="text-sm font-semibold text-ink" data-testid="delete-running-notice">
              진행 중인 채점을 먼저 취소하고 실행 환경을 정리한 뒤 지웁니다.
            </p>
          ) : null}
          <p className="text-[13px] leading-relaxed text-neutral-500">
            삭제 기록에는 제출 ID, 확인한 검토자 이름, 지운 자료의 개수만 남습니다.
          </p>
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-semibold">확인한 검토자 이름</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              autoComplete="off"
              data-testid="delete-reviewer-input"
              className={inputClassName}
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm font-medium text-fail">
              {error}
            </p>
          ) : null}
          <div className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={deleting}
              className={buttonClass("secondary", "lg")}
            >
              취소
            </button>
            <button
              type="submit"
              disabled={name.trim() === "" || deleting}
              data-testid="delete-confirm-button"
              className={buttonClass("dark", "lg")}
            >
              {deleting ? "삭제 요청 중…" : "삭제"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
