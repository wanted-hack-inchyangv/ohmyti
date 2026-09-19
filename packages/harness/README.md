# @ohmyti/harness

rubric의 `EXECUTION` 기준을 제출 서비스 **밖에서** HTTP로 검증하는 신뢰 하네스다 (TICKET.md T-107). 서비스 기동은 `@ohmyti/runner`(T-108), 결과 저장은 T-205가 맡는다. 이 패키지는 `@ohmyti/runner`·`@ohmyti/db`에 의존하지 않으며, 하네스 코드와 자격증명은 제출 환경에 복사되지 않는다.

## 케이스 DSL

케이스는 함수 없는 선언형 데이터다(`src/dsl.ts`). 앞 스텝의 응답을 `capture` 이름으로 저장하고, 뒤 스텝은 `{{name.body.id}}`(문자열 템플릿) 또는 `{ $ref: "name.body.id" }`(값 자리)로 참조한다.

| 스텝             | 역할                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `request`        | 요청 한 건. `body`(JSON) 또는 `rawBody`(문자열 그대로)                                                                       |
| `assertResponse` | 캡처된 응답의 `status`, 본문 일부(`{ "error.code": "NOT_FOUND" }`), 비어 있지 않은 문자열 필드를 검사                        |
| `observeState`   | `GET`으로 상태를 읽고(타임라인의 `stateAfter`) 기대값과 비교                                                                 |
| `parallel`       | `requests` 목록을 동시에 보내거나(`Promise.all`), 캡처된 배열의 항목마다(`forEach`, `{{item...}}`) 요청을 만들어 동시에 보냄 |

케이스 수준 `expect`는 집계 식(`$countWhere`, `$distinctCount`, `$allEqual`, `$min`, `$sameValue`)으로 동시 요청 결과를 결정적인 스칼라로 비교한다. 서버가 만든 무작위 id는 `actual`에 남지 않고 타임라인에만 남으므로, 같은 서비스에 여러 번 실행한 결과가 동일하다.

## 판정 규칙

- 케이스마다 먼저 `POST /admin/reset`을 호출한다. 응답이 없거나 200이 아니면 `INCONCLUSIVE · ENVIRONMENT`.
- 요청 시간 초과(`HARNESS_REQUEST_TIMEOUT_MS`, 기본 5000ms, 재시도 없음) → `INCONCLUSIVE · TIMEOUT`, 연결 실패 → `INCONCLUSIVE · ENVIRONMENT`.
- 검사가 하나라도 실패하면 `FAIL · ASSERTION`. 응답 중 5xx가 있으면 `FAIL · SUBMISSION`.
- 모든 검사 통과 → `PASS · NONE`.
- 결과의 `expected`·`actual`은 실패한 검사의 이름별 구체 값이고, `checks`는 전체 검사, `timeline`은 요청·응답 헤더·본문 전체(마스킹 적용)다.

`harnessVersion = <패키지 버전>+<케이스 정규 직렬화 sha256 앞 16자>`. 케이스 문장이 바뀌면 버전이 바뀐다.

## 기준별 판정 유도 (`src/derive.ts`)

`deriveCriteria(rubric, report, startup)`은 케이스 결과를 rubric의 EXECUTION 기준별로 접는다: FAIL 하나라도 있으면 FAIL, 아니면 INCONCLUSIVE, 모두 PASS면 PASS(`foldVerdicts`). 기동 관측이 HEALTHY가 아니면 실행 계약 영역(`CONTRACT_AREA`, R-10)은 FAIL·SUBMISSION이고 나머지는 INCONCLUSIVE·ENVIRONMENT다. 1단계 게이트(T-110)와 워커 오케스트레이터(T-204)가 같은 함수를 쓰고, T-205가 결과를 CriterionResult로 저장한다.

## 명령

```bash
pnpm harness:coverage                       # rubric의 모든 EXECUTION 기준이 케이스에 커버되는지
pnpm harness:run --base-url http://localhost:3001 --rubric samples/order-api/rubric.v1.json --out /tmp/a.json [--case R-05-idempotent-resend] [--timeout-ms 5000]
```

`harness:run`은 판정과 무관하게 실행이 끝나면 0으로 종료한다(판정은 보고서 JSON에 있다). 인자 오류·rubric 검증 실패·커버리지 실패는 1이다.

## 케이스 (order-api v1)

| 케이스                          | 기준 | 요약                                                                            |
| ------------------------------- | ---- | ------------------------------------------------------------------------------- |
| `R-01-normal-order`             | R-01 | 정상 주문 201, 응답 스키마, p1 재고 2 → 1                                       |
| `R-02-lookups`                  | R-02 | 상품 p1·p2·p3 200과 시드 재고, 주문 조회 200, 미존재 404                        |
| `R-05-idempotent-resend`        | R-05 | 같은 키·같은 본문 2회 → 둘 다 201, 같은 id, 재고 1회 차감                       |
| `R-06-idempotency-conflict`     | R-06 | 같은 키·다른 본문(상품·수량) → 422, 재고·첫 주문 불변                           |
| `R-09-cancel`                   | R-09 | 취소 200 → 재고 복구, 이중 취소 409, 없는 주문 404                              |
| `R-03-insufficient-stock`       | R-03 | p1 수량 3·p3 수량 1 → 409, 재고 불변, p1 수량 2 → 201·재고 0                    |
| `R-04-validation`               | R-04 | 잘못된 입력 10종 → 400, 재고 불변, 400으로 끝난 키 재사용 → 201                 |
| `R-07-same-key-concurrent`      | R-07 | 같은 키 10건 동시 → 모두 201 같은 id, p2 재고 4                                 |
| `R-08-distinct-keys-concurrent` | R-08 | 다른 키 10건 동시 → 201 5건·409 5건, 재고 0, 성공 id 5개 모두 조회 200          |
| `R-10-health-and-reset`         | R-10 | `/health` 200, `/admin/reset` 200 후 시드 복구·이전 주문 404·이전 키 재사용 201 |

R-10의 `npm start`·`PORT`·기동 후 10초 안 `/health`는 서비스 기동(T-108)의 관측이며, T-205가 두 관측을 합쳐 판정한다.
