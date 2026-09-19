# ohmyti · CodeGraph Reviewer

과제 제출물을 격리 환경에서 실행해 요구사항을 판정하고, 실패를 재생하며, 코드 근거를 보여 주는 리뷰 도구의 MVP입니다.

## 구조

```
apps/web/          Next.js UI (Vercel). 제출 코드를 실행하지 않는다
apps/worker/       평가 워커 (Railway). 유일한 실행 주체
packages/core/     도메인 타입, zod 스키마, 점수 집계, 상태 머신, 마스킹
packages/db/       Drizzle 스키마, 마이그레이션, 큐 쿼리
packages/storage/  ArtifactStore (fs, vercel-blob)
packages/harness/  신뢰 하네스: 공통 HTTP 테스트
packages/runner/   SandboxRunner (local-process, vercel-sandbox)
packages/analysis/ TS AST 분석, 관련 함수 그래프, mutation 적용기
packages/llm/      LLM 어댑터 (deepseek, fake)
packages/context/  이력서·GitHub 맥락 연결 로직
samples/order-api/ 샘플 과제 명세(SPEC.md), 실행 계약, 채점 기준 v1, 기대 결과표, 제출물 샘플 impl-a(정답, Express)·impl-b(대안 정답, Hono + 이벤트 원장)·impl-c(결함, 멱등성 없음)·impl-d(적대적: C + README·주석 지시문, score.json, stdout PASS 문구, 항상 통과 테스트)
templates/order-api-ts/ 승인 실행 템플릿: 제출물이 쓸 수 있는 고정 의존성(package.json + package-lock.json + template.json)
docs/              배포·데모·게이트 문서
```

## 요구 도구

- Node.js 22 이상 (`.nvmrc`는 22)
- pnpm 10 (`packageManager` 필드로 고정, corepack 사용 가능)
- Docker (로컬 PostgreSQL)
- 샘플 평가의 LLM 단계(리뷰 작성·맥락 연결·mutation 위치 제안)를 실제로 돌리려면 DeepSeek API 키(`DEEP_SEEK_API_KEY`)

## 빠른 시작: 깨끗한 클론 → 로컬 스택 → 샘플 평가

아래 명령을 순서대로 실행하면 로컬 PostgreSQL, 워커, 웹이 뜨고 샘플 A/B/C/D가 실제 파이프라인으로 채점됩니다.

```bash
git clone https://github.com/inchyangv/ohmyti.git && cd ohmyti   # 비공개 저장소: 접근 권한이 필요하다
pnpm install --frozen-lockfile

# 1. PostgreSQL (Docker). 이미 ohmyti-pg가 있으면 `docker start ohmyti-pg`
docker run -d --name ohmyti-pg -e POSTGRES_USER=ohmyti -e POSTGRES_PASSWORD=ohmyti -e POSTGRES_DB=ohmyti -p 55440:5432 postgres:16-alpine

# 2. 환경변수: .env.example을 복사하고 아래 세 값을 채운다 (나머지는 기본값으로 동작)
cp .env.example .env.local
#   DATABASE_URL=postgresql://ohmyti:ohmyti@localhost:55440/ohmyti?sslmode=disable
#   DATABASE_URL_TEST=postgresql://ohmyti:ohmyti@localhost:55440/postgres
#   DEEP_SEEK_API_KEY=<키>        # 없으면 LLM 단계가 "LLM 미실행(설정 없음)"으로 기록되고 demo:seed의 ai_reviews 확인이 실패한다
pnpm env:check                   # .env.example이 환경변수 계약과 일치하는지 확인

# 3. 실행 템플릿 의존성과 DB
pnpm template:build              # templates/order-api-ts/node_modules 설치(npm ci). 워커가 제출물을 이 의존성으로 실행한다
pnpm db:migrate                  # 마이그레이션 적용 (여러 번 실행해도 안전)

# 4. 로컬 스택 (터미널 하나를 차지한다. Ctrl+C로 종료)
pnpm stack:local                 # db:migrate → db:seed:sample(샘플 과제 등록·승인) → 워커(:4320/healthz) → 웹(:4310)

# 5. 샘플 평가 (다른 터미널)
pnpm demo:seed                   # 샘플 A/B/C/D를 제출하고, 떠 있는 워커가 전체 파이프라인을 끝낼 때까지 기다린다 (처음에는 GitHub에서 공개 샘플 저장소를 수집)
```

