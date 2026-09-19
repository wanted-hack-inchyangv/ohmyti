# 90초 데모 리허설 기록 (T-507)

`pnpm demo:rehearsal`이 `docs/demo.md` 구간별 화면 표를 순서대로 열어 남긴 스크린샷과 문구 확인 결과다. 저장된 실행만 열고 아무것도 바꾸지 않는다. 화면이 PRD 7장 표와 같은지와 90초 진행은 사람이 확인한다(아래 체크리스트).

- 대상: https://ohmyti.vercel.app
- 실행: 2026-09-18T22:16:10.173Z
- 샘플 C 저장된 평가: `07ab5b96-a1cb-4540-be8b-73d8c4bc412c`
- 자동 문구 확인: 모두 통과

| 구간    | 화면                   | 경로                                                                                                                  | HTTP | 로드 | 기대 문구 | 스크린샷                                                   |
| ------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ---: | ---: | --------- | ---------------------------------------------------------- |
| 0~15초  | 01-submission-form     | `/submissions/new`                                                                                                    |  200 | 1.4s | ✓         | [01-submission-form.png](./01-submission-form.png)         |
| 0~15초  | 02-demo                | `/demo`                                                                                                               |  200 | 0.8s | ✓         | [02-demo.png](./02-demo.png)                               |
| 15~40초 | 03-workbench-c         | `/evaluations/07ab5b96-a1cb-4540-be8b-73d8c4bc412c`                                                                   |  200 | 1.2s | ✓         | [03-workbench-c.png](./03-workbench-c.png)                 |
| 15~40초 | 04-r05-failure         | `/evaluations/07ab5b96-a1cb-4540-be8b-73d8c4bc412c?criterion=R-05`                                                    |  200 | 1.7s | ✓         | [04-r05-failure.png](./04-r05-failure.png)                 |
| 40~60초 | 05-r05-replay          | `/evaluations/07ab5b96-a1cb-4540-be8b-73d8c4bc412c?criterion=R-05&run=8ddab771-4476-4d48-acd0-8525195378f4`           |  200 | 1.7s | ✓         | [05-r05-replay.png](./05-r05-replay.png)                   |
| 40~60초 | 06-code-evidence       | `/evaluations/07ab5b96-a1cb-4540-be8b-73d8c4bc412c?criterion=R-05&run=8ddab771-4476-4d48-acd0-8525195378f4&pane=code` |  200 | 1.2s | ✓         | [06-code-evidence.png](./06-code-evidence.png)             |
| 60~75초 | 07-mutation-m01        | `/evaluations/07ab5b96-a1cb-4540-be8b-73d8c4bc412c?criterion=G1&mutation=M-01`                                        |  200 | 1.8s | ✓         | [07-mutation-m01.png](./07-mutation-m01.png)               |
| 75~90초 | 08-resume-links        | `/evaluations/07ab5b96-a1cb-4540-be8b-73d8c4bc412c?tab=resume`                                                        |  200 | 1.0s | ✓         | [08-resume-links.png](./08-resume-links.png)               |
| 75~90초 | 09-follow-up-questions | `/evaluations/07ab5b96-a1cb-4540-be8b-73d8c4bc412c?tab=questions`                                                     |  200 | 1.1s | ✓         | [09-follow-up-questions.png](./09-follow-up-questions.png) |
| 75~90초 | 10-r12-review          | `/evaluations/07ab5b96-a1cb-4540-be8b-73d8c4bc412c?criterion=R-12`                                                    |  200 | 1.0s | ✓         | [10-r12-review.png](./10-r12-review.png)                   |

## 사람 확인

- [ ] 리허설 진행자·일시:
- [ ] 구간별 화면이 `docs/demo.md` 기대 화면(PRD 7장 표)과 같다
- [ ] 다섯 구간을 90초 안에 설명했다 (실제 소요: 초)
- [ ] 화면에 홍보 수치나 실시간 성공 표현이 없다
