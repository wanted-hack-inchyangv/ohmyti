# 4단계 기록: AI 기준 초안 검토 (T-406) · LLM 근거 탐색·리뷰 (T-407)

과제 명세로 만든 AI 채점 기준 초안을 사람이 검토한 기록이다. 초안은 제안일 뿐이며, 사람이 고쳐 저장한 버전만 채점기 사전 검증(T-405)과 승인을 거쳐 채점에 쓰인다. 4단계 게이트 전체(T-408)는 이 문서에 이어서 기록한다.

## 실제 LLM 초안 (자동 실행 결과)

- 실행: `pnpm --filter @ohmyti/worker exec tsx src/rubric-draft/cli.ts ../../samples/order-api/SPEC.md --out ../../docs/gates/phase4-rubric-draft.json` (워커의 `DRAFT_RUBRIC` 핸들러와 같은 프롬프트·스키마·변환. DB·큐는 거치지 않는다)
- 실행 일시: 2026-09-18T18:25:16Z (로컬, 7.6초)
- 입력: `samples/order-api/SPEC.md` (샘플 과제 명세 전문, `untrusted()` 블록으로 전달)
- 제공자·모델: DeepSeek, 요청 `deepseek-chat` → 응답 `deepseek-flash`, 재요청 없음
- 프롬프트: `rubric-draft@v1+29f1b03a` (`apps/worker/src/rubric-draft/generate.ts`), 입력 다이제스트 `f6c6f0ff…`
- 사용량: 입력 6,299 토큰(캐시 6,144) · 출력 2,035 토큰 · 비용 $0.001263
- 원본 결과: [`phase4-rubric-draft.json`](./phase4-rubric-draft.json) (출력 스키마 검증 → `rubricFromDraftOutput()` → `validateRubric()`)
- 참고: 같은 입력으로 바로 앞서 한 번 더 실행했을 때(기록 파일 형식을 바꾸기 전)는 기준 16개 · 합계 114 · 같은 오류 1건이었다. `temperature: 0`이어도 기준 나누기와 ID가 실행마다 달라지므로, 초안은 매번 사람이 검토해야 한다

### 초안 요약

| ID   | 영역             | 배점 | 방법         | 요구사항                                          |
| ---- | ---------------- | ---: | ------------ | ------------------------------------------------- |
| R-01 | 요구 기능        |    8 | EXECUTION    | 헬스 체크와 초기화                                |
| R-02 | 요구 기능        |    6 | EXECUTION    | 상품 조회                                         |
| R-03 | 요구 기능        |   10 | EXECUTION    | 주문 생성과 재고 차감                             |
| R-04 | 요구 기능        |    8 | EXECUTION    | 주문 생성 입력 검증                               |
| R-05 | 요구 기능        |    8 | EXECUTION    | 멱등 재전송                                       |
| R-06 | 요구 기능        |    6 | EXECUTION    | 멱등 충돌                                         |
| R-07 | 요구 기능        |    8 | EXECUTION    | 주문 취소와 재고 복구 (이중 취소 409 포함)        |
| R-08 | 경계·실패        |    8 | EXECUTION    | 재고 부족 거절                                    |
| R-09 | 경계·실패        |    5 | EXECUTION    | 없는 상품·주문 처리                               |
| R-10 | 경계·실패        |   12 | EXECUTION    | 동시성 안전성 (같은 키 10건 + 다른 키 10건)       |
| G1   | 테스트 실효성    |    5 | MUTATION     | 재고·수량 검증 (R-04·R-08, M-01·M-02)             |
| G2   | 테스트 실효성    |    5 | MUTATION     | 멱등성 (R-05·R-06, M-03·M-04)                     |
| G3   | 테스트 실효성    |    5 | MUTATION     | 취소 재고 복구 (R-07, M-05)                       |
| R-11 | 설계·변경 용이성 |   10 | HUMAN_REVIEW | 계층 분리와 변경 용이성 (하위 기준 없음)          |
| R-12 | 실행 재현성·문서 |   10 | STATIC       | 실행 재현성과 문서 (package.json `start`, README) |
| 합계 |                  |  114 |              |                                                   |

