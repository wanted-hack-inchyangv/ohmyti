/**
 * `예시 명세로 채우기` (TICKET.md T-906).
 *
 * `/assignments/new`에서 한 번 눌러 `AI 초안 생성`을 바로 시연할 수 있도록, `samples/order-api/SPEC.md`를 줄인 명세다.
 * 배포된 web은 저장소 파일을 읽을 수 없으므로 상수로 둔다. 원본과 어긋나지 않는지 `example-spec.test.ts`가 검사한다.
 *
 * 이 값은 입력란을 채우기만 한다. 기준·배점은 AI 초안이나 사람이 정하며 이 파일에는 점수가 없다.
 */
export interface ExampleAssignment {
  name: string;
  description: string;
  title: string;
  specMarkdown: string;
}

export const EXAMPLE_ASSIGNMENT: ExampleAssignment = {
  name: "주문·재고 API",
  description: "TypeScript로 작은 주문·재고 HTTP API를 만드는 백엔드 과제",
  title: "v1",
  specMarkdown: `# 주문·재고 API

## 1. 과제 개요

TypeScript로 작은 주문·재고 HTTP API를 구현한다. 상품 재고를 확인해 주문을 만들고, 조회하고, 취소한다.
주문 생성은 \`Idempotency-Key\` 헤더로 멱등해야 하며, 동시 요청에서도 재고가 음수가 되거나 같은 키로 주문이 두 번
만들어지면 안 된다.

- 프레임워크는 자유이며 Node.js 내장 \`http\`만 써도 된다. 채점은 HTTP 동작만 관측한다.
- 상품·주문·멱등성 기록은 프로세스 메모리에 두어도 된다.
- 외부 데이터베이스·캐시·외부 HTTP 호출은 쓰지 않는다.

## 2. 시드 데이터

기동 직후와 \`POST /admin/reset\` 직후의 상태다. 주문과 멱등성 기록은 비어 있다.

| id | name | stock |
| --- | --- | ---: |
| \`p1\` | Keyboard | 2 |
| \`p2\` | Mouse | 5 |
| \`p3\` | Monitor | 0 |

## 3. 공통 규약

- 요청·응답 본문은 JSON이며 \`Content-Type: application/json\`이다.
- 오류 응답 본문은 \`{ "error": { "code": ..., "message": ... } }\` 형태다.
- 주문 \`id\`는 서버가 만드는 비어 있지 않은 문자열이다.
- 상태 코드와 \`error.code\`는 아래 표와 일치해야 한다. 그 밖의 상태 코드(500 등)는 판정 실패로 본다.

## 4. 오류 코드

| 코드 | HTTP 상태 | 의미 |
| --- | ---: | --- |
| \`VALIDATION_ERROR\` | 400 | 요청 본문·헤더가 검증 규칙을 어겼다 |
| \`NOT_FOUND\` | 404 | 요청한 상품 또는 주문이 없다 |
| \`INSUFFICIENT_STOCK\` | 409 | 요청 수량이 현재 재고보다 많다 |
| \`ALREADY_CANCELLED\` | 409 | 이미 취소된 주문을 다시 취소하려 했다 |
| \`IDEMPOTENCY_CONFLICT\` | 422 | 이미 쓴 \`Idempotency-Key\`를 다른 본문과 함께 재사용했다 |

## 5. 엔드포인트

| 엔드포인트 | 성공 상태 | 설명 |
| --- | ---: | --- |
| \`GET /health\` | 200 | 기동 확인. \`{ "status": "ok" }\` |
| \`POST /admin/reset\` | 200 | 시드 상태로 초기화. 주문과 멱등성 기록을 지운다 |
| \`GET /products/:id\` | 200 | 상품 조회. \`{ id, name, stock }\`, 없으면 404 |
| \`POST /orders\` | 201 | 주문 생성 (멱등) |
| \`GET /orders/:id\` | 200 | 주문 조회. 없으면 404 |
| \`POST /orders/:id/cancel\` | 200 | 주문 취소. 재고를 되돌린다 |

### \`POST /orders\`

- 헤더: \`Idempotency-Key\` (필수, 비어 있지 않은 문자열)
- 본문: \`{ "productId": string, "quantity": number }\`. \`quantity\`는 1 이상의 정수다.
- 성공: \`201\` \`{ "id": string, "productId": string, "quantity": number, "status": "CREATED" }\`
- 같은 키·같은 본문으로 다시 오면 새 주문을 만들지 않고 처음 만든 주문을 그대로 돌려준다. 재고는 한 번만 줄어든다.
- 같은 키·다른 본문이면 \`422 IDEMPOTENCY_CONFLICT\`이고 재고와 주문은 바뀌지 않는다.

## 6. 경계 조건

각 시나리오는 \`POST /admin/reset\`으로 시작한다.

| # | 시나리오 | 기대 |
| --- | --- | --- |
| B-1 | \`p1\`(재고 2)에 quantity 3 | \`409 INSUFFICIENT_STOCK\`, 재고 2 유지 |
| B-2 | quantity \`0\`·\`-1\`·\`1.5\`·\`"1"\`·누락 | \`400 VALIDATION_ERROR\`, 재고 불변 |
| B-3 | \`Idempotency-Key\` 누락·빈 문자열 | \`400 VALIDATION_ERROR\` |
| B-4 | 같은 키·같은 본문 2회 순차 | 두 번 모두 \`201\`, 같은 \`id\`, 재고 1회 차감 |
| B-5 | 같은 키·다른 본문 | 두 번째는 \`422 IDEMPOTENCY_CONFLICT\` |
| B-6 | 같은 키·같은 본문 10건 동시 | 전부 \`201\` 같은 \`id\`, 재고 1회 차감 |
| B-7 | 다른 키 10건 동시, \`p2\`(재고 5) quantity 1 | \`201\` 5건, \`409\` 5건, \`p2.stock\` 0 |
| B-8 | 취소 후 재고 | \`p1\` quantity 1 주문 → 취소 → \`p1.stock\` 2 |
| B-9 | 이중 취소 | 두 번째는 \`409 ALREADY_CANCELLED\` |
| B-10 | 초기화 | 초기화 뒤 이전 주문은 \`404\`, 재고는 시드 상태 |

## 7. 제출 요구사항

- 저장소 루트에 \`package.json\`(\`scripts.start\` 포함)과 \`README.md\`가 있어야 한다. README는 실행 방법과 포트 설정(\`PORT\`)을 적는다.
- 제출 테스트는 저장소 안에서 \`npm test\`로 실행된다. 테스트 개수가 아니라 주입된 결함을 실제로 잡아내는지를 본다.
`,
};
