# 페르소나: 오태윤 (Oh Taeyun) · 주니어

## 요약

- 3년차 백엔드 엔지니어, 주니어. 모아북스 독서 모임 예약 플랫폼팀 백엔드 엔지니어로 재직 중이며(2023.07 ~ 현재), 데브브릿지 백엔드 인턴 경력이 있다(2023.01 ~ 2023.06).
- 강점: 기본적인 REST API 설계·검증·계층 분리는 안정적으로 해낸다. 약점: 동시성과 멱등성의 세부 조건(멱등 키 충돌 감지, 동시 요청 직렬화)에 대한 이해가 아직 부족하다.
- 이 페르소나로 확인하려는 것: 채점에서는 "재고 초과 판매는 막았지만 멱등성 경합은 놓친" 특성이 정확히 R-06·R-07 실패로 드러나는지, 테스트 실효성에서는 이미 실패한 기준을 대상으로 한 변이가 NOT_APPLICABLE로 처리되면서도 그룹 판정에는 영향을 주지 않는지, 맥락 연결에서는 이력서의 과장(결제 웹훅 멱등 처리, 팀 생산성 CLI)이 실제로는 기대와 다른 방향으로 재분류되는지 확인한다.

## 입력값

| 항목              | 값                                                              |
| ----------------- | --------------------------------------------------------------- |
| 이력서 PDF        | `samples/personas/taeyun/resume.pdf`                            |
| GitHub 프로필 URL | https://github.com/wanted-hack-inchyangv                        |
| 과제 저장소 URL   | https://github.com/wanted-hack-inchyangv/taeyun-order-api       |
| 커밋 SHA          | `4c595e36efb5489dd0234d834cfdb583048ccfc1` (저장소의 현재 HEAD) |

## 저장소

