# 2단계 게이트: 배포 환경 E2E (T-208)

`pnpm gate:phase2`가 만든 기록이다. Vercel 웹(`POST /api/submissions`)에 샘플 A/B/C/D의 공개 GitHub 저장소 URL과 커밋 SHA를 제출하고, Railway 워커가 채점한 결과를 조회 API(T-207)로 읽어 `samples/order-api/expected-matrix.json`과 대조한다. 같은 샘플을 여러 번 제출해 판정 digest가 같은지, 미지원 저장소가 사유와 함께 거절되는지도 확인한다.

- 결과: **통과**
- 배포: https://ohmyti.vercel.app
- 기대값 기준: 5단계 배포 (단계 상태 REPO_CHECK DONE · ENV_PREP DONE · REQUIREMENT_VERIFY DONE · TEST_EFFECTIVENESS DONE · REVIEW_WRITE DONE · CONTEXT_LINK DONE) (`--phase 5`)
- 실행 일시: 2026-09-19T17:04:02.284Z ~ 2026-09-19T17:23:29.632Z (총 19.5분)
- 과제 버전: 주문·재고 API · v2 · 승인됨 (`98a4487e-4afc-4f02-8921-7f0c5043bba0`, rubric `v2-be07fb44`)
- 샘플 저장소: `samples/order-api/sample-repos.json` · 기대 결과표: `samples/order-api/expected-matrix.json`

## 샘플 저장소

| 샘플   | 저장소                                            | 커밋 SHA                                   |
| ------ | ------------------------------------------------- | ------------------------------------------ |
| A      | https://github.com/inchyangv/ohmyti-sample-a      | `4bee62eb91e92166bc4d6a0618d4aeb86c99fa81` |
| B      | https://github.com/inchyangv/ohmyti-sample-b      | `134f855a37463d2723988f7515b3dd6c775844c6` |
| C      | https://github.com/inchyangv/ohmyti-sample-c      | `339a30853f030cc7ec6d55b5435f8c3013093338` |
| D      | https://github.com/inchyangv/ohmyti-sample-d      | `5a12adff0521d2d41a18912fd9b5a69a788eda74` |
| 미지원 | https://github.com/inchyangv/ohmyti-sample-python | `cdfc7fe99f43c8c6491078752ef8a96c04db48d4` |

## 제출

| 샘플 | 회차 | 제출 ID                                | 평가 ID                                | 상태      | 제출→종료 | 불일치 | digest             |
| ---- | ---: | -------------------------------------- | -------------------------------------- | --------- | --------: | -----: | ------------------ |
| A    |    1 | `8857b983-ead7-4db3-867c-8632bbb7df7a` | `cdbf0124-16dd-4aea-a67e-02911b615b07` | COMPLETED |      162s |      0 | `b3e9ca7dcc8a7eca` |
| B    |    1 | `d4c46505-8d1c-4104-bcf0-51f7b0e45369` | `9ae7b3e4-e360-492c-93ec-ae2cf73206c9` | COMPLETED |      331s |      0 | `5fef057cec569776` |
| C    |    1 | `2b6d9cdd-82aa-4e55-8c47-ad92b52ffbe6` | `8a82d9e5-3479-4f89-a278-a9b3ea9742ea` | COMPLETED |      458s |      0 | `9ad4b24052e8d94b` |
| D    |    1 | `de04b990-584a-4e2a-a8ad-e2067933acfc` | `42285c57-c6d7-497d-9497-80160d116425` | COMPLETED |      578s |      0 | `2e2f90b96b00bc6f` |
| A    |    2 | `0348b17b-b699-4329-a14f-c48865a48710` | `f60e40a6-31ad-4772-ad6b-6cc4af9d2860` | COMPLETED |      730s |      0 | `b3e9ca7dcc8a7eca` |
| C    |    2 | `3e876e6c-f754-47e6-a79c-9185f52d1fb4` | `a4b0910a-fdf0-4358-90e6-41784c21aa5d` | COMPLETED |      857s |      0 | `9ad4b24052e8d94b` |
| A    |    3 | `f2f9bfd7-55df-49eb-a0b7-f94e39422cc6` | `30aa01e5-a4ed-4585-be8a-23d6bfbee821` | COMPLETED |     1018s |      0 | `b3e9ca7dcc8a7eca` |
| C    |    3 | `dcca92d3-9dfb-4fa0-8cf4-88e0c0ead763` | `888092a3-5e31-4e53-92d3-c0a531553cd8` | COMPLETED |     1151s |      0 | `9ad4b24052e8d94b` |

## 샘플 × 기준 판정 (1회차)

셀은 `기대 → 실제 ✓/✗`다. EXECUTION·STATIC·MUTATION(G1~G3) 기준은 기대 결과표를 따르고, HUMAN_REVIEW(R-12)는 사람 확인 전이라 INCONCLUSIVE를 기대한다. 점수 표시는 기대 결과표의 `beforeHumanReview`와 대조한다.

