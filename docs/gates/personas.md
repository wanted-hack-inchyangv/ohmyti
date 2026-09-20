# 6단계 게이트: 페르소나 4종 배포 환경 회귀 (T-606)

`pnpm gate:personas`가 만든 기록이다. 배포된 웹의 제출 폼(`/submissions/new`)에 페르소나의 과제 저장소 URL·커밋 SHA·이력서 PDF·GitHub 프로필 URL을 넣어 제출하고, Railway 워커가 채점·맥락 연결한 결과를 조회 API(`/api/evaluations/[id]`, `/api/evaluations/[id]/context`)로 읽어 `samples/personas/expected-matrix.json`과 대조한다. 실패 조건은 기준별 판정·점수, 변이 결과, 점수 표시, 단계 상태, REVIEW_WRITE의 LLM 결과와 R-12 초안, GitHub 근거 선정·커밋 수집, 후속 질문 존재다. 주장 상태 라벨은 LLM 판단이라 경고로만 적는다.

- 결과: **통과**
- 배포: https://ohmyti.vercel.app
- 실행 일시: 2026-09-20T04:34:56.292Z ~ 2026-09-20T04:47:49.387Z (총 12.9분)
- rubric: `v2-be07fb44` · 기대값: `samples/personas/expected-matrix.json`

## 제출

