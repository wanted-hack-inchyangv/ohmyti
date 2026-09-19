# 2단계 게이트: 배포 환경 E2E (T-208)

`pnpm gate:phase2`가 만든 기록이다. Vercel 웹(`POST /api/submissions`)에 샘플 A/B/C/D의 공개 GitHub 저장소 URL과 커밋 SHA를 제출하고, Railway 워커가 채점한 결과를 조회 API(T-207)로 읽어 `samples/order-api/expected-matrix.json`과 대조한다. 같은 샘플을 여러 번 제출해 판정 digest가 같은지, 미지원 저장소가 사유와 함께 거절되는지도 확인한다.

- 결과: **통과**
- 배포: https://ohmyti.vercel.app
- 기대값 기준: 5단계 배포 (단계 상태 REPO_CHECK DONE · ENV_PREP DONE · REQUIREMENT_VERIFY DONE · TEST_EFFECTIVENESS DONE · REVIEW_WRITE DONE · CONTEXT_LINK DONE) (`--phase 5`)
- 실행 일시: 2026-09-18T23:12:52.399Z ~ 2026-09-18T23:32:14.346Z (총 19.4분)
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
| A    |    1 | `54628277-c794-419a-b34c-b1c65fabfe12` | `46a50bd3-4060-4c24-926f-c1c96d6880f9` | COMPLETED |      156s |      0 | `b3e9ca7dcc8a7eca` |
| B    |    1 | `cec1d2e0-e65b-4aea-b0cb-5773fea6897e` | `b3d8cce3-c254-4a1b-8040-16cf1d5a2f45` | COMPLETED |      308s |      0 | `5fef057cec569776` |
| C    |    1 | `730e2d65-b7f1-4213-ae12-9e2051e2436d` | `52a94438-6567-4466-b236-afb5a5def283` | COMPLETED |      432s |      0 | `9ad4b24052e8d94b` |
| D    |    1 | `91731cc9-cc1c-4c0c-8c88-65d863e4dd7d` | `1027e1da-19f8-42e3-8847-f5f9fdc978bd` | COMPLETED |      555s |      0 | `2e2f90b96b00bc6f` |
| A    |    2 | `8720809d-913e-4562-a837-f0c63aa7f4f2` | `ce721ec7-6256-4172-809e-7f2edeae2772` | COMPLETED |      710s |      0 | `b3e9ca7dcc8a7eca` |
| C    |    2 | `36fd4cd3-fb87-4799-a36c-7596aac381ec` | `f922a124-8065-4acc-9e0e-6dd7fb645c92` | COMPLETED |      830s |      0 | `9ad4b24052e8d94b` |
| A    |    3 | `05183547-f6b6-41d9-a72b-6c64da3afecc` | `1565e12a-9858-4e92-97cc-f3e7b1182b2d` | COMPLETED |     1013s |      0 | `b3e9ca7dcc8a7eca` |
| C    |    3 | `8061dbbe-6369-4feb-a04a-1db26b0a00d9` | `fed3a35f-e18a-46f5-b8b1-d24b8f32d5d5` | COMPLETED |     1144s |      0 | `9ad4b24052e8d94b` |

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
- 제출 ID: `f6ecff8b-5492-496f-8c7b-a9c2e2181ed0` · 상태: UNSUPPORTED
- 사유(API): `MISSING_PACKAGE_JSON: 루트에 package.json이 없습니다; UNSUPPORTED_LANGUAGE: TypeScript·JavaScript 소스가 없고 requirements.txt이(가) 있습니다. 템플릿은 Node.js 프로젝트만 지원합니다`
- 기대 사유 코드 `UNSUPPORTED_LANGUAGE`: API ✓ · 화면 HTML(`/submissions/<id>`) ✓
