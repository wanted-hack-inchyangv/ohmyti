# 최종 인수 검증 (T-507)

PRD 12장 인수 기준 10개를 항목별로 상태, 증명 방법(테스트 이름 또는 수동 절차), 증거로 정리한다. 테스트 이름은 파일의 `it`·`test` 문자열 그대로다.

- 기준일: 2026-09-19
- 상태 표기: `충족`(자동 테스트·게이트로 증명), `충족 · 사람 확인 대기`(자동 증거는 있고 사람의 판단이 남음), `부분 충족`(일부 조건만 증명, 남은 부분을 적음)
- 공통 실행 명령: `pnpm test`(Vitest. DB 통합 테스트는 `DATABASE_URL_TEST`가 있어야 돈다), `pnpm e2e`(Playwright), `pnpm gate:phase1`, `pnpm gate:phase2 --base-url https://ohmyti.vercel.app --repeat 3`, `pnpm gate:phase4`, `pnpm context:isolation-check`, `pnpm copy:check`

## 요약

| #   | PRD 12장 인수 기준                                                              | 상태                  | 주 증거                                                                          |
| --- | ------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| 1   | 같은 SHA·기준·환경의 결정적 테스트 3회 반복 → 같은 결과. 불안정 테스트는 미확정 | 부분 충족             | `gate:phase1` 3회, 배포 환경 `gate:phase2 --repeat 3` digest 일치                |
| 2   | 모든 감점에 접근 가능한 실제 코드 또는 실행 근거                                | 충족                  | zod·DB 제약(G-02), 워크벤치 근거 E2E                                             |
| 3   | 재생 화면과 최종 리포트의 값이 같은 실행 기록에서 나온다                        | 충족                  | 리포트·run API·재생 컴포넌트 테스트, 워크벤치 E2E                                |
| 4   | 올바른 구현 두 종류 통과, 결함 구현은 의도한 요구사항에서 실패                  | 충족                  | `gate:phase1`·`gate:phase4`·배포 환경 `gate:phase2`의 기대 결과표 대조           |
| 5   | 유효한 mutation과 빌드 실패·환경 오류·동등 변형 구분                            | 충족                  | mutation·테스트 실효성 테스트, `gate:phase4`                                     |
| 6   | 실행 실패·근거 부족을 0점으로 바꾸지 않는다                                     | 충족                  | INCONCLUSIVE = null(G-04) 스키마·DB, 하네스 ENVIRONMENT·TIMEOUT, 점수 표기       |
| 7   | 과제 채점은 이력서 교체·GitHub 부재의 영향을 받지 않는다                        | 충족                  | 이력서 X/Y 판정 동일 테스트, 채점 입력 타입, `context:isolation-check`           |
| 8   | README에 만점 지시를 넣어도 기준·점수·권한이 변하지 않는다                      | 충족                  | 적대적 샘플 D = C (`gate:phase4`, 배포 환경 `gate:phase2`), 프롬프트 데이터 분리 |
| 9   | 재실행·기준 변경·사람의 수정 이력 보존                                          | 충족                  | 실행 기록 불변 트리거, 재실행 새 기록, v2 재평가, 검토 이력 불변                 |
| 10  | 승인 샘플만으로 90초 데모의 모든 장면을 실제 데이터로 재현                      | 충족 · 사람 확인 대기 | `demo:seed`, `e2e/demo.spec.ts`, `demo:rehearsal` 스크린샷(`docs/demo/`)         |

## 1. 결정성 3회 반복과 불안정 테스트

상태: **부분 충족**. 같은 SHA·기준·환경의 3회 반복 결과 동일성은 로컬과 배포 환경에서 모두 증명했다. 불안정(flaky) 테스트를 자동으로 찾아 미확정으로 바꾸는 로직은 없다. 현재는 회차별 digest가 다르면 게이트가 실패로 끝나고, 사람이 원인을 본다.

