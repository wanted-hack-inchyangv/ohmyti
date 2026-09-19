# @ohmyti/context

이력서·GitHub 맥락 연결 로직. 워커의 CONTEXT_LINK 단계만 쓴다. 채점 입력(`GradingInput`)과 채점 프롬프트에는 이 패키지의 결과가 들어가지 않는다 (G-10).

## 이력서 텍스트 추출 (T-501)

- `extractResumeText(bytes, limits?)`: PDF 바이트 → `EXTRACTED`(본문) | `IMAGE_ONLY`(텍스트 층 없음) | `NONE`(추출 불가 + 사유). 던지지 않는다.
  - 상한: 5 MiB, 20쪽(넘으면 파싱하지 않고 `RESUME_TOO_LARGE`·`RESUME_TOO_MANY_PAGES`), 추출 30초(`RESUME_EXTRACT_TIMEOUT`), 본문 100,000자(넘으면 자르고 `truncated`).
  - 공백을 뺀 글자가 40자 미만이면 `IMAGE_ONLY`(`RESUME_TEXT_NOT_FOUND`). OCR은 하지 않는다.
  - 사유 형식은 `<CODE>: <설명>`이며 본문을 담지 않는다.
- `runResumeExtraction({ db, store }, submissionId)`: `submission_context.resume_ref` → ArtifactStore → 추출 → `resume_text`·`resume_text_status`·`resume_text_reason`. 이력서가 없으면 쓰지 않는다. `MANUAL`(사람 입력)·`EXTRACTED`는 덮어쓰지 않는다. 반환값(`ResumeExtractionSummary`)에는 본문이 없으므로 그대로 로그에 남겨도 된다.
- 텍스트를 얻지 못한 이력서는 웹 제출 상태 화면(`/submissions/<id>`)에서 직접 입력해 `MANUAL`로 저장한다.

## GitHub 프로필 보충 조회 (T-502)

- `collectGitHubSources({ login, resumeText, jdText }, options)`: 공개 저장소 목록(최근 push 순 첫 100개, 포크·비공개 제외) → 이력서·JD 키워드와 저장소 이름·설명·토픽·주 언어의 토큰 겹침 점수로 최대 `MAX_PROFILE_REPOS`(기본 3, 1~10)개 선정. 동점은 최근 push → 이름 순. 던지지 않는다.
  - 키워드가 없으면(이력서 없음) 최근 push 순(`selection: RECENT_PUSH`). 키워드가 있는데 겹치는 저장소가 없으면 `NO_DATA`(`NO_RELATED_REPOS`).
  - 저장소별: README 앞 4 KiB(`application/vnd.github.raw+json`, 잘린 UTF-8 조각 제거), 언어, 최상위 파일(100개), 해당 사용자의 기본 브랜치 커밋 20개(`?author=`), 해당 사용자의 병합 PR 제목 10개(검색 API). 텍스트는 `maskSensitive`로 가린다.
  - **요청 수 상한: `1 + 5 × maxRepos`(기본 16)**. 상한에 닿거나 속도 제한(403 + `x-ratelimit-remaining: 0`·`retry-after`, 429)을 한 번 받으면 더 보내지 않는다.
  - 상태: `COLLECTED` / `PARTIAL`(일부 항목 `missing`) / `NO_DATA`. 사유는 `<CODE>: <설명>`이며 코드는 `NO_PROFILE`·`PROFILE_NOT_FOUND`·`RATE_LIMITED`·`GITHUB_UNAVAILABLE`·`NO_PUBLIC_REPOS`·`NO_RELATED_REPOS`·`REQUEST_LIMIT_REACHED`.
  - 스타·팔로워·포크 수는 읽지 않는다. 결과 스키마(`GitHubSourcesSchema`, `@ohmyti/core`)는 모든 객체가 strict다.
