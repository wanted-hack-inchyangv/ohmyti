# order-api 결함 구현 C (Express)

샘플 과제 [`SPEC.md`](../SPEC.md)의 **멱등성 요구사항을 위반하는** 구현입니다. 제출 테스트는 전부 통과하지만, `Idempotency-Key`를 저장하거나 조회하지 않으므로 같은 키로 두 번 주문하면 재고가 `2 → 1 → 0`이 됩니다. 채점 파이프라인이 "테스트는 통과하지만 요구사항은 위반"으로 판별해야 하는 샘플이며(`expected-matrix.json`의 C 열), 90초 데모의 핵심 샘플입니다.

정답 구현 [`impl-a`](../impl-a/README.md)와 같은 구조(Express, routes / service / repository, 인메모리 저장)이며, 멱등성 저장소와 그에 딸린 코드만 없습니다.

## 실행 방법

승인 템플릿 `templates/order-api-ts`의 고정 의존성만 사용합니다. 이 디렉터리에 `npm install`을 하지 않고, 템플릿 `node_modules`를 심볼릭 링크로 연결합니다.

```bash
# 저장소 루트에서
pnpm template:build     # 템플릿 node_modules 설치 (최초 1회)
pnpm samples:link       # samples/order-api/impl-*/node_modules → 템플릿 node_modules

cd samples/order-api/impl-c
PORT=4333 npm start     # tsx src/server.ts. PORT 미설정 시 3000
npm test                # vitest run (제출 테스트 11건, 전부 통과)
npm run typecheck       # tsc --noEmit
```

- 서버는 환경변수 `PORT`에 지정한 포트에서 수신합니다. `GET /health`가 200 `{ "status": "ok" }`를 반환하면 준비된 것입니다.
- `POST /admin/reset`은 재고를 시드(`p1` 2, `p2` 5, `p3` 0)로 되돌리고 주문을 지웁니다. 멱등성 기록은 애초에 없습니다.

## 구조

| 경로                           | 역할                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `src/server.ts`                | 진입점. `PORT`를 읽어 `createApp()`을 기동한다                                        |
| `src/app.ts`                   | 앱 조립. 상품·주문 저장소를 서비스에 주입한다 (멱등성 저장소 주입 없음)               |
| `src/http/routes.ts`           | HTTP 계층. 라우팅, 헤더·본문 추출, 응답 직렬화                                        |
| `src/http/error-handler.ts`    | 오류 응답 직렬화. `AppError` → 상태·코드, JSON 파싱 실패 → 400                        |
| `src/domain/order-service.ts`  | 도메인 규칙. 판정 순서 검증 → 상품 → 재고 → 생성. **멱등 조회·기록 단계가 없다**      |
| `src/domain/validation.ts`     | 검증 규칙. `Idempotency-Key`는 **형식만** 검사하고 버린다. 본문 스키마, 수량 하한     |
| `src/domain/errors.ts`         | 오류 코드 → HTTP 상태 매핑. `IDEMPOTENCY_CONFLICT`가 표에는 있지만 던지는 코드가 없다 |
| `src/domain/mutex.ts`          | 쓰기 임계 구역을 직렬화하는 비동기 뮤텍스                                             |
| `src/domain/seed.ts`           | 시드 데이터                                                                           |
| `src/repository/interfaces.ts` | `ProductRepository`, `OrderRepository` (`IdempotencyStore` 없음)                      |
| `src/repository/in-memory.ts`  | 위 인터페이스의 인메모리 구현                                                         |
| `test/*.test.ts`               | 제출 테스트 (vitest + supertest). 정상 주문·조회·취소 후 재고 복구만 검증             |

A에 있고 C에 없는 파일: `src/domain/digest.ts`, `IdempotencyStore` 인터페이스와 `InMemoryIdempotencyStore`, `IdempotencyRecord` 타입, `test/{stock,validation,idempotency,concurrency}.test.ts`.

## 존재하지 않는 로직: 멱등성 (R-05, R-06, R-07)

`createOrder()`는 `Idempotency-Key`의 형식(존재, 128자 이하)만 검사하고 값을 어디에도 저장하지 않습니다. 결과는 다음과 같습니다 (실제 HTTP로 확인, 2026-09-18).

| 기준 | SPEC 기대                                           | C의 실제 동작                                                |
| ---- | --------------------------------------------------- | ------------------------------------------------------------ |
| R-05 | 같은 키·같은 본문 재전송 → 같은 id, 재고 1회만 차감 | 두 번째 요청도 201이지만 **id가 다르고** p1 재고 `2 → 1 → 0` |
| R-06 | 같은 키·다른 본문 → 422 `IDEMPOTENCY_CONFLICT`      | 201, 새 주문 생성                                            |
| R-07 | 같은 키 10건 동시 → 주문 1건, 재고 1회 차감         | p2(재고 5)에서 201 5건·409 5건, 주문 5건, 재고 0             |

