# order-api (인라인 핸들러 fixture)

T-602 회귀 fixture다. 라우트 핸들러 안에 로직이 모두 인라인으로 들어 있고, 멱등 기록은 배열을 순회해 찾으며,
취소 시 재고는 `x.stock = x.stock + quantity` 대입으로 되돌린다. 제출 테스트는 단언이 약해서 M-01 ~ M-05를
잡지 못한다.

- 실행: `npm start` (포트는 `PORT` 환경변수, 기본 3000)
- 테스트: `npm test`