5단계가 끝나면 샘플별 평가 ID·점수·실행 기록 수·mutation 실험 수·ai_reviews 행 수를 표로 출력하고 `demo:seed OK`로 끝납니다. 기대 점수는 A·B `90~100/100 · 10점 검토 대기`, C·D `54~69/100 · 15점 검토 대기`입니다(`samples/order-api/expected-matrix.json`의 `beforeHumanReview`). http://localhost:4310/demo 에서 저장된 실행을 열고, http://localhost:4310/submissions/new 에서 공개 저장소 URL을 직접 제출할 수도 있습니다. 로컬 `next dev`는 `APP_ACCESS_PASSWORD`를 비워 두면 접근 보호를 끕니다.

`.env`와 `.env.local`은 저장소 루트에 두며 커밋하지 않습니다. 워커·스크립트·테스트는 두 파일을 자동으로 읽고(`.env.local` 우선), `apps/web`은 Next.js 기본 동작을 따릅니다. `stack:local`은 웹과 워커가 같은 fs 스토어(`apps/web/.artifacts-e2e`)와 절대 경로 `TEMPLATE_ROOT`를 쓰도록 맞춰 줍니다.

웹과 워커를 따로 띄울 때:

```bash
pnpm db:seed:sample                # 샘플 과제 등록·승인 (docs/gates/phase1.json을 승인 근거로 쓴다)
pnpm --filter @ohmyti/web dev      # http://localhost:3000 (DB를 쓰는 화면은 DATABASE_URL을 apps/web/.env.local 또는 셸 환경에 둔다)
pnpm --filter @ohmyti/worker dev   # 워커 (TEMPLATE_ROOT는 절대 경로로 둔다. 상대 경로는 apps/worker 기준으로 풀린다)
```

## 환경변수

전체 목록과 설명은 `.env.example`에 있고 `pnpm env:check`가 목록을 검사합니다. 로컬에서 주로 쓰는 값은 다음과 같습니다.

| 변수                                                               | 사용처     | 설명                                                                                                 |
| ------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                     | web·worker | PostgreSQL 연결 문자열                                                                               |
| `DATABASE_URL_TEST`                                                | 테스트     | 통합 테스트가 임시 데이터베이스(`ohmyti_test_*`)를 만들 서버. CREATEDB 권한 필요                     |
| `ARTIFACT_STORE`, `ARTIFACT_FS_ROOT`                               | web·worker | `fs`(로컬) 또는 `blob`(Vercel Blob, `BLOB_READ_WRITE_TOKEN` 필요)                                    |
| `APP_ACCESS_PASSWORD`, `SESSION_SECRET`                            | web        | 단일 비밀번호 접근 보호. 개발 모드에서만 비워 둘 수 있다                                             |
| `DEMO_MODE`                                                        | web        | `true`일 때만 `/demo` 샘플 체험을 연다 (`stack:local`은 `true`로 띄운다)                             |
| `SANDBOX_RUNNER`, `TEMPLATE_ROOT`                                  | worker     | `local`(기본, LocalProcessRunner) 또는 `vercel`(Vercel Sandbox, `VERCEL_*` 필요). 템플릿 경로        |
| `RUN_TIMEOUT_MS`, `RUN_MEMORY_MB`, `HEALTH_TIMEOUT_MS`             | worker     | 실행 제한                                                                                            |
| `DEEP_SEEK_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL`                   | worker     | LLM(DeepSeek, OpenAI 호환). `LLM_PROVIDER=fake` + `LLM_FAKE_RESPONSES_FILE`로 고정 응답을 쓸 수 있다 |
| `LLM_MAX_CALLS_PER_EVALUATION`, `LLM_MAX_COST_USD_PER_EVALUATION`  | worker     | 평가 하나의 LLM 호출 수·비용 상한                                                                    |
| `GITHUB_TOKEN`                                                     | worker     | 선택. GitHub 공개 API 속도 제한 완화                                                                 |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, `WORKER_STALE_MS` | worker     | 작업 큐                                                                                              |

## 테스트·게이트 명령

