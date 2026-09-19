# order-api 정답 구현 A (Express)

샘플 과제 [`SPEC.md`](../SPEC.md)를 모두 충족하는 기준 구현입니다. 채점 파이프라인이 "정답"으로 판별해야 하는 샘플이며(`expected-matrix.json`의 A 열), 제출 테스트는 결함 주입 카탈로그 M-01~M-05를 전부 잡아냅니다.

## 실행 방법

승인 템플릿 `templates/order-api-ts`의 고정 의존성만 사용합니다. 이 디렉터리에 `npm install`을 하지 않고, 템플릿 `node_modules`를 심볼릭 링크로 연결합니다.

```bash
# 저장소 루트에서
pnpm template:build     # 템플릿 node_modules 설치 (최초 1회)
pnpm samples:link       # samples/order-api/impl-*/node_modules → 템플릿 node_modules

cd samples/order-api/impl-a
PORT=4331 npm start     # tsx src/server.ts. PORT 미설정 시 3000
npm test                # vitest run (제출 테스트 49건)
npm run typecheck       # tsc --noEmit
```

- 서버는 환경변수 `PORT`에 지정한 포트에서 수신합니다. `GET /health`가 200 `{ "status": "ok" }`를 반환하면 준비된 것입니다.
- `POST /admin/reset`은 재고를 시드(`p1` 2, `p2` 5, `p3` 0)로 되돌리고 주문·멱등성 기록을 지웁니다.
- 워커의 채점 실행(`npm test`)은 vitest JSON 리포터 결과 파일로 수집합니다: `npm test -- --reporter=json --outputFile=<파일>`.

## 구조

| 경로                           | 역할                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `src/server.ts`                | 진입점. `PORT`를 읽어 `createApp()`을 기동한다                                            |
| `src/app.ts`                   | 앱 조립. 저장소 구현을 서비스에 주입하고 미들웨어·라우트·오류 처리기를 연결한다           |
| `src/http/routes.ts`           | HTTP 계층. 라우팅, 헤더·본문 추출, 응답 직렬화만 담당한다                                 |
| `src/http/error-handler.ts`    | 오류 응답 직렬화 한 곳. `AppError` → 상태·코드, JSON 파싱 실패 → 400, 그 밖은 500         |
| `src/domain/order-service.ts`  | 도메인 규칙. 판정 순서(검증 → 멱등성 → 상품 → 재고 → 생성), 취소·재고 복구, 초기화        |
| `src/domain/validation.ts`     | SPEC 5.4 검증 규칙 (`Idempotency-Key`, 본문 스키마, 수량 하한)                            |
| `src/domain/errors.ts`         | 오류 코드 → HTTP 상태 매핑(`ERROR_STATUS`)과 `AppError`. 새 오류 코드는 여기 한 줄로 추가 |
| `src/domain/digest.ts`         | 멱등성 비교용 본문 다이제스트 (sha256, 필드 순서 무관)                                    |
| `src/domain/mutex.ts`          | 쓰기 임계 구역을 직렬화하는 비동기 뮤텍스                                                 |
| `src/domain/seed.ts`           | 시드 데이터 (코드 내장)                                                                   |
| `src/repository/interfaces.ts` | `ProductRepository`, `OrderRepository`, `IdempotencyStore` 인터페이스                     |
| `src/repository/in-memory.ts`  | 위 인터페이스의 인메모리 구현                                                             |
| `test/*.test.ts`               | 제출 테스트 (vitest + supertest, 앱을 프로세스 안에서 직접 호출)                          |

## 설계 가정과 제약

- **계층 분리**: 도메인 규칙(`OrderService`)은 HTTP 요청·응답 객체를 모릅니다. 입력은 헤더 문자열과 파싱된 본문(`unknown`)이고, 결과는 도메인 객체 또는 `AppError`입니다. 상태 코드 변환은 `error-handler.ts`가 맡습니다.
- **멱등성 저장소 추상화**: 멱등성 기록은 `IdempotencyStore` 인터페이스 뒤에 있습니다. 키마다 요청 본문 다이제스트와 원래 201 응답을 저장하며, 같은 다이제스트면 저장된 응답을 그대로 돌려주고 다르면 `422 IDEMPOTENCY_CONFLICT`입니다. `201`로 끝난 요청만 기록합니다.
- **동시성**: 주문 생성·취소의 임계 구역(멱등 조회→기록, 재고 확인→차감)은 `Mutex`로 직렬화합니다. 인메모리 저장소는 동기적이라 Node 이벤트 루프만으로도 안전하지만, 저장소를 비동기 구현(예: 외부 DB)으로 바꿔도 같은 키 N건 동시 요청이 주문 1건, 다른 키 N건이 재고 이내로 유지되도록 구조를 유지합니다.
- **인메모리 저장**: 프로세스가 재시작되면 시드 상태로 돌아갑니다. 외부 DB·네트워크는 쓰지 않습니다.
- **본문 파싱**: `express.json({ strict: true })`이므로 JSON 객체·배열이 아닌 본문은 파서 단계에서 400이 됩니다. 배열과 `Content-Type`이 없는 요청은 검증 단계에서 400입니다. 응답에 명시되지 않은 추가 필드는 없습니다.
- **주문 id**: `crypto.randomUUID()`.

