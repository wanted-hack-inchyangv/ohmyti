import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AiUsage,
  AreaScore,
  EvaluationStageRecord,
  EvidenceDetail,
  EvidenceKind,
  GitHubSources,
  ReviewEventKind,
  ExecutionContract,
  ReportProfile,
  Rubric,
  RubricDraftFailureCode,
  RubricDraftStatus,
  RubricValidationError,
  ScorecardCompetencyEntry,
  ScorecardQuestionNote,
  SourceLocation,
} from "@ohmyti/core";
import { createdAt, id, timestamptz, updatedAt } from "./columns";
import {
  aiReviewKindEnum,
  assignmentVersionStatusEnum,
  contextStatusEnum,
  executionRecordKindEnum,
  failureKindEnum,
  jobStatusEnum,
  jobTypeEnum,
  methodEnum,
  mutationOutcomeEnum,
  resumeTextStatusEnum,
  reviewStateEnum,
  submissionStatusEnum,
  validationSampleKindEnum,
  verdictEnum,
} from "./enums";

/** 과제. 명세·기준·실행 계약은 버전(assignment_versions)에 둔다. */
export const assignments = pgTable("assignments", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * 과제 버전. DRAFT → VALIDATING → APPROVED → RETIRED (부록 B).
 * 승인되지 않은 버전으로는 채점하지 않는다 (T-201): `submissions` INSERT는 트리거
 * `submissions_require_approved_version`이 APPROVED가 아니면 `RUBRIC_NOT_APPROVED`로 거부한다.
 * APPROVED·RETIRED 행은 트리거 `assignment_versions_immutable_when_approved`가 rubric·계약·명세 변경을 막는다.
 * 수정은 새 버전 생성으로만 한다.
 */
export const assignmentVersions = pgTable(
  "assignment_versions",
  {
    id: id(),
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => assignments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: assignmentVersionStatusEnum("status").notNull().default("DRAFT"),
    title: text("title").notNull(),
    /** 과제 명세 원문의 artifact ref. 본문은 스토어에 둔다. */
    specRef: text("spec_ref").notNull(),
    specDigest: text("spec_digest").notNull(),
    rubric: jsonb("rubric").$type<Rubric>().notNull(),
    /** CriterionResult·ExecutionRecord가 참조하는 기준 버전 문자열 */
    rubricVersion: text("rubric_version").notNull(),
    executionContract: jsonb("execution_contract").$type<ExecutionContract>().notNull(),
    harnessVersion: text("harness_version").notNull(),
    /** 채점기 사전 검증 결과 (T-405). 샘플별 기대 결과와 실제 결과의 비교 */
    validationResult: jsonb("validation_result"),
    /**
     * 채용 리포트 프로필 (T-705). 기준별 역량 보정과 비개발자가 읽는 영향 문장이며 rubric 본문·rubricVersion 해시와 무관하다.
     * 승인 뒤에도 고칠 수 있도록 불변 트리거의 대상 열에 넣지 않는다 (점수·판정에 쓰이지 않는다).
     */
    reportProfile: jsonb("report_profile").$type<ReportProfile>(),
    approvedBy: text("approved_by"),
    approvedAt: timestamptz("approved_at"),
    retiredAt: timestamptz("retired_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("assignment_versions_assignment_version_idx").on(t.assignmentId, t.version),
    uniqueIndex("assignment_versions_rubric_version_idx").on(t.rubricVersion),
    check("assignment_versions_version_positive", sql`${t.version} >= 1`),
    check(
      "assignment_versions_approved_consistent",
      sql`(${t.status} <> 'APPROVED') OR (${t.approvedAt} IS NOT NULL)`,
    ),
  ],
);

/** 채점기 검증용 샘플 (PRD 2장 W3). 기대 결과표와 실제 채점 결과를 대조한다. */
export const validationSamples = pgTable(
  "validation_samples",
  {
    id: id(),
    assignmentVersionId: uuid("assignment_version_id")
      .notNull()
      .references(() => assignmentVersions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: validationSampleKindEnum("kind").notNull(),
    /** 샘플 코드 스냅샷의 artifact ref */
    snapshotRef: text("snapshot_ref").notNull(),
    submissionSha: text("submission_sha").notNull(),
    /** 기준별 기대 verdict·점수 (부록 A 기대 결과표) */
    expected: jsonb("expected").notNull(),
    /** 샘플 코드·기대 결과표를 검토한 사람 (expected-matrix의 `reviewedBy`). 검토 전에는 null */
    humanReviewedBy: text("human_reviewed_by"),
    humanReviewedAt: timestamptz("human_reviewed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("validation_samples_version_name_idx").on(t.assignmentVersionId, t.name)],
);

/** 제출물. 이력서·GitHub 정보는 여기 두지 않고 submission_context에 분리한다 (G-10). */
export const submissions = pgTable(
  "submissions",
  {
    id: id(),
    assignmentVersionId: uuid("assignment_version_id")
      .notNull()
      .references(() => assignmentVersions.id, { onDelete: "restrict" }),
    repoUrl: text("repo_url").notNull(),
    /** 사용자가 지정한 브랜치·태그·SHA. 없으면 기본 브랜치 */
    repoRef: text("repo_ref"),
    /** 수집 시 고정한 커밋 SHA (T-202) */
    submissionSha: text("submission_sha"),
    snapshotRef: text("snapshot_ref"),
    status: submissionStatusEnum("status").notNull().default("RECEIVED"),
    unsupportedReason: text("unsupported_reason"),
    /** 샘플 체험용 제출 (G-08: 저장된 실행으로 표시) */
    isSample: boolean("is_sample").notNull().default(false),
    /**
     * 채점기 사전 검증(T-405)이 검증 샘플을 채점하려고 만든 제출. 저장소 대신 샘플 스냅샷을 쓰며 항상 `is_sample`이다.
     * VALIDATING 버전에는 이 제출만 만들 수 있다 (트리거 `submissions_require_approved_version`)
     */
    validationSampleId: uuid("validation_sample_id").references(() => validationSamples.id, {
      onDelete: "cascade",
    }),
    /**
     * 샘플 체험(T-505)의 샘플 ID(`A`·`B`·`C`·`D`). `pnpm demo:seed`와 `이 샘플로 새로 실행`이 저장된 샘플 스냅샷으로
     * 만든 제출이며 항상 `is_sample`이다. `/demo`는 샘플마다 가장 최근에 끝난 평가를 `저장된 실행`으로 보여 준다
     */
    demoSampleId: text("demo_sample_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamptz("deleted_at"),
  },
  (t) => [
    index("submissions_version_status_idx").on(t.assignmentVersionId, t.status),
    index("submissions_validation_sample_idx").on(t.validationSampleId, t.createdAt),
    index("submissions_demo_sample_idx").on(t.demoSampleId, t.createdAt),
    check(
      "submissions_validation_run_is_sample",
      sql`${t.validationSampleId} IS NULL OR ${t.isSample}`,
    ),
    check(
      "submissions_demo_sample",
      sql`${t.demoSampleId} IS NULL OR (${t.isSample} AND ${t.demoSampleId} ~ '^[A-Z]$')`,
    ),
    check(
      "submissions_sha_format",
      sql`${t.submissionSha} IS NULL OR ${t.submissionSha} ~ '^[0-9a-f]{40}$'`,
    ),
  ],
);

/**
 * 지원자 맥락 (이력서 텍스트, GitHub 소스). 채점 테이블과 분리하며 채점 입력에 조인하지 않는다 (G-10).
 * 삭제 시 제출물과 함께 지운다 (T-506).
 */
export const submissionContext = pgTable("submission_context", {
  submissionId: uuid("submission_id")
    .primaryKey()
    .references(() => submissions.id, { onDelete: "cascade" }),
  /** 이력서 원본(PDF)의 artifact ref */
  resumeRef: text("resume_ref"),
  /** 추출한 이력서 텍스트 (T-501). 마스킹 전 원문이므로 로그에 쓰지 않는다 */
  resumeText: text("resume_text"),
  /** 이력서 텍스트 상태 (T-501). 이력서가 없거나 아직 추출하지 않았으면 NONE */
  resumeTextStatus: resumeTextStatusEnum("resume_text_status").notNull().default("NONE"),
  /** 추출하지 못한 사유 (크기·페이지 상한 초과, PDF 파싱 실패 등). 본문은 담지 않는다 */
  resumeTextReason: text("resume_text_reason"),
  githubLogin: text("github_login"),
  /**
   * GitHub 프로필 보충 조회 결과 (T-502, `GitHubSourcesSchema`). 이력서·JD와 관련된 공개 저장소 최대 3개의
   * README 앞부분·언어·최상위 파일·최근 커밋·병합 PR. 조회하지 못했으면 `NO_DATA` + 사유. 아직 조회하지 않았으면 null
   */
  githubSources: jsonb("github_sources").$type<GitHubSources>(),
  /** 분석 한도(MAX_PROFILE_REPOS 등)로 일부만 읽었을 때의 범위 표시 */
  analysisScope: jsonb("analysis_scope"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 한 제출물에 대한 평가 1회. 기준·하네스가 바뀌면 새 평가를 만든다 (PRD 5장 불변 규칙 9). */
export const evaluations = pgTable(
  "evaluations",
  {
    id: id(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    assignmentVersionId: uuid("assignment_version_id")
      .notNull()
      .references(() => assignmentVersions.id, { onDelete: "restrict" }),
    rubricVersion: text("rubric_version").notNull(),
    harnessVersion: text("harness_version").notNull(),
    environmentDigest: text("environment_digest").notNull(),
    submissionSha: text("submission_sha").notNull(),
    /** 단계별 상태 (EvaluationStageRecord[]) */
    stageLog: jsonb("stage_log").$type<EvaluationStageRecord[]>().notNull().default([]),
    /** 확정 점수 = earned_points가 null이 아닌 기준의 합 (부록 C). 집계 전에는 null */
    scoreEarned: integer("score_earned"),
    /** 확정 점수 하한 (= score_earned) */
    scoreMin: integer("score_min"),
    /** 확정 + 검토 대기 배점 */
    scoreMax: integer("score_max"),
    /** 검토 대기 배점 = earned_points가 null인 기준의 max_points 합 */
    pendingPoints: integer("pending_points"),
    /**
     * 영역별 소계 (`aggregateScore().byArea`, RubricArea 열거 순서). 워커가 판정 저장 시 함께 쓰며
     * 워크벤치(T-302)는 이 값을 그대로 보여 준다. 마이그레이션 0005 이전의 평가는 null
     */
    scoreByArea: jsonb("score_by_area").$type<AreaScore[]>(),
    /** 샘플의 사전 계산 결과 (G-08: `저장된 실행`으로 표시) */
    isSample: boolean("is_sample").notNull().default(false),
    createdAt: createdAt(),
    finishedAt: timestamptz("finished_at"),
  },
  (t) => [
    index("evaluations_submission_idx").on(t.submissionId, t.createdAt),
    check(
      "evaluations_score_range",
      sql`(${t.scoreMin} IS NULL AND ${t.scoreMax} IS NULL) OR (${t.scoreMin} <= ${t.scoreMax})`,
    ),
  ],
);

/**
 * 실행 기록 (PRD 9장 ExecutionRecord). 불변이다 (G-03).
 * UPDATE·DELETE는 트리거 `execution_records_immutable`이 막는다. 삭제는 T-506의 전용 함수만 허용.
 */
export const executionRecords = pgTable(
  "execution_records",
  {
    id: id(),
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "restrict" }),
    kind: executionRecordKindEnum("kind").notNull(),
    submissionSha: text("submission_sha").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    harnessVersion: text("harness_version").notNull(),
    environmentDigest: text("environment_digest").notNull(),
    /** mutation 실행이면 적용한 패치의 다이제스트 */
    patchDigest: text("patch_digest"),
    seed: text("seed"),
    inputRef: text("input_ref").notNull(),
    expectedRef: text("expected_ref").notNull(),
    actualRef: text("actual_ref").notNull(),
    exitCode: integer("exit_code"),
    failureKind: failureKindEnum("failure_kind").notNull(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("execution_records_evaluation_idx").on(t.evaluationId, t.createdAt)],
);

/** 근거 (PRD 9장 Evidence). 코드 위치, 실행 기록, 테스트 ID, artifact 참조와 스니펫. */
export const evidences = pgTable(
  "evidences",
  {
    id: id(),
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    submissionSha: text("submission_sha").notNull(),
    /** 스냅샷 안의 코드 위치 (SourceLocation). 실행 근거는 정적 라우트 분석으로 결정한다 */
    source: jsonb("source").$type<SourceLocation>(),
    /** 이 근거를 만든 실행 기록 */
    runId: uuid("run_id").references(() => executionRecords.id, { onDelete: "restrict" }),
    testId: text("test_id"),
    artifactRefs: text("artifact_refs").array().notNull().default([]),
    /** 코드 스니펫 원문 (source 범위). 코드 근거 뷰어가 스냅샷 없이도 보여 줄 수 있게 저장 */
    snippet: text("snippet"),
    /** 근거 종류 (core `EvidenceKind`). `STATIC_RELATION`은 정적 라우트 분석으로 대응시킨 핸들러 위치(T-304), null은 실행·정적 검사 근거 */
    kind: text("kind").$type<EvidenceKind>(),
    /** LLM 근거(T-407)의 출처·제안 내용 (core `EvidenceDetail`). 그 밖의 근거는 null */
    detail: jsonb("detail").$type<EvidenceDetail>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("evidences_evaluation_idx").on(t.evaluationId),
    index("evidences_run_idx").on(t.runId),
  ],
);

/**
 * 기준별 판정 (PRD 9장 CriterionResult).
 * G-02: 감점(earned_points < max_points)이면 evidence_ids가 비어 있을 수 없다.
 * G-04: INCONCLUSIVE는 earned_points가 null이며 0과 구분한다.
 */
export const criterionResults = pgTable(
  "criterion_results",
  {
    id: id(),
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    maxPoints: integer("max_points").notNull(),
    earnedPoints: integer("earned_points"),
    verdict: verdictEnum("verdict").notNull(),
    method: methodEnum("method").notNull(),
    evidenceIds: uuid("evidence_ids").array().notNull().default([]),
    /** 같은 결함을 여러 기준에서 중복 감점하지 않기 위한 결함 ID (G-12) */
    issueId: text("issue_id"),
    /** 관측 사실 */
    observation: text("observation").notNull(),
    /** 해석·추정. 사실과 분리한다 */
    interpretation: text("interpretation"),
    reviewState: reviewStateEnum("review_state").notNull(),
    /** PARTIAL일 때 충족한 rubric 하위 기준 ID (T-004). PARTIAL이 아니면 null */
    satisfiedSubCriterionIds: text("satisfied_sub_criterion_ids").array(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("criterion_results_evaluation_criterion_idx").on(t.evaluationId, t.criterionId),
    check("criterion_results_max_points_nonneg", sql`${t.maxPoints} >= 0`),
    check(
      "criterion_results_earned_range",
      sql`${t.earnedPoints} IS NULL OR (${t.earnedPoints} >= 0 AND ${t.earnedPoints} <= ${t.maxPoints})`,
    ),
    // G-02
    check(
      "criterion_results_deduction_requires_evidence",
      sql`${t.earnedPoints} IS NULL OR ${t.earnedPoints} >= ${t.maxPoints} OR cardinality(${t.evidenceIds}) > 0`,
    ),
    // G-04
    check(
      "criterion_results_inconclusive_is_null",
      sql`${t.verdict} <> 'INCONCLUSIVE' OR ${t.earnedPoints} IS NULL`,
    ),
  ],
);

/** mutation 실험 (PRD 2장 W2). 변형 적용 → 하네스 검증 → 제출 테스트 실행 결과. */
export const mutationExperiments = pgTable(
  "mutation_experiments",
  {
    id: id(),
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    mutationId: text("mutation_id").notNull(),
    groupId: text("group_id").notNull(),
    targetCriterionId: text("target_criterion_id").notNull(),
    target: jsonb("target").$type<SourceLocation>(),
    patchDigest: text("patch_digest"),
    patchRef: text("patch_ref"),
    outcome: mutationOutcomeEnum("outcome").notNull(),
    /** 변형 후 하네스로 결함이 드러났는지 검증한 실행 기록 */
    validationRecordId: uuid("validation_record_id").references(() => executionRecords.id, {
      onDelete: "restrict",
    }),
    /** 변형 후 제출 테스트를 돌린 실행 기록 */
    testRecordId: uuid("test_record_id").references(() => executionRecords.id, {
      onDelete: "restrict",
    }),
    /** 유효성 검증(변형 위 하네스) 판정. 검증을 돌리지 않았으면 null (T-403) */
    validationVerdict: verdictEnum("validation_verdict"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mutation_experiments_evaluation_mutation_idx").on(t.evaluationId, t.mutationId),
    // T-403: KILLED·SURVIVED는 하네스가 변형에서 실패(유효한 결함)를 관측하고 제출 테스트를 돌린 실험만 될 수 있다
    check(
      "mutation_experiments_effective_requires_failing_validation",
      sql`${t.outcome} NOT IN ('KILLED', 'SURVIVED') OR (${t.validationVerdict} = 'FAIL' AND ${t.validationRecordId} IS NOT NULL AND ${t.testRecordId} IS NOT NULL)`,
    ),
    // EQUIVALENT는 하네스가 변형에서도 통과한 실험이다
    check(
      "mutation_experiments_equivalent_requires_passing_validation",
      sql`${t.outcome} <> 'EQUIVALENT' OR (${t.validationVerdict} = 'PASS' AND ${t.validationRecordId} IS NOT NULL AND ${t.testRecordId} IS NULL)`,
    ),
  ],
);

/**
 * 사람 검토 이력 (PRD 9장 ReviewEvent, T-306). 쌓이기만 한다: UPDATE는 트리거 `review_events_append_only`가 거부하고
 * DELETE는 평가 삭제 cascade(T-506)에서만 일어난다 (트리거가 외래 키 트리거 안에서 일어난 cascade 삭제만 허용).
 */
export const reviewEvents = pgTable(
  "review_events",
  {
    id: id(),
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    criterionResultId: uuid("criterion_result_id")
      .notNull()
      .references(() => criterionResults.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    /** 액션 종류 (core `ReviewEventKind`: CONFIRM·OVERRIDE·DISPUTE·APPROVE_DESIGN, T-306) */
    kind: text("kind").$type<ReviewEventKind>().notNull(),
    reviewer: text("reviewer").notNull(),
    /** { earnedPoints, verdict, reviewState } */
    previous: jsonb("previous").notNull(),
    next: jsonb("next").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("review_events_evaluation_idx").on(t.evaluationId, t.createdAt),
    check(
      "review_events_kind_check",
      sql`${t.kind} IN ('CONFIRM', 'OVERRIDE', 'DISPUTE', 'APPROVE_DESIGN')`,
    ),
  ],
);

/**
 * 이력서 주장 ↔ GitHub 근거 ↔ 과제 관측 연결 (PRD 4장 B).
 * 점수 관련 컬럼(score, point, earned)은 두지 않는다. 테스트가 컬럼 이름을 대조한다.
 */
export const contextLinks = pgTable(
  "context_links",
  {
    id: id(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    /** 연결을 만든 평가 (T-503). 같은 제출을 다시 평가하면 제출의 연결 전체를 새로 만든다 */
    evaluationId: uuid("evaluation_id").references(() => evaluations.id, { onDelete: "cascade" }),
    /** 이력서 인용(`RESUME`)이거나, 이력서가 없을 때의 안내 행(`SYSTEM`, "이력서 미제공") */
    claimSource: text("claim_source").notNull().default("RESUME"),
    claim: text("claim").notNull(),
    /** EVIDENCE_FOUND·NEEDS_CHECK·NO_DATA 세 값만 (enum 타입 + CHECK) */
    status: contextStatusEnum("status").notNull(),
    /** [{ repo, url, summary }] */
    githubEvidence: jsonb("github_evidence"),
    /** { summary, source?, evidenceId? } */
    assignmentObservation: jsonb("assignment_observation"),
    /** 주 질문. v3(T-703)부터는 `question`의 주 질문을 그대로 넣는다 (이전 화면·게이트 호환) */
    followUpQuestion: text("follow_up_question"),
    /** 인터뷰 질문 구조 `ContextQuestion` (T-703). v2 이전 연결은 null */
    question: jsonb("question"),
    aiReviewId: uuid("ai_review_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("context_links_submission_idx").on(t.submissionId),
    check("context_links_claim_source_known", sql`${t.claimSource} in ('RESUME', 'SYSTEM')`),
    check(
      "context_links_status_known",
      sql`${t.status}::text in ('EVIDENCE_FOUND', 'NEEDS_CHECK', 'NO_DATA')`,
    ),
  ],
);

/** LLM 호출 기록 (1.5). 모델·프롬프트 버전·입력 다이제스트·사용량을 남기고 재생성은 version을 올린다. */
export const aiReviews = pgTable(
  "ai_reviews",
  {
    id: id(),
    kind: aiReviewKindEnum("kind").notNull(),
    evaluationId: uuid("evaluation_id").references(() => evaluations.id, { onDelete: "cascade" }),
    assignmentVersionId: uuid("assignment_version_id").references(() => assignmentVersions.id, {
      onDelete: "cascade",
    }),
    submissionId: uuid("submission_id").references(() => submissions.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputDigest: text("input_digest").notNull(),
    /** zod 검증을 통과한 출력. 구조는 kind마다 다르다 */
    output: jsonb("output").notNull(),
    usage: jsonb("usage").$type<AiUsage>().notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_reviews_evaluation_kind_idx").on(t.evaluationId, t.kind),
    check("ai_reviews_version_positive", sql`${t.version} >= 1`),
  ],
);

/**
 * 면접 스코어카드 (T-707, PRD 14.3의 8절). 면접관이 면접 뒤에 손으로 기입한 기록이다.
 *
 * - 행은 넣기만 한다. 같은 면접관이 다시 저장하면 새 행이 쌓이고 이전 행이 이력으로 남는다(UPDATE 경로가 없다).
 * - 점수 관련 컬럼(score, point, earned, grade)을 두지 않는다. 역량별 값은 `competencies` jsonb 안의 사람 기입값이며
 *   과제 점수·판정·다이제스트와 무관하다. 테스트가 컬럼 이름을 대조한다.
 * - 제출 삭제 cascade에 들어간다(`evaluation_id`의 ON DELETE CASCADE + `deletion.ts`의 명시적 삭제).
 */
export const interviewScorecards = pgTable(
  "interview_scorecards",
  {
    id: id(),
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    /** 면접관 이름 (사람이 입력한 문자열. 계정·권한은 범위 밖이다) */
    interviewer: text("interviewer").notNull(),
    /** `ScorecardCompetencyEntry[]`: 역량별 1~4 값과 메모. 비워 둔 칸은 null */
    competencies: jsonb("competencies").$type<ScorecardCompetencyEntry[]>().notNull(),
    /** `ScorecardQuestionNote[]`: 인터뷰 키트 질문별 메모 */
    questionNotes: jsonb("question_notes").$type<ScorecardQuestionNote[]>().notNull(),
    /** 면접관 최종 의견 (자유 서술) */
    finalNote: text("final_note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("interview_scorecards_evaluation_idx").on(t.evaluationId, t.createdAt),
    check("interview_scorecards_interviewer_not_blank", sql`btrim(${t.interviewer}) <> ''`),
  ],
);

/**
 * AI 채점 기준 초안 요청 (T-406). web이 행과 `DRAFT_RUBRIC` job을 넣고 워커가 LLM 결과를 채운다.
 * 초안은 채점에 쓰이지 않으며, 사람이 고쳐 저장한 버전(`assignment_versions`)만 검증·승인 대상이다.
 * 과제를 만들기 전(`/assignments/new`)에도 요청할 수 있어 `assignment_id`는 선택이다.
 */
export const rubricDrafts = pgTable(
  "rubric_drafts",
  {
    id: id(),
    assignmentId: uuid("assignment_id").references(() => assignments.id, {
      onDelete: "cascade",
    }),
    /** 명세 원문의 artifact ref (내용 주소 `rubric-drafts/specs/<sha256>.md`) */
    specRef: text("spec_ref").notNull(),
    specDigest: text("spec_digest").notNull(),
    status: text("status").$type<RubricDraftStatus>().notNull().default("QUEUED"),
    /** `rubricFromDraftOutput()` 결과. 형식은 `Rubric`이지만 `validateRubric()`을 통과했다는 뜻은 아니다 */
    rubric: jsonb("rubric").$type<Rubric>(),
    validationErrors: jsonb("validation_errors").$type<RubricValidationError[]>(),
    notes: jsonb("notes").$type<string[]>(),
    droppedMutationIds: jsonb("dropped_mutation_ids").$type<string[]>(),
    failureCode: text("failure_code").$type<RubricDraftFailureCode>(),
    failureMessage: text("failure_message"),
    /** LLM 호출 기록 (`ai_reviews`). 실패해 기록이 없으면 null */
    aiReviewId: uuid("ai_review_id").references(() => aiReviews.id, { onDelete: "set null" }),
    model: text("model"),
    promptVersion: text("prompt_version"),
    createdAt: createdAt(),
    finishedAt: timestamptz("finished_at"),
  },
  (t) => [
    index("rubric_drafts_assignment_idx").on(t.assignmentId, t.createdAt),
    check(
      "rubric_drafts_status_valid",
      sql`${t.status} in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')`,
    ),
    check(
      "rubric_drafts_succeeded_has_rubric",
      sql`${t.status} <> 'SUCCEEDED' or (${t.rubric} is not null and ${t.validationErrors} is not null and ${t.finishedAt} is not null)`,
    ),
    check(
      "rubric_drafts_failed_has_reason",
      sql`${t.status} <> 'FAILED' or (${t.failureCode} is not null and ${t.failureMessage} is not null and ${t.finishedAt} is not null)`,
    ),
  ],
);

/** DB 기반 작업 큐. 폴링·잠금·재시도 로직은 T-006. */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: jobTypeEnum("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: jobStatusEnum("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamptz("run_after").notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedAt: timestamptz("locked_at"),
    /** 워커가 갱신하는 진행 신호. `WORKER_STALE_MS`를 넘기면 회수 대상 */
    heartbeatAt: timestamptz("heartbeat_at"),
    lastError: text("last_error"),
    /** 같은 대상의 중복 적재 방지 키. QUEUED·RUNNING인 동안만 유일 */
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_status_run_after_idx").on(t.status, t.runAfter),
    uniqueIndex("jobs_dedupe_key_active_idx")
      .on(t.dedupeKey)
      .where(sql`${t.status} IN ('QUEUED', 'RUNNING')`),
    check("jobs_attempts_nonneg", sql`${t.attempts} >= 0`),
    check("jobs_max_attempts_positive", sql`${t.maxAttempts} >= 1`),
  ],
);

/**
 * 제출 삭제 기록 (T-506). 제출 행은 지워지므로 FK 없이 ID와 지운 자원 목록을 남긴다.
 * `requested_by`는 삭제를 확인한 검토자 이름, `removed`는 `DeletionRemoved`(`deletion.ts`: 테이블별 행 수·아티팩트 접두사·지운 객체 수)다.
 * 삭제된 제출 URL이 "삭제됨"을 보이는 근거다.
 */
export const deletionLog = pgTable(
  "deletion_log",
  {
    id: id(),
    submissionId: uuid("submission_id").notNull(),
    requestedBy: text("requested_by"),
    /** 함께 지운 자원: artifact ref 목록, 실행 기록 수 등 */
    removed: jsonb("removed").notNull(),
    reason: text("reason"),
    deletedAt: timestamptz("deleted_at").notNull().defaultNow(),
  },
  (t) => [index("deletion_log_submission_idx").on(t.submissionId)],
);