- `runGitHubSourcesCollection({ db, collect }, submissionId)`: `submission_context.github_login`·이력서 텍스트(EXTRACTED·MANUAL) → 수집 → `submission_context.github_sources`. 기록이 이미 있으면 다시 조회하지 않는다(일시적 실패 `RATE_LIMITED`·`GITHUB_UNAVAILABLE`로 끝난 NO_DATA만 다시 조회). 반환 요약(`GitHubSourcesSummary`)에는 README·커밋 본문이 없다.
- 워커는 CONTEXT_LINK 단계에서 이력서 추출 다음에 호출한다. 실패해도 파이프라인은 계속된다.

```bash
pnpm --filter @ohmyti/context test -- github
```

## 맥락 연결과 후속 질문 (T-503)

- `runContextLinkStage({ submissionId, evaluationId, criteria }, { db, llm })`: 이력서 텍스트(EXTRACTED·MANUAL) + GitHub 소스 + 과제 관측(기준 ID·판정·관측 문장, `listCriterionObservations`) → LLM(`CONTEXT_LINK`) → 후처리 → `context_links`를 이 결과로 바꾼다(`replaceContextLinks`, 제출 단위). 단계 기록에는 `ContextLinkSummary`(개수·상태별 수·미평가 영역·버린 항목 코드)만 남기고 claim·이력서 문장은 넣지 않는다.
  - 이력서가 없으면 LLM을 부르지 않고 `SYSTEM` 출처의 `NO_DATA "이력서 미제공"` 연결 하나만 저장한다.
  - 예산 초과·설정 오류·설정 없음·결과 미확정은 연결 없이 단계 DONE + 사유(`LLM 미실행(예산 초과)` 등)다.
- 후처리(`postprocessContextLinks`, 결정적):
  - claim은 이력서 본문의 인용이어야 한다(글자·숫자만 남긴 정규화 비교, 6자 이상). README·커밋·관측 문장은 버린다(`CLAIM_NOT_IN_RESUME`). 같은 claim은 처음 것만 남긴다.
  - 근거 URL은 수집한 저장소 페이지·커밋·병합 PR URL만 받는다. 모르는 URL은 근거만 뗀다. 기준 ID는 판정에 있는 것만 받고, 관측 문장은 LLM 문장 대신 저장된 관측을 쓴다.
  - `EVIDENCE_FOUND`는 검증된 GitHub 근거가 있을 때만이다. 없으면 `NEEDS_CHECK`로 낮춘다.
  - 근거 요약·후속 질문·미평가 영역에 금지 표현(거짓·허위·과장·진위·AI 작성·기여율·합격·탈락·순위 등, `CONTEXT_FORBIDDEN_EXPRESSIONS`)이 있으면 그 항목을 버린다.
- 점수 격리: 출력 스키마에 점수·판정 키가 없다. `pnpm context:isolation-check`(`scripts/check-context-isolation.ts`)가 이 단계의 파일(`context-link.ts`, `@ohmyti/db`의 `context-links.ts`, 워커 `pipeline/context-link.ts`)이 판정 행의 점수 열·평가 행·점수 식별자를 참조하지 않는지 AST로 검사한다.
- 실제 LLM 1회 실행: `pnpm --filter @ohmyti/worker exec tsx src/context-link/cli.ts [a|b|c|d] [--resume <텍스트 파일>] [--github <login>] [--out <result.json>]`

```bash
pnpm --filter @ohmyti/context test -- context-link
```

## 테스트 픽스처

`@ohmyti/context/testing`의 `buildTextPdf`·`buildImageOnlyPdf`가 외부 도구 없이 결정적인 PDF를 만든다. `fakeGitHubProfileApi`는 인기도 필드를 섞은 가짜 GitHub 응답을 돌려주고 받은 요청을 기록한다. 커밋한 `fixtures/*.pdf`는 이 빌더의 출력과 같아야 한다 (`fixtures/README.md`).

```bash
pnpm --filter @ohmyti/context test -- resume
```
