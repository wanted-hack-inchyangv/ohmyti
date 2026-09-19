# 6단계 게이트: 페르소나 4종 배포 환경 회귀 (T-606)

`pnpm gate:personas`가 만든 기록이다. 배포된 웹의 제출 폼(`/submissions/new`)에 페르소나의 과제 저장소 URL·커밋 SHA·이력서 PDF·GitHub 프로필 URL을 넣어 제출하고, Railway 워커가 채점·맥락 연결한 결과를 조회 API(`/api/evaluations/[id]`, `/api/evaluations/[id]/context`)로 읽어 `samples/personas/expected-matrix.json`과 대조한다. 실패 조건은 기준별 판정·점수, 변이 결과, 점수 표시, 단계 상태, REVIEW_WRITE의 LLM 결과와 R-12 초안, GitHub 근거 선정·커밋 수집, 후속 질문 존재다. 주장 상태 라벨은 LLM 판단이라 경고로만 적는다.

- 결과: **통과**
- 배포: https://ohmyti.vercel.app
- 실행 일시: 2026-09-19T17:34:12.888Z ~ 2026-09-19T17:34:41.100Z (총 0.5분)
- rubric: `v2-be07fb44` · 기대값: `samples/personas/expected-matrix.json`

## 제출

| 페르소나 | 저장소 @ SHA                 | 제출 ID                                | 평가 ID                                                                                                              | 상태      | 제출→종료 | 불일치 | 경고 |
| -------- | ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------- | --------: | -----: | ---: |
| seojin   | seojin-order-api @ `d35969b` | `8f15fdd1-212e-4bf8-b31f-a5e7e055a3a1` | [`6b10f046-7ecb-4a4b-aceb-274fdd3c02cb`](https://ohmyti.vercel.app/evaluations/6b10f046-7ecb-4a4b-aceb-274fdd3c02cb) | COMPLETED |     1040s |      0 |    0 |
| taeyun   | taeyun-order-api @ `4c595e3` | `06667dd6-ec6e-4fcc-881a-8dc2bac5e901` | [`009b7afb-a8ef-4187-b60a-874a56f3bd76`](https://ohmyti.vercel.app/evaluations/009b7afb-a8ef-4187-b60a-874a56f3bd76) | COMPLETED |     1192s |      0 |    2 |
| gaeun    | gaeun-order-api @ `dbff20e`  | `a64da1e5-1345-4167-8db9-34db2a96df96` | [`8d5c095b-d5a0-45c1-813a-d05785a9fec5`](https://ohmyti.vercel.app/evaluations/8d5c095b-d5a0-45c1-813a-d05785a9fec5) | COMPLETED |     1294s |      0 |    0 |
| dohyun   | dohyun-order-api @ `3cf8469` | `c419a77b-c6ee-4bb8-8c3a-8c7ccf6151d8` | [`f2a11050-6f32-4ca8-9974-7154f5b364d3`](https://ohmyti.vercel.app/evaluations/f2a11050-6f32-4ca8-9974-7154f5b364d3) | COMPLETED |     1461s |      0 |    2 |

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
| seojin   | COLLECTED · RESUME_LINK | `wanted-hack-inchyangv/seojin-stock-reservation` (16·0·NONE), `wanted-hack-inchyangv/seojin-idempotency-kit` (13·0·NONE) | `wanted-hack-inchyangv/seojin-order-api` |
| taeyun   | COLLECTED · RESUME_LINK | `wanted-hack-inchyangv/taeyun-til-cli` (12·0·NONE), `wanted-hack-inchyangv/taeyun-room-booking` (12·0·NONE)              | `wanted-hack-inchyangv/taeyun-order-api` |
| gaeun    | COLLECTED · RESUME_LINK | `wanted-hack-inchyangv/gaeun-todo-react` (9·0·NONE), `wanted-hack-inchyangv/gaeun-bookmark-api` (9·0·NONE)               | `wanted-hack-inchyangv/gaeun-order-api`  |
| dohyun   | COLLECTED · RESUME_LINK | `wanted-hack-inchyangv/dohyun-report-batch` (10·0·NONE), `wanted-hack-inchyangv/dohyun-board-api` (8·0·NONE)             | `wanted-hack-inchyangv/dohyun-order-api` |

## 단계 · REVIEW_WRITE · R-12 초안

| 페르소나 | 단계                                                                                                                        | REVIEW_WRITE LLM | R-12 초안 |
| -------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------- |
| seojin   | REPO_CHECK DONE · ENV_PREP DONE · REQUIREMENT_VERIFY DONE · TEST_EFFECTIVENESS DONE · REVIEW_WRITE DONE · CONTEXT_LINK DONE | OK               | 9/10      |
| taeyun   | REPO_CHECK DONE · ENV_PREP DONE · REQUIREMENT_VERIFY DONE · TEST_EFFECTIVENESS DONE · REVIEW_WRITE DONE · CONTEXT_LINK DONE | OK               | 7/10      |
| gaeun    | REPO_CHECK DONE · ENV_PREP DONE · REQUIREMENT_VERIFY DONE · TEST_EFFECTIVENESS DONE · REVIEW_WRITE DONE · CONTEXT_LINK DONE | OK               | 3/10      |
| dohyun   | REPO_CHECK DONE · ENV_PREP DONE · REQUIREMENT_VERIFY DONE · TEST_EFFECTIVENESS DONE · REVIEW_WRITE DONE · CONTEXT_LINK DONE | OK               | 3/10      |

- seojin R-12 초안 근거: (a) 계층 분리: src/http/routes.ts의 핸들러는 헤더·본문 파싱과 zod 검증(46-59행)만 하고 도메인 규칙은 orderService.createOrder/cancelOrder 호출(61-65, 77행)로 위임한다. 도메인 규칙은 src/application/order-service.ts에 모여 있고 HTTP 요청·응답 객체에 의존하지 않는다. src/domain/errors.ts가 오류 코드↔상태 매핑을 담당한다는 구조가 파일 목록과 README 설명으로 확인된다. 다만 routes.ts의 registerRoutes가 51줄로 가장 긴 함수이고 라우팅·검증·서비스 호출이 한 함수에 몰려 있어 완전한 분리는 아니다. (b) 멱등성 저장소 추상화: src/application/ports.ts에 IdempotencyStore 인터페이스가 있고 src/infra/in-memory-repositories.ts가 이를 구현하며 OrderService가 생성자 주입을 받는 구조로 보인다. 저장소 교체 시 주문 생성 로직 수정이 불필요하다는 점이 파일 구성상 확인된다. (c) 변경 용이성: 오류 코드·상태 매핑이 src/domain/errors.ts 한 곳, 검증 규칙이 src/http/schemas.ts 한 곳에 모여 있다는 신호가 파일 목록과 README에 나타난다. 다만 검증 실패 메시지 조합이 routes.ts 57행에 있어 검증 규칙 추가 시 schemas.ts와 routes.ts 두 곳을 볼 수 있다. AST 신호로는 명시적 any 0곳, tsconfig strict 켜짐, 같은 모양의 연속 문장 블록 0건으로 타입 안전성과 중복 코드 측면의 위험은 낮다.
- taeyun R-12 초안 근거: (a) 계층 분리: 라우트(order-routes.ts:20-33)는 req/res만 다루고 service.createOrder/getProduct/getOrder에 값(헤더 문자열, req.body, params 문자열)을 넘기며, 서비스는 HTTP 객체를 참조하지 않는다. 도메인 규칙은 order-service.ts에 모여 있어 분리는 충족으로 보인다. (b) 멱등성 저장소 추상화: idempotency-repository.ts가 get/set 인터페이스를 제공하고 서비스는 이 추상에만 의존하므로 인메모리 구현 교체 시 createOrder를 고칠 필요는 없다. 다만 저장되는 값이 Order뿐이라 본문 비교(R-06)를 추가하려면 저장 구조 자체를 바꿔야 해 추상이 요구사항을 담기에 얕다. (c) 변경 용이성: errors.ts에 에러 코드↔HTTP 상태 매핑이 모여 있고 검증은 validation.ts에 집중돼 있어 새 오류 코드·검증 규칙 추가 지점은 대체로 한 곳이다. 다만 멱등성 충돌 판정 로직이 서비스에 없어 새 오류 코드(IDEMPOTENCY_CONFLICT)를 추가할 자리가 비어 있는 점은 감점 요인이다. AST 신호로는 명시적 any 0, strict 켜짐, 약한 단언 0으로 타입·테스트 견고성은 양호하다.
- gaeun R-12 초안 근거: (a) 계층 분리: 라우팅·응답 직렬화는 src/app.ts에, 데이터 조작은 src/data.ts에 나뉘어 있으나 도메인 규칙(재고 차감, 멱등성, 취소)이 핸들러와 data 함수에 흩어져 있고 재고 검사·차감이 HTTP 핸들러 안에서 직접 이뤄진다. 도메인 규칙이 req/res 객체에 직접 의존하지는 않으므로 부분 충족. (b) 멱등성 저장소 추상화: 멱등성 기록 저장·조회 코드가 아예 없어 인터페이스나 별도 모듈이 존재하지 않는다. (c) 변경 용이성: 오류 코드·상태 코드 매핑이 각 핸들러에 인라인으로 반복되어(404 NOT_FOUND 3곳, 400/409 등) 새 오류 코드 추가 시 여러 위치를 고쳐야 한다. 같은 모양의 연속 문장 블록 1건(24-30 ↔ 34-40)도 응답 구성 중복을 보여준다.
- dohyun R-12 초안 근거: (a) 계층 분리: 라우팅·요청 파싱·응답 직렬화와 도메인 규칙(재고 차감·멱등성·취소)이 모두 src/index.ts 한 파일의 라우트 콜백 안에 섞여 있고, 가장 긴 함수가 app.post 콜백 133줄(src/index.ts:101-233)이다. 도메인 규칙이 req/res에 직접 의존하므로 분리 미흡으로 판단해 4점 중 낮게 본다. (b) 멱등성 저장소 추상화: idemStore가 배열로 선언되고 POST /orders 콜백 안에서 for 루프로 직접 순회(src/index.ts:168-174)하며, 인터페이스나 별도 모듈이 없다. 저장소 교체 시 주문 생성 로직을 고쳐야 하므로 3점 중 0에 가깝다. (c) 변경 용이성: 오류 응답이 라우트마다 res.status().json({error:{code:...}}) 형태로 반복되고, 같은 모양의 연속 문장 블록이 src/index.ts:79-90과 241-252에 나타나 조회 로직이 중복돼 있다. 상태 코드·오류 코드 매핑이 흩어져 있어 3점 중 낮게 본다. 명시적 any 12곳과 tsconfig strict 꺼짐도 도메인 타입 경계를 약화시킨다.

## 맥락 연결과 후속 질문

### seojin

| 주장                                                                                                                                                                                   | 상태           | 관측 기준 | 후속 질문                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 주문·재고 서비스의 동시 주문 처리 구간에서 초과 판매(overselling)가 반복적으로 발생하는 문제를 맡아, 상품 단위 재고 선점(stock reservation) 시스템을 설계해 도입했습니다.              | EVIDENCE_FOUND | R-08      | 회사 시스템에서는 재고 선점을 어떤 저장소(DB/Redis)에서 어떤 격리 수준으로 구현했고, 이번 과제의 인메모리 compare-and-set 구현과 비교해 충돌 재시도 조건은 어떻게 달랐나요?               |
| TTL 기반 예약과 버전 비교(version check) 기반의 낙관적 잠금(optimistic locking)으로 재고 차감을 직렬화한 결과, 피크 트래픽 구간에서 동시 주문으로 인한 초과 판매를 0건으로 줄였습니다. | EVIDENCE_FOUND | R-03      | 피크 트래픽에서 초과 판매 0건을 확인할 때 어떤 지표와 시간 창을 기준으로 측정했고, 이번 과제의 재고 하한 검사와 달리 운영 환경에서는 만료 예약 회수 지연이 끼치는 영향은 어떻게 다뤘나요? |
| 결제·주문 생성 API에 멱등성 키(Idempotency-Key) 미들웨어를 도입해, 클라이언트 재시도·네트워크 재전송으로 발생하던 중복 주문을 제거했습니다.                                            | EVIDENCE_FOUND | R-05      | 회사 결제 API에서는 멱등성 키의 TTL과 저장 위치를 어떻게 정했고, 이번 과제의 인메모리 저장소·lazy TTL 만료 방식과 비교해 재시작·다중 인스턴스 상황에서 보장 범위는 어떻게 달랐나요?       |
| 도입 후 3개월간 중복 주문으로 인한 결제 취소·환불 처리 건수가 0건으로 유지되고 있습니다.                                                                                               | NEEDS_CHECK    | R-06      | 3개월간 중복 주문 0건을 어떤 로그·지표로 집계했고, 같은 키에 다른 본문이 오는 충돌 케이스는 운영에서 어떻게 감지·알림 처리했나요?                                                         |
| 주문 생성부터 배송 상태 변경까지의 도메인 이벤트를 Kafka 기반 이벤트 파이프라인으로 전환해 주문·재고·정산 서비스 간 동기 호출 의존을 제거했습니다.                                     | NO_DATA        | -         | Kafka 파이프라인 전환 시 주문·재고·정산 간 정합성을 어떤 방식(아웃박스, 사가 등)으로 보장했고, 이번 과제의 단일 프로세스 인메모리 구현과 비교해 컨슈머 재처리 조건은 어떻게 달랐나요?     |
| 이벤트 컨슈머 재처리(replay)와 재시도 정책을 함께 설계해 장애 시 데이터 유실 없이 복구할 수 있는 구조를 만들었습니다.                                                                  | NO_DATA        | -         | 컨슈머 재처리 시 중복 소비를 막기 위한 멱등 처리 키는 무엇으로 잡았고, 재시도 한계 초과 메시지는 어떻게 처리했나요?                                                                       |
| 운송장 조회 API의 응답 지연을 인덱스 재설계와 캐시 도입으로 개선해 p95 응답 시간을 1.2초에서 180ms로 단축했습니다.                                                                     | NO_DATA        | -         | p95 1.2초→180ms 측정은 어떤 트래픽 조건과 부하 도구로 했고, 캐시 무효화는 어떤 기준으로 처리했나요?                                                                                       |
| 병렬 예약 요청 200건을 동시에 보내 초과 판매가 발생하지 않음을 확인하는 동시성 테스트(concurrency test)로 정합성을 검증했습니다.                                                       | EVIDENCE_FOUND | R-07      | 200건 동시 예약 테스트에서 재시도 횟수와 실패 허용 기준은 어떻게 정했고, 이번 과제의 같은 키 동시 요청 병합과는 어떤 점이 다른 시나리오였나요?                                            |

### taeyun

| 주장                                                                                                                                                                                                              | 상태           | 관측 기준 | 후속 질문                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 결제 웹훅(payment webhook) 수신을 맡아 같은 웹훅이 재전송돼도 결제가 중복 반영되지 않도록 멱등(idempotent) 처리를 담당했습니다.                                                                                   | NEEDS_CHECK    | R-05      | 결제 웹훅 멱등 처리에서는 같은 키로 다른 본문이 재전송되는 경우를 어떻게 다뤘나요? 이번 과제의 R-06(멱등 키 충돌)에서는 422를 기대했는데 201이 반환됐는데, 실무 구현과 과제 구현의 충돌 판정 조건 차이는 무엇인가요?                                      |
| 같은 시간대에 같은 장소·모임이 중복 예약되지 않도록 검증 로직을 구현했습니다                                                                                                                                      | EVIDENCE_FOUND | -         | 실무 예약 검증 로직은 동시에 들어오는 요청을 어떤 방식(트랜잭션 격리 수준, 유니크 제약, 락 등)으로 직렬화했나요? 이번 과제의 R-07(같은 키 동시 요청)에서는 재고가 0까지 소진되는 결과가 나왔는데, 그 조건에서도 중복이 막히도록 하려면 무엇이 필요할까요? |
| 개인적으로 같은 문제를 다시 정리해 taeyun-room-booking 저장소에 회의실 예약 API로 만들어 공개했습니다.                                                                                                            | EVIDENCE_FOUND | -         | 이 저장소에서 인메모리 레포지토리를 선택한 이유는 무엇이고, 실제 DB(PostgreSQL 등)로 바꿀 때 겹침 검사 로직에서 달라져야 할 부분은 무엇인가요?                                                                                                            |
| 모임·예약·결제 도메인의 라우팅(routes)·서비스(services)·저장소(repository) 계층을 분리하는 리팩터링에 참여해 신규 기능 추가 시 변경 범위를 줄였습니다.                                                            | EVIDENCE_FOUND | R-12      | 실무 리팩터링에서 계층 분리 기준을 어떻게 정했고, 이번 과제 코드에서 서비스 계층과 저장소 계층의 책임 경계를 다시 나눈다면 어디를 바꾸겠습니까?                                                                                                           |
| 회의실 예약 REST API. 같은 시간대 중복 예약(overlapping booking)을 막는 검사 로직, zod 기반 입력 검증, routes/services/repository 계층 분리, vitest 테스트를 포함합니다. Express + TypeScript로 만들었습니다. 다… | EVIDENCE_FOUND | R-07      | 동시 예약 요청을 아직 다루지 못했다고 하셨는데, 이번 과제의 R-07 같은 동시 요청 상황에서 중복을 막으려면 어떤 동시성 제어 방식을 적용하겠습니까?                                                                                                          |
| TIL(Today I Learned) 마크다운을 관리하는 Node.js CLI 도구입니다. 기록 작성, 태그 검색, 주간 요약 기능을 붙여서 팀의 개발 생산성을 높이는 데 도움이 됐습니다.                                                      | EVIDENCE_FOUND | -         | 주간 요약 기능에서 '최근 7일' 기준은 어떤 타임존과 날짜 경계로 계산했나요? 자정 근처에 작성된 기록이 어느 주에 포함되는지 어떻게 보장했나요?                                                                                                              |
| 요구사항을 엔드포인트와 검증 규칙으로 정리하고, 계층을 나눠 구현하는 데 익숙합니다.                                                                                                                               | EVIDENCE_FOUND | R-04      | 검증 규칙을 정할 때 어떤 기준으로 스키마 레벨 검증과 서비스 레벨 검증을 나누나요? 이번 과제에서 검증 실패 응답 형식은 어떤 규칙으로 통일했나요?                                                                                                           |
| 최근에는 동시 요청 상황에서 발생하는 문제를 더 깊이 이해하려고 학습하고 있습니다.                                                                                                                                 | NEEDS_CHECK    | R-07      | 동시 요청 문제를 학습하면서 지금까지 정리한 내용은 무엇이고, 이번 과제의 R-07 결과를 보면 어떤 지점(원자성, 락 범위, 재시도 등)을 우선 보완해야 한다고 생각하나요?                                                                                        |

### gaeun

| 주장                                                                                                           | 상태           | 관측 기준 | 후속 질문                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 웹 에이전시에서 퍼블리셔 겸 프론트엔드 개발자로 1년간 근무하며 React와 TypeScript로 다양한 화면을 구현했습니다 | EVIDENCE_FOUND | -         | 실무에서 React + TypeScript로 구현한 화면 중 상태 관리가 가장 복잡했던 사례는 무엇이고, 이번 과제의 서버 상태 관리와 비교해 어떤 차이가 있었나요?                                                       |
| 기존 jQuery 기반 화면 일부를 React + TypeScript 컴포넌트로 전환                                                | EVIDENCE_FOUND | -         | jQuery 화면을 React로 전환할 때 기존 DOM 조작 코드와 React 상태를 어떻게 공존시켰나요? 전환 중 회귀 버그를 어떻게 잡았나요?                                                                             |
| 반응형 레이아웃과 크로스 브라우저 이슈를 점검하고 수정                                                         | EVIDENCE_FOUND | -         | 크로스 브라우저 이슈를 점검할 때 어떤 브라우저와 어떤 기준으로 확인했나요? 이번 과제의 API 응답 검증과는 어떤 점이 다른가요?                                                                            |
| Node.js, Express를 이용한 REST API 설계와 구현 학습                                                            | EVIDENCE_FOUND | -         | 북마크 API에서는 입력값 검증을 어떻게 처리했나요? 이번 과제에서 수량 누락·0·음수 요청이 201로 통과한 것과 비교해 검증 시점과 범위가 어떻게 달랐나요?                                                    |
| 팀 프로젝트로 주문/예약 API를 설계하며 대용량 트래픽 환경을 고려한 동시성 제어와 멱등성 설계 경험을 쌓음       | NEEDS_CHECK    | R-05      | 팀 프로젝트에서 멱등성 키를 어떤 저장소에 어떤 키로 보관했고, 같은 키로 다른 본문이 오는 경우는 어떻게 구분했나요? 이번 과제에서는 그 경우가 새 주문으로 처리되었는데 두 구현의 조건 차이는 무엇인가요? |
| 인메모리 저장소와 간단한 테스트 코드를 포함합니다                                                              | EVIDENCE_FOUND | G1        | 북마크 API 테스트는 어떤 경계값을 검증했나요? 이번 과제에서 제출 테스트가 통과했는데도 하네스 결함이 남은 이유를 본인 테스트 설계 관점에서 어떻게 설명하겠나요?                                         |
| 시각디자인을 전공한 경험을 살려 사용자와 동료 개발자 모두가 이해하기 쉬운 구조와 문서를 만들려고 노력합니다    | EVIDENCE_FOUND | R-11      | README에 API 계약(에러 코드, 상태 코드)을 어느 수준까지 문서화하나요? 이번 과제 README에서 보완하고 싶은 부분이 있나요?                                                                                 |

### dohyun

| 주장                                                                                                                            | 상태           | 관측 기준 | 후속 질문                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 클린 아키텍처(Clean Architecture)와 TDD(Test-Driven Development)를 적용하여 유지보수성을 높였습니다.                            | EVIDENCE_FOUND | G1        | 이력서에서는 TDD를 적용했다고 하셨는데, 이번 과제에서는 하네스가 확인한 재고 부족·입력 검증 결함을 제출 테스트가 잡지 못했습니다. 실무에서 TDD를 적용할 때 어떤 경계 조건을 테스트로 먼저 고정하는지, 이번 과제에서는 왜 그 조건이 테스트에 들어가지 않았는지 설명해 주시겠어요? |
| 게시글·댓글 CRUD와 페이징을 갖춘 게시판(board) REST API입니다. Express와 TypeScript로 구현했고 데이터는 JSON 파일에 저장합니다. | EVIDENCE_FOUND | R-02      | 게시판 API에서는 페이징과 검색을 JSON 파일 저장소 위에서 구현하셨는데, 이번 과제의 조회 API에서는 동시 요청이나 데이터 변경 중 조회 일관성을 어떻게 보장하셨나요?                                                                                                                |
| 매출 CSV 데이터를 집계해 보고서(리포트, report)를 CSV와 HTML 요약으로 자동 생성하는 Node.js 배치(batch) 스크립트입니다.         | EVIDENCE_FOUND | R-11      | 배치 스크립트에서는 CSV 입력을 파일 단위로 처리했는데, 이번 과제의 주문 API에서는 입력 검증 실패 시 어떤 기준으로 요청을 거절하고 어떤 기준으로 재처리 가능하게 두셨나요?                                                                                                        |
| 수작업으로 작성하던 매출 보고서를 자동화했습니다.                                                                               | EVIDENCE_FOUND | -         | 자동화 전후로 보고서 수치가 맞는지 어떻게 검증하셨나요? 이번 과제의 집계·재고 수치 검증과 비교해 어떤 검증 절차를 추가로 두셨는지 궁금합니다.                                                                                                                                    |
| REST API를 설계·개발하고 정해진 일정 안에 요구사항을 빠짐없이 구현하여 납기를 준수해 왔습니다.                                  | NEEDS_CHECK    | R-10      | 이번 과제에서 실행 계약(헬스 체크·리셋)은 충족했지만, 실무에서 '요구사항을 빠짐없이 구현'했다는 것을 어떤 기준과 산출물로 확인받으셨나요?                                                                                                                                        |
| 온라인몰 주문 API 고도화 B 유통사 2023.02 2023.12 백엔드 개발, 성능 개선 Java, Spring Boot, Oracle, Redis                       | NEEDS_CHECK    | R-05      | 주문 API 고도화에서 성능 개선을 하셨다면, 이번 과제의 멱등 재전송 처리와 비교해 중복 요청 방지 키를 어떤 저장소에 얼마 동안 보관하는 설계였는지 설명해 주시겠어요?                                                                                                               |
| 통계 포털 유지보수 A 공공기관 2022.01 2023.01 백엔드 유지보수, 장애 대응 Node.js, Express, MySQL                                | NEEDS_CHECK    | R-09      | 운영 장애 대응 경험이 있다고 하셨는데, 이번 과제의 주문 취소·재고 복구 같은 상태 변경 로직에서 장애 발생 시 원인 파악을 위해 어떤 로그나 검증 지점을 남기셨나요?                                                                                                                 |
| 짧은 일정의 프로젝트가 많아 요구사항을 빠르게 동작하는 코드로 구현하는 데 익숙합니다.                                           | NEEDS_CHECK    | G2        | 빠르게 동작하는 코드를 우선할 때, 이번 과제의 멱등 키 충돌(R-06)처럼 정상 경로 밖의 조건은 어떤 시점에 검증하시는 편인가요?                                                                                                                                                      |

## 불일치

없음

## 경고 (주장 상태 라벨, 실패 조건 아님)

- taeyun: 주장(웹훅·webhook): 기대 NO_DATA, 실제 NEEDS_CHECK
- taeyun: 주장(CLI): 기대 NEEDS_CHECK, 실제 EVIDENCE_FOUND
- dohyun: 주장(SI·납기): 기대 EVIDENCE_FOUND, 실제 NEEDS_CHECK
- dohyun: 주장(TDD·클린 아키텍처·Clean Architecture): 기대 NO_DATA, 실제 EVIDENCE_FOUND

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