```bash
pnpm typecheck   # 모든 패키지 + 루트 스크립트
pnpm lint        # ESLint (typescript-eslint, Next.js 규칙)
pnpm test        # Vitest (워크스페이스 프로젝트별 실행)
pnpm build       # Next.js 빌드 + 워커 번들(esbuild → apps/worker/dist)
pnpm e2e         # Playwright (E2E_PORT, 기본 4310에 dev 서버를 띄운다). chromium 프로젝트(워커 없음) 뒤에 stack 프로젝트(e2e/workbench-stack.spec.ts, T-308)가
                 # 워커를 띄워(E2E_WORKER_PORT 4320에 이미 있으면 재사용) 샘플 C 제출 → 감점 클릭 → 근거 → 재실행 → R-12 승인을 돌리고 test-results/phase3-screenshots/에 스크린샷을 남긴다
                 # `pnpm stack:local`이 떠 있는 동안에는 `pnpm e2e workbench`처럼 워크벤치 스펙만 돌린다 (submissions 스펙은 워커가 없어야 한다)
pnpm copy:check  # UI 문구·문서에 정확도·비용 절감·속도 홍보 수치와 결과를 바꿀 수 없다고 보장하는 표현이 없는지 확인 (T-507, PRD 13장)
pnpm context:isolation-check  # 맥락 연결 단계 코드가 점수 열을 읽지 않는지 AST로 확인 (T-503, G-10)
pnpm deps:check  # 의존성이 정확한 버전으로 고정되어 있는지 확인
pnpm deps:boundary-check  # apps/web이 runner·harness·analysis·llm에 의존하지 않는지 확인 (G-05)
pnpm samples:check        # samples/order-api의 명세·실행 계약·기준·기대 결과표 대조 (T-101)
pnpm template:build       # 템플릿 node_modules 설치(npm ci) + template.json의 allowedDependencies·environmentDigest 기록 (T-102)
pnpm samples:link         # samples/order-api/impl-*/node_modules를 템플릿 node_modules로 심볼릭 링크 (샘플 로컬 실행용)
pnpm harness:coverage     # 하네스 케이스가 rubric의 EXECUTION 기준을 모두 커버하는지 확인 (T-107)
pnpm harness:run --base-url http://localhost:3001 --rubric samples/order-api/rubric.v1.json --out /tmp/a.json [--case <id>]
                          # 기동된 제출 서비스에 하네스 케이스를 실행해 보고서 JSON을 쓴다. 요청 제한 시간은 HARNESS_REQUEST_TIMEOUT_MS(기본 5000)
pnpm gate:phase1 [--rounds 3] [--out docs/gates/phase1.md] [--json docs/gates/phase1.json] [--matrix <path>] [--samples A,B,C,D]
                          # 1단계 게이트(T-110): 샘플 A/B/C/D를 러너로 기동해 하네스·제출 테스트를 돌리고 expected-matrix와 대조, 3회 반복해 판정 digest가 같은지 확인. 불일치·비결정성이면 exit 1. 템플릿 node_modules(template:build)가 필요하다. 요약 JSON은 db:seed:sample이 승인 근거로 쓴다
pnpm gate:phase2 --base-url https://ohmyti.vercel.app [--phase 5] [--repeat 3] [--repeat-samples A,C] [--samples A,B,C,D] [--skip-unsupported] [--out docs/gates/phase2.md] [--json docs/gates/phase2.json]
                          # 배포 환경 E2E(T-208, T-507): 배포된 웹에 샘플 A/B/C/D의 공개 저장소(samples/order-api/sample-repos.json)를 API로 제출하고, 워커 채점 결과를 조회 API로 읽어 expected-matrix와 대조. 반복 제출의 판정 digest 일치(결정성)와 미지원(Python) 저장소 거절도 확인
                          # --phase는 배포된 단계의 기대값: 2(mutation 이전, withoutMutationStage), 4(테스트 실효성·리뷰 작성 DONE), 5(맥락 연결까지 DONE, 기본). 접근 비밀번호는 APP_ACCESS_PASSWORD 또는 --password
pnpm gate:phase4 [--fake]  # 4단계 게이트(T-408): 임시 DB에서 채점기 검증 → 승인 흐름 → A/B/C/D 전체 파이프라인(LLM 포함)을 기대 결과표와 대조. B 만점, D = C, LLM 전후 판정 불변 확인. 기록 docs/gates/phase4.md
pnpm demo:seed [--env-store --external-worker] [--samples A,B,C,D]
                          # 샘플 체험(/demo)의 저장된 실행을 실제 파이프라인으로 만든다(T-505). 배포 환경은 --env-store --external-worker
pnpm demo:rehearsal --base-url https://ohmyti.vercel.app
                          # 90초 데모 리허설 준비(T-507): docs/demo.md 구간별 화면을 열어 스크린샷과 기대 문구 확인 결과를 docs/demo/에 남긴다. 아무것도 바꾸지 않는다
pnpm db:generate # 스키마 변경 → 마이그레이션 SQL 생성. db:migrate / db:studio / db:reset(개발 전용)
pnpm db:seed:sample [--gate docs/gates/phase1.json] [--approved-by seed]
                          # 샘플 과제 "주문·재고 API" v1을 등록·승인하고(validation_result = 1단계 게이트 결과) 검증 샘플 A/B/C/D를 스토어·DB에 넣는다 (T-201). 멱등. gate:phase1이 만든 docs/gates/phase1.json이 필요하다
pnpm format      # Prettier
```