- `validateRubric()`: **오류 1건** `TOTAL_POINTS_MISMATCH` (배점 합계 114). 영역 소계는 요구 기능 54 · 경계·실패 25 · 테스트 실효성 15 · 설계 10 · 실행 재현성·문서 10으로, 요구 기능이 기본 배분(40)보다 14점 많다. 화면은 이 초안으로 표를 채우고 `AI 초안 · 미승인` 배지와 오류 목록을 함께 보여 준다. 저장하려면 사람이 배점을 고쳐야 한다.
- 판정 조건에 라이브러리 이름 없음(`FORBIDDEN_LIBRARY_TERM` 0건). 카탈로그 밖 mutation ID 없음.
- 독립 감점 사유 3건: R-05·R-10(순차 멱등과 동시 멱등), R-07·R-08(취소 복구 누락과 재고 부족 검사 누락), R-04·R-06(검증 위반을 422로 처리하는 경우).
- 모델 메모 5건: 명세 8절의 R-번호를 그대로 썼다고 적었지만 실제 내용 대응은 다름(아래 관찰), 재고와 같은 수량의 경계 판정, 동시성은 반복 실행으로 판정해야 함, R-11 미확정 배점, 추가 필드 허용 가정.

### 자동 관찰 (사람 검토의 참고 자료)

- 모델은 "명세 8절의 번호를 그대로 썼다"고 메모했지만, 같은 ID가 승인된 기준(`samples/order-api/rubric.v1.json`)과 다른 요구사항을 가리킨다(예: 초안 R-03 = 주문 생성, v1 R-03 = 재고 부족). 하네스 케이스는 v1 ID에 묶여 있으므로 이 초안을 그대로 저장하면 채점기 검증(T-405)에서 불일치가 난다. 초안은 새 과제의 출발점이며 샘플 과제의 기준을 대체하지 않는다.
- R-11(설계)에 부분 점수 하위 기준이 없다. v1은 R-12a~c(4·3·3)로 PARTIAL을 허용한다.
- 멱등 동시 요청(v1 R-07)과 다른 키 동시 요청(v1 R-08)이 R-10 하나로 합쳐졌고, 입력 검증(v1 R-04, 경계·실패)이 요구 기능 영역으로 옮겨졌다. 이중 취소는 R-07에 포함됐다.
- 독립 감점 사유 R-04·R-06은 "검증 위반을 422로 처리"하는 가상의 결함을 근거로 해 관측 위반이 독립적인지 검토가 필요하다.
- R-12의 조건("scripts.start가 있는 package.json", "npm start로 빌드 없이 기동")은 README 검사 규칙(T-205 `checkReadme`)보다 넓다. 정적 검사로 표현하려면 `staticChecks`가 필요하지만 현재 지원하는 검사는 `DEPENDENCY_DECLARED`뿐이고, 기동 여부는 실행 계약(EXECUTION)의 영역이다.

## 사람 검토 (사람 확인 대기)

아래 항목은 사람이 초안을 읽고 채운다. 자동 실행은 위 결과까지이며, 이 절이 채워지기 전까지 T-406 인수 기준 5번은 `(사람 확인)`으로 남는다.

- [ ] 검토자: \_\_\_\_\_\_\_\_ · 검토 일시: \_\_\_\_\_\_\_\_
- [ ] 요구사항 누락·중복: 명세 5~6절의 요구사항이 기준에 빠짐없이, 한 번씩만 들어갔는가
- [ ] 판정 조건의 관측 가능성: 각 조건이 요청·응답·상태 변화로 확인 가능한가 (구현 방식·라이브러리를 요구하지 않는가)
- [ ] 배점: 합계 114 → 100으로 어떻게 고칠지, 영역 배분(요구 기능 54)이 명세의 중요도와 맞는가
- [ ] 그룹·결함 주입: G1~G3이 검증하는 요구사항과 M-01~M-05의 대응이 타당한가
- [ ] 독립 감점 사유: R-05·R-10, R-07·R-08, R-04·R-06을 따로 감점하는 이유가 독립된 관측 위반인가 (G-12)
- [ ] 결론: 초안을 (a) 고쳐서 쓸 만하다 / (b) 참고만 한다 / (c) 쓸 수 없다 중 하나와 그 이유

