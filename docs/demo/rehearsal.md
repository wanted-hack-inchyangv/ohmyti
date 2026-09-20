# 90초 데모 리허설 기록 (T-507)

`pnpm demo:rehearsal`이 `docs/demo.md` 구간별 화면 표를 순서대로 열어 남긴 스크린샷과 문구 확인 결과다. 저장된 실행만 열고 아무것도 바꾸지 않는다. 화면이 PRD 7장 표와 같은지와 90초 진행은 사람이 확인한다(아래 체크리스트).

- 대상: https://ohmyti.vercel.app
- 실행: 2026-09-20T02:01:06.201Z
- 샘플 C 저장된 평가: `0c1f61dd-5b58-432c-9cbb-218945d1447a`
- 자동 문구 확인: 모두 통과

| 구간    | 화면               | 경로                                                                                                                  | HTTP | 로드 | 기대 문구 | 스크린샷                                           |
| ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- | ---: | ---: | --------- | -------------------------------------------------- |
| 0~15초  | 01-submission-form | `/submissions/new`                                                                                                    |  200 | 0.9s | ✓         | [01-submission-form.png](./01-submission-form.png) |
| 0~15초  | 02-demo            | `/demo`                                                                                                               |  200 | 0.8s | ✓         | [02-demo.png](./02-demo.png)                       |
| 15~40초 | 03-workbench-c     | `/evaluations/0c1f61dd-5b58-432c-9cbb-218945d1447a`                                                                   |  200 | 1.9s | ✓         | [03-workbench-c.png](./03-workbench-c.png)         |
| 15~40초 | 04-r05-failure     | `/evaluations/0c1f61dd-5b58-432c-9cbb-218945d1447a?criterion=R-05`                                                    |  200 | 1.8s | ✓         | [04-r05-failure.png](./04-r05-failure.png)         |
| 40~60초 | 05-r05-replay      | `/evaluations/0c1f61dd-5b58-432c-9cbb-218945d1447a?criterion=R-05&run=03bb7cb3-2fd3-41b9-abed-880b2408ef37`           |  200 | 3.3s | ✓         | [05-r05-replay.png](./05-r05-replay.png)           |
| 40~60초 | 06-code-evidence   | `/evaluations/0c1f61dd-5b58-432c-9cbb-218945d1447a?criterion=R-05&run=03bb7cb3-2fd3-41b9-abed-880b2408ef37&pane=code` |  200 | 1.5s | ✓         | [06-code-evidence.png](./06-code-evidence.png)     |
| 60~75초 | 07-mutation-m01    | `/evaluations/0c1f61dd-5b58-432c-9cbb-218945d1447a?criterion=G1&mutation=M-01`                                        |  200 | 2.1s | ✓         | [07-mutation-m01.png](./07-mutation-m01.png)       |
| 75~90초 | 08-hiring-report   | `/evaluations/0c1f61dd-5b58-432c-9cbb-218945d1447a/report`                                                            |  200 | 1.7s | ✓         | [08-hiring-report.png](./08-hiring-report.png)     |
| 75~90초 | 09-interview-kit   | `/evaluations/0c1f61dd-5b58-432c-9cbb-218945d1447a/interview-kit`                                                     |  200 | 1.3s | ✓         | [09-interview-kit.png](./09-interview-kit.png)     |
| 75~90초 | 10-resume-links    | `/evaluations/0c1f61dd-5b58-432c-9cbb-218945d1447a?tab=resume`                                                        |  200 | 1.5s | ✓         | [10-resume-links.png](./10-resume-links.png)       |

## 사람 확인

- [ ] 리허설 진행자·일시:
- [ ] 구간별 화면이 `docs/demo.md` 기대 화면(PRD 7장 표)과 같다
- [ ] 다섯 구간을 90초 안에 설명했다 (실제 소요: 초)
- [ ] 화면에 홍보 수치나 실시간 성공 표현이 없다