## 배포

Railway(워커·PostgreSQL) + Vercel(웹·Blob). 절차·변수·현재 배포 식별자는 `docs/deploy.md`에 있습니다.

- 웹: https://ohmyti.vercel.app (`/api/health`가 DB 연결을 확인합니다). 로그인 없이 누구나 접속할 수 있는 공개 배포입니다(`APP_ACCESS_MODE=public`). 비공개로 운영하려면 이 값을 빼고 `APP_ACCESS_PASSWORD`를 설정합니다 (`docs/deploy.md` 9절)
- 워커: Railway 프로젝트 `ohmyti`의 서비스 `worker` (`railway up --service worker`), 서비스 설정은 `.railway/railway.ts`
- CI: `.github/workflows/ci.yml` (typecheck·lint·test·build + 워커 이미지 스모크)

## 문서

- `docs/acceptance.md`: PRD 12장 인수 기준 10개의 상태·증명 방법·증거 (T-507)
- `docs/demo.md`: 90초 데모 시나리오(구간별 URL·클릭 순서·기대 화면)와 리허설 기록
- `docs/deploy.md`: Railway + Vercel 배포 절차·변수·현재 배포 식별자
- `docs/gates/`: 단계별 게이트 기록(`phase1.md`·`phase2.md`·`phase3.md`·`phase4.md`)

## 지원 범위와 알려진 제약

- **주문·재고 API 과제 템플릿 전용**: 지원하는 제출물은 TypeScript 주문·재고 API 과제(`templates/order-api-ts` 실행 계약 준수)뿐입니다. 제출물의 `dependencies`·`devDependencies`는 `templates/order-api-ts/template.json`의 `allowedDependencies` 부분집합이어야 하며, 어떤 러너도 제출물의 `npm install`을 실행하지 않습니다 (`templates/order-api-ts/README.md`). 다른 언어나 템플릿 밖 의존성은 사유와 함께 `미지원`으로 거절합니다.
- **공개 GitHub 저장소 전용**: 저장소는 GitHub 공개 저장소의 tarball API로만 수집합니다. 비공개 저장소, 다른 호스팅, 압축 파일 업로드는 지원하지 않습니다.
- **제출 테스트는 vitest 전용**: 제출물의 자체 테스트는 vitest JSON 리포터 결과로만 수집합니다. 다른 테스트 도구의 결과나 stdout의 `PASS` 문구는 신뢰하지 않습니다 (G-07).
- **네트워크 미차단**: MVP의 `LocalProcessRunner`(`packages/runner`, T-108)는 워커 컨테이너 안에서 비관리자 사용자로 자식 프로세스 그룹을 띄우며 일회성 임시 디렉터리, 템플릿 `node_modules` 읽기 전용 연결, 환경변수 화이트리스트(`PATH`·`HOME`·`NODE_ENV`·`PORT`·`NODE_OPTIONS`), 벽시계·힙 메모리 제한, 설치 명령 차단을 적용합니다. 그러나 컨테이너 권한 없이 아웃바운드 네트워크를 OS 수준에서 차단하지 못합니다. 강화 경로는 `SANDBOX_RUNNER=vercel`로 켜는 `VercelSandboxRunner`(T-209)이며, Firecracker microVM 안에서 실행하고 템플릿 설치 뒤 아웃바운드를 `deny-all`로 닫습니다. 자세한 내용은 `packages/runner/README.md`와 `docs/deploy.md`를 보세요.
- **모바일 미최적화**: 워크벤치(요구사항·재생·근거 3단 + 하단 탭)는 데스크톱 너비를 전제로 만들었습니다. 좁은 화면에서는 레이아웃이 깨질 수 있습니다.
- LLM은 기준 초안, mutation 위치 후보, 근거 서술·리뷰 초안, 맥락 연결·후속 질문에만 쓰며 점수와 PASS/FAIL 판정에는 쓰지 않습니다 (G-01). LLM 문장은 실행마다 달라질 수 있습니다.
- 이력서 텍스트 추출은 텍스트 PDF만 지원하고 OCR은 하지 않습니다. 이미지 PDF는 직접 입력을 안내합니다.
