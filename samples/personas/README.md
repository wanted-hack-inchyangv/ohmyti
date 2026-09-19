# samples/personas

ohmyti(CodeGraph Reviewer)를 시험하기 위해 만든 가상 지원자 페르소나 자료 모음이다. 이 디렉터리의 이름, 이력서, 경력, 저장소는 모두 이 프로젝트를 위해 지어낸 것이며 실존하는 인물이나 회사와 관련이 없다.

## 명명 규칙과 디렉터리 구조

- 핸들: 영문 소문자 이름 (`seojin`, `taeyun`, `gaeun`, `dohyun`).
- 디렉터리: `samples/personas/<핸들>/` 아래에 `persona.md`(페르소나 정의 및 실제 제출 결과), `resume.html`(이력서 원본), `resume.pdf`(채점에 쓰는 이력서 파일)를 둔다.
- 저장소 이름: `<핸들>-<프로젝트>` 형식이다. 과제 제출물 저장소는 `<핸들>-order-api`이고, 포트폴리오 저장소는 `<핸들>-<프로젝트명>`이다. 모든 저장소는 GitHub 조직 https://github.com/wanted-hack-inchyangv 아래에 있다.
- 네 페르소나(한서진·오태윤·문가은·백도현)는 같은 조직 프로필 하나(https://github.com/wanted-hack-inchyangv)를 GitHub 프로필 URL로 공유한다. 자세한 영향은 "알려진 한계"를 참고한다.

## 페르소나 요약

| 핸들     | 수준   | 과제 제출물                                                                     | 포트폴리오 저장소                                                                                                                                                                            | 기대 판정 요약                                                        | 실제 점수                   | 문서                            |
| -------- | ------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------- | ------------------------------- |
| `seojin` | 시니어 | [`seojin-order-api`](https://github.com/wanted-hack-inchyangv/seojin-order-api) | [`seojin-stock-reservation`](https://github.com/wanted-hack-inchyangv/seojin-stock-reservation), [`seojin-idempotency-kit`](https://github.com/wanted-hack-inchyangv/seojin-idempotency-kit) | R-01 ~ R-10 전부 PASS, 결함 없음                                      | 90~100/100 (10점 검토 대기) | [persona.md](seojin/persona.md) |
| `taeyun` | 주니어 | [`taeyun-order-api`](https://github.com/wanted-hack-inchyangv/taeyun-order-api) | [`taeyun-room-booking`](https://github.com/wanted-hack-inchyangv/taeyun-room-booking), [`taeyun-til-cli`](https://github.com/wanted-hack-inchyangv/taeyun-til-cli)                           | R-06·R-07만 FAIL(멱등 키 충돌, 동시 요청), 나머지 PASS                | 78~88/100 (10점 검토 대기)  | [persona.md](taeyun/persona.md) |
| `gaeun`  | 신입   | [`gaeun-order-api`](https://github.com/wanted-hack-inchyangv/gaeun-order-api)   | [`gaeun-todo-react`](https://github.com/wanted-hack-inchyangv/gaeun-todo-react), [`gaeun-bookmark-api`](https://github.com/wanted-hack-inchyangv/gaeun-bookmark-api)                         | R-04·R-05·R-06·R-07·R-09 FAIL(입력 검증, 멱등성 전체, 재고 복구 누락) | 37~57/100 (20점 검토 대기)  | [persona.md](gaeun/persona.md)  |
| `dohyun` | 미들   | [`dohyun-order-api`](https://github.com/wanted-hack-inchyangv/dohyun-order-api) | [`dohyun-board-api`](https://github.com/wanted-hack-inchyangv/dohyun-board-api), [`dohyun-report-batch`](https://github.com/wanted-hack-inchyangv/dohyun-report-batch)                       | R-01 ~ R-11 전부 PASS, G1 ~ G3은 테스트가 결함을 잡지 못해 FAIL       | 75~85/100 (10점 검토 대기)  | [persona.md](dohyun/persona.md) |

## 사용 방법

1. https://ohmyti.vercel.app/submissions/new 를 연다.
2. "채용 과제"에서 이 네 페르소나가 공통으로 쓰는 과제 버전을 선택한다.
3. "과제 저장소 URL"에 그 페르소나의 과제 제출물 저장소(예: `https://github.com/wanted-hack-inchyangv/seojin-order-api`)를 입력한다.
4. "커밋 SHA"에는 그 페르소나 `persona.md`의 "입력값" 표에 있는 커밋 SHA를 입력한다. 비워 두면 입력 시점의 HEAD가 고정된다.
5. "이력서 (PDF)"에 그 페르소나의 `resume.pdf`를 업로드한다.
6. "GitHub 프로필 URL"에 `https://github.com/wanted-hack-inchyangv`를 입력한다.
7. "분석 및 채점"을 누르면 제출이 저장되고 워커가 격리 환경에서 채점과 맥락 연결을 진행한다.

## 실제 제출 결과 요약

2026-09-19 17:08 UTC에 6단계(T-601 ~ T-605) 수정을 배포한 뒤, `pnpm gate:personas`가 네 페르소나를 https://ohmyti.vercel.app 의 웹 제출 폼으로 현재 HEAD SHA와 함께 제출했다(채점 기준 `v2-be07fb44`). 결과는 조회 API로 읽어 `expected-matrix.json`과 대조했고, 불일치는 0건이었다. 전체 대조 기록은 [`docs/gates/personas.md`](../../docs/gates/personas.md)에 있다.

- 기준별 판정(R-01 ~ R-11, G1 ~ G3)과 점수 표시는 네 페르소나 모두 기대값과 일치했다. dohyun은 변이 M-01 ~ M-05가 모두 적용되어 SURVIVED였고 G1·G2·G3가 모두 FAIL이다. 이전 제출에서는 M-03·M-05가 적용되지 않아 G3가 INCONCLUSIVE였다.
- REVIEW_WRITE는 네 페르소나 모두 정상 완료(`llm: OK`)되었고 R-12 AI 초안이 생성되었다. 잠정 점수는 seojin 9/10, taeyun 7/10, gaeun 3/10, dohyun 3/10이다. gaeun은 이전 제출에서 출력 스키마 검증 실패로 초안이 없었다.
- GitHub 근거: 네 페르소나 모두 이력서에 적힌 본인 포트폴리오 저장소 2개가 선택되었고, 제출 저장소와 다른 페르소나의 저장소는 선택되지 않았다. 선택된 저장소마다 커밋이 8 ~ 16개 수집되었다.
- 후속 질문: taeyun의 결제 웹훅 멱등 처리 주장, gaeun의 동시성 제어·멱등성 설계 주장, dohyun의 클린 아키텍처·TDD 주장에 기대대로 후속 질문이 생성되었다.
- 주장 상태 라벨은 LLM 판단이라 경고로만 기록한다. taeyun의 웹훅 주장(기대 자료 없음 → 추가 확인 필요)과 CLI 주장(기대 추가 확인 필요 → 관련 근거 확인), dohyun의 SI 납기 주장(기대 관련 근거 확인 → 추가 확인 필요)과 TDD 주장(기대 자료 없음 → 관련 근거 확인)이 기대와 달랐다.
- 각 페르소나의 세부 결과(워크벤치 URL, R-12 초안 근거, 후속 질문 요지, 이전 제출 링크)는 각자의 `persona.md` "실제 제출 결과" 절에 있다. 2026-09-19 12:38 ~ 13:17 UTC의 이전 제출 4건은 삭제하지 않고 남겨 두었다.

## 알려진 한계

- **스키마 경계의 수량 하한**: seojin은 수량 하한을 zod 스키마 `min(1)`로 검증한다. 변이 M-02는 비교식(`<= 0`)을 찾아 바꾸는 방식이라 이 구조에서는 대상이 없어 NOT_APPLICABLE이다. G1은 M-01 KILLED로 PASS이므로 판정과 점수는 설계와 같다.
- **바쁜 대기는 R-12 초안 문장에 드러나지 않을 수 있다**: dohyun의 폴링 기반 전역 락(`lockit`/`unlockit`)은 워크벤치의 코드 신호 목록에 "바쁜 대기 1곳"으로 나타나지만, LLM이 쓴 R-12 초안 문장은 `any` 12곳과 strict 꺼짐만 언급했다. 코드 신호는 판정·점수에 쓰지 않는 참고 사실이다.
- **조직 프로필 공유**: 네 페르소나는 같은 조직 프로필(https://github.com/wanted-hack-inchyangv)을 공유한다. T-603 이후 이력서에 적힌 저장소 링크를 우선 선정하고 제출 저장소를 제외하므로, 이전 제출에서 나타났던 다른 페르소나 저장소의 교차 선택은 이번 제출에서 나타나지 않았다. 이력서에 저장소 링크가 없는 지원자는 여전히 키워드 중복도로 선정된다.
- **조직 프로필의 커밋 수집**: 각 페르소나의 커밋은 가상 이메일로 작성되어 조직 계정의 GitHub 로그인과 연결되어 있지 않다. T-604 이후 조직 프로필은 작성자 조건 없이 커밋을 수집하고 근거 표에 작성자 조건 `NONE`으로 표시한다. 따라서 수집된 커밋이 지원자 본인의 커밋이라는 보장은 없다.
