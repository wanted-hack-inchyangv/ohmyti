# 데모 리허설 기록 (T-907, 9단계 플로우)

`pnpm demo:rehearsal`이 `docs/demo.md`의 대본을 순서대로 열어 남긴 데스크톱(1600px)·모바일(390px) 스크린샷과 문구 확인 결과다. 저장된 실행만 열고 아무것도 바꾸지 않는다. 화면이 PRD 7장 표와 같은지와 대본 진행은 사람이 확인한다(아래 체크리스트).

- 대상: https://ohmyti.vercel.app
- 실행: 2026-09-20T13:26:18.011Z
- 샘플 C 저장된 평가: `c57780c6-4948-4fae-9a31-c6500c16d468`
- 자동 문구 확인: 모두 통과

| 구간        | 화면                   | 경로                                                                           | HTTP | 로드 | 기대 문구 | 데스크톱                                                                   | 모바일                                                                   |
| ----------- | ---------------------- | ------------------------------------------------------------------------------ | ---: | ---: | --------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 도입        | 01-home                | `/`                                                                            |  200 | 0.8s | ✓         | [01-home-desktop.png](./01-home-desktop.png)                               | [01-home-mobile.png](./01-home-mobile.png)                               |
| 샘플 이해   | 02-demo                | `/demo`                                                                        |  200 | 1.3s | ✓         | [02-demo-desktop.png](./02-demo-desktop.png)                               | [02-demo-mobile.png](./02-demo-mobile.png)                               |
| 워크벤치    | 03-workbench-r05       | `/evaluations/c57780c6-4948-4fae-9a31-c6500c16d468?criterion=R-05`             |  200 | 1.9s | ✓         | [03-workbench-r05-desktop.png](./03-workbench-r05-desktop.png)             | [03-workbench-r05-mobile.png](./03-workbench-r05-mobile.png)             |
| 워크벤치    | 04-mutation-m01        | `/evaluations/c57780c6-4948-4fae-9a31-c6500c16d468?criterion=G1&mutation=M-01` |  200 | 2.4s | ✓         | [04-mutation-m01-desktop.png](./04-mutation-m01-desktop.png)               | [04-mutation-m01-mobile.png](./04-mutation-m01-mobile.png)               |
| 채점 요청   | 05-submission-sample-c | `/submissions/new?sample=C`                                                    |  200 | 1.2s | ✓         | [05-submission-sample-c-desktop.png](./05-submission-sample-c-desktop.png) | [05-submission-sample-c-mobile.png](./05-submission-sample-c-mobile.png) |
| 채점 요청   | 06-submission-persona  | `/submissions/new?persona=dohyun`                                              |  200 | 1.2s | ✓         | [06-submission-persona-desktop.png](./06-submission-persona-desktop.png)   | [06-submission-persona-mobile.png](./06-submission-persona-mobile.png)   |
| 과제 만들기 | 07-assignment-example  | `/assignments/new`                                                             |  200 | 1.3s | ✓         | [07-assignment-example-desktop.png](./07-assignment-example-desktop.png)   | [07-assignment-example-mobile.png](./07-assignment-example-mobile.png)   |

## 사람 확인

- [ ] 리허설 진행자·일시:
- [ ] 화면이 `docs/demo.md`의 기대 화면(PRD 7장 표)과 같다
- [ ] 90초 대본을 90초 안에, 3분 확장 대본을 3분 안에 설명했다 (실제 소요: 초 / 초)
- [ ] 모바일(390px)에서 가로 스크롤이나 잘린 카드가 없다
- [ ] 화면에 홍보 수치·실시간 성공 표현·가짜 진행률이 없다