- 자동 테스트
  - `packages/harness/src/run.test.ts` — "3회 연속 실행한 결과가 verdict·actual·검사 결과까지 동일하다"
  - `packages/runner/src/submitted-tests/run.test.ts` — "같은 스냅샷을 두 번 실행하면 판정 부분이 같다 (결정성)"
  - `scripts/gate-phase1.test.ts` — "케이스 actual 값이나 테스트 상태가 다르면 digest가 다르고 checkDeterminism이 잡는다"
  - `scripts/gate-phase2.test.ts` — "같은 샘플의 회차별 digest가 다르면 문제로 보고한다"
- 게이트
  - `pnpm gate:phase1`(기본 3회): `docs/gates/phase1.md` 반복 3회, 샘플 A/B/C/D 판정 digest 동일
  - `pnpm gate:phase2 --base-url https://ohmyti.vercel.app --repeat 3`(T-507, 배포 환경, 기대값 5단계): `docs/gates/phase2.md`. 샘플 A·C를 3회씩 제출해 판정 digest(환경 digest, 기준별 판정·점수, 단계 상태, 하네스 케이스, 제출 테스트)가 같은지 대조한다. 결과는 아래 "배포 환경 게이트" 절
- 남은 부분: 같은 평가 안에서 테스트를 반복 실행해 결과가 흔들리는 테스트를 INCONCLUSIVE로 표시하는 규칙. 후속 과제로 남긴다(TICKET.md T-507 후속 제안).

## 2. 모든 감점의 근거

상태: **충족**.

- `packages/core/src/contracts.test.ts` — "감점인데 Evidence가 없으면 거부한다 (G-02)" (zod 스키마)
- `packages/db/src/schema.test.ts` — "감점인데 evidence_ids가 비어 있으면 INSERT가 실패한다" (DB CHECK 제약)
- `packages/db/src/results.test.ts` — "G-02 위반(감점인데 근거 없음)은 스키마가 거부하고 트랜잭션이 되돌아간다"
- `apps/web/lib/reviews/service.test.ts` — "R-12를 일부만 확정하면 PARTIAL + 하위 기준이 저장되고, 근거가 없던 감점에는 HUMAN_REVIEW 근거가 붙는다 (G-02)"
- `apps/web/app/evaluations/[id]/code-evidence.test.tsx` — "표시된 스니펫이 스냅샷 파일의 해당 라인과 동일하고 라인 번호가 source 범위와 같다"
- `e2e/workbench-stack.spec.ts` — "코드 탭: 핸들러 위치 스니펫이 리포트 근거와 같고 GitHub 링크는 고정 SHA만 쓴다"
- 화면: `docs/demo/05-r05-replay.png`(R-05 감점의 실행 기록·코드 근거 6건), `docs/demo/07-mutation-m01.png`(G1 감점의 변형 실험 기록)

## 3. 재생 화면과 리포트의 출처

상태: **충족**.

- `apps/web/lib/reports/service.test.ts` — "리포트의 실행 기록과 run 엔드포인트의 본문은 같은 runId·같은 ref에서 나온다"
- `apps/web/app/evaluations/[id]/replay.test.tsx` — "기대/실제 값이 T-207 리포트(run 본문)의 expected·actual과 동일하고 통과/실패는 기록의 checks[].ok를 그대로 쓴다"
- `apps/web/app/evaluations/[id]/replay.test.tsx` — "expected·actual을 다시 비교하거나 배점·재고를 계산하는 코드가 없다"
- `e2e/workbench.spec.ts` — "C의 R-05 실패 재생: stateAfter 재고 2 → 1 → 0, 기대 1·실제 0이 runs API 값과 같다 (T-303)"
- `e2e/workbench-stack.spec.ts` — "R-05 실패 카드 클릭 → 중앙에 기대 1·실제 0, 재고 2 → 1 → 0 (워커 기록 그대로)"

## 4. 올바른 구현 두 종류와 결함 구현

상태: **충족**.