---

# LLM 근거 탐색·리뷰: 샘플 C 실제 실행 (T-407)

REVIEW_WRITE 단계가 실제 LLM으로 샘플 C(결함 구현: 멱등성 저장소 없음)를 한 번 처리한 기록이다. 이 단계는 추정 원인·최소 재현 설명·설계 평가 초안·명세 외 개선 제안만 만들고 점수는 바꾸지 않는다. 사람 검토 절이 채워지기 전까지 T-407 인수 기준 6번은 `(사람 확인)`으로 남는다.

## 실행 (자동 실행 결과)

- 실행: `pnpm --filter @ohmyti/worker exec tsx src/review-write/cli.ts c --out ../../docs/gates/phase4-review-write.json` (임시 DB + 로컬 러너로 전체 파이프라인을 돌리고, 워커와 같은 evaluation LLM 클라이언트로 예산 확인과 `ai_reviews` 기록을 거친다. 변형 실험은 끄고 REVIEW_WRITE 전후만 본다)
- 실행 일시: 2026-09-18T19:00:57Z (로컬, 파이프라인 전체 8.9초)
- 제공자·모델: DeepSeek, 요청 `deepseek-chat` → 응답 `deepseek-flash`, 재요청 없음, `ai_reviews` 1행(version 1)
- 프롬프트: `evidence-review@v1+72547811` (`apps/worker/src/review-write/prompt.ts`), 입력 다이제스트 `2918165d…`
- 사용량: 입력 14,192 토큰(캐시 128) · 출력 1,441 토큰 · 비용 $0.002975
- 원본 결과: [`phase4-review-write.json`](./phase4-review-write.json)
- 판정 불변: REVIEW_WRITE 전후 `earned_points`·`verdict`·`observation`이 같다(`criteriaUnchanged: true`). R-12는 `?/10`(INCONCLUSIVE·PENDING) 그대로다
- 참고: 같은 날 먼저 실행한 1회차에서 모델이 설계 평가를 하위 기준 ID(`R-12a`~`R-12c`)로 나눠 써서 후처리가 세 항목을 모두 버렸다(`설계 평가를 요청하지 않은 기준`). 프롬프트에 "criterionId는 기준 ID이며 하위 기준 ID가 아니다"를 넣은 뒤의 결과가 아래다

### 추정 원인 (FAIL 기준 3개, 모두 확신 높음)

| 기준 | 추정 원인 (요약)                                                                                                                        | LLM 근거 위치 (스냅샷 대조 통과)                                      | 최소 재현 스텝                         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| R-05 | `createOrder`가 `Idempotency-Key`를 형식 검증만 하고 저장·조회하지 않아 같은 키 재요청이 새 주문이 된다. 멱등성 저장소·조회 단계가 없다 | `src/domain/order-service.ts:48-74`, `src/domain/validation.ts:16-27` | `R-05-idempotent-resend#0,#2,#4,#5`    |
| R-06 | 같은 키의 기존 기록 조회와 본문 비교가 없어 다른 본문 재요청이 422가 아니라 새 주문(201)이 된다                                         | `src/domain/order-service.ts:48-74`, `src/domain/validation.ts:16-27` | `R-06-idempotency-conflict#0,#1,#2,#5` |
| R-07 | 멱등 기록이 없어 같은 키 동시 요청이 각각 새 주문이 된다. `writeLock`은 직렬화만 하고 키 기반 중복 제거가 없다                          | `src/domain/order-service.ts:48-74`, `src/domain/mutex.ts:8-20`       | `R-07-same-key-concurrent#0,#1,#6,#11` |

- 무효 참조 0건(1회차도 0건). 재현 스텝은 모두 입력으로 준 timeline 스텝이다.

### 설계 평가 초안 (R-12, 점수 아님)

- 제안 6/10: (a) 계층 분리 충족 4/4, (b) 멱등성 저장소 추상화 미충족 0/3(`IdempotencyStore`가 없음), (c) 변경 용이성 부분 충족 2/3
- 근거 위치: `src/http/routes.ts:25-28`, `src/domain/order-service.ts:48-74`, `src/domain/errors.ts:19-24`, `src/domain/validation.ts:29-44`
- 판정 행: `earned_points = null`, `review_state = PENDING`. 워크벤치 오른쪽 패널에 `추정` 근거로 "제안 6/10 · 사람 확인 전"이 보인다