| 구분        | 저장소                                                                                | 설명                                                                                              |
| ----------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 과제 제출물 | [`taeyun-order-api`](https://github.com/wanted-hack-inchyangv/taeyun-order-api)       | Express 5 + TypeScript로 만든 주문·재고 API. 상품 재고 확인부터 주문 생성/조회/취소까지 제공      |
| 포트폴리오  | [`taeyun-room-booking`](https://github.com/wanted-hack-inchyangv/taeyun-room-booking) | 같은 시간대 중복 예약을 막는 회의실 예약 REST API. zod 검증, routes/services/repository 계층 분리 |
| 포트폴리오  | [`taeyun-til-cli`](https://github.com/wanted-hack-inchyangv/taeyun-til-cli)           | TIL 마크다운을 관리하는 Node.js CLI. 기록 작성, 태그 검색, 주간 요약 기능                         |

## 기대 판정

| 기준 | 내용                          | 기대 |   하네스 실측   |
| ---- | ----------------------------- | :--: | :-------------: |
| R-01 | 정상 주문 생성                | PASS | PASS (6회 반복) |
| R-02 | 상품·주문 조회                | PASS | PASS (6회 반복) |
| R-03 | 재고 부족 거절                | PASS | PASS (6회 반복) |
| R-04 | 입력 검증                     | PASS | PASS (6회 반복) |
| R-05 | 멱등 재전송                   | PASS | PASS (6회 반복) |
| R-06 | 멱등 키 충돌                  | FAIL | FAIL (6회 반복) |
| R-07 | 같은 키 동시 요청             | FAIL | FAIL (6회 반복) |
| R-08 | 다른 키 동시 요청과 재고 하한 | PASS | PASS (6회 반복) |
| R-09 | 주문 취소와 재고 복구         | PASS | PASS (6회 반복) |
| R-10 | 실행 계약 충족                | PASS | PASS (6회 반복) |

`pnpm harness:run --base-url http://localhost:4812 --rubric samples/order-api/rubric.v1.json`을 초기 1회와 반복 5회, 총 6회 실행했고 매번 `10건 (PASS 8, FAIL 2, INCONCLUSIVE 0)`으로 FAIL 대상도 매번 R-06·R-07로 같았다(흔들림 없음). R-05는 순차 요청이라 같은 키 기록이 이미 저장된 뒤 도착하므로 정상 동작하고, R-08은 재고 확인·차감이 단일 동기 구간이라 다른 키 요청끼리는 안전하다.

### 그 밖의 기준

- R-11(README, STATIC): README.md에 실행 방법(`npm start`)과 포트 설정(`PORT`)이 명시되어 있어 충족을 기대한다.
- R-12(설계·변경 용이성, HUMAN_REVIEW): 사람 확인 대기이지만, README의 "구조" 절에서 라우트(HTTP)와 서비스(도메인 규칙)를 분리하고 저장소를 인터페이스 뒤에 숨겼다고 설명하므로 부분적인 충족을 기대한다. 다만 README의 "아쉬운 점"에서 동시성 테스트 부족을 스스로 밝히고 있어 완전한 충족은 기대하지 않는다.
- G1 ~ G3(테스트 실효성, MUTATION): rubric의 `independentReasons`에 따라 R-06이 기준 상태에서 이미 FAIL이므로, G2 대상 변이 M-04(R-06 대상)는 NOT_APPLICABLE로 예상되지만 같은 그룹의 M-03(R-05 대상)이 KILLED되면 G2는 PASS로 집계될 것으로 기대한다. G1(M-01은 R-03 대상, M-02는 R-04 대상)과 G3(M-05는 R-09 대상)은 대상 로직이 정상 동작하는 기준이므로 KILLED를 기대한다.

## 구현 특징과 결함

결함이 있는 페르소나다. 기본적인 재고 초과 판매 방지는 구현했지만 멱등성 경합에서 두 기준이 실패한다.

### R-06 멱등 키 충돌

- 위치: `src/repositories/idempotency-repository.ts`의 `InMemoryIdempotencyRepository`(키 → `Order` 응답만 저장하고 요청 본문은 저장하지 않음), 그리고 이를 사용하는 `src/services/order-service.ts`의 `OrderService.createOrder()`.
- 원인: `createOrder()`는 `const existing = await this.idempotency.get(key)`로 기존 기록을 찾으면 본문이 같은지 다른지 비교하지 않고 곧바로 `return existing`으로 원래 응답을 재생한다. 같은 키로 다른 `productId`/`quantity`를 보내도 422 `IDEMPOTENCY_CONFLICT`가 아니라 처음 응답과 같은 201이 돌아온다.

### R-07 같은 키 동시 요청

- 위치: `src/services/order-service.ts`의 `OrderService.createOrder()`와 `src/repositories/idempotency-repository.ts`의 `get`/`set`, `src/repositories/io-delay.ts`의 `ioDelay`.
- 원인: `createOrder()`는 멱등성 기록을 잠금(mutex) 없이 조회(`idempotency.get`)한 뒤, 상품 예약(`products.reserveStock`)과 주문 저장(`orders.insert`)을 거쳐 맨 마지막에야 `idempotency.set`으로 기록을 남긴다. 저장소 메서드마다 `ioDelay`로 1~5ms의 비동기 지연이 들어가 있어서, 같은 키로 거의 동시에 도착한 요청들은 모두 "기록 없음" 상태로 `get`을 통과해 각자 새 주문을 만들어 버린다. 결과적으로 동시 요청 중 재고가 허용하는 만큼만 서로 다른 주문으로 생성되고 나머지는 재고 부족으로 거절되어, 명세가 요구하는 "동일 키 요청은 모두 같은 주문 id"를 만족하지 못한다.

참고로 R-08(다른 키 동시 요청)은 통과한다. `src/repositories/product-repository.ts`의 `InMemoryProductRepository.reserveStock()`이 맨 앞에서 `await ioDelay(undefined)` 한 번만 기다리고 그 뒤로는 재고 조회·부족 검사·차감이 끝까지 동기 코드로 이어지기 때문에, 서로 다른 키로 들어온 동시 요청이라도 재고 차감은 항상 순서대로 하나씩 반영된다. 재고 초과 판매 문제는 알고 대응했지만 멱등성 저장소 쪽에는 같은 보호 장치를 적용하지 않았다는 설정이다.

## 이력서 주장과 기대 맥락 상태

| #   | 이력서 주장                                                   | 이력서 위치    | 근거 저장소           | 기대 상태                       | 사유                                                                                                                                   |
| --- | ------------------------------------------------------------- | -------------- | --------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 모임 예약 API에서 시간대 중복 예약을 방지하는 로직을 구현했다 | 경력(모아북스) | `taeyun-room-booking` | 관련 근거 확인 (EVIDENCE_FOUND) | 시간대 중복 검사(overlap check)를 구현한 회의실 예약 API로, 동시 요청까지는 다루지 않는다고 README에 명시되어 있다                     |
| 2   | 결제 웹훅의 멱등 처리를 담당해 중복 결제 반영을 방지했다      | 경력(모아북스) | 없음                  | 자료 없음 (NO_DATA)             | 공개 근거가 없고, 과제 제출물이 오히려 같은 영역(멱등 키 충돌 R-06, 동시 요청 R-07)에서 결함을 보여 면접에서 후속 질문 대상으로 남는다 |
| 3   | 팀의 개발 생산성을 높이는 CLI 도구를 제작했다                 | 개인 프로젝트  | `taeyun-til-cli`      | 추가 확인 필요 (NEEDS_CHECK)    | TIL 작성/태그 검색/주간 요약 기능은 확인되지만, "팀 생산성 향상"이라는 효과까지는 저장소만으로 검증할 수 없다                          |

## 실제 제출 결과

- 제출 환경: https://ohmyti.vercel.app (채점 기준 `v2-be07fb44`), 2026-09-19 17:08 UTC에 6단계(T-601 ~ T-605) 수정을 배포한 뒤 `pnpm gate:personas`가 웹 제출 폼으로 제출했다. 평가 커밋은 입력값 표의 현재 HEAD `4c595e36efb5489dd0234d834cfdb583048ccfc1`이다. 대조 기록은 `docs/gates/personas.md`에 있고 `samples/personas/expected-matrix.json`의 기대값과 불일치 0건이었다.
- 워크벤치: https://ohmyti.vercel.app/evaluations/009b7afb-a8ef-4187-b60a-874a56f3bd76, 점수 78~88/100(10점 검토 대기). 제출부터 평가 종료까지 1192초가 걸렸다.
- 기준별 판정: R-06·R-07이 FAIL이고 나머지 R-01 ~ R-11은 PASS로 기대와 일치했다. G1 ~ G3는 PASS다. G2의 M-04는 대상 기준 R-06이 이미 FAIL이어서 NOT_APPLICABLE이지만 같은 그룹의 M-03이 KILLED여서 PASS로 집계되었다. R-12는 사람의 검토 대기(INCONCLUSIVE)다.
- LLM 리뷰와 R-12 설계 초안: REVIEW_WRITE가 정상 완료(`llm: OK`)되었고 R-12 초안은 7/10이다. 계층 분리와 멱등성 저장소 추상화는 충족으로 보았지만, 저장 값이 주문뿐이라 본문 비교(R-06)를 넣으려면 저장 구조를 바꿔야 한다는 점을 감점 요인으로 들었다.
- GitHub 근거로 선택된 저장소: `taeyun-til-cli`(커밋 12개), `taeyun-room-booking`(커밋 12개)이다. 이력서 링크로 선정되었고 제출 저장소는 제외되었다. 이전 제출에서 세 번째 자리에 끼어들었던 `gaeun-bookmark-api`는 이번에는 선택되지 않았다.
- 이력서 주장별 실제 상태: 시간대 중복 예약 방지 주장은 기대대로 관련 근거 확인(EVIDENCE_FOUND)이다. 결제 웹훅 멱등 처리 주장은 기대(자료 없음)와 달리 추가 확인 필요(NEEDS_CHECK)로, 팀 생산성 CLI 주장은 기대(추가 확인 필요)와 달리 관련 근거 확인으로 분류되었다. 두 건은 LLM 판단 차이라 경고로만 기록했다.
- 생성된 후속 질문의 요지: 결제 웹훅 멱등 처리 주장에는 기대대로 R-05와 연결된 질문이 생성되었다. 같은 키로 다른 본문이 재전송되는 경우를 실무에서 어떻게 다뤘는지, 이번 과제에서 R-06이 422 대신 201로 처리된 것과 조건 차이가 무엇인지 묻는 내용이다. 그 밖에 동시 예약 직렬화 방식(R-07), 계층 분리 기준(R-12), 검증 규칙 배치(R-04), 인메모리 저장소 선택 이유를 묻는 질문이 생성되었다.
- 이전 제출(2026-09-19 12:38 UTC경, 이름 변경 전 커밋 `dc0b849`): 평가 `e2611352`. 수정 뒤의 재제출로 대체되어 2026-09-20에 배포 환경에서 삭제했다(링크 없음).

## 산출물

- `persona.md`: 본 문서.
- `resume.html`: 이력서 HTML 원본.
- `resume.pdf`: `resume.html`을 렌더링한 이력서 PDF, 실제 채점 입력값으로 쓴다.
