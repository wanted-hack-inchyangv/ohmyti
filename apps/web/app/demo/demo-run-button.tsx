"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { buttonClass } from "@/components/ui";
import { startDemoRunAction } from "@/lib/demo/actions";
import type { DemoResult, StartedDemoRun } from "@/lib/demo/service";

/** `이 샘플로 새로 실행`. 저장된 스냅샷으로 새 제출을 만들고 새 실행 화면으로 이동한다. 실패 사유는 그대로 보인다 (G-09) */
export function DemoRunButton({ sampleId, disabled }: { sampleId: string; disabled: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onClick() {
    setError(null);
    start(async () => {
      let result: DemoResult<StartedDemoRun>;
      try {
        result = await startDemoRunAction(sampleId);
      } catch {
        setError("새 실행 요청을 보내지 못했습니다. 잠시 후 다시 시도해 주세요");
        return;
      }
      if (!result.ok) {
        setError(`${result.code}: ${result.message}`);
        return;
      }
      router.push(`/demo/runs/${result.data.submissionId}`);
    });
  }

  return (
    <div className="flex flex-col gap-1.5 sm:flex-1">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || pending}
        className={`${buttonClass("secondary", "lg")} w-full`}
        data-testid={`demo-run-${sampleId}`}
      >
        {pending ? "새 실행 요청 중…" : "이 샘플로 새로 실행"}
      </button>
      {error ? (
        <p
          className="text-[13px] leading-relaxed text-neutral-700"
          role="alert"
          data-testid={`demo-run-error-${sampleId}`}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