| 페르소나 | 저장소 @ SHA                 | 제출 ID                                | 평가 ID                                                                                                              | 상태      | 제출→종료 | 불일치 | 경고 |
| -------- | ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------- | --------: | -----: | ---: |
| seojin   | seojin-order-api @ `d35969b` | `a21def92-ee82-4335-a6fd-8349ffacbcf8` | [`1bc69b13-00c6-4283-aa1b-52e6f5616362`](https://ohmyti.vercel.app/evaluations/1bc69b13-00c6-4283-aa1b-52e6f5616362) | COMPLETED |      186s |      0 |    0 |
| taeyun   | taeyun-order-api @ `4c595e3` | `822b60c3-4982-4e1c-bcaf-ab830a3d20fb` | [`f9d4d72a-72d0-4a2f-9907-11563827bcf4`](https://ohmyti.vercel.app/evaluations/f9d4d72a-72d0-4a2f-9907-11563827bcf4) | COMPLETED |      361s |      0 |    2 |
| gaeun    | gaeun-order-api @ `dbff20e`  | `69033fda-51af-47cc-9af1-6b4710131f5a` | [`855fa55b-8530-4782-8c12-745fdaefd9f4`](https://ohmyti.vercel.app/evaluations/855fa55b-8530-4782-8c12-745fdaefd9f4) | COMPLETED |      487s |      0 |    0 |
| dohyun   | dohyun-order-api @ `3cf8469` | `c98810b5-ea18-4583-8d3b-cd42d4c83082` | [`8dacf67a-16b6-4295-bc4b-d0d9a9e6ba10`](https://ohmyti.vercel.app/evaluations/8dacf67a-16b6-4295-bc4b-d0d9a9e6ba10) | COMPLETED |      671s |      0 |    2 |

## 기준별 판정 (기대 → 실제)

| 기준 | seojin                                                      | taeyun                                                    | gaeun                                                     | dohyun                                                    |
| ---- | ----------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| R-01 | PASS → PASS 8 ✓                                             | PASS → PASS 8 ✓                                           | PASS → PASS 8 ✓                                           | PASS → PASS 8 ✓                                           |
| R-02 | PASS → PASS 6 ✓                                             | PASS → PASS 6 ✓                                           | PASS → PASS 6 ✓                                           | PASS → PASS 6 ✓                                           |
| R-03 | PASS → PASS 7 ✓                                             | PASS → PASS 7 ✓                                           | PASS → PASS 7 ✓                                           | PASS → PASS 7 ✓                                           |
| R-04 | PASS → PASS 6 ✓                                             | PASS → PASS 6 ✓                                           | FAIL → FAIL 0 ✓                                           | PASS → PASS 6 ✓                                           |
| R-05 | PASS → PASS 14 ✓                                            | PASS → PASS 14 ✓                                          | FAIL → FAIL 0 ✓                                           | PASS → PASS 14 ✓                                          |
| R-06 | PASS → PASS 6 ✓                                             | FAIL → FAIL 0 ✓                                           | FAIL → FAIL 0 ✓                                           | PASS → PASS 6 ✓                                           |
| R-07 | PASS → PASS 6 ✓                                             | FAIL → FAIL 0 ✓                                           | FAIL → FAIL 0 ✓                                           | PASS → PASS 6 ✓                                           |
| R-08 | PASS → PASS 6 ✓                                             | PASS → PASS 6 ✓                                           | PASS → PASS 6 ✓                                           | PASS → PASS 6 ✓                                           |
| R-09 | PASS → PASS 6 ✓                                             | PASS → PASS 6 ✓                                           | FAIL → FAIL 0 ✓                                           | PASS → PASS 6 ✓                                           |
| R-10 | PASS → PASS 6 ✓                                             | PASS → PASS 6 ✓                                           | PASS → PASS 6 ✓                                           | PASS → PASS 6 ✓                                           |
| R-11 | PASS → PASS 4 ✓                                             | PASS → PASS 4 ✓                                           | PASS → PASS 4 ✓                                           | PASS → PASS 4 ✓                                           |
| G1   | PASS → PASS 5 ✓                                             | PASS → PASS 5 ✓                                           | FAIL → FAIL 0 ✓                                           | FAIL → FAIL 0 ✓                                           |
| G2   | PASS → PASS 5 ✓                                             | PASS → PASS 5 ✓                                           | INCONCLUSIVE → INCONCLUSIVE ✓                             | FAIL → FAIL 0 ✓                                           |
| G3   | PASS → PASS 5 ✓                                             | PASS → PASS 5 ✓                                           | INCONCLUSIVE → INCONCLUSIVE ✓                             | FAIL → FAIL 0 ✓                                           |
| R-12 | INCONCLUSIVE → INCONCLUSIVE ✓                               | INCONCLUSIVE → INCONCLUSIVE ✓                             | INCONCLUSIVE → INCONCLUSIVE ✓                             | INCONCLUSIVE → INCONCLUSIVE ✓                             |
| 점수 | 90~100/100 · 10점 검토 대기 → 90~100/100 · 10점 검토 대기 ✓ | 78~88/100 · 10점 검토 대기 → 78~88/100 · 10점 검토 대기 ✓ | 37~57/100 · 20점 검토 대기 → 37~57/100 · 20점 검토 대기 ✓ | 75~85/100 · 10점 검토 대기 → 75~85/100 · 10점 검토 대기 ✓ |

## 변이 결과 (기대 → 실제)

| 변이 | seojin                            | taeyun                            | gaeun                             | dohyun                |
| ---- | --------------------------------- | --------------------------------- | --------------------------------- | --------------------- |
| M-01 | KILLED → KILLED ✓                 | KILLED → KILLED ✓                 | SURVIVED → SURVIVED ✓             | SURVIVED → SURVIVED ✓ |
| M-02 | NOT_APPLICABLE → NOT_APPLICABLE ✓ | KILLED → KILLED ✓                 | NOT_APPLICABLE → NOT_APPLICABLE ✓ | SURVIVED → SURVIVED ✓ |
| M-03 | KILLED → KILLED ✓                 | KILLED → KILLED ✓                 | NOT_APPLICABLE → NOT_APPLICABLE ✓ | SURVIVED → SURVIVED ✓ |
| M-04 | KILLED → KILLED ✓                 | NOT_APPLICABLE → NOT_APPLICABLE ✓ | NOT_APPLICABLE → NOT_APPLICABLE ✓ | SURVIVED → SURVIVED ✓ |
| M-05 | KILLED → KILLED ✓                 | KILLED → KILLED ✓                 | NOT_APPLICABLE → NOT_APPLICABLE ✓ | SURVIVED → SURVIVED ✓ |

- seojin M-02: 수량 하한이 zod 스키마 `min(1)`에 있어 비교식 변이 대상이 아니다(알려진 한계). 페르소나 자체 검증은 스키마를 직접 고쳐 KILLED였다. G1은 M-01 KILLED로 PASS다 · 워커 사유: 대상 로직 없음 · AST 휴리스틱 후보 없음, LLM 후보 1개 모두 검증 실패 (거절 코드: NODE_NOT_FOUND)
- taeyun M-04: 대상 기준 R-06이 기준 상태에서 이미 FAIL이라 적용하지 않는다. G2는 M-03 KILLED로 PASS다 · 워커 사유: 대상 로직 없음 · AST 휴리스틱 후보 없음, LLM 후보 없음
- gaeun M-02: 대상 기준 R-04가 이미 FAIL · 워커 사유: 대상 로직 없음 · AST 휴리스틱 후보 없음, LLM 후보 없음
- gaeun M-03: 대상 기준 R-05가 이미 FAIL · 워커 사유: 대상 로직 없음 · AST 휴리스틱 후보 없음, LLM 후보 없음
- gaeun M-04: 대상 기준 R-06이 이미 FAIL · 워커 사유: 대상 로직 없음 · AST 휴리스틱 후보 없음, LLM 후보 없음
- gaeun M-05: 대상 기준 R-09가 이미 FAIL · 워커 사유: 대상 로직 없음 · AST 휴리스틱 후보 없음, LLM 후보 없음

## GitHub 근거 선정

| 페르소나 | 상태 · 선정 방식        | 선택된 저장소 (커밋·병합 PR·작성자 조건)                                                                                 | 제외한 제출 저장소                       |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| seojin   | COLLECTED · RESUME_LINK | `wanted-hack-inchyangv/seojin-stock-reservation` (17·0·NONE), `wanted-hack-inchyangv/seojin-idempotency-kit` (14·0·NONE) | `wanted-hack-inchyangv/seojin-order-api` |
| taeyun   | COLLECTED · RESUME_LINK | `wanted-hack-inchyangv/taeyun-til-cli` (12·0·NONE), `wanted-hack-inchyangv/taeyun-room-booking` (12·0·NONE)              | `wanted-hack-inchyangv/taeyun-order-api` |
| gaeun    | COLLECTED · RESUME_LINK | `wanted-hack-inchyangv/gaeun-todo-react` (9·0·NONE), `wanted-hack-inchyangv/gaeun-bookmark-api` (9·0·NONE)               | `wanted-hack-inchyangv/gaeun-order-api`  |
| dohyun   | COLLECTED · RESUME_LINK | `wanted-hack-inchyangv/dohyun-report-batch` (10·0·NONE), `wanted-hack-inchyangv/dohyun-board-api` (8·0·NONE)             | `wanted-hack-inchyangv/dohyun-order-api` |

## 단계 · REVIEW_WRITE · R-12 초안

| 페르소나 | 단계                                                                                                                                             | REVIEW_WRITE LLM | R-12 초안 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | --------- |
| seojin   | REPO_CHECK DONE · ENV_PREP DONE · REQUIREMENT_VERIFY DONE · TEST_EFFECTIVENESS DONE · REVIEW_WRITE DONE · CONTEXT_LINK DONE · INTERVIEW_KIT DONE | OK               | 9/10      |
| taeyun   | REPO_CHECK DONE · ENV_PREP DONE · REQUIREMENT_VERIFY DONE · TEST_EFFECTIVENESS DONE · REVIEW_WRITE DONE · CONTEXT_LINK DONE · INTERVIEW_KIT DONE | OK               | 7/10      |
| gaeun    | REPO_CHECK DONE · ENV_PREP DONE · REQUIREMENT_VERIFY DONE · TEST_EFFECTIVENESS DONE · REVIEW_WRITE DONE · CONTEXT_LINK DONE · INTERVIEW_KIT DONE | OK               | 3/10      |
| dohyun   | REPO_CHECK DONE · ENV_PREP DONE · REQUIREMENT_VERIFY DONE · TEST_EFFECTIVENESS DONE · REVIEW_WRITE DONE · CONTEXT_LINK DONE · INTERVIEW_KIT DONE | OK               | 3/10      |

- seojin R-12 초안 근거: (a) 계층 분리: src/http/routes.ts의 핸들러는 헤더·본문 파싱과 zod 검증(48-59행)만 하고 도메인 규칙은 orderService.createOrder/cancelOrder 호출(61-65, 77행)로 위임한다. 라우트 핸들러는 RequestContext만 알고 도메인 규칙을 담지 않으며, application/order-service.ts는 req/res를 참조하지 않는 구조로 보인다(파일 목록·README 구조 설명과 일치). (b) 멱등성 저장소 추상화: application/ports.ts에 IdempotencyStore 인터페이스가 있고 infra/in-memory-repositories.ts가 구현하며 OrderService가 생성자 주입을 받는 구조다. 저장소 교체 시 주문 생성 로직 수정이 불필요하다는 점이 파일 분리로 확인된다. (c) 변경 용이성: domain/errors.ts에 오류 코드↔상태 매핑이 모이고 http/schemas.ts에 검증 스키마가 모이며, 라우트는 AppError를 상태 코드로 변환하는 단일 지점을 통과한다. 다만 오류 코드 추가 시 errors.ts와 각 라우트의 throw 지점을 함께 손대야 하는 부분은 남아 있어 만점은 아니다. AST 신호(명시적 any 0, strict 켜짐, 약한 단언 0%)는 타입 안정성과 테스트 구체성에 부합한다.
- taeyun R-12 초안 근거: (a) 계층 분리: 라우트(order-routes.ts)는 req.header/req.body를 읽어 service.createOrder에 값으로 넘기고 응답 직렬화만 하며, 서비스는 req/res에 의존하지 않고 AppError를 던진다. HTTP와 도메인 규칙이 모듈로 나뉘어 있어 4점 기준은 충족한다. (b) 멱등성 저장소 추상화: idempotency.get/set이 별도 모듈(InMemoryIdempotencyRepository) 뒤에 있고 서비스는 인터페이스만 호출하므로 저장소 교체 시 createOrder를 고칠 필요가 없다. 다만 저장소가 키 존재 여부만 다루고 본문 비교·원자적 선점 같은 멱등성 의미론이 서비스에 흩어져 있어 3점 중 일부만 인정한다. (c) 변경 용이성: 오류 코드→HTTP 상태 매핑은 errors.ts 한 곳에 모여 있고 검증 규칙은 validation.ts에 집중되어 있으나, 멱등성 충돌 판정이 아예 없고 재고 부족 판정이 product-repository.reserveStock에 있어 새 오류 코드 추가 시 서비스·저장소를 함께 봐야 한다. 세 하위 기준을 종합해 만점 10 중 7을 제안한다.
- gaeun R-12 초안 근거: (a) 계층 분리: 라우팅·응답 처리는 src/app.ts, 데이터 접근은 src/data.ts로 나뉘어 있으나 도메인 규칙(재고 차감, 재고 부족 판정, 취소)이 핸들러 콜백 안에 인라인되어 있고 createOrder가 product 객체를 직접 변경한다. 도메인 규칙이 HTTP 객체에 직접 의존하지는 않으므로 부분 충족으로 본다. (b) 멱등성 저장소 추상화: 멱등성 기록 저장·조회 코드가 아예 없어 인터페이스나 별도 모듈이 존재하지 않는다. (c) 변경 용이성: 오류 코드·상태 코드 매핑이 각 핸들러에 흩어져 있고 검증 규칙도 핸들러 내부에 있어 추가 시 여러 위치를 고쳐야 한다. 같은 모양의 연속 문장 블록 1건(조회 핸들러 3문장)과 명시적 any 3곳도 응집도가 낮은 신호로 확인된다.
- dohyun R-12 초안 근거: (a) 계층 분리: 라우팅·파싱·응답 직렬화와 도메인 규칙이 모두 src/index.ts 한 파일의 라우트 콜백 안에 섞여 있다. POST /orders 콜백이 133줄(src/index.ts:101-233)에 걸쳐 멱등키 검증, 본문 검증, 멱등 기록 조회, 재고 차감을 직접 수행하고, 취소 콜백도 재고 복구 로직을 인라인으로 담고 있다(src/index.ts:295-304). 도메인 규칙이 별도 모듈로 분리되지 않아 (a)는 미흡하다. (b) 멱등성 저장소 추상화: idemStore가 배열 변수로 선언되어 라우트 콜백에서 for 루프로 직접 순회·비교된다(src/index.ts:167-174). 인터페이스나 별도 모듈이 없어 저장소 교체 시 주문 생성 로직을 고쳐야 하므로 (b)는 미흡하다. (c) 변경 용이성: 오류 응답이 각 검증 분기마다 res.status(...).json({error:{code:...}}) 형태로 반복 하드코딩되어 있고, 같은 모양의 연속 문장 블록이 src/index.ts:79-90과 241-252에 나타난다. 상태 코드·오류 코드 매핑이 한 곳에 모여 있지 않아 (c)도 미흡하다. 다만 라우트별로 검증 순서가 읽히고 400/404/409/422 코드가 일관된 형태로 쓰인 점은 부분적 가점 요소다. 세 하위 기준 모두 뚜렷한 분리·추상화 근거가 없어 만점 10 중 낮은 제안 점수를 둔다.

## 맥락 연결과 후속 질문

### seojin

| 주장                                                                                                                                                                                      | 상태           | 관측 기준 | 후속 질문                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| TTL 기반 예약과 버전 비교(version check) 기반의 낙관적 잠금(optimistic locking)으로 재고 차감을 직렬화한 결과, 피크 트래픽 구간에서 동시 주문 때문에 생긴 초과 판매를 0건으로 줄였습니다. | EVIDENCE_FOUND | R-08      | 재고 선점 시스템에서 낙관적 잠금 충돌이 났을 때 재시도는 어떤 조건으로 몇 번까지 수행하도록 설계하셨나요?                  |
| 결제·주문 생성 API에 멱등성 키(Idempotency-Key) 미들웨어를 도입해, 클라이언트 재시도·네트워크 재전송으로 발생하던 중복 주문을 제거했습니다.                                               | EVIDENCE_FOUND | R-05      | 결제·주문 생성 API에 붙인 멱등성 키 미들웨어에서 같은 키로 진행 중인 요청이 두 번 들어오면 어떻게 병합하도록 구현하셨나요? |
| 도입 후 3개월간 중복 주문 때문에 생긴 결제 취소·환불 처리 건수가 0건으로 유지되고 있습니다.                                                                                               | NEEDS_CHECK    | R-06      | 중복 주문으로 인한 결제 취소·환불 건수 0건은 어떤 지표와 기간으로 집계하셨나요?                                            |
| 주문 생성부터 배송 상태 변경까지의 도메인 이벤트를 Kafka 기반 이벤트 파이프라인으로 전환해 주문·재고·정산 서비스 간 동기 호출 의존을 제거했습니다.                                        | NO_DATA        | -         | 주문·재고·정산 서비스 간 동기 호출을 Kafka 이벤트로 전환할 때 어떤 이벤트 단위와 순서 보장 기준을 세우셨나요?              |
| 운송장 조회 API의 응답 지연을 인덱스 재설계와 캐시 도입으로 개선해 p95 응답 시간을 1.2초에서 180ms로 단축했습니다.                                                                        | NO_DATA        | -         | 운송장 조회 API의 p95 응답 시간 1.2초에서 180ms 단축은 어떤 측정 환경과 트래픽 조건에서 확인하셨나요?                      |

### taeyun

| 주장                                                                                                                                                                     | 상태           | 관측 기준 | 후속 질문                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | --------- | ---------------------------------------------------------------------------------------- |
| 결제 웹훅(payment webhook) 수신을 맡아 같은 웹훅이 재전송돼도 결제가 중복 반영되지 않도록 멱등(idempotent) 처리를 담당했습니다.                                          | NEEDS_CHECK    | R-05      | 결제 웹훅 멱등 처리에서 같은 키로 다른 내용이 재전송되면 어떻게 처리하도록 설계하셨나요? |
| 독서 모임 예약(booking) API를 개발하며 같은 시간대에 같은 장소·모임이 중복 예약되지 않도록 검증 로직을 구현했습니다.                                                     | EVIDENCE_FOUND | R-08      | 회사 예약 API에서 중복 예약 검증은 어느 계층에서 어떤 조건으로 수행하셨나요?             |
| 모임·예약·결제 도메인의 라우팅(routes)·서비스(services)·저장소(repository) 계층을 분리하는 리팩터링에 참여해 신규 기능 추가 시 변경 범위를 줄였습니다.                   | EVIDENCE_FOUND | R-12      | 계층을 분리한 뒤 신규 기능을 추가할 때 변경 범위가 실제로 어떻게 달라졌나요?             |
| 회의실 예약 REST API. 같은 시간대 중복 예약(overlapping booking)을 막는 검사 로직, zod 기반 입력 검증, routes/services/repository 계층 분리, vitest 테스트를 포함합니다. | EVIDENCE_FOUND | G1        | 중복 예약 검사 로직에서 어떤 경계 조건을 테스트로 고정하셨나요?                          |
| TIL(Today I Learned) 마크다운을 관리하는 Node.js CLI 도구입니다. 기록 작성, 태그 검색, 주간 요약 기능을 붙여서 팀의 개발 생산성을 높이는 데 도움이 됐습니다.             | EVIDENCE_FOUND | -         | 주간 요약 기능은 어떤 기간 기준과 데이터 소스로 동작하도록 만드셨나요?                   |

### gaeun

| 주장                                                                                                                     | 상태           | 관측 기준 | 후속 질문                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | -------------- | --------- | ----------------------------------------------------------------------------- |
| 팀 프로젝트로 주문/예약 API를 설계하며 대용량 트래픽 환경을 고려한 동시성 제어와 멱등성 설계 경험을 쌓음                 | NEEDS_CHECK    | R-05      | 팀 프로젝트에서 멱등성은 어떤 기준으로 같은 요청인지 판단하도록 설계하셨나요? |
| 부트캠프 백엔드 과정에서 만든 Express 기반 북마크(bookmark) CRUD API. 인메모리 저장소와 간단한 테스트 코드를 포함합니다. | EVIDENCE_FOUND | R-04      | 북마크 API에서 입력값 검증은 어떤 기준으로 어디에 두셨나요?                   |
| 기존 jQuery 기반 화면 일부를 React + TypeScript 컴포넌트로 전환                                                          | EVIDENCE_FOUND | -         | jQuery 기반 화면을 React 컴포넌트로 전환할 때 상태 관리는 어떻게 옮기셨나요?  |

### dohyun

| 주장                                                                                                                            | 상태           | 관측 기준 | 후속 질문                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | -------------------------------------------------------------------------- |
| 최근 참여한 프로젝트에서는 클린 아키텍처(Clean Architecture)와 TDD(Test-Driven Development)를 적용하여 유지보수성을 높였습니다. | NEEDS_CHECK    | G1        | 클린 아키텍처와 TDD를 적용한 프로젝트에서 계층을 나눈 기준은 무엇이었나요? |
| 온라인몰 주문 API 고도화 B 유통사 2023.02 2023.12 백엔드 개발, 성능 개선 Java, Spring Boot, Oracle, Redis                       | NEEDS_CHECK    | R-05      | 온라인몰 주문 API에서 성능 개선은 어떤 지표를 기준으로 진행하셨나요?       |
| 매출 CSV 데이터를 집계해 보고서를 CSV와 HTML 요약으로 자동 생성하는 Node.js 배치 스크립트입니다.                                | EVIDENCE_FOUND | -         | CSV 파싱을 외부 라이브러리 없이 직접 구현하신 이유는 무엇인가요?           |
| 게시글·댓글 CRUD와 페이징을 갖춘 게시판(board) REST API입니다. Express와 TypeScript로 구현했고 데이터는 JSON 파일에 저장합니다. | EVIDENCE_FOUND | -         | JSON 파일에 데이터를 저장할 때 동시 쓰기는 어떻게 다루셨나요?              |

## 불일치

없음

## 경고 (주장 상태 라벨, 실패 조건 아님)

- taeyun: 주장(웹훅·webhook): 기대 NO_DATA, 실제 NEEDS_CHECK
- taeyun: 주장(CLI): 기대 NEEDS_CHECK, 실제 EVIDENCE_FOUND
- dohyun: 주장(SI·납기): 맥락 연결에서 찾지 못함 (기대 EVIDENCE_FOUND)
- dohyun: 주장(TDD·클린 아키텍처·Clean Architecture): 기대 NO_DATA, 실제 NEEDS_CHECK

## 화면 캡처

데스크톱 1440×900, 모바일 iPhone 13(390×844) 전체 페이지 캡처다. 자동 점검: HTTP 상태, 가로 넘침, 오류 화면 문구, 콘솔 오류.

| 화면                 | 뷰포트  | HTTP | 가로 넘침 | 콘솔 오류 | 파일                                                   | 문제 |
| -------------------- | ------- | ---: | --------: | --------: | ------------------------------------------------------ | ---- |
| 01-home              | desktop |  200 |       0px |         0 | `docs/gates/personas/01-home-desktop.png`              | 없음 |
| 02-submit            | desktop |  200 |       0px |         0 | `docs/gates/personas/02-submit-desktop.png`            | 없음 |
| 03-submission-status | desktop |  200 |       0px |         0 | `docs/gates/personas/03-submission-status-desktop.png` | 없음 |
| 04-workbench         | desktop |  200 |       0px |         0 | `docs/gates/personas/04-workbench-desktop.png`         | 없음 |
| 05-workbench-r12     | desktop |  200 |       0px |         0 | `docs/gates/personas/05-workbench-r12-desktop.png`     | 없음 |
| 01-home              | mobile  |  200 |       0px |         0 | `docs/gates/personas/01-home-mobile.png`               | 없음 |
| 02-submit            | mobile  |  200 |       0px |         0 | `docs/gates/personas/02-submit-mobile.png`             | 없음 |
| 03-submission-status | mobile  |  200 |       0px |         0 | `docs/gates/personas/03-submission-status-mobile.png`  | 없음 |
| 04-workbench         | mobile  |  200 |       0px |         0 | `docs/gates/personas/04-workbench-mobile.png`          | 없음 |
| 05-workbench-r12     | mobile  |  200 |       0px |         0 | `docs/gates/personas/05-workbench-r12-mobile.png`      | 없음 |
