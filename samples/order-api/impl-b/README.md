# order-api 대안 정답 구현 B (Hono + 이벤트 원장)

샘플 과제 [`SPEC.md`](../SPEC.md)를 모두 충족하는 두 번째 정답 구현입니다. [구현 A](../impl-a/README.md)와 프레임워크·디렉터리 구조·핵심 자료구조·멱등성 구현 방식이 모두 다르며, 채점기가 특정 구조나 라이브러리를 요구하지 않는지 확인하는 용도입니다(`expected-matrix.json`의 B 열). 제출 테스트는 결함 주입 카탈로그 M-01~M-05를 전부 잡아냅니다.

## 실행 방법

승인 템플릿 `templates/order-api-ts`의 고정 의존성만 사용합니다. 이 디렉터리에 `npm install`을 하지 않고, 템플릿 `node_modules`를 심볼릭 링크로 연결합니다.

```bash
# 저장소 루트에서
pnpm template:build     # 템플릿 node_modules 설치 (최초 1회)
pnpm samples:link       # samples/order-api/impl-*/node_modules → 템플릿 node_modules

cd samples/order-api/impl-b
PORT=4332 npm start     # tsx src/main.ts. PORT 미설정 시 3000
npm test                # vitest run (제출 테스트 61건)
npm run typecheck       # tsc --noEmit
```

- 서버는 환경변수 `PORT`에 지정한 포트에서 수신합니다. `GET /health`가 200 `{ "status": "ok" }`를 반환하면 준비된 것입니다.
- `POST /admin/reset`은 재고 원장을 비워 시드(`p1` 2, `p2` 5, `p3` 0)로 되돌리고 주문·멱등성 기록을 지웁니다.
- 워커의 채점 실행(`npm test`)은 vitest JSON 리포터 결과 파일로 수집합니다: `npm test -- --reporter=json --outputFile=<파일>`.

## A와 다른 점

| 항목            | 구현 A (`impl-a`)                                                    | 구현 B (`impl-b`)                                                                                            |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 프레임워크      | Express 5 (`express.json` 미들웨어, 오류 미들웨어)                   | Hono 4 + `@hono/node-server` (fetch 기반, `app.request()`로 프로세스 안 테스트)                              |
| 진입점·조립     | `src/server.ts` → `src/app.ts`(`createApp`)                          | `src/main.ts` → `src/api.ts`(`buildApi`)                                                                     |
| 디렉터리 구조   | `src/http/`, `src/domain/`, `src/repository/` 3계층                  | `src/api.ts` 한 파일 + `src/core/` 함수 모듈. 저장소 계층 없음                                               |
| 코드 스타일     | 클래스(`OrderService`, `Mutex`, 저장소 클래스)와 예외(`AppError`)    | 클로저와 순수 함수. 예외 대신 `Outcome<T>`(`ok`/`fail`) 값 반환                                              |
| 재고 자료구조   | `Product.stock` 숫자를 `adjustStock(delta)`로 덮어씀                 | 이벤트 원장(`ledger.ts`): `RESERVE`/`RELEASE` 이벤트를 append-only로 쌓고 `시드 + Σdelta`로 현재 재고를 계산 |
| 멱등성 구현     | `IdempotencyStore` 인터페이스 + sha256 다이제스트(`digest.ts`)       | `State.idempotency` Map + 필드 고정 순서 직렬화 지문(`fingerprintOf`, 해시 없음)                             |
| 입력 검증       | zod 스키마 + 명시적 `quantity <= 0` 비교                             | 스키마 라이브러리 없이 필드별 수동 검사(`rules.ts`). `zod` 의존성 없음                                       |
| 동시성 제어     | `Mutex` 클래스(`run(fn)`)                                            | `createSerial()` 클로저 큐                                                                                   |
| 테스트 디렉터리 | `test/*.test.ts`, supertest로 HTTP 호출                              | `spec/*.spec.ts`, Hono `app.request()` 직접 호출. `supertest` 의존성 없음                                    |
| dependencies    | express, tsx, zod (+ @types/express, @types/supertest, supertest, …) | @hono/node-server, hono, tsx (+ @types/node, typescript, vitest)                                             |

