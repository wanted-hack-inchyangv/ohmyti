import type {
  AssignmentVersionStatus,
  JobStatus,
  ReviewState,
  StageState,
  SubmissionStatus,
} from "./enums";

/** 상태 머신을 가진 엔터티 (부록 B). */
export type StateEntity =
  "submission" | "evaluationStage" | "job" | "assignmentVersion" | "reviewState";

export interface EntityStateMap {
  submission: SubmissionStatus;
  evaluationStage: StageState;
  job: JobStatus;
  assignmentVersion: AssignmentVersionStatus;
  reviewState: ReviewState;
}

type TransitionTable = {
  readonly [E in StateEntity]: readonly (readonly [EntityStateMap[E], EntityStateMap[E]])[];
};

/**
 * 허용 전이 표. `packages/core/README.md`의 표와 같아야 하며 테스트가 대조한다.
 * 부록 B: Submission은 어느 상태에서든 DELETED로, Job은 어느 상태에서든 CANCELLED로 갈 수 있다.
 */
export const TRANSITION_TABLE: TransitionTable = {
  submission: [
    ["RECEIVED", "QUEUED"],
    ["QUEUED", "RUNNING"],
    ["RUNNING", "COMPLETED"],
    ["RUNNING", "FAILED"],
    ["RUNNING", "UNSUPPORTED"],
    ["RECEIVED", "DELETED"],
    ["QUEUED", "DELETED"],
    ["RUNNING", "DELETED"],
    ["COMPLETED", "DELETED"],
    ["FAILED", "DELETED"],
    ["UNSUPPORTED", "DELETED"],
  ],
  evaluationStage: [
    ["PENDING", "RUNNING"],
    ["PENDING", "SKIPPED"],
    ["RUNNING", "DONE"],
    ["RUNNING", "SKIPPED"],
    ["RUNNING", "FAILED"],
    ["RUNNING", "UNSUPPORTED"],
  ],
  job: [
    ["QUEUED", "RUNNING"],
    ["RUNNING", "SUCCEEDED"],
    ["RUNNING", "FAILED"],
    ["RUNNING", "QUEUED"],
    ["QUEUED", "CANCELLED"],
    ["RUNNING", "CANCELLED"],
    ["SUCCEEDED", "CANCELLED"],
    ["FAILED", "CANCELLED"],
  ],
  assignmentVersion: [
    ["DRAFT", "VALIDATING"],
    ["VALIDATING", "DRAFT"],
    ["VALIDATING", "APPROVED"],
    ["APPROVED", "RETIRED"],
  ],
  reviewState: [
    ["PENDING", "CONFIRMED"],
    ["NOT_REQUIRED", "CONFIRMED"],
  ],
};

/** `from`에서 `to`로의 전이가 허용되는지 반환한다. 같은 상태로의 전이는 허용하지 않는다. */
export function canTransition<E extends StateEntity>(
  entity: E,
  from: EntityStateMap[E],
  to: EntityStateMap[E],
): boolean {
  const table = TRANSITION_TABLE[entity] as readonly (readonly [string, string])[];
  return table.some(([a, b]) => a === from && b === to);
}

/** `from`에서 갈 수 있는 상태 목록. */
export function nextStates<E extends StateEntity>(
  entity: E,
  from: EntityStateMap[E],
): EntityStateMap[E][] {
  const table = TRANSITION_TABLE[entity] as readonly (readonly [string, string])[];
  return table.filter(([a]) => a === from).map(([, b]) => b as EntityStateMap[E]);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: StateEntity,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${entity}: ${from} → ${to} 전이는 허용되지 않습니다`);
    this.name = "InvalidTransitionError";
  }
}

/** 전이가 허용되지 않으면 `InvalidTransitionError`를 던진다. */
export function assertTransition<E extends StateEntity>(
  entity: E,
  from: EntityStateMap[E],
  to: EntityStateMap[E],
): void {
  if (!canTransition(entity, from, to)) {
    throw new InvalidTransitionError(entity, from, to);
  }
}
