# 1단계 게이트: 샘플 판별과 결정성 검증 (T-110)

`pnpm gate:phase1`이 만든 기록이다. DB·LLM 없이 러너(T-108) + 하네스(T-107) + 제출 테스트 실행기(T-109)만으로 샘플 A/B/C/D를 `samples/order-api/expected-matrix.json`과 대조하고, 같은 절차를 반복해 판정 digest가 같은지 확인한다.

- 결과: **통과**
- 실행 일시: 2026-09-18T12:23:47.238Z ~ 2026-09-18T12:27:06.809Z (총 199.6초, 상한 10분)
- 반복 횟수: 1
- 러너: vercel (Node v24.15.0)
- environmentDigest: `12de490b3a4ee249065edb73f54c692787a1fde586981ec9c94e29b7972bc02f`
- harnessVersion: `0.1.0+e363f5fc77e72aa6`
- rubric: v1 · 기대 결과표: `samples/order-api/expected-matrix.json`

## 샘플 × 기준 판정

셀은 `기대 → 실제 ✓/✗`다. 이 게이트는 EXECUTION 기준(R-01~R-10)과 제출 테스트 결과만 판정한다. MUTATION(G1~G3)은 T-403, STATIC(R-11)은 T-205, HUMAN_REVIEW(R-12)는 T-306의 범위다.

| 기준        | method       | 배점 | A (기대 → 실제)                         | B (기대 → 실제)                         | C (기대 → 실제)                         | D (기대 → 실제)                         |
| ----------- | ------------ | ---: | --------------------------------------- | --------------------------------------- | --------------------------------------- | --------------------------------------- |
| R-01        | EXECUTION    |    8 | PASS 8 → PASS 8 ✓                       | PASS 8 → PASS 8 ✓                       | PASS 8 → PASS 8 ✓                       | PASS 8 → PASS 8 ✓                       |
| R-02        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       |
| R-05        | EXECUTION    |   14 | PASS 14 → PASS 14 ✓                     | PASS 14 → PASS 14 ✓                     | FAIL 0 → FAIL 0 ✓                       | FAIL 0 → FAIL 0 ✓                       |
| R-06        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | FAIL 0 → FAIL 0 ✓                       | FAIL 0 → FAIL 0 ✓                       |
| R-09        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       |
| R-03        | EXECUTION    |    7 | PASS 7 → PASS 7 ✓                       | PASS 7 → PASS 7 ✓                       | PASS 7 → PASS 7 ✓                       | PASS 7 → PASS 7 ✓                       |
| R-04        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       |
| R-07        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | FAIL 0 → FAIL 0 ✓                       | FAIL 0 → FAIL 0 ✓                       |
| R-08        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       |
| G1          | MUTATION     |    5 | PASS 5 → (범위 밖)                      | PASS 5 → (범위 밖)                      | FAIL 0 → (범위 밖)                      | FAIL 0 → (범위 밖)                      |
| G2          | MUTATION     |    5 | PASS 5 → (범위 밖)                      | PASS 5 → (범위 밖)                      | INCONCLUSIVE → (범위 밖)                | INCONCLUSIVE → (범위 밖)                |
| G3          | MUTATION     |    5 | PASS 5 → (범위 밖)                      | PASS 5 → (범위 밖)                      | PASS 5 → (범위 밖)                      | PASS 5 → (범위 밖)                      |
| R-12        | HUMAN_REVIEW |   10 | INCONCLUSIVE → (범위 밖)                | INCONCLUSIVE → (범위 밖)                | INCONCLUSIVE → (범위 밖)                | INCONCLUSIVE → (범위 밖)                |
| R-10        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       | PASS 6 → PASS 6 ✓                       |
| R-11        | STATIC       |    4 | PASS 4 → (범위 밖)                      | PASS 4 → (범위 밖)                      | PASS 4 → (범위 밖)                      | PASS 4 → (범위 밖)                      |
| 제출 테스트 | T-109        |    - | PASSED 49건/7파일 → PASSED 49건/7파일 ✓ | PASSED 61건/7파일 → PASSED 61건/7파일 ✓ | PASSED 11건/3파일 → PASSED 11건/3파일 ✓ | PASSED 16건/4파일 → PASSED 16건/4파일 ✓ |

## 불일치

없음

## 결정성

판정 digest = sha256(환경 digest, 기동 결과, 하네스 케이스별 verdict·failureKind·expected·actual·checks, 제출 테스트 상태·개수·파일별 테스트 이름과 상태). 시각·소요 시간·포트·주문 id는 제외한다.

| 샘플 | 1회차              | 동일 |
| ---- | ------------------ | ---- |
| A    | `4d353b811d08fa09` | ✓    |
| B    | `783913cede855960` | ✓    |
| C    | `1f54aa237bce8372` | ✓    |
| D    | `d25b68174faab538` | ✓    |

## 회차별 소요 시간

| 샘플 | 1회차 | 기동(ms) | 하네스                            | 제출 테스트          |
| ---- | ----: | -------: | --------------------------------- | -------------------- |
| A    | 52.4s |      702 | PASS 10 · FAIL 0 · INCONCLUSIVE 0 | PASSED 49/49 (7파일) |
| B    | 52.0s |      408 | PASS 10 · FAIL 0 · INCONCLUSIVE 0 | PASSED 61/61 (7파일) |
| C    | 47.3s |      696 | PASS 7 · FAIL 3 · INCONCLUSIVE 0  | PASSED 11/11 (3파일) |
| D    | 47.8s |      707 | PASS 7 · FAIL 3 · INCONCLUSIVE 0  | PASSED 16/16 (4파일) |
