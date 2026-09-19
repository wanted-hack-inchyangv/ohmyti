# 1단계 게이트: 샘플 판별과 결정성 검증 (T-110)

`pnpm gate:phase1`이 만든 기록이다. DB·LLM 없이 러너(T-108) + 하네스(T-107) + 제출 테스트 실행기(T-109)만으로 샘플 A/B/C/D를 `samples/order-api/expected-matrix.json`과 대조하고, 같은 절차를 반복해 판정 digest가 같은지 확인한다.

- 결과: **통과**
- 실행 일시: 2026-09-18T13:06:15.367Z ~ 2026-09-18T13:06:30.248Z (총 14.9초, 상한 10분)
- 반복 횟수: 3
- 러너: local (Node v24.15.0)
- environmentDigest: `2044a2e63de05a7fa5be2f53d0693ecd2ea2b95df754926b0ee50473734c0b07`
- harnessVersion: `0.1.0+c40aa35430460704`
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

| 샘플 | 1회차              | 2회차              | 3회차              | 동일 |
| ---- | ------------------ | ------------------ | ------------------ | ---- |
| A    | `58cc264b292ad7a1` | `58cc264b292ad7a1` | `58cc264b292ad7a1` | ✓    |
| B    | `171797ea7949a000` | `171797ea7949a000` | `171797ea7949a000` | ✓    |
| C    | `b4ba627e4528738d` | `b4ba627e4528738d` | `b4ba627e4528738d` | ✓    |
| D    | `198ff8c0368ef1c6` | `198ff8c0368ef1c6` | `198ff8c0368ef1c6` | ✓    |

## 회차별 소요 시간

| 샘플 | 1회차 | 2회차 | 3회차 | 기동(ms) | 하네스                            | 제출 테스트          |
| ---- | ----: | ----: | ----: | -------: | --------------------------------- | -------------------- |
| A    |  1.6s |  1.5s |  1.2s |      308 | PASS 10 · FAIL 0 · INCONCLUSIVE 0 | PASSED 49/49 (7파일) |
| B    |  1.1s |  1.2s |  1.1s |      308 | PASS 10 · FAIL 0 · INCONCLUSIVE 0 | PASSED 61/61 (7파일) |
| C    |  1.2s |  1.3s |  1.1s |      311 | PASS 7 · FAIL 3 · INCONCLUSIVE 0  | PASSED 11/11 (3파일) |
| D    |  1.3s |  1.2s |  1.1s |      307 | PASS 7 · FAIL 3 · INCONCLUSIVE 0  | PASSED 16/16 (4파일) |
