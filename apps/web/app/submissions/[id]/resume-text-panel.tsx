"use client";

import { useState, useTransition } from "react";
import { buttonClass } from "@/components/ui";
import { saveManualResumeTextAction } from "@/lib/submissions/actions";
import {
  IMAGE_ONLY_NOTICE,
  MAX_MANUAL_RESUME_CHARS,
  RESUME_TEXT_STATUS_LABEL,
} from "@/lib/submissions/resume-text";
import type { ResumeTextView, SubmissionActionResult } from "@/lib/submissions/service";

interface ResumeTextPanelProps {
  submissionId: string;
  initial: ResumeTextView;
}

/**
 * 이력서 텍스트 상태 (T-501). 텍스트를 추출하지 못한 이력서(IMAGE_ONLY, 상한 초과 등)는 추출한 척하지 않고
 * 안내와 입력란을 보여 준다. OCR은 하지 않는다. 저장하면 MANUAL이 된다.
 * 본문은 서버에서 받지 않으므로 이미 입력한 텍스트를 고칠 때도 새로 입력한다.
 */
export function ResumeTextPanel({ submissionId, initial }: ResumeTextPanelProps) {
  const [view, setView] = useState(initial);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, startSave] = useTransition();
  // 폴링으로 새 상태가 오면(추출이 끝나면) 그 값을 따른다. 저장 직후 값은 저장 결과가 우선한다
  const current = saved ? view : initial;

  function onSave() {
    setError(null);
    startSave(async () => {
      let result: SubmissionActionResult<ResumeTextView>;
      try {
        result = await saveManualResumeTextAction(submissionId, text);
      } catch {
        setError("저장 요청을 보내지 못했습니다. 잠시 후 다시 시도해 주세요");
        return;
      }
      if (!result.ok) {
        setError(`${result.code}: ${result.message}`);
        return;
      }
      setView(result.data);
      setSaved(true);
      setText("");
    });
  }

  const needsInput = current.status === "IMAGE_ONLY" || current.status === "NONE";

  return (
    <section
      className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-surface p-5 sm:p-6"
      data-testid="resume-text-panel"
      data-status={current.status}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-lg font-bold tracking-tight">이력서 텍스트</h2>
        <span className="inline-flex items-center rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-700">
          {RESUME_TEXT_STATUS_LABEL[current.status]}
        </span>
      </div>
      {current.chars !== null && (current.status === "EXTRACTED" || current.status === "MANUAL") ? (
        <p className="-mt-2 text-sm text-neutral-500">
          <span>
            {current.chars.toLocaleString("ko-KR")}자 · 맥락 연결에만 쓰며 채점에는 쓰지 않습니다
          </span>
        </p>
      ) : null}

      {current.manualInputAllowed && needsInput ? (
        <div
          role="status"
          className="flex flex-col gap-1.5 rounded-lg bg-neutral-50 p-4 ring-1 ring-neutral-200"
          data-testid="resume-image-only-notice"
        >
          <p className="text-[15px] font-bold text-ink">{IMAGE_ONLY_NOTICE}</p>
          {current.reason ? (
            <p className="text-[13px] break-all text-neutral-700" data-testid="resume-text-reason">
              {current.reason}
            </p>
          ) : null}
          <p className="text-[13px] leading-relaxed text-neutral-600">
            스캔·이미지 문서는 OCR로 읽지 않습니다. 입력한 텍스트는 맥락 연결에만 쓰며 채점에는 쓰지
            않습니다.
          </p>
        </div>
      ) : null}

      {current.manualInputAllowed ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="manual-resume-text" className="text-sm font-semibold text-ink">
            {current.status === "MANUAL" ? "텍스트 다시 입력" : "이력서 텍스트"}
          </label>
          <textarea
            id="manual-resume-text"
            name="resumeText"
            data-testid="manual-resume-text"
            rows={8}
            maxLength={MAX_MANUAL_RESUME_CHARS}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="w-full rounded-lg border border-neutral-300 bg-surface px-4 py-3 text-[15px] leading-relaxed text-ink placeholder:text-neutral-400 hover:border-neutral-400 focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none"
            placeholder="이력서 본문을 붙여 넣으세요"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSave}
              disabled={saving || text.trim().length === 0}
              data-testid="manual-resume-save"
              className={buttonClass("primary", "md")}
            >
              {saving ? "저장 중…" : "텍스트 저장"}
            </button>
            {saved ? (
              <span
                className="text-sm font-semibold text-primary"
                data-testid="manual-resume-saved"
              >
                저장했습니다
              </span>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-sm font-medium text-fail">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