세 기준의 근본 원인은 하나(`idempotency-store-missing`)이지만 관측 가능한 위반이 다르므로 rubric의 `independentReason`대로 각각 감점됩니다.

## 존재하지만 테스트되지 않는 보호 로직 (R-03, R-04, R-08, R-09)

아래 로직은 코드에 있고 실제로 동작하지만, 제출 테스트가 검증하지 않습니다. 하네스(T-107)는 이 기준들을 PASS로 판정해야 하고, mutation 실험(G1)은 테스트가 없다는 점을 드러내야 합니다.

| 기준 | 위치                                                     | 동작 (실제 HTTP 확인)                                               | 제출 테스트 |
| ---- | -------------------------------------------------------- | ------------------------------------------------------------------- | ----------- |
| R-03 | `order-service.ts` `createOrder` 재고 검사 (`M-01` 주석) | p1에 quantity 3 → 409 `INSUFFICIENT_STOCK`, p3에 1 → 409, 재고 불변 | 없음        |
| R-04 | `validation.ts` (`M-02` 주석)                            | 키 누락·129자, quantity 0·-1·1.5, productId 누락, 잘못된 JSON → 400 | 없음        |
| R-08 | `order-service.ts` `Mutex` + 재고 검사                   | 다른 키 10건 동시(p2 재고 5) → 201 5건·409 5건, 재고 0, 음수 없음   | 없음        |
| R-09 | `order-service.ts` `cancelOrder` 재고 복구 (`M-05` 주석) | 취소 200 → 재고 복구, 이중 취소 409 `ALREADY_CANCELLED`             | 있음 (3건)  |

## 제출 테스트 범위

| 파일             | 확인 내용                                                                   | 검증하지 않는 것                             |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| `health.test.ts` | `/health` 200, `/admin/reset`이 재고·주문을 되돌림                          |                                              |
| `orders.test.ts` | 상품 조회·미존재 404, 정상 주문 201·재고 차감, 다른 키는 다른 id, 주문 조회 | 재고 부족 409, 입력 검증 400, 같은 키 재전송 |
| `cancel.test.ts` | 취소 200·재고 복구, 취소 후 조회, 복구된 재고 재사용                        | 이중 취소 409                                |

## 결함 주입 실험 결과 (M-01~M-05)

각 결함을 손으로 적용한 뒤 `npm test -- --reporter=json`을 돌린 결과입니다. 적용 후에는 원본으로 되돌렸습니다 (2026-09-18, vitest 4.1.11, 총 11건).

| ID   | 적용 위치                                             | 변형                                                     | 실패 테스트 수 | 결과                   |
| ---- | ----------------------------------------------------- | -------------------------------------------------------- | -------------: | ---------------------- |
| M-01 | `src/domain/order-service.ts` `createOrder` 재고 검사 | 재고 검사 블록 제거                                      |              0 | **SURVIVED** (G1 근거) |
| M-01 | 같은 곳                                               | `input.quantity > product.stock` → `<` (조건 반전)       |              5 | KILLED (아래 참고)     |
| M-02 | `src/domain/validation.ts` 수량 하한                  | `quantity <= 0` → `quantity < 0`                         |              0 | **SURVIVED** (G1 근거) |
| M-03 | 멱등 키 조회                                          | 대상 코드 없음                                           |              - | NOT_APPLICABLE         |
| M-04 | 같은 키의 본문 비교                                   | 대상 코드 없음                                           |              - | NOT_APPLICABLE         |
| M-05 | `src/domain/order-service.ts` `cancelOrder` 재고 복구 | `adjustStock(order.productId, order.quantity)` 호출 제거 |              3 | **KILLED** (G3 근거)   |

- **M-01 반전 변형이 KILLED인 이유**: `<`로 반전하면 재고보다 적은 수량의 정상 주문(p1 재고 2에 quantity 1)까지 409가 되어 정상 경로 테스트가 실패합니다. 재고 부족을 검사하는 테스트가 있어서가 아닙니다. 따라서 G1의 SURVIVED 시연 근거는 **제거 변형**이며, T-402 적용기는 C 같은 샘플에서 반전이 아니라 제거 변형을 대표로 써야 합니다.
- **M-03·M-04가 NOT_APPLICABLE인 이유**: 멱등 키를 조회하는 문장도, 본문 다이제스트를 비교하는 문장도 존재하지 않습니다 (`grep -rn idempotency src/`는 `validateIdempotencyKey`의 형식 검사만 찾습니다). 기준 상태에서 이미 R-05·R-06이 FAIL이므로 G2는 `NOT_APPLICABLE`로 두고 검토 대기(INCONCLUSIVE)로 남깁니다.

기대 결과표(C 열): G1 `FAIL 0`(M-01·M-02 SURVIVED), G2 `INCONCLUSIVE`, G3 `PASS 5`(M-05 KILLED).