소스 파일 경로 집합은 서로 겹치지 않습니다.

- A: `src/server.ts`, `src/app.ts`, `src/http/routes.ts`, `src/http/error-handler.ts`, `src/domain/{order-service,validation,errors,digest,mutex,seed,types}.ts`, `src/repository/{interfaces,in-memory}.ts`
- B: `src/main.ts`, `src/api.ts`, `src/core/{commands,rules,ledger,state,catalog,outcome,serial}.ts`

## 구조

| 경로                   | 역할                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `src/main.ts`          | 진입점. `PORT`를 읽어 `serve({ fetch: buildApi().fetch, port })`로 기동하고 SIGTERM에 종료한다      |
| `src/api.ts`           | HTTP 라우팅. 헤더·본문 추출, `Outcome` → 상태 코드·오류 본문 변환(`STATUS_OF`), 404·500 처리        |
| `src/core/commands.ts` | 도메인 명령 `createCommands()`: `product`·`order`·`place`·`cancel`·`reset`. 판정 순서와 쓰기 직렬화 |
| `src/core/rules.ts`    | SPEC 5.4 검증 규칙(`parseKey`, `parseOrderRequest`)과 멱등성 지문(`fingerprintOf`)                  |
| `src/core/ledger.ts`   | 재고 이벤트 원장. `reserve`/`release`로 이벤트를 쌓고 `availableStock`으로 합산한다                 |
| `src/core/state.ts`    | 프로세스 상태(원장, 주문 Map, 멱등성 Map)와 초기화                                                  |
| `src/core/catalog.ts`  | 시드 상품(코드 내장). `initialStock`이 원장의 시작값이다                                            |
| `src/core/outcome.ts`  | `Outcome<T>` 결과 타입과 오류 코드(`FailureCode`)                                                   |
| `src/core/serial.ts`   | 비동기 직렬 큐 `createSerial()`                                                                     |
| `spec/*.spec.ts`       | 제출 테스트 (vitest, `app.request()`로 프로세스 안에서 호출). `spec/harness.ts`는 공용 헬퍼         |

## 설계 가정과 제약

- **함수형 모듈 구성**: 상태는 `createCommands()` 클로저 안에만 있고, 밖으로는 함수만 노출합니다. HTTP 계층(`api.ts`)은 `Outcome`의 성공/실패만 보고 상태 코드를 정하며, 도메인은 HTTP를 모릅니다.
- **재고 원장**: 재고를 숫자로 덮어쓰지 않고 이벤트로 기록합니다. 어떤 주문이 재고를 바꿨는지 `orderId`로 추적할 수 있고, 취소는 반대 부호의 `RELEASE` 이벤트입니다. `/admin/reset`은 원장을 비우면 됩니다.
- **멱등성**: 키마다 요청 지문과 원래 201 본문을 저장합니다. 같은 지문이면 저장된 본문을 그대로 돌려주고, 다르면 `422 IDEMPOTENCY_CONFLICT`입니다. `201`로 끝난 요청만 기록하며, 키의 범위는 서버 전체입니다. 원래 주문이 취소되어도 재전송 응답은 원래 본문(`CREATED`)입니다.
- **동시성**: `place`·`cancel`·`reset`은 `createSerial()` 큐를 거칩니다. 검증(400)은 큐 밖에서 처리하고, "멱등 조회 → 상품 → 재고 → 기록"은 한 작업으로 큐 안에서 처리하므로 같은 키 N건은 주문 1건, 다른 키 N건은 재고 이내로 유지됩니다.
- **본문 파싱**: `c.req.json()`이 실패하거나 본문이 없으면 `undefined`로 두고 검증 단계에서 `400 VALIDATION_ERROR`가 됩니다. 객체가 아닌 JSON(배열, 문자열, null)도 400입니다.
- **인메모리 저장**: 프로세스가 재시작되면 시드 상태로 돌아갑니다. 외부 DB·네트워크는 쓰지 않습니다.
- **주문 id**: `crypto.randomUUID()`.

## 제출 테스트 범위