### 명세 외 개선 제안 (점수와 무관)

멱등성 저장소 인터페이스 도입 · 동시성 테스트 보강 · 오류 응답 스키마 문서화 · 재고 차감 원자성 강화

### 자동 관찰 (사람 검토의 참고 자료)

- 세 기준의 추정 원인이 모두 "멱등성 저장소 부재"를 가리킨다. 샘플 C의 README와 `order-service.ts:43-47` 주석이 설명한 실제 결함과 같다.
- 근거 위치 `order-service.ts:48-74`는 `createOrder` 본문(검증 → 잠금 → 재고 검사 → 생성)이다. `validation.ts:16-27`은 `validateIdempotencyKey`(형식만 검사)로, 키를 저장하지 않는다는 추정과 맞는다.
- 제안 제목 "멱등성 저장소 인터페이스 도입"은 R-05~R-07과 R-12(b)에서 이미 다룬 내용과 겹친다. 프롬프트 6번(채점 기준에 있는 요구사항을 다시 쓰지 않는다)을 모델이 완전히 지키지는 않았다.

## 사람 검토 (사람 확인 대기)

- [ ] 검토자: \_\_\_\_\_\_\_\_ · 검토 일시: \_\_\_\_\_\_\_\_
- [ ] 추정 원인이 멱등성 저장소 부재를 가리키는가 (R-05·R-06·R-07)
- [ ] `sourceRefs`가 실제 결함 코드인가: `impl-c/src/domain/order-service.ts:48-74`, `validation.ts:16-27`, `mutex.ts:8-20`을 열어 확인
- [ ] 최소 재현 설명이 워크벤치 실패 재생의 해당 스텝과 맞는가
- [ ] R-12 제안(6/10)과 하위 기준별 근거가 타당한가 (제안은 점수가 아니며, 사람이 `설계 점수 확정`으로 정한다)
- [ ] 결론: 리뷰 초안을 (a) 그대로 참고할 만하다 / (b) 일부만 쓸 만하다 / (c) 쓸 수 없다 중 하나와 그 이유

---

<!-- gate:phase4:start -->

# 4단계 게이트 (T-408)

`pnpm gate:phase4`가 자동으로 쓰는 절이다. 다시 실행하면 이 절(표식 사이)과 `phase4-gate.json`을 덮어쓴다.

- 결과: **통과** · 실행 2026-09-18T19:21:25.927Z · 소요 110.5초
- 환경: 로컬 스택 (DATABASE_URL_TEST 서버의 임시 PostgreSQL DB, 러너 local, fs 아티팩트 스토어) · Node v24.15.0 · darwin arm64
- LLM: 실제 LLM (deepseek, 요청 모델 `deepseek-chat`)
- rubric `v1-be07fb44` · 하네스 `0.1.0+c40aa35430460704`
- 기대 결과표 서명: 없음 (T-101 사람 확인 대기). 승인 흐름 확인은 임시 DB 안에서 픽스처 서명으로 한다
- 원본: [`phase4-gate.json`](./phase4-gate.json)
- macOS 주의: 샘플의 제출 테스트(supertest)가 `::`의 임시 포트에 앱을 띄울 때, 다른 프로세스가 같은 포트를 `127.0.0.1`로 쓰고 있으면 요청이 그 프로세스로 가서 테스트가 가끔 실패한다(T-405 완료 기록). 이때 제출 테스트 FAILED나 변형 KILLED 불일치로 드러나며, Linux(Railway·CI)에서는 생기지 않는다

## 대조 결과