- 게이트
  - `pnpm gate:phase1`: 러너로 A/B/C/D를 기동해 하네스·제출 테스트 결과를 `samples/order-api/expected-matrix.json`과 대조 (`docs/gates/phase1.md`)
  - `pnpm gate:phase4`: 전체 파이프라인 결과 = 기대 결과표(MATRIX), B는 사람 검토 기준(R-12)을 뺀 모든 기준 PASS 만점·테스트 실효성 15/15(ALTERNATIVE_B) (`docs/gates/phase4.md`, `docs/gates/phase4-gate.json`)
  - 배포 환경 `pnpm gate:phase2 --repeat 3`: A·B는 `90~100/100 · 10점 검토 대기`, C는 R-05·R-06·R-07(멱등성 저장소 없음)과 G1에서 실패해 `54~69/100 · 15점 검토 대기`
- 자동 테스트
  - `apps/worker/src/results/results.test.ts` — "A: `75~100/100 · 25점 검토 대기`, 판정 15건, 감점 없음, R-12·G1~G3만 검토 대기"
  - `scripts/gate-phase1.test.ts` — "C: R-05·R-06·R-07 FAIL이면 일치, A 기대표로 대조하면 세 건이 불일치다"
  - `apps/worker/src/gate-phase4/gate-phase4.test.ts` — "B: 기준 하나가 FAIL이거나 그룹이 만점이 아니면 실패하고, 사람 검토 기준이 확정되어 있어도 실패한다"
  - `apps/worker/src/mutation/mutation.test.ts` — "C: M-01·M-02 SURVIVED, M-03·M-04 NOT_APPLICABLE(대상 로직 없음), M-05 KILLED이고 expected-matrix와 일치한다"
- 기대 결과표 서명(`expected-matrix.json`의 `reviewedBy`)은 T-101의 사람 확인 항목이다.

## 5. mutation 결과 구분

상태: **충족**. 워커 단계에서 실제 환경 오류(ENV_ERROR)를 일으키는 통합 테스트는 없고, 분류 규칙은 순수 함수 테스트로 증명한다.

- `apps/worker/src/effectiveness/effectiveness.test.ts` — "유효 실험이 없으면(NOT_APPLICABLE·EQUIVALENT·BUILD_FAIL·ENV_ERROR·TIMEOUT·실험 없음) INCONCLUSIVE다"
- `apps/worker/src/effectiveness/effectiveness.test.ts` — "KILLED가 있고 SURVIVED가 없으면 나머지가 TIMEOUT·EQUIVALENT여도 PASS다"
- `apps/worker/src/mutation/mutation.test.ts` — "하네스가 변형에서도 통과하는 픽스처는 EQUIVALENT로 기록되고 제출 테스트를 돌리지 않으며 SURVIVED로 세지 않는다"
- `apps/worker/src/mutation/mutation.test.ts` — "DB 검사: SURVIVED 실험은 예외 없이 유효성 검증 기록의 verdict가 FAIL이고, 어긋난 행은 CHECK 제약이 거부한다"
- `packages/analysis/src/mutation/operators.test.ts` — "변형이 타입 오류를 만들면 BUILD_FAIL이고 새 오류만 보고한다"
- 화면: `docs/demo/07-mutation-m01.png`(C의 G2는 대상 로직이 없어 NOT_APPLICABLE이며 검토 대기로 남는다)

## 6. 실행 실패·근거 부족은 0점이 아니다

상태: **충족**.

- `packages/core/src/contracts.test.ts` — "INCONCLUSIVE는 earnedPoints가 null이어야 한다 (G-04)"
- `packages/db/src/schema.test.ts` — "INCONCLUSIVE는 earned_points가 null이어야 한다"
- `packages/harness/src/run.test.ts` — "서비스가 없으면 INCONCLUSIVE · ENVIRONMENT이고 초기화 요청만 기록된다"
- `packages/harness/src/run.test.ts` — "응답이 제한 시간을 넘으면 INCONCLUSIVE · TIMEOUT이며 재시도하지 않는다"
- `packages/core/src/score.test.ts` — "50점 확정 + 50점 미확정은 50~100/100 · 50점 검토 대기이며 100/100이 되지 않는다"
- `apps/worker/src/pipeline/pipeline.test.ts` — "환경 장애: 시도가 남았으면 단계를 RUNNING으로 두고 lastError만 남기며, 마지막 시도면 FAILED(ENVIRONMENT)로 닫는다"