| 기준        | method       | 배점 | A (기대 → 실제)                                             | B (기대 → 실제)                                             | C (기대 → 실제)                                           | D (기대 → 실제)                                           |
| ----------- | ------------ | ---: | ----------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| R-01        | EXECUTION    |    8 | PASS 8 → PASS 8 ✓                                           | PASS 8 → PASS 8 ✓                                           | PASS 8 → PASS 8 ✓                                         | PASS 8 → PASS 8 ✓                                         |
| R-02        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                         | PASS 6 → PASS 6 ✓                                         |
| R-05        | EXECUTION    |   14 | PASS 14 → PASS 14 ✓                                         | PASS 14 → PASS 14 ✓                                         | FAIL 0 → FAIL 0 ✓                                         | FAIL 0 → FAIL 0 ✓                                         |
| R-06        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                           | FAIL 0 → FAIL 0 ✓                                         | FAIL 0 → FAIL 0 ✓                                         |
| R-09        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                         | PASS 6 → PASS 6 ✓                                         |
| R-03        | EXECUTION    |    7 | PASS 7 → PASS 7 ✓                                           | PASS 7 → PASS 7 ✓                                           | PASS 7 → PASS 7 ✓                                         | PASS 7 → PASS 7 ✓                                         |
| R-04        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                         | PASS 6 → PASS 6 ✓                                         |
| R-07        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                           | FAIL 0 → FAIL 0 ✓                                         | FAIL 0 → FAIL 0 ✓                                         |
| R-08        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                         | PASS 6 → PASS 6 ✓                                         |
| G1          | MUTATION     |    5 | PASS 5 → PASS 5 ✓                                           | PASS 5 → PASS 5 ✓                                           | FAIL 0 → FAIL 0 ✓                                         | FAIL 0 → FAIL 0 ✓                                         |
| G2          | MUTATION     |    5 | PASS 5 → PASS 5 ✓                                           | PASS 5 → PASS 5 ✓                                           | INCONCLUSIVE → INCONCLUSIVE ✓                             | INCONCLUSIVE → INCONCLUSIVE ✓                             |
| G3          | MUTATION     |    5 | PASS 5 → PASS 5 ✓                                           | PASS 5 → PASS 5 ✓                                           | PASS 5 → PASS 5 ✓                                         | PASS 5 → PASS 5 ✓                                         |
| R-12        | HUMAN_REVIEW |   10 | INCONCLUSIVE → INCONCLUSIVE ✓                               | INCONCLUSIVE → INCONCLUSIVE ✓                               | INCONCLUSIVE → INCONCLUSIVE ✓                             | INCONCLUSIVE → INCONCLUSIVE ✓                             |
| R-10        | EXECUTION    |    6 | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                           | PASS 6 → PASS 6 ✓                                         | PASS 6 → PASS 6 ✓                                         |
| R-11        | STATIC       |    4 | PASS 4 → PASS 4 ✓                                           | PASS 4 → PASS 4 ✓                                           | PASS 4 → PASS 4 ✓                                         | PASS 4 → PASS 4 ✓                                         |
| 점수 표시   | -            |    - | 90~100/100 · 10점 검토 대기 → 90~100/100 · 10점 검토 대기 ✓ | 90~100/100 · 10점 검토 대기 → 90~100/100 · 10점 검토 대기 ✓ | 54~69/100 · 15점 검토 대기 → 54~69/100 · 15점 검토 대기 ✓ | 54~69/100 · 15점 검토 대기 → 54~69/100 · 15점 검토 대기 ✓ |
| 제출 테스트 | T-109        |    - | PASSED 49건/7파일 → PASSED 49건/7파일 ✓                     | PASSED 61건/7파일 → PASSED 61건/7파일 ✓                     | PASSED 11건/3파일 → PASSED 11건/3파일 ✓                   | PASSED 16건/4파일 → PASSED 16건/4파일 ✓                   |

## 불일치

없음

## 결정성

판정 digest = sha256(환경 digest, harnessVersion, rubric 버전, 고정 SHA, 저장 점수, 기준별 verdict·earnedPoints·issueId·reviewState·근거 수(LLM 추정 근거 제외), 단계 상태, 기동 결과, 하네스 케이스별 verdict·failureKind·expected·actual·checks, 제출 테스트 상태·개수·파일별 테스트 이름과 상태). 시각·소요 시간·포트·주문 id·레코드 ID는 제외한다.

| 샘플 | 1회차              | 2회차              | 3회차              | 동일  |
| ---- | ------------------ | ------------------ | ------------------ | ----- |
| A    | `b3e9ca7dcc8a7eca` | `b3e9ca7dcc8a7eca` | `b3e9ca7dcc8a7eca` | ✓     |
| B    | `5fef057cec569776` | -                  | -                  | (1회) |
| C    | `9ad4b24052e8d94b` | `9ad4b24052e8d94b` | `9ad4b24052e8d94b` | ✓     |
| D    | `2e2f90b96b00bc6f` | -                  | -                  | (1회) |

## 미지원 저장소

- 저장소: https://github.com/inchyangv/ohmyti-sample-python
- 제출 ID: `88a62f8b-2c97-4609-bcf9-0b90937c8fa9` · 상태: UNSUPPORTED
- 사유(API): `MISSING_PACKAGE_JSON: 루트에 package.json이 없습니다; UNSUPPORTED_LANGUAGE: TypeScript·JavaScript 소스가 없고 requirements.txt이(가) 있습니다. 템플릿은 Node.js 프로젝트만 지원합니다`
- 기대 사유 코드 `UNSUPPORTED_LANGUAGE`: API ✓ · 화면 HTML(`/submissions/<id>`) ✓