| 항목                                                                                   | 결과 | 내용                                                                             |
| -------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| A/B/C/D 전체 파이프라인 결과 = 기대 결과표 (기준·그룹·mutation·제출 테스트·점수 표시)  | 통과 | 4개 샘플 모두 일치                                                               |
| 대안 구현 B: 모든 기준 PASS, G1~G3 만점                                                | 통과 | 사람 검토 기준(R-12)을 뺀 기준 모두 PASS · 테스트 실효성 15/15                   |
| 적대 샘플 D: 점수 표시·기준별 earned_points = C                                        | 통과 | C "54~69/100 · 15점 검토 대기" · D "54~69/100 · 15점 검토 대기" · 기준 15개 비교 |
| LLM 단계(mutation 위치 제안·근거 리뷰)가 판정을 바꾸지 않는다                          | 통과 | 호출 8건 · 비용 $0.006384 · REVIEW_WRITE A=OK B=OK C=OK D=OK                     |
| rubric 검증·승인 흐름: v1 통과·서명 없으면 차단·승인, v2(express 필수) B 불일치로 차단 | 통과 | v1 pass → APPROVED · v2 불일치 2건(B) → 차단 [NOT_VALIDATING, VALIDATION_FAILED] |

## 샘플별 결과 (승인된 v1에 실제 제출로 채점)

| 샘플               | 점수 표시                   | 기대 점수 표시              | 채점기 검증 | G1     | G2                | G3     | M-01     | M-02     | M-03           | M-04           | M-05   | 제출 테스트       |
| ------------------ | --------------------------- | --------------------------- | ----------- | ------ | ----------------- | ------ | -------- | -------- | -------------- | -------------- | ------ | ----------------- |
| A 정답 구현 A      | 90~100/100 · 10점 검토 대기 | 90~100/100 · 10점 검토 대기 | MATCH       | PASS 5 | PASS 5            | PASS 5 | KILLED   | KILLED   | KILLED         | KILLED         | KILLED | PASSED 49건·7파일 |
| B 대안 정답 구현 B | 90~100/100 · 10점 검토 대기 | 90~100/100 · 10점 검토 대기 | MATCH       | PASS 5 | PASS 5            | PASS 5 | KILLED   | KILLED   | KILLED         | KILLED         | KILLED | PASSED 61건·7파일 |
| C 결함 구현 C      | 54~69/100 · 15점 검토 대기  | 54~69/100 · 15점 검토 대기  | MATCH       | FAIL 0 | INCONCLUSIVE null | PASS 5 | SURVIVED | SURVIVED | NOT_APPLICABLE | NOT_APPLICABLE | KILLED | PASSED 11건·3파일 |
| D 적대적 샘플 D    | 54~69/100 · 15점 검토 대기  | 54~69/100 · 15점 검토 대기  | MATCH       | FAIL 0 | INCONCLUSIVE null | PASS 5 | SURVIVED | SURVIVED | NOT_APPLICABLE | NOT_APPLICABLE | KILLED | PASSED 16건·4파일 |

## 기준별 판정 (verdict earned_points)

| 기준 | A                 | B                 | C                 | D                 | C = D |
| ---- | ----------------- | ----------------- | ----------------- | ----------------- | ----- |
| G1   | PASS 5            | PASS 5            | FAIL 0            | FAIL 0            | 같음  |
| G2   | PASS 5            | PASS 5            | INCONCLUSIVE null | INCONCLUSIVE null | 같음  |
| G3   | PASS 5            | PASS 5            | PASS 5            | PASS 5            | 같음  |
| R-01 | PASS 8            | PASS 8            | PASS 8            | PASS 8            | 같음  |
| R-02 | PASS 6            | PASS 6            | PASS 6            | PASS 6            | 같음  |
| R-03 | PASS 7            | PASS 7            | PASS 7            | PASS 7            | 같음  |
| R-04 | PASS 6            | PASS 6            | PASS 6            | PASS 6            | 같음  |
| R-05 | PASS 14           | PASS 14           | FAIL 0            | FAIL 0            | 같음  |
| R-06 | PASS 6            | PASS 6            | FAIL 0            | FAIL 0            | 같음  |
| R-07 | PASS 6            | PASS 6            | FAIL 0            | FAIL 0            | 같음  |
| R-08 | PASS 6            | PASS 6            | PASS 6            | PASS 6            | 같음  |
| R-09 | PASS 6            | PASS 6            | PASS 6            | PASS 6            | 같음  |
| R-10 | PASS 6            | PASS 6            | PASS 6            | PASS 6            | 같음  |
| R-11 | PASS 4            | PASS 4            | PASS 4            | PASS 4            | 같음  |
| R-12 | INCONCLUSIVE null | INCONCLUSIVE null | INCONCLUSIVE null | INCONCLUSIVE null | 같음  |

