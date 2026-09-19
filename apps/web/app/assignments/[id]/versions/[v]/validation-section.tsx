"use client";

/**
 * 과제 설정 하단 (T-406): 검증 샘플 목록 → `검증 실행` → 진행 상태 → 결과 표 → `기준 승인`.
 * 검증은 워커의 `VALIDATE_RUBRIC` job이 샘플을 실제로 채점해 기대 결과와 대조한다 (T-405). 이 화면은 요청·표시만 한다.
 *
 * - DRAFT: `검증 실행` 가능. 검증 중(VALIDATING, 결과 없음)이면 3초마다 서버 컴포넌트를 다시 그린다.
 * - VALIDATING + pass: 승인자 이름을 넣으면 `기준 승인`. 조건이 모자라면 버튼은 비활성이고 사유를 모두 보인다.
 * - APPROVED·RETIRED: 표시만 한다 (편집·검증·승인 컨트롤 없음).
 */
import {
  type ApprovalBlocker,
  type AssignmentVersionStatus,
  type ValidationResult,
} from "@ohmyti/core";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button, inputClassName } from "@/components/ui";
import { approveVersionAction, requestValidationAction } from "@/lib/assignments/actions";

const POLL_MS = 3_000;

export interface ValidationControlsProps {
  assignmentVersionId: string;
  status: AssignmentVersionStatus;
  validation: ValidationResult | null;
  validationJob: { status: string; lastError: string | null; attempts: number } | null;
  blockers: ApprovalBlocker[];
  sampleCount: number;
}

/** 검증 진행 상태 (표시용 순수 함수) */
export function validationPhase(
  props: Pick<ValidationControlsProps, "status" | "validation" | "validationJob">,
): "idle" | "running" | "job-failed" | "passed" | "mismatch" {
  if (props.status === "VALIDATING" && props.validation === null) {
    return props.validationJob?.status === "FAILED" ? "job-failed" : "running";
  }
  if (props.validation === null) return "idle";
  return props.validation.pass ? "passed" : "mismatch";
}

export function ValidationControls(props: ValidationControlsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [approver, setApprover] = useState("");
  const phase = validationPhase(props);

  useEffect(() => {
    if (phase !== "running") return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase, router]);

  const canRequest =
    (props.status === "DRAFT" || phase === "job-failed") && props.sampleCount > 0 && !pending;
  const blockers: ApprovalBlocker[] = [
    ...props.blockers,
    ...(approver.trim()
      ? []
      : [{ code: "APPROVER_MISSING", message: "승인자 이름을 입력하세요" } as ApprovalBlocker]),
  ];

  function requestValidation() {
    setError(null);
    startTransition(async () => {
      const result = await requestValidationAction(props.assignmentVersionId);
      if (!result.ok) setError(`${result.code}: ${result.message}`);
      router.refresh();
    });
  }

  function approve() {
    setError(null);
    startTransition(async () => {
      const result = await approveVersionAction({
        assignmentVersionId: props.assignmentVersionId,
        approvedBy: approver,
      });
      if (!result.ok) {
        setError(`${result.code}: ${result.message}`);
        return;
      }
      router.refresh();
    });
  }

  const statusText =
    phase === "running"
      ? "검증 중: 워커가 검증 샘플을 채점하고 있습니다 (샘플마다 하네스·제출 테스트·결함 주입을 실행합니다)"
      : phase === "job-failed"
        ? `검증 job이 실패했습니다: ${props.validationJob?.lastError ?? "사유 없음"}`
        : phase === "passed"
          ? "검증 통과: 승인할 수 있습니다"
          : phase === "mismatch"
            ? "검증 불일치: 기준을 고친 뒤 다시 검증하세요"
            : props.status === "DRAFT"
              ? "아직 검증하지 않았습니다"
              : "";
  const statusColor =
    phase === "job-failed" || phase === "mismatch"
      ? "text-fail"
      : phase === "passed"
        ? "text-ink"
        : "text-neutral-600";
  // 승인 단계(VALIDATING)에서는 `기준 승인`이 주요 동작이고, 그 전에는 `검증 실행`이 주요 동작이다
  const approving = props.status === "VALIDATING";

  return (
    <div
      className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-surface p-5 sm:p-6"
      data-testid="validation-controls"
      data-phase={phase}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button
          type="button"
          variant={approving ? "secondary" : "primary"}
          size={approving ? "md" : "lg"}
          onClick={requestValidation}
          disabled={!canRequest}
          title={props.sampleCount === 0 ? "검증 샘플이 없습니다" : undefined}
        >
          {phase === "job-failed" ? "검증 다시 실행" : "검증 실행"}
        </Button>
        <span
          className={`flex items-center gap-2 text-sm font-medium ${statusColor}`}
          role="status"
          data-testid="validation-status"
        >
          {phase === "running" ? (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 animate-pulse rounded-full bg-primary"
            />
          ) : null}
          {statusText}
        </span>
      </div>

      {approving ? (
        <div className="flex flex-col gap-4 border-t border-neutral-200 pt-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex w-full max-w-sm flex-col gap-2">
              <span className="text-sm font-semibold text-neutral-800">승인자 이름</span>
              <input
                className={inputClassName}
                name="approvedBy"
                placeholder="이름을 입력하세요"
                value={approver}
                onChange={(e) => setApprover(e.target.value)}
              />
            </label>
            <Button
              type="button"
              variant="primary"
              size="lg"
              onClick={approve}
              disabled={blockers.length > 0 || pending}
            >
              기준 승인
            </Button>
          </div>
          {blockers.length > 0 ? (
            <div className="rounded-lg bg-neutral-50 px-4 py-3 text-sm">
              <p className="font-semibold text-neutral-800">승인하려면</p>
              <ul
                className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-neutral-700"
                data-testid="approval-blockers"
              >
                {blockers.map((b, i) => (
                  <li key={`${b.code}-${i}`} data-blocker={b.code}>
                    {b.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p
          className="rounded-lg bg-fail/5 px-4 py-3 text-sm text-neutral-800 ring-1 ring-fail/20"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