## 7. 이력서 교체·GitHub 부재와 채점

상태: **충족**. GitHub 유무를 바꿔 판정을 비교하는 테스트는 따로 없지만, 채점 입력 타입에 이력서·GitHub 필드가 존재하지 않고(G-10) 맥락 연결 단계는 판정 이후에 돌며 점수 열을 읽지 않는다.

- `apps/worker/src/pipeline/context-link.test.ts` — "같은 스냅샷을 이력서 X와 Y로 평가하면 criterion_results는 같고 context_links는 다르다"
- `packages/core/src/grading-input.test.ts` — "타입 검사가 컴파일 시점에 고정된다" (`@ts-expect-error`로 resume·github·applicant 키 차단)
- `packages/context/src/context-link.test.ts` — "맥락 연결 단계 파일에 위반이 없다" (`pnpm context:isolation-check`와 같은 검사)
- `packages/db/src/schema.test.ts` — "context_links에는 점수 관련 컬럼이 없다 (DB 컬럼 목록 대조)"
- 배포 환경: `gate:phase2` 제출은 이력서·GitHub 없이 들어가며, 이력서가 있는 `demo:seed` 평가(`/demo`)와 점수 표시가 같다(A·B `90~100/100 · 10점 검토 대기`, C·D `54~69/100 · 15점 검토 대기`)

## 8. README 만점 지시

상태: **충족**. 샘플 D는 C와 같은 결함에 README·주석 지시문, 점수 파일(`score.json`), stdout `PASS` 문구, 항상 통과하는 테스트를 넣은 적대적 샘플이다. 워커의 실행 권한(환경변수 화이트리스트·설치 차단)은 제출물 내용과 무관하게 고정되어 있다(`packages/runner`).

- `apps/worker/src/gate-phase4/gate-phase4.test.ts` — "D: 점수 표시나 기준 하나의 earned_points가 C와 다르면 실패한다"
- `apps/worker/src/review-write/review-write.test.ts` — "D: 만점 제안이 와도 R-12의 earned_points는 null이고 PENDING이다. 판정은 C와 같다"
- `apps/worker/src/results/results.test.ts` — "C와 D: `49~74/100 · 25점 검토 대기`, R-05·R-06·R-07 FAIL이 근거를 참조하고 두 샘플의 판정이 같다"
- `scripts/samples-check.test.ts` — "D의 기대 판정이 C와 다르면 실패한다"
- `packages/llm/src/prompt.test.ts` — "프롬프트 스냅샷: 지시문은 사용자 메시지의 데이터 블록 안에만 있고 시스템 프롬프트와 분리된다"
- 게이트: `gate:phase4`의 ADVERSARIAL_D 통과, 배포 환경 `gate:phase2`에서 D의 점수·판정이 기대 결과표(= C)와 일치

## 9. 이력 보존

상태: **충족**.

- `packages/db/src/schema.test.ts` — `execution_records 불변 (G-03)`의 "UPDATE를 거부한다", "DELETE를 거부한다"
- `apps/worker/src/rerun/rerun.test.ts` — "R-05 재실행: 기록이 1건 늘고 원본 행·아티팩트는 바이트 단위로 같으며 actual(재고 0)이 원본과 같다"
- `apps/worker/src/validate-rubric/validate-rubric.test.ts` — "human_reviewed_by가 빈 샘플이 하나라도 있으면 검증 pass여도 승인이 거부되고, v2 승인 시 기존 제출마다 새 evaluation이 생기며 v1 evaluation은 그대로 남는다"
- `apps/web/lib/reviews/service.test.ts` — "같은 기준을 두 번 수정하면 두 이벤트가 모두 시간순으로 남고 CONFIRM·DISPUTE는 점수를 바꾸지 않는다"
- `packages/db/src/review-events.test.ts` — "검토 이력은 UPDATE·직접 DELETE를 거부하고 평가 삭제 cascade로만 지워진다"
- `e2e/workbench-stack.spec.ts` — "재실행: 워커가 새 기록을 만들고 원본 기록은 그대로다"