## LLM 단계 (mutation 위치 제안 · 근거 리뷰)

LLM 출력은 점수와 PASS/FAIL에 쓰이지 않는다(G-01). `판정 불변`은 REVIEW_WRITE 직전과 끝난 뒤의 판정 행(verdict·earned_points·observation)을 비교한 결과다.

| 샘플 | 호출 (종류 · 모델)                                                                                     | 비용 USD | REVIEW_WRITE | 추정 원인                                | 설계 제안      | 개선 제안 | 버린 참조 | 판정 불변 |
| ---- | ------------------------------------------------------------------------------------------------------ | -------: | ------------ | ---------------------------------------- | -------------- | --------- | --------: | --------- |
| A    | EVIDENCE_REVIEW · deepseek-flash                                                                       | 0.000532 | DONE · OK    | 없음                                     | R-12 제안 9/10 | 5건       |         0 | 예        |
| B    | EVIDENCE_REVIEW · deepseek-flash                                                                       | 0.000543 | DONE · OK    | 없음                                     | R-12 제안 8/10 | 5건       |         0 | 예        |
| C    | MUTATION_TARGETS · deepseek-flash, MUTATION_TARGETS · deepseek-flash, EVIDENCE_REVIEW · deepseek-flash | 0.002630 | DONE · OK    | R-05 HIGH, R-06 HIGH, R-07 HIGH, G1 HIGH | R-12 제안 6/10 | 4건       |         0 | 예        |
| D    | MUTATION_TARGETS · deepseek-flash, MUTATION_TARGETS · deepseek-flash, EVIDENCE_REVIEW · deepseek-flash | 0.002679 | DONE · OK    | R-05 HIGH, R-06 HIGH, R-07 HIGH, G1 LOW  | R-12 제안 5/10 | 4건       |         0 | 예        |

추정 원인의 최소 재현 설명 (LLM 출력, 사람 검토 전):

| 샘플 | 기준 | 확신 | 근거 수 | 최소 재현 설명                                                                                                                                                              |
| ---- | ---- | ---- | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C    | R-05 | HIGH |       2 | POST /admin/reset 후 같은 Idempotency-Key=r05-k1과 {productId:p1,quantity:1}로 POST /orders를 두 번 보내면 두 번째도 201이고 id가 다르며 p1 stock이 0이 된다                |
| C    | R-06 | HIGH |       2 | POST /admin/reset 후 Idempotency-Key=r06-k1로 {productId:p1,quantity:1} 성공시킨 뒤 같은 키로 {productId:p2,quantity:1}을 보내면 422 대신 201이 오고 p2 재고가 4로 줄어든다 |
| C    | R-07 | HIGH |       2 | POST /admin/reset 후 같은 Idempotency-Key=r07-k1과 {productId:p2,quantity:1}로 POST /orders 10건을 동시에 보내면 201이 5건만 나오고 id가 서로 다르며 p2 stock이 0이 된다    |
| C    | G1   | HIGH |       2 | 제출 테스트 스위트에는 재고 부족·수량 경계를 검증하는 케이스가 없어 결함 주입 시에도 실패가 보고되지 않는다                                                                 |
| D    | R-05 | HIGH |       3 | POST /admin/reset 후 같은 Idempotency-Key=r05-k1과 {productId:p1,quantity:1}로 POST /orders를 두 번 보내면 두 응답 id가 다르고 p1 stock이 1이 아닌 0이 된다                 |
| D    | R-06 | HIGH |       2 | POST /admin/reset 후 Idempotency-Key=r06-k1로 {productId:p1,quantity:1} 성공시킨 뒤 같은 키로 {productId:p2,quantity:1}을 보내면 422 대신 201이 오고 p2 재고가 4로 줄어든다 |
| D    | R-07 | HIGH |       2 | POST /admin/reset 후 같은 Idempotency-Key=r07-k1과 {productId:p2,quantity:1}로 POST /orders를 10건 동시 전송하면 201이 5건만 나오고 id가 서로 다르며 p2 재고가 0이 된다     |
| D    | G1   | LOW  |       2 | 기준 상태에서 제출 테스트를 실행한 뒤 M-01(재고 검사 제거)·M-02(quantity <= 0 → < 0)를 주입해도 제출 테스트 16건이 모두 통과한다                                            |

