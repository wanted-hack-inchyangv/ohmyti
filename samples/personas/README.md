# samples/personas

ohmyti(CodeGraph Reviewer)를 시험하기 위해 만든 가상 지원자 페르소나 자료 모음이다. 이 디렉터리의 이름, 이력서, 경력, 저장소는 모두 이 프로젝트를 위해 지어낸 것이며 실존하는 인물이나 회사와 관련이 없다.

## 명명 규칙과 디렉터리 구조

- 핸들: 영문 소문자 이름 (`seojin`, `taeyun`, `gaeun`, `dohyun`).
- 디렉터리: `samples/personas/<핸들>/` 아래에 `persona.md`(페르소나 정의 및 실제 제출 결과), `resume.html`(이력서 원본), `resume.pdf`(채점에 쓰는 이력서 파일)를 둔다.
- 저장소 이름: `<핸들>-<프로젝트>` 형식이다. 과제 제출물 저장소는 `<핸들>-order-api`이고, 포트폴리오 저장소는 `<핸들>-<프로젝트명>`이다. 모든 저장소는 GitHub 조직 https://github.com/wanted-hack-inchyangv 아래에 있다.
- 세 페르소나(한서진·오태윤·문가은)는 같은 조직 프로필 하나(https://github.com/wanted-hack-inchyangv)를 GitHub 프로필 URL로 공유한다. 자세한 영향은 "알려진 한계"를 참고한다.

## 페르소나 요약

| 핸들     | 수준   | 과제 제출물                                                                     | 포트폴리오 저장소                                                                                                                                                                            | 기대 판정 요약                                                        | 실제 점수                   | 문서                            |
| -------- | ------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------- | ------------------------------- |
| `seojin` | 시니어 | [`seojin-order-api`](https://github.com/wanted-hack-inchyangv/seojin-order-api) | [`seojin-stock-reservation`](https://github.com/wanted-hack-inchyangv/seojin-stock-reservation), [`seojin-idempotency-kit`](https://github.com/wanted-hack-inchyangv/seojin-idempotency-kit) | R-01 ~ R-10 전부 PASS, 결함 없음                                      | 90~100/100 (10점 검토 대기) | [persona.md](seojin/persona.md) |
| `taeyun` | 주니어 | [`taeyun-order-api`](https://github.com/wanted-hack-inchyangv/taeyun-order-api) | [`taeyun-room-booking`](https://github.com/wanted-hack-inchyangv/taeyun-room-booking), [`taeyun-til-cli`](https://github.com/wanted-hack-inchyangv/taeyun-til-cli)                           | R-06·R-07만 FAIL(멱등 키 충돌, 동시 요청), 나머지 PASS                | 78~88/100 (10점 검토 대기)  | [persona.md](taeyun/persona.md) |
| `gaeun`  | 신입   | [`gaeun-order-api`](https://github.com/wanted-hack-inchyangv/gaeun-order-api)   | [`gaeun-todo-react`](https://github.com/wanted-hack-inchyangv/gaeun-todo-react), [`gaeun-bookmark-api`](https://github.com/wanted-hack-inchyangv/gaeun-bookmark-api)                         | R-04·R-05·R-06·R-07·R-09 FAIL(입력 검증, 멱등성 전체, 재고 복구 누락) | 37~57/100 (20점 검토 대기)  | [persona.md](gaeun/persona.md)  |
| `dohyun` | 미들   | 제작 중                                                                         | 제작 중                                                                                                                                                                                      | 제작 중(실행 기준은 통과하지만 코드 품질이 낮은 유형으로 설계 예정)   | 제작 중                     | 제작 중                         |

## 사용 방법

1. https://ohmyti.vercel.app/submissions/new 를 연다.
2. "채용 과제"에서 이 세 페르소나가 공통으로 쓰는 과제 버전을 선택한다.
3. "과제 저장소 URL"에 해당 페르소나의 과제 제출물 저장소(예: `https://github.com/wanted-hack-inchyangv/seojin-order-api`)를 입력한다.
4. "커밋 SHA"에는 해당 페르소나 `persona.md`의 "입력값" 표에 있는 커밋 SHA를 입력한다. 비워 두면 입력 시점의 HEAD가 고정된다.
5. "이력서 (PDF)"에 해당 페르소나의 `resume.pdf`를 업로드한다.
6. "GitHub 프로필 URL"에 `https://github.com/wanted-hack-inchyangv`를 입력한다.
7. "분석 및 채점"을 누르면 제출이 저장되고 워커가 격리 환경에서 채점과 맥락 연결을 진행한다.

## 실제 제출 결과 요약

세 페르소나 모두 2026-09-19 12:38 ~ 12:46 UTC 구간에 https://ohmyti.vercel.app 에서 채점 기준 `v2-be07fb44`(로컬 `rubric.v1.json`과 동일한 구성)로 제출, 평가를 마쳤다. 평가에 쓴 커밋은 과제 제출물 저장소 이름을 변경하기 전의 HEAD이며, 현재 HEAD와의 차이는 README 제목과 패키지 이름뿐이다.

- R-01 ~ R-11은 세 페르소나 모두 기대와 정확히 일치했다.
- G1 ~ G3(테스트 실효성): seojin과 taeyun은 전부 PASS였다. gaeun은 G1이 FAIL(제출 테스트가 결함을 놓침)이었고 G2·G3는 대상 기준이 이미 FAIL 상태라 변이를 적용할 수 없어 INCONCLUSIVE였다.
- R-12(설계·변경 용이성)는 세 페르소나 모두 사람의 검토 대기(INCONCLUSIVE)로 남았다.
- 이력서 주장 맥락 연결: seojin과 gaeun은 핵심 주장 3가지가 모두 기대와 일치했다. taeyun은 "결제 웹훅 멱등 처리" 주장이 기대(자료 없음)와 달리 추가 확인 필요로, "팀 생산성 CLI" 주장이 기대(추가 확인 필요)와 달리 관련 근거 확인으로 분류되었다. gaeun의 "동시성 제어와 멱등성 설계 경험" 주장과 taeyun의 "결제 웹훅 멱등 처리" 주장에는 기대대로 후속 질문이 생성되었다.
- gaeun의 평가에서는 LLM 리뷰 작성(REVIEW_WRITE) 단계가 출력 스키마 검증에 2회 실패해 미확정으로 처리되었고, AI 리뷰 제안과 R-12 설계 초안이 생성되지 않았다. 점수에는 영향이 없었다.
- 각 페르소나의 세부 결과(워크벤치 URL, GitHub 근거 선정, 후속 질문 요지 등)는 각자의 `persona.md` "실제 제출 결과" 절에 있다.

## 알려진 한계

- **조직 프로필 공유로 인한 교차 선택**: 세 페르소나가 GitHub 프로필 URL로 같은 조직 프로필(https://github.com/wanted-hack-inchyangv)을 공유하기 때문에, 맥락 연결 단계의 GitHub 근거 선정에서 다른 페르소나의 저장소가 상위 3개 안에 들 수 있다. 실제로 taeyun의 평가에서는 gaeun의 `gaeun-bookmark-api`가, gaeun의 평가에서는 한서진의 과제 제출물이 근거로 선택되었다.
- **조직 로그인으로는 커밋 작성자 필터가 비어 있게 된다**: GitHub 근거 수집은 GitHub API의 `author=<login>` 파라미터로 그 프로필 로그인이 작성한 최근 커밋과 병합된 PR만 가져온다. 그런데 각 페르소나의 실제 커밋은 페르소나별 가상 이메일(예: `seojin.han@example.com`)로 작성되어 있어 조직 계정(`wanted-hack-inchyangv`)의 GitHub 로그인과 연결되어 있지 않다. 그 결과 실제 제출 3건 모두 모든 후보 저장소에서 최근 커밋 0개, 병합 PR 0개로 수집되었고, 저장소 선정은 README·설명 텍스트의 키워드 중복도에만 의존했다.
