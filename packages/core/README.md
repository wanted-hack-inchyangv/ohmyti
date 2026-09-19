# @ohmyti/core

도메인 타입, zod 스키마, 상태 머신, 기준 검증, 점수 집계, 마스킹 유틸리티를 담는다. DB 코드는 포함하지 않는다.

## 구성

| 파일                   | 내용                                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/enums.ts`         | `Verdict`, `Method`, `ReviewState`, `FailureKind`, `EvaluationStage`, `StageState`, `SubmissionStatus`, `JobStatus`, `AssignmentVersionStatus`, `MutationOutcome`, `ContextStatus`, `ExecutionRecordKind`, `RubricArea`, `AiReviewKind`, `JobType`                                                       |
| `src/contracts.ts`     | PRD 9장 `CriterionResult`, `Evidence`, `ExecutionRecord` (필드명은 PRD와 동일, 추가 필드만 허용)                                                                                                                                                                                                         |
| `src/rubric.ts`        | `Rubric`(criteria, groups, partialRules, independentReasons), `validateRubric`, `FORBIDDEN_LIBRARY_TERMS`                                                                                                                                                                                                |
| `src/score.ts`         | `aggregateScore(results, rubric)`, `formatScoreDisplay`, `ScoreAggregationError`, `DuplicateDeductionError`, `UnknownSubCriterionError`                                                                                                                                                                  |
| `src/entities.ts`      | `ExecutionContract`, `AssignmentVersion`, `Submission`, `Evaluation`, `ReviewEvent`, `ContextLink`, `MutationExperiment`, `AiReview`, `Job`                                                                                                                                                              |
| `src/state-machine.ts` | `TRANSITION_TABLE`, `canTransition`, `nextStates`, `assertTransition`                                                                                                                                                                                                                                    |
| `src/grading-input.ts` | `GradingInput`(채점 엔진 입력), `AssertNoForbiddenKeys`(G-10 타입 검사)                                                                                                                                                                                                                                  |
| `src/masking.ts`       | `maskSensitive(text, secrets)`                                                                                                                                                                                                                                                                           |
| `src/report.ts`        | 평가 조회 API 응답 스키마 (T-207): `EvaluationReport`, `RunRecordReport`, `SubmissionSummary`, 응답 봉투(`apiOkSchema`·`ApiErrorSchema`), `formatStoredScoreDisplay`(저장 점수의 부록 C 표기), 제출 생성·승인 버전 목록 API(T-208) `CreateSubmissionRequest`·`CreatedSubmission`·`ApprovedVersionOption` |

타임스탬프는 ISO 8601 문자열(`z.iso.datetime({ offset: true })`), 커밋 SHA는 40자 hex, 다이제스트는 sha256 hex다.

## 기준 검증 규칙 (`validateRubric`)

- 배점 합계는 100이어야 한다.
- 기준 ID와 그룹 ID는 유일해야 한다.
- `allowPartial: true`인 기준은 `partialRules`에 하위 기준을 1개 이상 명시해야 하고, 하위 배점 합은 `maxPoints` 이하여야 한다. PARTIAL을 허용하지 않는 기준에 PARTIAL 규칙이 있어도 오류다.
- 그룹, 독립 감점 사유(`independentReasons`), PARTIAL 규칙은 존재하는 기준만 참조해야 한다. 기준의 `groupId`는 존재하는 그룹이어야 한다.
- 판정 조건(`condition`)에 `FORBIDDEN_LIBRARY_TERMS`의 라이브러리 이름을 쓸 수 없다. 기준은 겉으로 드러나는 동작에 배점한다.

## 점수 집계 (`aggregateScore`)

부록 C의 표기 규칙을 순수 함수로 구현했다. LLM·DB·UI에 의존하지 않는다 (G-01).

- 확정 점수 `earned` = `earnedPoints`가 null이 아닌 기준의 합이다. `min`은 `earned`, `max`는 `earned + pendingPoints`, `total`은 rubric 배점 합(100)이다.
- 미확정 배점 `pendingPoints` = `earnedPoints`가 null인 기준(`INCONCLUSIVE`, 검토 대기)과 결과가 아직 없는 기준(`NOT_EVALUATED`)의 `maxPoints` 합이다. `pendingCriteria`에 사유와 함께 나열한다. 미확정 배점을 제외하고 재환산하지 않는다 (G-04).
- `display`: 미확정이 없으면 `87/100`, 있으면 `54~69/100 · 15점 검토 대기`.
- `byArea`: `RubricArea` 열거 순서로 영역별 `earned`/`min`/`max`/`pendingPoints`/`total`. 영역 소계의 합은 전체와 같다.
- PARTIAL은 `CriterionResult.satisfiedSubCriterionIds`가 가리키는 rubric 하위 기준 배점 합으로만 계산한다. 하위 기준이 rubric에 없으면 `UnknownSubCriterionError`, 기준이 PARTIAL을 허용하지 않으면 `PARTIAL_NOT_ALLOWED`, 결과의 `earnedPoints`가 하위 합과 다르면 `PARTIAL_POINTS_MISMATCH`다.
- 같은 `issueId`로 두 기준 이상에서 감점(`earnedPoints < maxPoints`)했는데 rubric `independentReasons`가 그 기준들을 모두 포함하지 않으면 `DuplicateDeductionError`다 (G-12).
- rubric에 없는 기준, 같은 기준의 중복 결과, `rubricVersion`·`maxPoints` 불일치는 `ScoreAggregationError`(`code`로 구분)다.

## 상태 전이 표

부록 B를 옮긴 표다. `src/state-machine.ts`의 `TRANSITION_TABLE`과 같아야 하며 `state-machine.test.ts`가 이 표를 파싱해 대조한다. 표에 없는 전이는 모두 거부된다.

| 엔터티            | from         | to          |
| ----------------- | ------------ | ----------- |
| submission        | RECEIVED     | QUEUED      |
| submission        | QUEUED       | RUNNING     |
| submission        | RUNNING      | COMPLETED   |
| submission        | RUNNING      | FAILED      |
| submission        | RUNNING      | UNSUPPORTED |
| submission        | RECEIVED     | DELETED     |
| submission        | QUEUED       | DELETED     |
| submission        | RUNNING      | DELETED     |
| submission        | COMPLETED    | DELETED     |
| submission        | FAILED       | DELETED     |
| submission        | UNSUPPORTED  | DELETED     |
| evaluationStage   | PENDING      | RUNNING     |
| evaluationStage   | PENDING      | SKIPPED     |
| evaluationStage   | RUNNING      | DONE        |
| evaluationStage   | RUNNING      | SKIPPED     |
| evaluationStage   | RUNNING      | FAILED      |
| evaluationStage   | RUNNING      | UNSUPPORTED |
| job               | QUEUED       | RUNNING     |
| job               | RUNNING      | SUCCEEDED   |
| job               | RUNNING      | FAILED      |
| job               | RUNNING      | QUEUED      |
| job               | QUEUED       | CANCELLED   |
| job               | RUNNING      | CANCELLED   |
| job               | SUCCEEDED    | CANCELLED   |
| job               | FAILED       | CANCELLED   |
| assignmentVersion | DRAFT        | VALIDATING  |
| assignmentVersion | VALIDATING   | DRAFT       |
| assignmentVersion | VALIDATING   | APPROVED    |
| assignmentVersion | APPROVED     | RETIRED     |
| reviewState       | PENDING      | CONFIRMED   |
| reviewState       | NOT_REQUIRED | CONFIRMED   |

단계 순서와 파급 규칙(표 밖의 오케스트레이션 규칙, T-204에서 구현):

- 단계 순서는 `EVALUATION_STAGE_ORDER` = REPO_CHECK → ENV_PREP → REQUIREMENT_VERIFY → TEST_EFFECTIVENESS → REVIEW_WRITE → CONTEXT_LINK.
- 앞 단계가 UNSUPPORTED면 뒤 단계는 모두 SKIPPED가 된다.
- REQUIREMENT_VERIFY가 FAILED여도 REVIEW_WRITE와 CONTEXT_LINK는 가능한 범위에서 실행한다.
- `job`의 RUNNING → QUEUED는 stale 회수·재시도다.
- `reviewState`의 NOT_REQUIRED → CONFIRMED는 자동 판정을 사람이 수정한 경우다. 원래 값은 `ReviewEvent`에 남는다.

## 채점 입력 (`GradingInput`)

명세 참조, 기준, 실행 계약, 스냅샷 참조, 하네스 버전만 담는다. `resume`, `github`, `applicant`로 시작하는 키는 어느 깊이에도 있을 수 없다. `AssertNoForbiddenKeys<GradingInput>` 타입이 이를 컴파일 시점에 고정하고, `findForbiddenGradingInputKeys(GradingInputSchema)`가 런타임에서도 스키마를 순회해 확인한다.

## 마스킹 (`maskSensitive`)

지정 비밀값(`[SECRET]`) → `Bearer` 토큰·`sk-`·`ghp_`류 토큰(`[TOKEN]`) → 이메일(`[EMAIL]`) → 전화번호(`[PHONE]`) 순으로 치환한다. 로그, 에러 메시지, 단계 실패 사유에 저장하기 전에 적용한다.