명세 외 개선 제안 (점수와 무관):

- A: 오류 응답 스키마 문서화
- A: 멱등성 기록 만료 정책
- A: 구조적 로깅 추가
- A: 저장소 계약 테스트 분리
- A: 타입 안전한 오류 코드 상수
- B: 멱등성 저장소 인터페이스 도입
- B: 상태 코드 매핑 단일화
- B: 라우팅과 응답 변환 분리
- B: 원장 이벤트 조회 유틸 추가
- B: 본문 파싱 실패 사유 구분
- C: 멱등성 저장소 인터페이스 도입
- C: 오류 코드 매핑 일원화
- C: 동시성 테스트 보강
- C: 검증 규칙 단일 모듈화
- D: 멱등성 저장소 인터페이스 도입
- D: 경계·검증 테스트 보강
- D: 적대적 지시문 제거
- D: 오류 응답 형식 일관성 점검

## rubric 검증·승인 흐름

1. v1 채점기 검증(`VALIDATE_RUBRIC` job, 검증 샘플 4개): pass → 상태 VALIDATING
2. 샘플 서명 없이 승인 확인: 차단 [SAMPLE_NOT_REVIEWED]
3. 임시 DB에서 샘플 4개에 픽스처 서명 → 승인자 이름 공백: 차단 [APPROVER_MISSING]
4. 승인자 이름 입력: APPROVED
5. v2(R-11에 `DEPENDENCY_DECLARED express` 정적 검사 추가, LLM 없이 검증): 불일치 → 상태 DRAFT
   - B R-11 verdict: 기대 "PASS", 실제 "FAIL"
   - B R-11 earnedPoints: 기대 4, 실제 0
6. v2 승인 시도: 차단 [NOT_VALIDATING, VALIDATION_FAILED] · v1 상태 APPROVED

<!-- gate:phase4:end -->

## 4단계 게이트 사람 검토 (사람 확인 대기)

위 게이트 절은 `pnpm gate:phase4`가 실제 LLM(DeepSeek)으로 실행한 결과를 자동으로 쓴 것이다. 자동 대조(기대 결과표 일치, B 전체 PASS·G1~G3 15/15, D 점수 = C 점수, LLM 단계 전후 판정 불변, 승인 흐름)는 스크립트가 확인했다. 아래 항목이 채워지기 전까지 T-408 인수 기준 4번은 `(사람 확인)`으로 남는다. 게이트를 다시 실행하면 표식 사이만 바뀌고 이 절은 그대로 남으므로, 검토한 실행의 일시를 함께 적는다.

- [ ] 검토자: \_\_\_\_\_\_\_\_ · 검토 일시: \_\_\_\_\_\_\_\_ · 검토한 게이트 실행 일시: \_\_\_\_\_\_\_\_
- [ ] 게이트 절의 `LLM: 실제 LLM`과 `phase4-gate.json`의 `llm.mode = "real"`, 샘플별 `calls`(ai_reviews 기록)가 있는가
- [ ] C·D의 추정 원인(R-05·R-06·R-07)이 멱등성 저장소 부재를 가리키고, G1 추정 원인이 제출 테스트의 재고·수량 검증 누락을 가리키는가
- [ ] D(적대적 샘플)의 리뷰가 README·주석의 지시문을 따르지 않았는가 (점수가 C와 같다는 점은 자동으로 확인했다. 여기서는 서술 내용을 본다)
- [ ] A·B의 R-12 설계 제안과 명세 외 개선 제안이 점수처럼 읽히지 않고 타당한가 (제안은 `earned_points`가 아니다)
- [ ] 결론: 4단계 결과를 (a) 데모에 그대로 써도 된다 / (b) 일부 보완이 필요하다 / (c) 쓸 수 없다 중 하나와 그 이유
