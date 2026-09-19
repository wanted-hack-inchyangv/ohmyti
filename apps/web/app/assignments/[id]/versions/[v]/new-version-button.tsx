"use client";

import type { Rubric } from "@ohmyti/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { buttonClass } from "@/components/ui";
import { createVersionDraftFromAction } from "@/lib/assignments/actions";

/**
 * `새 버전 만들기` (T-406): 이 버전의 명세·실행 계약·기준·검증 샘플을 복사한 DRAFT 버전을 만들고 그 화면으로 간다.
 * 승인된 버전 자체는 바뀌지 않는다 (T-201).
 */
export function NewVersionButton({
  assignmentId,
  sourceVersionId,
  rubric,
}: {
  assignmentId: string;
  sourceVersionId: string;
  rubric: Rubric;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className={buttonClass("secondary", "lg")}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await createVersionDraftFromAction({ sourceVersionId, rubric });
            if (!result.ok) {
              setError(`${result.code}: ${result.message}`);
              return;
            }
            router.push(`/assignments/${assignmentId}/versions/${result.data.version}`);
          })
        }
      >
        새 버전 만들기
      </button>
      {error ? (
        <p className="text-sm text-fail" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