| 기준 | 테스트 파일                  | 확인 내용                                                                                     |
| ---- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| R-01 | `catalog-and-orders.spec.ts` | 201 응답 스키마, 재고 차감, 재고와 같은 수량(B-3), 없는 상품 404                              |
| R-02 | `catalog-and-orders.spec.ts` | 시드 상품 조회, 주문 조회, 미존재 404(B-8, B-15)                                              |
| R-03 | `stock-guard.spec.ts`        | 재고 부족 409·재고 불변(B-1, B-2), 소진 후 409, 반복 요청에서 음수 없음, 409 키 미기록        |
| R-04 | `input-rules.spec.ts`        | 본문·헤더 검증 400 열네 가지(B-4~B-7), 키 128자 경계, 검증이 멱등성보다 먼저, 400 키 미기록   |
| R-05 | `idempotency-key.spec.ts`    | 같은 키·같은 본문 재전송(B-9), 3회 재전송, 필드 순서, 재고 소진 후 재전송, 취소 후 재전송     |
| R-06 | `idempotency-key.spec.ts`    | 같은 키·다른 본문 422·불변(B-10), 서버 전체 범위 키, 충돌이 상품·재고보다 먼저, 404 키 미기록 |
| R-07 | `parallel-requests.spec.ts`  | 같은 키 10건 동시(B-11), 같은 키 동시 요청에 다른 본문이 섞인 경우                            |
| R-08 | `parallel-requests.spec.ts`  | 다른 키 10건 동시(B-12), 수량이 섞인 동시 요청의 재고 하한                                    |
| R-09 | `cancellation.spec.ts`       | 취소·재고 복구(B-13), 이중 취소 409(B-14), 동시 취소 복구 1회, 미존재 404, 복구된 재고 재사용 |
| R-10 | `lifecycle.spec.ts`          | `/health`, `/admin/reset` 응답과 효과(B-16)                                                   |

## 결함 주입 실험 결과 (M-01~M-05)

각 결함을 손으로 적용한 뒤 `npm test -- --reporter=json`을 돌린 결과입니다. 적용 후에는 원본으로 되돌렸습니다 (2026-09-18, vitest 4.1.11, 총 61건).

| ID   | 적용 위치                                          | 변형                                                            | 실패 테스트 수 | 대표 실패 테스트                                                                           |
| ---- | -------------------------------------------------- | --------------------------------------------------------------- | -------------: | ------------------------------------------------------------------------------------------ |
| M-01 | `src/core/commands.ts` `placeSerialized` 재고 검사 | `request.quantity > stock` → `<` (조건 반전)                    |             31 | `재고 부족 p1(재고 2)에 quantity 3 → 409 INSUFFICIENT_STOCK` (B-1)                         |
| M-01 | 같은 곳                                            | 재고 검사 블록 제거                                             |              7 | `다른 키 10건 동시 … 201 정확히 5건, 409 INSUFFICIENT_STOCK 5건` (B-12)                    |
| M-02 | `src/core/rules.ts` 수량 하한                      | `quantity <= 0` → `quantity < 0`                                |              2 | `quantity 0 → 400 VALIDATION_ERROR, 재고 불변` (B-4)                                       |
| M-03 | `src/core/commands.ts` 멱등 키 조회                | `state.idempotency.get(key)` → `undefined` (조회 건너뜀)        |             11 | `같은 키 + 같은 본문 재전송 두 번 모두 201, 같은 id, 재고는 1회만 차감` (B-9)              |
| M-04 | `src/core/commands.ts` 지문 비교                   | `seen.fingerprint !== fingerprint` → `false` (본문 비교 건너뜀) |              5 | `같은 키 + 다른 본문 quantity가 다르면 422 IDEMPOTENCY_CONFLICT` (B-10)                    |
| M-05 | `src/core/commands.ts` `cancel` 재고 복구          | `release(state.ledger, …)` 호출 제거                            |              6 | `POST /orders/:id/cancel 200 CANCELLED를 반환하고 RELEASE 이벤트로 재고를 복구한다` (B-13) |

모든 결함에서 최소 1개 테스트가 실패하므로 기대 결과표의 G1·G2·G3은 `KILLED`입니다.
