# @ohmyti/db

Drizzle ORM 스키마, 마이그레이션, 클라이언트 팩토리, 테스트 DB 유틸을 담는다. 큐 로직(T-006)과 시드 데이터(T-201)는 포함하지 않는다.

## 구성

| 경로                   | 내용                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/schema/enums.ts`  | PostgreSQL enum. 값은 `@ohmyti/core`의 zod enum에서 가져온다                                                                                                                                                  |
| `src/schema/tables.ts` | 테이블 정의와 CHECK·인덱스                                                                                                                                                                                    |
| `src/client.ts`        | `createDb`, `createServerlessDb`(max 1), `createWorkerDb`(max 10), `requireDatabaseUrl`                                                                                                                       |
| `src/migrate.ts`       | `runMigrations(db)`: `drizzle/` 폴더의 미적용 마이그레이션 적용                                                                                                                                               |
| `src/timestamps.ts`    | timestamptz(Date) ↔ core의 ISO 8601 문자열 변환                                                                                                                                                               |
| `src/testing.ts`       | `createTestDatabase()`: 임시 데이터베이스 생성·마이그레이션·삭제                                                                                                                                              |
| `src/assignments.ts`   | 과제·버전 등록, 상태 전이(DRAFT→VALIDATING→APPROVED→RETIRED), 제출 생성 (T-201)                                                                                                                               |
| `src/submissions.ts`   | 제출 행 갱신: SHA 고정, UNSUPPORTED 표시, 상태 기록 (T-202), `enqueueSubmissionEvaluation` (T-204)                                                                                                            |
| `src/evaluations.ts`   | 평가 생성·조회(`findOpenEvaluation`)·종료(`finishEvaluation`), `stage_log` 단계 기록 갱신(부록 B 전이 검사), 뒤 단계 SKIPPED (T-203, T-204)                                                                   |
| `src/results.ts`       | 판정 저장 (T-205): `persistEvaluationResults`(실행 기록 → 근거 → 판정 → 점수를 한 트랜잭션에), 조회(`getEvaluationResults`·`getExecutionRecord`·`listEvidencesForRun`), 행 ↔ core 변환                        |
| `src/review-events.ts` | 사람 수정 이력 조회 (`listReviewEvents`, `toReviewEvent`). 리포트 API(T-207)가 읽고 기록은 T-306이 남긴다                                                                                                     |
| `src/reruns.ts`        | 재실행(T-307): `listRerunJobs`(평가의 `RERUN_EXECUTION` job, payload의 `evaluationId`로 조회, CANCELLED 제외), `appendCriterionResultEvidence`(재실행 근거를 판정의 `evidence_ids` 뒤에 붙임, 점수·판정 불변) |
| `drizzle/*.sql`        | 마이그레이션 SQL. `0000_init`(스키마), `0001`·`0003`·`0007`(트리거), `0002`(job enum), `0004`(`satisfied_sub_criterion_ids`), `0005`(`score_by_area`), `0006`(`evidences.kind`), `0007`(`review_events.kind`) |
| `drizzle.config.ts`    | drizzle-kit 설정 (저장소 루트 `.env.local`·`.env`를 읽음)                                                                                                                                                     |
| `scripts/migrate.ts`   | `pnpm db:migrate`                                                                                                                                                                                             |
| `scripts/reset.ts`     | `pnpm db:reset` (개발 전용, 운영 환경 변수가 있으면 거부)                                                                                                                                                     |

## 스크립트 (루트에서 실행)

```bash
pnpm db:generate   # 스키마 변경 → drizzle/ 에 마이그레이션 SQL 생성 (drizzle-kit generate)
pnpm db:migrate    # DATABASE_URL에 미적용 마이그레이션 적용. 두 번 실행해도 두 번째는 변경 없음
pnpm db:studio     # drizzle-kit studio
pnpm db:reset      # public·drizzle 스키마를 지우고 처음부터 적용 (개발 전용)
pnpm db:seed:sample  # 샘플 과제 "주문·재고 API" v1 등록·승인 + 검증 샘플 A/B/C/D (scripts/db-seed-sample.ts, 멱등)
```

트리거·함수처럼 Drizzle 스키마로 표현할 수 없는 SQL은 `pnpm --filter @ohmyti/db exec drizzle-kit generate --custom --name=<이름>`으로 빈 파일을 만들어 직접 적는다.

로컬 PostgreSQL은 Docker로 띄운다.

```bash
docker run -d --name ohmyti-pg -e POSTGRES_USER=ohmyti -e POSTGRES_PASSWORD=ohmyti -e POSTGRES_DB=ohmyti -p 55440:5432 postgres:16-alpine
# .env.local
DATABASE_URL=postgresql://ohmyti:ohmyti@localhost:55440/ohmyti
DATABASE_URL_TEST=postgresql://ohmyti:ohmyti@localhost:55440/postgres
```

## 테스트

`pnpm --filter @ohmyti/db test`. 통합 테스트는 `DATABASE_URL_TEST`의 서버에 `ohmyti_test_<hex>` 데이터베이스를 만들어 마이그레이션을 적용하고, 끝나면 `DROP DATABASE ... WITH (FORCE)`로 지운다. 스키마(search_path)가 아니라 데이터베이스를 만드는 이유는 drizzle-kit이 enum 타입을 `public`으로 한정해 생성하기 때문이다. `DATABASE_URL_TEST`가 없으면 통합 테스트는 경고와 함께 건너뛴다(단위 테스트만 실행).

## 테이블

| 테이블                 | 역할                                                                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignments`          | 과제. 명세·기준·실행 계약은 버전에 둔다                                                                                                                                                                                                                                                                         |
| `assignment_versions`  | 과제 버전. `status`(DRAFT/VALIDATING/APPROVED/RETIRED), `rubric` jsonb, `rubric_version`(유일, `v<n>-<sha256 앞 8자>`), `execution_contract` jsonb, `validation_result` jsonb, `approved_by`, `approved_at`. APPROVED이면 `approved_at`이 있어야 하고, APPROVED·RETIRED 행은 트리거가 본문 변경을 막는다 (아래) |
| `validation_samples`   | 채점기 검증 샘플(정답 A·대안 B·결함 C·적대 D)과 기대 결과표 (W3). `human_reviewed_by`·`human_reviewed_at`은 사람이 샘플을 검토하기 전까지 null                                                                                                                                                                  |
| `submissions`          | 제출물. 저장소 URL, 고정 SHA(40자 hex CHECK), 스냅샷 ref, 상태. 이력서·GitHub 컬럼은 없다                                                                                                                                                                                                                       |
| `submission_context`   | 지원자 맥락: 이력서 ref·텍스트, GitHub 로그인·프로필. 채점 테이블과 분리 (G-10). 제출 삭제 시 cascade                                                                                                                                                                                                           |
| `evaluations`          | 제출물 1회 평가. `rubric_version`, `harness_version`, `environment_digest`, `stage_log` jsonb, `score_earned`/`score_min`/`score_max`/`pending_points`, `is_sample`                                                                                                                                             |
| `criterion_results`    | 기준별 판정 (PRD 9장). `(evaluation_id, criterion_id)` 유일. CHECK: 감점이면 `evidence_ids` 비어 있을 수 없음(G-02), INCONCLUSIVE면 `earned_points` null(G-04), `0 ≤ earned ≤ max`. `satisfied_sub_criterion_ids`는 PARTIAL이 충족한 하위 기준(T-004)                                                           |
| `evidences`            | 근거 (PRD 9장). `source` jsonb(SourceLocation), `run_id` → execution_records, `test_id`, `artifact_refs`, `snippet`, `kind`(null = 실행·정적 검사 근거, `STATIC_RELATION` = 정적 라우트 분석으로 대응시킨 핸들러 위치, T-304)                                                                                   |
| `execution_records`    | 실행 기록 (PRD 9장). 불변: 트리거가 UPDATE·DELETE를 거부한다 (아래)                                                                                                                                                                                                                                             |
| `mutation_experiments` | mutation 실험 결과. `validation_record_id`·`test_record_id` → execution_records                                                                                                                                                                                                                                 |
| `review_events`        | 사람 검토 이력 (T-306). `kind`(CONFIRM/OVERRIDE/DISPUTE/APPROVE_DESIGN, check 제약), `previous`·`next` jsonb, 이유, 검토자. 쌓이기만 한다 (아래 트리거)                                                                                                                                                         |
| `context_links`        | 이력서 주장 ↔ GitHub 근거 ↔ 과제 관측 연결. 점수 관련 컬럼(score/point/earned) 없음. 테스트가 대조한다                                                                                                                                                                                                          |
| `ai_reviews`           | LLM 호출 기록. 제공자·모델·프롬프트 버전·입력 다이제스트·사용량·`version`                                                                                                                                                                                                                                       |
| `jobs`                 | DB 작업 큐. `(status, run_after)` 인덱스, `dedupe_key`는 QUEUED·RUNNING일 때만 유일(부분 유니크 인덱스)                                                                                                                                                                                                         |
| `deletion_log`         | 제출 삭제 기록 (T-506). 제출 행은 지워지므로 FK 없이 ID와 지운 자원 목록을 남긴다                                                                                                                                                                                                                               |

### 관계도

```
assignments 1──n assignment_versions 1──n validation_samples
                        │
                        1
                        │
                        n
                  submissions 1──1 submission_context
                        │ 1──n context_links
                        │
                        n
                  evaluations 1──n criterion_results 1──n review_events
                        │ 1──n evidences ──n──1 execution_records
                        │ 1──n execution_records
                        │ 1──n mutation_experiments ──n──1 execution_records (validation, test)
                        │ 1──n ai_reviews (assignment_versions·submissions에서도 참조)
jobs, deletion_log: FK 없음
```

삭제 규칙: `submissions` 삭제는 `submission_context`, `context_links`, `evaluations`(→ criterion_results, evidences, review_events, mutation_experiments, ai_reviews)로 cascade된다. `execution_records`는 `evaluations`를 `restrict`로 참조하므로 실행 기록이 남아 있는 평가는 지울 수 없다. 제출 삭제 전용 SQL 함수 `delete_submission_execution_records(submission_id)`(마이그레이션 0016, T-506)가 아래 설정을 켜고 실행 기록을 지운 뒤 다시 끈다. 이 함수는 삭제 요청(`submissions.deleted_at`)이 기록된 제출에만 동작한다.

### 제출 삭제 cascade (T-506, `src/deletion.ts`)

1. `requestSubmissionDeletion`(web): 한 트랜잭션에서 제출을 DELETED·`deleted_at`으로 바꾸고 이 제출의 QUEUED·RUNNING job(payload의 `submissionId` 또는 이 제출 평가의 `evaluationId`)을 CANCELLED로 바꾼 뒤 `DELETE_SUBMISSION` job을 넣는다. 이미 요청된 제출이면 삭제 job만 다시 넣는다.
2. `cancelJob`·`cancelSubmissionJobs`는 RUNNING이던 job의 `locked_by`를 남긴다. 실행하던 워커가 핸들러(러너 정리 포함)를 빠져나온 뒤 `acknowledgeCancelledJob`으로 비운다. `listUnacknowledgedCancelledJobs`가 빌 때까지 기다리면 실행이 멈췄다는 뜻이다.
3. `readSubmissionArtifactScope`로 평가 ID와 행이 참조하는 아티팩트를 읽고, 워커가 접두사를 지운다. 그 뒤 `deleteSubmissionRows`가 한 트랜잭션에서 jobs(끝난 것) → context_links → ai_reviews → mutation_experiments → evidences → criterion_results(→ review_events cascade) → 전용 함수로 execution_records → evaluations → submission_context → submissions 순으로 지우고 `deletion_log.removed`(`DeletionRemoved`: 테이블별 행 수, 지운 접두사·객체 수, 남긴 공유 참조, 취소한 job)를 남긴다.
4. `findSubmissionDeletion`: 삭제 요청 뒤(PENDING) 또는 삭제 뒤(DONE) 상태. 삭제된 제출 URL의 "삭제됨" 안내 근거다.

### execution_records 불변 트리거 (G-03)

`execution_records_immutable` 트리거(BEFORE UPDATE OR DELETE)가 `execution_records_reject_mutation()`을 호출한다.

- UPDATE는 항상 `restrict_violation`으로 실패한다.
- DELETE는 같은 트랜잭션에서 `SET LOCAL ohmyti.allow_execution_record_delete = 'on'`을 설정한 경우에만 허용한다. 애플리케이션 코드는 이 설정을 직접 쓰지 않고 T-506의 전용 SQL 함수 `delete_submission_execution_records`만 쓴다(E2E 정리 코드는 예외).

### review_events append-only 트리거 (T-306)

`review_events_append_only` 트리거(BEFORE UPDATE OR DELETE)가 `review_events_reject_mutation()`을 호출한다. UPDATE와 직접 DELETE는 `restrict_violation`으로 실패하고, 평가 행 삭제의 cascade(외래 키 트리거 안, `pg_trigger_depth() > 1`)에서만 삭제된다. 검토 액션은 `lockCriterionResult`(FOR UPDATE) → `applyCriterionReview` → `insertReviewEvent` → `setEvaluationScore` 순으로 한 트랜잭션에서 쓴다 (`apps/web/lib/reviews/service.ts`).

### 판정 저장 (T-205)

`persistEvaluationResults(db, { evaluationId, executionRecords, evidences, criterionResults, score })`는 한 트랜잭션에서 `execution_records` → `evidences` → `criterion_results` → `evaluations` 점수 필드(`score_earned`·`score_min`·`score_max`·`pending_points`) 순으로 쓴다. 판정의 `evidenceIds`가 같은 입력의 근거를 가리키는지, core 스키마(G-02·G-04)를 통과하는지 먼저 검사하고, 이미 판정이 있는 평가에는 아무것도 쓰지 않고 `EvaluationResultsExistError`를 던진다. 재시도할 때는 `hasCriterionResults`로 먼저 확인한다. ID는 호출자가 UUID로 정한다. 근거가 `run_id`로 기록을 참조하기 때문이다. `toCriterionResult`·`toEvidence`·`toExecutionRecord`가 행을 PRD 9장 타입으로 바꾼다.

### assignment_versions 불변 트리거와 제출 차단 (T-201)

- `assignment_versions_immutable_when_approved`(BEFORE UPDATE): `status`가 APPROVED·RETIRED인 행은 `rubric`·`rubric_version`·`execution_contract`·`spec_ref`·`spec_digest`·`harness_version`·`validation_result`·`title`·`approved_*`·`created_at`을 바꿀 수 없다. 허용되는 변경은 APPROVED → RETIRED(`retired_at` 필수)와 `updated_at`뿐이다. 수정은 새 버전 생성으로만 한다.
- `submissions_require_approved_version`(BEFORE INSERT OR UPDATE OF assignment_version_id): 참조하는 버전이 APPROVED가 아니면 `RUBRIC_NOT_APPROVED:`로 시작하는 `check_violation`이다. `createSubmission()`은 INSERT 전에 같은 검사를 해 `SubmissionRejectedError(RUBRIC_NOT_APPROVED)`를 던진다.

## 타입 규약

- ID는 uuid이며 기본값은 `gen_random_uuid()`다. core의 `IdSchema`는 문자열이므로 그대로 호환된다.
- 타임스탬프 컬럼은 timestamptz이며 애플리케이션에서는 `Date`로 다룬다. JSON 경계(web ↔ worker, API 응답)에서는 `toIsoTimestamp`/`fromIsoTimestamp`로 core의 ISO 8601 문자열과 변환한다.
- SHA·다이제스트는 text로 저장하며 형식은 core 스키마(`ShaSchema`, `DigestSchema`)와 `submissions_sha_format` CHECK로 검사한다.
- jsonb 컬럼(`rubric`, `execution_contract`, `stage_log`, `source`, `usage`)은 `$type<>`으로 core 타입을 붙였다. 읽은 값은 신뢰 경계를 넘을 때 core의 zod 스키마로 다시 검증한다.