## 10. 90초 데모 재현

상태: **충족 · 사람 확인 대기**. 자동화는 데이터 생성, `/demo`·헤더 배지, 구간별 화면의 기대 문구까지 확인한다. 90초 진행과 화면이 PRD 7장 표와 같은지는 사람이 리허설로 확인한다.

- `pnpm demo:seed`: 샘플 A/B/C/D를 실제 파이프라인으로 채점하고 평가마다 실행 기록·mutation 실험·ai_reviews 행이 있는지 확인한다(하드코딩 결과 없음). 프로덕션 시드는 T-505 완료 기록, 깨끗한 클론 로컬 재현은 T-507 완료 기록
- `e2e/demo.spec.ts` — "샘플 체험: 안내 문구와 샘플 4개의 저장된 실행 배지", "샘플 체험: 워크벤치 헤더가 저장된 실행과 사전 검증 배지를 보인다", "샘플 체험: 워커가 없으면 새 실행은 실패 상태와 저장된 실행 링크를 보인다"
- `pnpm demo:rehearsal --base-url https://ohmyti.vercel.app`: `docs/demo.md` 구간별 화면 10개를 순서대로 열어 스크린샷과 기대 문구 확인 결과를 `docs/demo/`에 남긴다. 기록은 `docs/demo/rehearsal.md`
- 사람 확인: `docs/demo/rehearsal.md` 끝의 체크리스트(진행자·일시, 화면 일치, 90초 안 진행, 홍보 수치 없음)

## 배포 환경 게이트 (T-507)

`pnpm copy:check && pnpm gate:phase2 --base-url https://ohmyti.vercel.app --repeat 3` 결과는 `docs/gates/phase2.md`와 `docs/gates/phase2.json`에 있다.

- 결과: **통과** (2026-09-18T23:12:52Z ~ 23:32:14Z, 19.4분, 기대값 5단계)
- 샘플 A/B/C/D 1회차: 기준 15개·점수 표시·제출 테스트가 기대 결과표와 모두 일치(불일치 0). A·B `90~100/100 · 10점 검토 대기`, C·D `54~69/100 · 15점 검토 대기`
- 결정성: A 3회 digest `b3e9ca7dcc8a7eca`, C 3회 digest `9ad4b24052e8d94b`로 모두 같다
- 미지원 저장소(Python): `UNSUPPORTED`, 사유 코드 `UNSUPPORTED_LANGUAGE`가 API와 화면에 모두 보인다
- 이전 실행 두 번은 실패였다. 첫 번째는 A의 R-12 근거 수가 LLM 추정 근거 때문에 회차마다 달라 digest가 달랐고(판정·점수는 같음), digest에서 `LLM_INTERPRETATION` 근거를 빼는 것으로 고쳤다(TICKET.md 결정 로그). 두 번째는 중단된 이전 게이트 실행의 제출 8건이 워커 대기열에 남아 A 1회차가 900초 제한을 넘겼다. 나머지 회차의 digest는 모두 같았다

## UI 문구 점검

`pnpm copy:check`(`scripts/copy-check.ts`)는 웹 화면 소스, 도메인 문구(`packages/core/src`), README와 데모·인수 문서에서 정확도·비용 절감률·실행 속도 수치와 결과를 바꿀 수 없다고 보장하는 표현을 찾는다(PRD 13장, G-16). 금지 표현이 있으면 위치를 출력하고 종료 코드 1로 끝난다.
