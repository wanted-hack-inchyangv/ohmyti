# 6단계 게이트: 페르소나 4종 배포 환경 회귀 (T-606)

`pnpm gate:personas`가 만든 기록이다. 배포된 웹의 제출 폼(`/submissions/new`)에 페르소나의 과제 저장소 URL·커밋 SHA·이력서 PDF·GitHub 프로필 URL을 넣어 제출하고, Railway 워커가 채점·맥락 연결한 결과를 조회 API(`/api/evaluations/[id]`, `/api/evaluations/[id]/context`)로 읽어 `samples/personas/expected-matrix.json`과 대조한다. 실패 조건은 기준별 판정·점수, 변이 결과, 점수 표시, 단계 상태, REVIEW_WRITE의 LLM 결과와 R-12 초안, GitHub 근거 선정·커밋 수집, 후속 질문 존재다. 주장 상태 라벨은 LLM 판단이라 경고로만 적는다.

- 결과: **통과**
- 배포: https://ohmyti.vercel.app
- 실행 일시: 2026-09-20T01:36:50.996Z ~ 2026-09-20T01:49:01.238Z (총 12.2분)
- rubric: `v2-be07fb44` · 기대값: `samples/personas/expected-matrix.json`

## 제출

| 페르소나 | 저장소 @ SHA                 | 제출 ID                                | 평가 ID                                                                                                              | 상태      | 제출→종료 | 불일치 | 경고 |
| -------- | ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------- | --------: | -----: | ---: |
| seojin   | seojin-order-api @ `d35969b` | `2b458a6a-c41d-47d1-ad31-42c49dfc0078` | [`0f3b8cbe-c5a1-4f64-a9c5-6a1ccee20fa0`](https://ohmyti.vercel.app/evaluations/0f3b8cbe-c5a1-4f64-a9c5-6a1ccee20fa0) | COMPLETED |      163s |      0 |    2 |
| taeyun   | taeyun-order-api @ `4c595e3` | `106fc323-3bdc-4014-acf3-dbec7d7d5f8e` | [`65711c8c-7660-4c69-9517-fb80911f499a`](https://ohmyti.vercel.app/evaluations/65711c8c-7660-4c69-9517-fb80911f499a) | COMPLETED |      330s |      0 |    7 |
| gaeun    | gaeun-order-api @ `dbff20e`  | `6cba126e-1039-4118-9248-2734a18c780b` | [`069a839f-ad1b-43a0-8d98-80adffad73a6`](https://ohmyti.vercel.app/evaluations/069a839f-ad1b-43a0-8d98-80adffad73a6) | COMPLETED |      451s |      0 |    3 |
| dohyun   | dohyun-order-api @ `3cf8469` | `8ee90138-edf1-4a99-ae6e-62d5acc524e7` | [`8b759d05-c1fb-4637-9fab-3786bbf35162`](https://ohmyti.vercel.app/evaluations/8b759d05-c1fb-4637-9fab-3786bbf35162) | COMPLETED |      627s |      0 |    4 |

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

- seojin R-12 초안 근거: (a) 계층 분리: src/http/routes.ts의 핸들러는 헤더·본문 파싱과 zod 검증(46-59행)만 하고 도메인 규칙은 orderService.createOrder/cancelOrder/getProduct/getOrder 호출로 위임한다(40-79행). 도메인 규칙은 src/application/order-service.ts에 모여 있고 HTTP 요청·응답 객체에 의존하지 않는다. domain/errors.ts가 오류 코드↔상태 매핑을 담당한다는 구조가 파일 목록과 README 구조 설명에서 확인된다. 다만 routes.ts의 registerRoutes가 51줄로 가장 긴 함수이고 라우트 등록·검증·서비스 호출이 한 함수에 몰려 있어 완전한 분리는 아니다. (b) 멱등성 저장소 추상화: src/application/ports.ts에 IdempotencyStore 인터페이스가 있고 infra/in-memory-repositories.ts가 이를 구현하며 OrderService가 생성자 주입을 받는 구조로, 저장소 교체 시 주문 생성 로직 수정이 불필요하다. (c) 변경 용이성: 오류 코드·상태 매핑이 domain/errors.ts 한 곳, 검증 규칙이 http/schemas.ts 한 곳에 모여 있고, routes.ts에서 AppError 서브클래스를 던지는 패턴이 일관된다. 다만 검증 실패 메시지 조합(57행)과 키 검증(49-52행)이 라우트 핸들러에 남아 있어 새 검증 규칙 추가 시 schemas.ts와 routes.ts 두 곳을 볼 수 있다. AST 신호상 명시적 any 0곳, strict 켜짐, 약한 단언 0%로 타입·테스트 품질도 설계를 뒷받침한다.
- taeyun R-12 초안 근거: (a) 계층 분리: 라우트 핸들러는 req.header/req.body/req.params에서 값을 꺼내 서비스에 넘기고 응답 직렬화만 하며, 도메인 규칙은 OrderService에 모여 있어 req/res에 직접 의존하지 않는다. 다만 라우트가 상태 코드 201/200을 직접 지정하고 오류는 error-handler로 위임하는 구조라 분리는 대체로 지켜진다. (b) 멱등성 저장소 추상화: idempotency.get/set이 별도 저장소 모듈 뒤에 있고 서비스는 인터페이스 메서드만 호출하므로 인메모리 구현 교체 시 createOrder 본문을 고칠 필요는 없다. 다만 저장소가 '키→주문' 단순 매핑이라 본문 비교·동시성 제어 같은 멱등성 정책을 담을 자리가 없고, 그 정책 부재가 R-06·R-07 실패로 드러났다. (c) 변경 용이성: 오류 코드는 errors.ts의 AppError로, 검증 규칙은 validation.ts로 모여 있고 상태 코드 매핑도 errors.ts 한 곳에 있어 새 오류 코드·검증 규칙 추가 지점이 비교적 한 곳에 모여 있다. 다만 IDEMPOTENCY_CONFLICT 같은 충돌 코드가 실제로 쓰이는 경로가 없어 매핑과 사용처가 어긋나 있다.
- gaeun R-12 초안 근거: (a) 계층 분리: 라우팅·응답 처리는 src/app.ts, 데이터 접근은 src/data.ts로 나뉘어 있고 도메인 함수가 req/res에 의존하지 않아 부분적으로 충족한다. 다만 재고 확인·차감·취소 같은 도메인 규칙이 핸들러 콜백 안에 직접 들어 있어 HTTP 계층과 도메인 규칙이 완전히 분리되지 않았다. (b) 멱등성 저장소 추상화: 멱등성 기록 저장·조회 코드가 아예 없어 인터페이스나 별도 모듈 뒤에 있다고 볼 수 없다. (c) 변경 용이성: 오류 코드·상태 코드 매핑이 각 핸들러에 인라인으로 흩어져 있고 검증 규칙도 핸들러 안에 있어 새 오류 코드·검증 규칙 추가 시 여러 위치를 고쳐야 한다.
- dohyun R-12 초안 근거: (a) 계층 분리: 라우팅·요청 파싱·응답 직렬화와 도메인 규칙이 모두 src/index.ts 한 파일에 있고, POST /orders 콜백이 133줄(src/index.ts:101-233)에 걸쳐 멱등키 검증·본문 검증·재고 차감·응답 생성을 직접 수행한다. 도메인 규칙이 Request/Response 객체에 직접 의존하므로 분리 미흡으로 판단해 4점 중 낮게 본다. (b) 멱등성 저장소 추상화: idemStore가 모듈 전역 배열이고 조회가 POST /orders 안의 for 루프(src/index.ts:168-174)로 인라인되어 있어 인터페이스나 별도 모듈 뒤에 있지 않다. 저장소 교체 시 주문 생성 로직을 고쳐야 하므로 3점 중 0에 가깝다. (c) 변경 용이성: 오류 응답이 핸들러마다 res.status(...).json({error:{code:...}}) 형태로 반복되고, 같은 모양의 연속 문장 블록이 src/index.ts:79-90과 241-252에 나타나 조회 로직이 중복되어 있다. 오류 코드·상태 코드 매핑이 한 곳에 모여 있지 않아 3점 중 낮게 본다. 명시적 any 12곳과 tsconfig strict 꺼짐도 타입 경계를 약화시켜 변경 용이성에 부정적 신호로 본다.

## 맥락 연결과 후속 질문

### seojin

| 주장                                                                                                                                                                      | 상태           | 관측 기준 | 후속 질문                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 주문·재고 서비스의 동시 주문 처리 구간에서 초과 판매(overselling)가 반복적으로 발생하는 문제를 맡아, 상품 단위 재고 선점(stock reservation) 시스템을 설계해 도입했습니다. | EVIDENCE_FOUND | R-08      | 상품 단위 재고 선점 시스템에서 재고 차감을 직렬화할 때 어떤 지점에서 충돌을 감지하고 재시도하도록 설계하셨나요?                                |
| 결제·주문 생성 API에 멱등성 키(Idempotency-Key) 미들웨어를 도입해, 클라이언트 재시도·네트워크 재전송으로 발생하던 중복 주문을 제거했습니다.                               | EVIDENCE_FOUND | R-05      | 이 경험에서 본인이 맡은 범위와 가장 어려웠던 기술적 결정을 설명해 주시겠어요?                                                                  |
| 운송장 조회 API의 응답 지연을 인덱스 재설계와 캐시 도입으로 개선해 p95 응답 시간을 1.2초에서 180ms로 단축했습니다.                                                        | NEEDS_CHECK    | -         | 운송장 조회 API의 p95 응답 시간을 1.2초에서 180ms로 단축했다고 하셨는데, 그 수치는 어떤 부하 조건에서 어떻게 측정한 값인가요?                  |
| 주문 생성부터 배송 상태 변경까지의 도메인 이벤트를 Kafka 기반 이벤트 파이프라인으로 전환해 주문·재고·정산 서비스 간 동기 호출 의존을 제거했습니다.                        | NEEDS_CHECK    | -         | 주문·재고·정산 서비스 간 동기 호출 의존을 Kafka 기반 이벤트 파이프라인으로 제거하셨는데, 이벤트 발행과 소비 사이의 정합성은 어떻게 맞추셨나요? |

### taeyun

| 주장                                                                                                                                                                                                              | 상태           | 관측 기준 | 후속 질문                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 결제 웹훅(payment webhook) 수신을 맡아 같은 웹훅이 재전송돼도 결제가 중복 반영되지 않도록 멱등(idempotent) 처리를 담당했습니다.                                                                                   | NEEDS_CHECK    | R-05      | 이 경험에서 본인이 맡은 범위와 가장 어려웠던 기술적 결정을 설명해 주시겠어요?                                                 |
| 독서 모임 예약(booking) API를 개발하며 같은 시간대에 같은 장소·모임이 중복 예약되지 않도록 검증 로직을 구현했습니다.                                                                                              | EVIDENCE_FOUND | R-03      | 회사 예약 API에서 같은 시간대 중복 예약을 막는 검증 로직은 어떤 조건으로 판정하도록 구현하셨나요?                             |
| 모임·예약·결제 도메인의 라우팅(routes)·서비스(services)·저장소(repository) 계층을 분리하는 리팩터링에 참여해 신규 기능 추가 시 변경 범위를 줄였습니다.                                                            | EVIDENCE_FOUND | R-12      | 라우팅·서비스·저장소 계층을 분리한 리팩터링에서 계층 간 경계는 어떤 기준으로 나누셨나요?                                      |
| 회의실 예약 REST API. 같은 시간대 중복 예약(overlapping booking)을 막는 검사 로직, zod 기반 입력 검증, routes/services/repository 계층 분리, vitest 테스트를 포함합니다. Express + TypeScript로 만들었습니다. 다… | EVIDENCE_FOUND | R-07      | 개인 프로젝트에서 동시에 들어오는 예약 요청을 아직 다루지 못했다고 하셨는데, 그 상황에서 어떤 문제가 생길 수 있다고 보시나요? |
| TIL(Today I Learned) 마크다운을 관리하는 Node.js CLI 도구입니다. 기록 작성, 태그 검색, 주간 요약 기능을 붙여서 팀의 개발 생산성을 높이는 데 도움이 됐습니다.                                                      | EVIDENCE_FOUND | -         | TIL CLI에서 주간 요약과 태그 검색 기능은 어떤 기준으로 데이터를 모으고 출력하도록 구현하셨나요?                               |

### gaeun

| 주장                                                                                                     | 상태           | 관측 기준 | 후속 질문                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------- | -------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 팀 프로젝트로 주문/예약 API를 설계하며 대용량 트래픽 환경을 고려한 동시성 제어와 멱등성 설계 경험을 쌓음 | NEEDS_CHECK    | R-05      | 팀 프로젝트에서 멱등성 키를 도입해 같은 요청이 두 번 처리되지 않도록 설계하셨다고 하셨는데, 그때 키와 응답을 어디에 어떤 조건으로 저장하도록 정하셨나요? |
| Node.js, Express를 이용한 REST API 설계와 구현 학습                                                      | EVIDENCE_FOUND | R-04      | 이 경험에서 본인이 맡은 범위와 가장 어려웠던 기술적 결정을 설명해 주시겠어요?                                                                            |
| 인메모리 저장소와 간단한 테스트 코드를 포함합니다                                                        | EVIDENCE_FOUND | G1        | 북마크 API의 테스트는 어떤 입력과 기대 결과를 기준으로 작성하셨나요?                                                                                     |
| 기존 jQuery 기반 화면 일부를 React + TypeScript 컴포넌트로 전환                                          | EVIDENCE_FOUND | -         | jQuery 기반 화면을 React + TypeScript 컴포넌트로 전환할 때 상태 관리와 이벤트 처리는 어떤 기준으로 옮기셨나요?                                           |
| 반응형 레이아웃과 크로스 브라우저 이슈를 점검하고 수정                                                   | EVIDENCE_FOUND | -         | 크로스 브라우저 이슈를 점검할 때 어떤 브라우저와 조건을 기준으로 확인하셨나요?                                                                           |

### dohyun

| 주장                                                                                                                            | 상태           | 관측 기준 | 후속 질문                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| 최근 참여한 프로젝트에서는 클린 아키텍처(Clean Architecture)와 TDD(Test-Driven Development)를 적용하여 유지보수성을 높였습니다. | NEEDS_CHECK    | G1        | 이 경험에서 본인이 맡은 범위와 가장 어려웠던 기술적 결정을 설명해 주시겠어요?                                   |
| 매출 CSV 데이터를 집계해 보고서를 CSV와 HTML 요약으로 자동 생성하는 Node.js 배치 스크립트입니다.                                | EVIDENCE_FOUND | -         | 매출 CSV 집계 배치에서 입력 파일 형식이 예상과 다르거나 값이 비어 있을 때 어떻게 처리하도록 설계하셨나요?       |
| 게시글·댓글 CRUD와 페이징을 갖춘 게시판(board) REST API입니다. Express와 TypeScript로 구현했고 데이터는 JSON 파일에 저장합니다. | EVIDENCE_FOUND | -         | 게시판 API에서 JSON 파일에 데이터를 저장할 때 동시에 여러 요청이 같은 파일에 쓰이면 어떻게 처리하도록 하셨나요? |
| 다수의 SI 프로젝트에서 REST API를 설계·개발하고, 정해진 일정 안에 요구사항을 빠짐없이 구현하여 납기를 준수해 왔습니다.          | NEEDS_CHECK    | R-12      | REST API를 설계할 때 변경이 잦은 요구사항을 어떻게 반영할 수 있도록 구조를 잡으셨나요?                          |

## 불일치

없음

## 경고 (주장 상태 라벨, 실패 조건 아님)

- seojin: 기본 질문(TEMPLATE) 대체 1/9
- seojin: 주장(Kafka·카프카): 기대 NO_DATA, 실제 NEEDS_CHECK
- taeyun: 기본 질문(TEMPLATE) 대체 5/11
- taeyun: 버린 LLM 출력 STRENGTH_DEPTH:R-03: LINT_VIOLATION (COMPOUND_QUESTION)
- taeyun: 버린 LLM 출력 STRENGTH_DEPTH:R-04: LINT_VIOLATION (COMPOUND_QUESTION)
- taeyun: 버린 LLM 출력 DESIGN_TRADEOFF:R-12: LINT_VIOLATION (COMPOUND_QUESTION)
- taeyun: 버린 LLM 출력 EXTENSION:persistent-store: LINT_VIOLATION (COMPOUND_QUESTION)
- taeyun: 주장(웹훅·webhook): 기대 NO_DATA, 실제 NEEDS_CHECK
- taeyun: 주장(CLI): 기대 NEEDS_CHECK, 실제 EVIDENCE_FOUND
- gaeun: 기본 질문(TEMPLATE) 대체 3/14
- gaeun: 버린 LLM 출력 EXTENSION:multi-instance: LINT_VIOLATION (COMPOUND_QUESTION)
- gaeun: 버린 LLM 출력 EXTENSION:persistent-store: LINT_VIOLATION (COMPOUND_QUESTION)
- dohyun: 기본 질문(TEMPLATE) 대체 2/11
- dohyun: 버린 LLM 출력 EXTENSION:persistent-store: LINT_VIOLATION (COMPOUND_QUESTION)
- dohyun: 주장(SI·납기): 기대 EVIDENCE_FOUND, 실제 NEEDS_CHECK
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