## 제출 테스트 범위

| 기준 | 테스트 파일                   | 확인 내용                                                                     |
| ---- | ----------------------------- | ----------------------------------------------------------------------------- |
| R-01 | `products-and-orders.test.ts` | 201 응답 스키마, 재고 차감, 재고와 같은 수량(B-3)                             |
| R-02 | `products-and-orders.test.ts` | 시드 상품 조회, 주문 조회, 미존재 404(B-8, B-15)                              |
| R-03 | `stock.test.ts`               | 재고 부족 409·재고 불변(B-1, B-2), 소진 후 409, 409 키 미기록                 |
| R-04 | `validation.test.ts`          | 본문·헤더 검증 400 열 가지 이상(B-4~B-7), 키 128자 경계, 400 키 미기록        |
| R-05 | `idempotency.test.ts`         | 같은 키·같은 본문 재전송(B-9), 필드 순서, 재고 소진 후 재전송, 취소 후 재전송 |
| R-06 | `idempotency.test.ts`         | 같은 키·다른 본문 422·불변(B-10), 서버 전체 범위 키, 404 키 미기록            |
| R-07 | `concurrency.test.ts`         | 같은 키 10건 동시(B-11)                                                       |
| R-08 | `concurrency.test.ts`         | 다른 키 10건 동시(B-12), 수량이 섞인 동시 요청의 재고 하한                    |
| R-09 | `cancel.test.ts`              | 취소·재고 복구(B-13), 이중 취소 409(B-14), 미존재 404, 복구된 재고 재사용     |
| R-10 | `health-and-reset.test.ts`    | `/health`, `/admin/reset` 응답과 효과(B-16)                                   |

## 결함 주입 실험 결과 (M-01~M-05)

각 결함을 손으로 적용한 뒤 `npm test -- --reporter=json`을 돌린 결과입니다. 적용 후에는 원본으로 되돌렸습니다 (2026-09-18, vitest 4.1.11, 총 49건).

| ID   | 적용 위치                                             | 변형                                                             | 실패 테스트 수 | 대표 실패 테스트                                                              |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------- | -------------: | ----------------------------------------------------------------------------- |
| M-01 | `src/domain/order-service.ts` `createOrder` 재고 검사 | `input.quantity > product.stock` → `<` (조건 반전)               |             24 | `재고 부족 p1(재고 2)에 quantity 3 → 409 INSUFFICIENT_STOCK` (B-1)            |
| M-01 | 같은 곳                                               | 재고 검사 블록 제거                                              |              6 | 같은 테스트, `다른 키 10건 동시 … 201 정확히 5건, 409 5건` (B-12)             |
| M-02 | `src/domain/validation.ts` 수량 하한                  | `quantity <= 0` → `quantity < 0`                                 |              2 | `quantity 0 → 400 VALIDATION_ERROR, 재고 불변` (B-4)                          |
| M-03 | `src/domain/order-service.ts` 멱등 키 조회            | `await this.idempotency.get(key)` → `undefined` (조회 건너뜀)    |              8 | `같은 키 + 같은 본문 재전송 두 번 모두 201, 같은 id, 재고는 1회만 차감` (B-9) |
| M-04 | `src/domain/order-service.ts` 다이제스트 비교         | `existing.requestDigest !== digest` → `false` (본문 비교 건너뜀) |              3 | `같은 키 + 다른 본문 quantity가 다르면 422 IDEMPOTENCY_CONFLICT` (B-10)       |
| M-05 | `src/domain/order-service.ts` `cancelOrder` 재고 복구 | `adjustStock(order.productId, order.quantity)` 호출 제거         |              5 | `POST /orders/:id/cancel 200 CANCELLED를 반환하고 재고를 복구한다` (B-13)     |

모든 결함에서 최소 1개 테스트가 실패하므로 기대 결과표의 G1·G2·G3은 `KILLED`입니다.
