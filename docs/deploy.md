# 배포: Railway + Vercel

이 문서만 보고 새 환경을 구성할 수 있도록 순서·변수·명령을 모두 적는다. 값(비밀번호, 토큰, 연결 문자열)은 적지 않는다.

## 현재 배포 (2026-09-18)

| 구성 요소              | 위치                                                                                  | 식별자                     |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------- |
| Railway 프로젝트       | 프로젝트 `ohmyti`, 환경 `production`, 리전 `us-east4`                                 | `<railway-project-id>`     |
| 워커 서비스            | Railway 서비스 `worker` (Dockerfile 빌드, CLI 업로드, Serverless 절전)                | `<worker-service-id>`      |
| 워커 깨우기 주소       | `https://<worker-domain>.up.railway.app/wake` (포트 8080, 아래 "비용 절감 구성")      |                            |
| PostgreSQL             | Railway 서비스 `Postgres` (`postgres-ssl:18`, 볼륨 `postgres-volume` 50 GB)           | `<postgres-service-id>`    |
| PostgreSQL 공개 프록시 | `<proxy-host>.proxy.rlwy.net:<port>` → 5432 (TLS, `sslmode=require`)                  | TCP proxy `<tcp-proxy-id>` |
| Vercel 프로젝트        | 팀 `<vercel-team>`, 프로젝트 `ohmyti`, 루트 `apps/web`, Node 22.x, 함수 리전 `iad1`   | `<project-id>`             |
| 웹 URL                 | https://ohmyti.vercel.app (프로덕션 별칭), 헬스: https://ohmyti.vercel.app/api/health |                            |
| Vercel Blob            | 스토어 `ohmyti-artifacts` (private, icn1), 프로젝트 `ohmyti`에 연결                   | `store_kQz8bhA5qiqhaEfo`   |
| GitHub                 | https://github.com/inchyangv/ohmyti (비공개). CI: `.github/workflows/ci.yml`          |                            |

## 토폴로지 요약 (TICKET.md 1.1)

- `apps/web`(Vercel)과 `apps/worker`(Railway)는 별도 API 없이 같은 PostgreSQL을 공유한다.
- 워커는 Railway 내부 네트워크(`postgres.railway.internal`, TLS 없음)로, Vercel 함수는 공개 TCP 프록시(TLS, `sslmode=require`)로 DB에 붙는다.
- Vercel 함수 인스턴스는 커넥션 1개(`createServerlessDb`, `apps/web/lib/db.ts`), 워커는 최대 10개(`createWorkerDb`).
- 제출 코드 실행은 워커만 한다. `pnpm deps:boundary-check`가 web이 runner·harness·analysis·llm에 의존하지 않는지 확인한다.

## 배포 순서 (새 환경)

### 0. 준비

- 로그인: `railway login`, `vercel login`, `gh auth login`.
- 로컬 검증이 통과하는 커밋: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

### 1. Railway: 프로젝트·DB·워커 서비스

```bash
railway init --name ohmyti --workspace "<workspace>"      # 프로젝트 생성 + 현재 디렉터리 링크
railway add --database postgres                           # 서비스 Postgres (볼륨 포함)
railway add --service worker                              # 빈 서비스 worker
railway tcp-proxy create --port 5432 --service Postgres   # 공개 TCP 프록시 (Vercel → DB)
railway tcp-proxy list --service Postgres --json          # endpoint(호스트:포트) 확인
```

공개 연결 문자열은 `postgresql://<PGUSER>:<PGPASSWORD>@<proxy host>:<proxy port>/<PGDATABASE>?sslmode=require` 형태다. 사용자·비밀번호·DB 이름은 `railway variables --service Postgres --json`에서 읽는다(`PGUSER`, `PGPASSWORD`, `PGDATABASE`). Railway 프록시의 인증서는 자체 서명이라 `postgres` 드라이버는 `sslmode=require`에서 검증 없이 TLS만 켠다.

### 2. Railway: 워커 서비스 설정 (Infrastructure as Code)

Railway는 `railway.json`(Config as Code)을 폐기했으므로 서비스 설정은 `.railway/railway.ts`에 둔다. 빌더 `DOCKERFILE`, `dockerfilePath: apps/worker/Dockerfile`(빌드 컨텍스트는 저장소 루트), `preDeployCommand: node dist/migrate.js`, `startCommand: node dist/index.js`, `healthcheckPath: /healthz`, 재시작 `ON_FAILURE` 10회, `drainingSeconds: 30`.

```bash
pnpm install                      # 루트 devDependency railway(SDK)가 필요하다
railway config plan               # 변경 미리보기
railway config apply --yes        # 적용 (변수의 preserve()는 기존 값을 유지한다)
```

주의: Dockerfile에 `# syntax=` 지시자나 `RUN --mount=type=cache`가 있으면 Railway 빌더가 로그 없이 실패했다. 현재 Dockerfile은 둘 다 쓰지 않는다. `watchPatterns`도 두지 않는다(CLI 업로드가 `SKIPPED`가 된다).

### 3. Railway: 워커 변수

`railway variable set --service worker --skip-deploys KEY=VALUE ...`로 넣는다. `DATABASE_URL`은 참조 문법 `${{Postgres.DATABASE_URL}}`을 그대로 값으로 넣는다.

| 변수                                                                                              | 값                                                        | 비고                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                                                    | `${{Postgres.DATABASE_URL}}`                              | 내부 네트워크. 비밀                                                                                                                                                                  |
| `ARTIFACT_STORE` / `BLOB_ACCESS`                                                                  | `blob` / `private`                                        |                                                                                                                                                                                      |
| `BLOB_READ_WRITE_TOKEN`                                                                           | Vercel Blob 토큰                                          | `vercel env pull`로 받은 값. 비밀                                                                                                                                                    |
| `SANDBOX_RUNNER` / `TEMPLATE_ROOT`                                                                | `local` / `/opt/templates`                                | 이미지의 `/opt/templates/order-api-ts`에 템플릿이 설치된다                                                                                                                           |
| `MIGRATIONS_FOLDER`                                                                               | `/app/drizzle`                                            | 이미지 안 마이그레이션 SQL 위치 (Dockerfile ENV와 같음)                                                                                                                              |
| `RUN_TIMEOUT_MS` / `RUN_MEMORY_MB` / `HEALTH_TIMEOUT_MS`                                          | `60000` / `512` / `10000`                                 |                                                                                                                                                                                      |
| `MAX_SOURCE_FILES` / `MAX_SOURCE_BYTES` / `MAX_PROFILE_REPOS`                                     | `500` / `20971520` / `3`                                  |                                                                                                                                                                                      |
| `DEEP_SEEK_API_KEY`                                                                               | DeepSeek 키                                               | 비밀                                                                                                                                                                                 |
| `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_MODEL`                                                     | `deepseek` / `https://api.deepseek.com` / `deepseek-chat` |                                                                                                                                                                                      |
| `LLM_MAX_CALLS_PER_EVALUATION` / `LLM_MAX_COST_USD_PER_EVALUATION`                                | `20` / `0.50`                                             |                                                                                                                                                                                      |
| `WORKER_POLL_INTERVAL_MS` / `WORKER_CONCURRENCY` / `WORKER_STALE_MS` / `WORKER_SHUTDOWN_GRACE_MS` | `1000` / `1` / `60000` / `25000`                          | `drainingSeconds`(30) > grace(25초)                                                                                                                                                  |
| `WORKER_IDLE_STOP_MS`                                                                             | `120000`                                                  | 큐가 2분 비면 폴링·DB 연결을 멈추고 `/wake`를 기다린다. 0이면 계속 폴링한다 (아래 "비용 절감 구성")                                                                                  |
| `PORT` / `LOG_LEVEL`                                                                              | `8080` / `info`                                           | 헬스 체크 포트                                                                                                                                                                       |
| `GITHUB_TOKEN`                                                                                    | 선택 (권장)                                               | 저장소 수집(T-202)과 GitHub 프로필 보충 조회(T-502). 없으면 IP당 시간 60회 한도라 제출 몇 건이면 보충 조회가 `RATE_LIMITED`로 끝난다. 공개 저장소 읽기 전용 fine-grained 토큰을 쓴다 |
| `VERCEL_TOKEN`·`VERCEL_TEAM_ID`·`VERCEL_PROJECT_ID`, `VERCEL_SANDBOX_*`                           | `SANDBOX_RUNNER=vercel`일 때만                            | 아래 "Vercel Sandbox 러너" 절 (T-209)                                                                                                                                                |

비밀이 아닌 값은 `.railway/railway.ts`에도 같은 값으로 적혀 있다. 비밀은 `preserve()`로 두므로 코드에 들어가지 않는다.

### 4. Railway: 워커 배포

```bash
railway up --service worker --detach --json --message "<메시지>"   # 저장소 루트 업로드 (.gitignore 존중)
railway deployment list --service worker --json                    # 상태: BUILDING → SUCCESS
railway logs --service worker --lines 50                           # "db:migrate OK", "워커 시작", "폴링 중"
```

pre-deploy 단계가 `node dist/migrate.js`로 마이그레이션을 적용한 뒤 컨테이너가 뜨고 Railway가 `/healthz`(200)를 확인한다. 워커는 폴링하는 동안 1분마다 `폴링 중` info 로그를 남기고, 큐가 `WORKER_IDLE_STOP_MS` 동안 비면 `큐가 비어 폴링을 멈춥니다` 로그를 남긴 뒤 조용해진다.

GitHub 자동 배포는 연결하지 않았다. 필요하면 `railway service source connect --repo inchyangv/ohmyti --branch main --service worker`.

### 5. Vercel: 프로젝트 설정

프로젝트 `ohmyti`(팀 `<vercel-team>`)는 T-005에서 Blob 스토어를 연결하기 위해 만들었다. 설정은 REST API로 맞춘다 (`vercel project` 명령에는 루트 디렉터리 옵션이 없다).

```bash
vercel link --yes --scope <vercel-team> --project ohmyti     # .vercel/ 생성 (gitignore)
vercel api "/v9/projects/<projectId>?teamId=<teamId>" -X PATCH \
  -f rootDirectory=apps/web -f nodeVersion=22.x -f framework=nextjs
```

- 루트 디렉터리 `apps/web`, Node 22.x(`apps/web/package.json`의 `engines.node`도 `22.x`), 프레임워크 Next.js. Vercel이 상위의 `pnpm-workspace.yaml`을 감지해 모노레포 루트에서 `pnpm install`을 실행한다.
- Vercel Authentication(배포 보호)은 껐다(`ssoProtection: null`). 접근 보호는 T-008의 비밀번호 proxy(`apps/web/proxy.ts`)가 맡는다. 아래 9절 참고.

### 6. Vercel: 환경변수 (Production, Preview)

```bash
vercel env add <KEY> production --scope <vercel-team> --force        # 값은 stdin
vercel api "/v10/projects/<projectId>/env?teamId=<teamId>&upsert=true" -X POST --input body.json   # preview는 CLI가 브랜치를 요구하므로 API로 넣는다
```

| 변수                             | 값                                            | 비고                                                                                  |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | 공개 프록시 연결 문자열 (`?sslmode=require`)  | 비밀(sensitive)                                                                       |
| `ARTIFACT_STORE` / `BLOB_ACCESS` | `blob` / `private`                            |                                                                                       |
| `BLOB_READ_WRITE_TOKEN`          | Blob 스토어 연결 시 자동 추가                 | Production·Preview·Development                                                        |
| `APP_ACCESS_PASSWORD`            | 데모 접근 비밀번호                            | 비밀. 없으면 production 기동 실패                                                     |
| `SESSION_SECRET`                 | 64자 hex (`openssl rand -hex 32`)             | 비밀. 32자 이상. Preview는 별도 값                                                    |
| `WORKER_WAKE_URL`                | `https://<worker-domain>.up.railway.app/wake` | job을 적재할 때마다 워커를 깨운다. 없으면 깨우지 않는다 (워커가 항상 폴링하는 구성용) |
| `DEMO_MODE`                      | Production `true`, Preview `false`            | `true`일 때만 `/demo`(T-505)를 연다. 샘플 배지는 값과 상관없이 표시                   |

### 7. Vercel: 배포

```bash
pnpm deploy:web                                      # 프로덕션. 로컬에서 빌드해 산출물만 올린다 (Vercel 빌드 시간 0)
vercel deploy --yes --scope <vercel-team>            # 프리뷰 (Vercel에서 빌드, Standard 머신)
curl -i https://ohmyti.vercel.app/api/health      # {"ok":true,"db":"ok",...} 200. DB 실패 시 503
```

`pnpm deploy:web`은 `vercel pull`(프로젝트 설정·환경변수) → `vercel build --prod`(로컬, 약 15초) → `vercel deploy --prebuilt --prod`를 차례로 실행한다. 함수 런타임은 로컬 Node 버전과 상관없이 프로젝트 설정(22.x)을 따른다. 로컬 빌드가 안 되는 환경에서는 `vercel deploy --prod --yes`로 Vercel에서 빌드한다.

### 8. GitHub와 CI

```bash
gh repo create ohmyti --private --source . --remote origin
git push -u origin main
```

`.github/workflows/ci.yml`은 `main` push와 모든 PR에서 두 job을 돈다.

- `verify`: PostgreSQL 16 서비스 컨테이너, `pnpm install --frozen-lockfile`, `env:check`·`deps:check`·`deps:boundary-check`·`format:check`, `typecheck`, `lint`, `db:migrate`, `test`(`DATABASE_URL_TEST`로 통합 테스트 포함), `build`.
- `worker-image`: `apps/worker/Dockerfile` 빌드 후 컨테이너에서 `node dist/migrate.js`와 `/healthz` 200을 확인.
- `e2e`(T-308): PostgreSQL 서비스 컨테이너 + Playwright chromium. `template:build` → `db:migrate` → `pnpm e2e`. chromium 프로젝트(워커 없음)가 끝나면 stack 프로젝트가 워커를 직접 띄워 샘플 C(`sample-repos.json`, 공개 저장소·SHA 고정)를 제출·채점하고 감점 클릭 → 근거 → 재실행 → R-12 승인을 검증한다. `test-results/`(단계별 스크린샷 `phase3-screenshots/`, 워커 로그 `stack-worker.log`, 실패 시 trace)와 `playwright-report/`를 아티팩트 `playwright-phase3`로 올린다. 결과 기록은 `docs/gates/phase3.md`.

Vercel Git 연동과 Railway GitHub 자동 배포는 쓰지 않는다. 배포는 위 CLI 명령으로 한다.

### 9. 접근 보호 (T-008)

`apps/web/proxy.ts`가 `APP_ACCESS_PASSWORD`가 설정된 환경에서 `/login`, `/api/login`, `/api/health`, `/robots.txt`, `/favicon.ico`, `/_next/*` 외 모든 경로에 서명 쿠키(`ohmyti_access`, HMAC-SHA256, 7일, HttpOnly, SameSite=Lax)를 요구한다.

- 쿠키가 없거나 서명·만료가 잘못된 HTML 탐색은 `/login?next=<원래 경로>`로 307, API·비HTML 요청은 401 JSON.
- `POST /api/login`(JSON `{password, next}` 또는 form)이 비밀번호를 확인하고 200에 쿠키를 발급한다. 틀리면 401. `next`는 같은 사이트의 절대 경로만 허용한다.
- `APP_ACCESS_PASSWORD`가 없으면 `next dev`에서는 보호가 꺼지고 production(`next start`, Vercel)에서는 `instrumentation.ts`가 오류를 남기고 종료한다. `SESSION_SECRET`은 32자 이상이어야 한다.
- `robots.txt`는 전체 차단(`Disallow: /`).
- 공개 데모 배포는 `APP_ACCESS_MODE=public`으로 보호를 끈다. 이 값이 있으면 비밀번호 설정과 상관없이 모든 경로가 열리고 production에서도 비밀번호 없이 기동하며 `robots.txt`는 `Allow: /`가 된다. 현재 https://ohmyti.vercel.app 은 이 모드로 운영한다.

```bash
curl -i -H "accept: text/html" https://ohmyti.vercel.app/                 # 307 → /login?next=%2F
curl -i -H "content-type: application/json" -d '{"password":"<비밀번호>","next":"/"}' -c jar https://ohmyti.vercel.app/api/login   # 200 + Set-Cookie
curl -i -b jar https://ohmyti.vercel.app/                                  # 200
```

## 비용 절감 구성 (2026-09-20)

실측(2026-09-18 ~ 09-19)으로 이 프로젝트의 비용은 Vercel은 빌드 CPU 시간이 98%, Railway는 유휴 워커의 메모리 점유가 약 70%였다. 아래 구성이 둘을 없앤다.

**Vercel**

- 빌드 머신 `turbo`(30 vCPU) → `standard`(4 vCPU). 빌드는 `빌드 시간 × vCPU 수`로 과금되므로 분당 단가가 7.5배 낮다. 프로젝트 설정 `resourceConfig.buildMachineType`이며 REST API(`PATCH /v9/projects/<projectId>`)로 바꾼다.
- 프로덕션 배포는 `pnpm deploy:web`(prebuilt)이라 Vercel 빌드 머신을 쓰지 않는다.
- 함수 기본 제한 시간 300초 → 60초(`resourceConfig.functionDefaultTimeout`). DB 연결이 멈춘 요청이 5분 동안 과금되는 것을 막는다. 웹에는 60초를 넘는 요청이 없다(오래 걸리는 일은 모두 워커 job이다).

**Railway: 워커 절전 (Serverless)**

- `.railway/railway.ts`의 `deploy.sleepApplication: true`. Railway는 서비스가 나가는 패킷을 5~10분 동안 보내지 않으면 컨테이너를 재우고 그동안 CPU·메모리를 과금하지 않는다. 들어오는 요청이 오면 다시 띄운다.
- 워커는 큐가 `WORKER_IDLE_STOP_MS`(2분) 동안 비어 있고 끝나지 않은 job(재시도 대기 포함)이 하나도 없으면 폴링을 멈춘다. DB 풀은 유휴 30초 뒤 연결을 닫으므로 나가는 트래픽이 없어진다. 유휴 대기 중 `/healthz`는 DB를 확인하지 않는다(`"dormant":true,"db":"skipped"`).
- 깨우기: `@ohmyti/db`의 `enqueue`가 새 job을 만들 때마다 `WORKER_WAKE_URL`로 `POST /wake`를 보낸다(web은 `apps/web/lib/db.ts`에서 Next.js `after`로 응답 뒤에 전송, `pnpm demo:seed --external-worker`도 같은 훅을 건다). 재운 서비스의 첫 요청은 502일 수 있어 3번까지 다시 시도한다. 보완으로 제출 상태·샘플 실행 상태 폴링 API가 끝나지 않은 job을 보는 동안 30초에 한 번 다시 깨운다.
- 컨테이너가 재워졌다 깨어나면 프로세스가 새로 뜨고 기동 직후 폴링하므로 `/wake` 처리 여부와 상관없이 쌓인 job을 잡는다. 첫 job은 컨테이너 기동 시간(수 초)만큼 늦게 시작한다.
- `/wake`는 인증하지 않는다. 하는 일이 폴링 재개뿐이고 Railway는 어떤 요청이 와도 재운 서비스를 깨운다.
- 워커 도메인: `railway domain --service worker --port 8080`. 확인: `railway deployment list --service worker --json`의 상태가 유휴 10분쯤 뒤 `SLEEPING`.
- DB에 직접 적재하는 다른 도구(`pnpm gate:phase4` 등)를 배포 워커에 쓸 때는 `WORKER_WAKE_URL`을 환경에 두거나 `curl -X POST <깨우기 주소>`를 먼저 부른다.
- 끄기: `WORKER_IDLE_STOP_MS=0`과 `sleepApplication: false`로 `railway config apply`.

**하지 않은 것**: PostgreSQL 절전. 메모리 약 90 MB(월 1달러 미만)를 아끼지만, 재운 뒤 첫 방문자의 페이지가 DB 기동을 기다리다 오류가 될 수 있다. 공개 심사 기간이 끝나면 Postgres 서비스 설정에서 Serverless를 켜는 것을 검토한다.

## 로컬에서 워커 이미지 확인

```bash
docker build -f apps/worker/Dockerfile -t ohmyti-worker .
docker run --rm -e DATABASE_URL=postgresql://ohmyti:ohmyti@host.docker.internal:55440/ohmyti ohmyti-worker node dist/migrate.js
docker run -d --name ohmyti-worker-smoke -p 18080:8080 \
  -e DATABASE_URL=postgresql://ohmyti:ohmyti@host.docker.internal:55440/ohmyti \
  -e ARTIFACT_STORE=fs -e ARTIFACT_FS_ROOT=/tmp/artifacts ohmyti-worker
curl -i http://localhost:18080/healthz
docker stop ohmyti-worker-smoke && docker rm ohmyti-worker-smoke
```

이미지는 `node:22.23.2-bookworm-slim` 기반, 비관리자 사용자 `runner`(uid 10001), `/app`에 `dist/`(`index.js`, `migrate.js`)·`node_modules`(프로덕션 의존성만, `pnpm deploy --prod --legacy`)·`drizzle/`(마이그레이션 SQL), `/opt/templates/order-api-ts`(승인 실행 템플릿: `package.json`·`package-lock.json`·`template.json`·`npm ci`로 설치한 `node_modules`, root 소유라 runner는 읽기만 가능, T-102).

macOS Docker Desktop에서 `docker pull`이 멈추면 자격증명 helper(`credsStore: desktop`)가 키체인 프롬프트를 기다리는 것이다. 익명 설정으로 우회한다:

```bash
mkdir -p /tmp/docker-anon && echo '{"auths":{}}' > /tmp/docker-anon/config.json
ln -sfn ~/.docker/cli-plugins /tmp/docker-anon/cli-plugins
export DOCKER_CONFIG=/tmp/docker-anon DOCKER_HOST=unix://$HOME/.docker/run/docker.sock DOCKER_BUILDKIT=1
```

## 2단계 게이트: 배포 환경 E2E (T-208)

배포가 끝난 뒤 실제 입력 경로(공개 GitHub 저장소 URL)로 샘플을 제출해 채점 결과를 대조한다. 워커 배포(마이그레이션 포함)와 웹 배포가 모두 최신 커밋이어야 한다.

```bash
pnpm gate:phase2 --base-url https://ohmyti.vercel.app          # 공개 배포(APP_ACCESS_MODE=public)
APP_ACCESS_PASSWORD=<접근 비밀번호> pnpm gate:phase2 --base-url <보호된 배포 URL>
```

- 샘플 저장소: `samples/order-api/sample-repos.json`(A/B/C/D 각각 `inchyangv/ohmyti-sample-{a,b,c,d}`, 미지원 검사용 `ohmyti-sample-python`). 각 저장소는 `samples/order-api/impl-*` 디렉터리 내용(`node_modules` 제외) 전체다. 샘플을 고치면 저장소를 다시 push하고 이 파일의 `sha`를 갱신한다.
- 흐름: `POST /api/login`(비밀번호가 있을 때만) → `GET /api/assignment-versions`(승인 버전이 정확히 하나여야 한다) → `POST /api/submissions`(샘플별, SHA 고정) → `GET /api/submissions/[id]` 폴링 → `GET /api/evaluations/[id]`·`runs/[runId]` → 대조. 기본은 A/B/C/D 1회 + A·C 2회 추가(총 8건, 약 10분)이며 워커가 순서대로 처리한다.
- 결과는 `docs/gates/phase2.md`·`phase2.json`에 남는다. 워커 로그의 비밀값 마스킹 확인은 게이트 밖에서 한다: `railway variables --service worker --json`의 `BLOB_READ_WRITE_TOKEN`·`DEEP_SEEK_API_KEY`·DB 비밀번호 값을 `railway logs --service worker --lines 3000` 출력에서 `grep -F`로 찾아 0건이어야 한다.

## 6단계 게이트: 페르소나 회귀 (T-606)

가상 지원자 페르소나 4종(`samples/personas/`)을 배포 환경에 실제 입력 경로(웹 폼, 이력서 PDF 포함)로 제출해 결과를 대조한다. 워커·웹이 모두 최신 커밋이어야 한다.

```bash
pnpm gate:personas --base-url https://ohmyti.vercel.app
```

- 기대값: `samples/personas/expected-matrix.json`(페르소나별 저장소 URL·SHA·이력서·포트폴리오, 기준별 판정, 변이별 결과, 점수 표시, 후속 질문이 있어야 하는 주장, 주장별 기대 상태).
- 흐름: Playwright가 `/submissions/new`에 저장소 URL·SHA·이력서·GitHub 프로필 URL을 넣어 제출 → `GET /api/submissions/[id]` 폴링 → `GET /api/evaluations/[id]`(판정·변이·단계) + `GET /api/evaluations/[id]/context`(GitHub 근거·맥락 연결, 이력서 본문 없음) → 대조. 4건은 워커가 순서대로 처리하며 약 15~25분 걸린다.
- 실패 조건: 판정·점수, 변이 결과, 점수 표시, 단계 상태, REVIEW_WRITE의 LLM 결과(OK)와 R-12 초안, GitHub 근거(본인 포트폴리오 포함, 제출 저장소·다른 페르소나 저장소 없음, 커밋 1개 이상), 후속 질문 존재. 주장 상태 라벨은 경고로만 남긴다.
- 끝나면 첫 화면 → 제출 → 제출 상태 → 워크벤치(R-12 포함)를 데스크톱·모바일로 캡처해 `docs/gates/personas/`에 두고 HTTP 상태·가로 넘침·오류 문구·콘솔 오류를 점검한다. 결과는 `docs/gates/personas.md`·`personas.json`.
- 워커에 `GITHUB_TOKEN`이 없으면 GitHub API 한도가 IP당 시간 60회다. 페르소나 한 건은 프로필 보충 조회에 11회 안팎을 쓰므로 다른 게이트와 겹쳐 돌리기 전에 한도를 확인한다(`railway ssh --service worker -- node -e "fetch('https://api.github.com/rate_limit').then(r=>r.json()).then(j=>console.log(j.rate))"`).

## Vercel Sandbox 러너 (T-209)

`SANDBOX_RUNNER=vercel`이면 워커는 제출 코드를 Railway 컨테이너 안이 아니라 Vercel Sandbox(Firecracker microVM, `@vercel/sandbox` 3.3.0)에서 실행한다. 인터페이스는 `LocalProcessRunner`와 같고 파이프라인·게이트 코드는 바뀌지 않는다. MVP 기본값은 여전히 `local`이며(TICKET.md 1.4), 전환은 워커 변수 하나로 한다.

**환경 하나가 하는 일**: VM 생성(이미지 `vercel/sandbox/node:22`, 포트 3000 노출, 네트워크 허용) → 템플릿 `package.json`·`package-lock.json`만 올려 `npm ci` → 템플릿을 root 소유·읽기 전용으로 → 워커에서 검증·정리한 스냅샷(node_modules 제거)을 올려 풀고 템플릿 `node_modules`를 심볼릭 링크 → 네트워크 `deny-all` → 서비스 기동·하네스·제출 테스트 → `stop()`. 제출물의 lockfile·`package.json`으로 설치하는 경로는 없다. 하네스는 VM의 공개 URL(`https://<sandbox>-3000.<region>.vercel.run`)로 HTTPS 요청을 보낸다.

**필요한 토큰**

| 변수                | 값                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `VERCEL_TOKEN`      | Vercel 계정 토큰. Sandbox API 권한이 있어야 한다. 팀 `<vercel-team>` 범위. 비밀          |
| `VERCEL_TEAM_ID`    | `<team-id>` (`.vercel/project.json`의 `orgId`)                                           |
| `VERCEL_PROJECT_ID` | `<project-id>` (`.vercel/project.json`의 `projectId`). 샌드박스가 이 프로젝트에 귀속된다 |

셋 중 하나라도 없으면 워커가 기동 시 실패한다(`loadVercelRunnerConfig`). 워커 컨테이너에는 OIDC 토큰이 없으므로 계정 토큰 방식만 쓴다. 토큰은 워커 로그 마스킹 대상(`SECRET_ENV_KEYS`)에 이미 들어 있다.

**한도와 비용 상한**

| 변수                                                                   | 기본                     | 뜻                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `VERCEL_SANDBOX_TIMEOUT_MS`                                            | `900000` (15분)          | 세션 제한. 지나면 Vercel이 VM을 멈추고 진행 중인 명령은 거부된다. **환경 하나의 벽시계·비용 상한**             |
| `VERCEL_SANDBOX_VCPUS`                                                 | `2`                      | vCPU 수(1 또는 짝수, 플랜 상한 Hobby 4·Pro 8). vCPU당 메모리 2 GB. 비용은 vCPU 수에 비례한다                   |
| `VERCEL_SANDBOX_INSTALL_TIMEOUT_MS`                                    | `300000` (5분)           | 템플릿 `npm ci` 제한. 넘으면 환경 오류(ENVIRONMENT)로 job이 재시도된다                                         |
| `VERCEL_SANDBOX_IMAGE`                                                 | `vercel/sandbox/node:22` | 템플릿 `nodeVersion`(22)과 같은 Node 메이저여야 한다. 바꾸면 `environmentDigest`가 아니라 실제 런타임이 바뀐다 |
| `VERCEL_SANDBOX_REGION`                                                | SDK 기본값(`iad1`)       | `icn1`을 권장한다. 워커(Railway)와 하네스 왕복 지연이 줄어든다                                                 |
| `RUN_TIMEOUT_MS`, `HEALTH_TIMEOUT_MS`, `RUN_MEMORY_MB`, `MAX_SOURCE_*` | local과 같음             | 명령·서비스 벽시계, `/health` 상한, 힙 상한, 스냅샷 한도. local 러너와 같은 변수를 쓴다                        |

- 비용: Vercel Sandbox는 활성 CPU 시간·프로비저닝된 메모리·생성 횟수·네트워크 전송(노출 포트 트래픽 포함)으로 과금된다(Vercel 가격표 참고). 평가 하나가 쓸 수 있는 최대치는 `VERCEL_SANDBOX_TIMEOUT_MS × VERCEL_SANDBOX_VCPUS`로 막힌다. 실측(2026-09-18, `icn1`, 2 vCPU): 샘플 하나당 약 50초(그중 `npm ci` 약 35초).
- 동시성: 플랜 동시 샌드박스 한도(Hobby 10) 안에서 `WORKER_CONCURRENCY`를 정한다. 환경 하나가 VM 하나다.
- 잔존 VM: `prepare` 실패·`destroy`·예외 경로에서 항상 `stop()`한다. 워커가 강제 종료되면(SIGKILL) 세션 제한 시간이 지난 뒤 Vercel이 VM을 멈춘다. 남은 것은 `vercel sandbox list`로 확인하고 `vercel sandbox stop <name>`으로 정리한다.
- 데이터: `persistent: false`라 스냅샷을 남기지 않는다. VM 안에는 제출 코드와 템플릿뿐이며 워커 환경변수는 어떤 것도 넘기지 않는다(자식 환경변수는 `PATH`·`HOME`·`NODE_ENV`·`NODE_OPTIONS`·`PORT`뿐).

**전환·검증**

```bash
# 로컬(.env.local에 VERCEL_* 세 값)
SANDBOX_RUNNER=vercel VERCEL_SANDBOX_REGION=icn1 pnpm gate:phase1 --rounds 1 \
  --out .run-logs/phase1-vercel.md --json .run-logs/phase1-vercel.json
# Railway 워커
railway variable set --service worker --skip-deploys SANDBOX_RUNNER=vercel VERCEL_SANDBOX_REGION=icn1 \
  VERCEL_TOKEN=<토큰> VERCEL_TEAM_ID=<team-id> VERCEL_PROJECT_ID=<project-id>
railway up --service worker
```

`gate:phase1`의 기본 출력 경로(`docs/gates/phase1.*`)는 local 기록이며 시드가 읽으므로 vercel 실행은 다른 경로로 낸다. 환경 digest는 러너 종류를 포함하므로 local과 다르다(`sha256(node 버전 + lockfile + "vercel")`). 알려진 한계: VM 안에서 프로세스 신호는 명령 단위라 손자 프로세스가 남을 수 있지만 VM과 함께 사라진다. 환경당 서비스는 한 번에 하나(포트 3000)만 띄운다.

## 운영 메모

- 마이그레이션은 워커 pre-deploy에서만 적용한다. 웹 배포는 스키마를 바꾸지 않으므로 스키마 변경이 있는 커밋은 워커를 먼저 배포한다.
- 샘플 과제 시드(T-201)는 로컬에서 프로덕션 DB·Blob을 가리켜 실행한다. 공개 프록시 연결 문자열은 `railway variables --service Postgres --json`의 `PGUSER`·`PGPASSWORD`·`RAILWAY_TCP_PROXY_DOMAIN`·`RAILWAY_TCP_PROXY_PORT`·`PGDATABASE`로 조립한다(`?sslmode=require`). `DATABASE_URL=<공개 프록시> ARTIFACT_STORE=blob BLOB_ACCESS=private BLOB_READ_WRITE_TOKEN=<토큰> pnpm db:seed:sample`. 멱등이라 다시 실행해도 안전하며 승인된 버전은 바꾸지 않는다.
- 워커 재배포 중 진행 중 job은 SIGTERM 후 25초 안에 끝나지 않으면 QUEUED로 반납된다(T-006). `drainingSeconds`는 이보다 길게 둔다.
- DB 비밀번호 교체: Railway `Postgres` 변수 변경 → 워커는 참조라 자동 반영, Vercel `DATABASE_URL`은 다시 넣고 재배포.
- 데이터 삭제·초기화 명령(`pnpm db:reset`)은 `RAILWAY_ENVIRONMENT`·`VERCEL_ENV=production`에서 거부된다.
- 샘플 체험(T-505): 워커를 먼저 배포(pre-deploy가 마이그레이션 `0015` 적용)한 뒤 웹을 배포하고 로컬에서 프로덕션 DB·Blob을 가리켜 `pnpm demo:seed --env-store --external-worker`를 실행한다(연결 문자열은 위와 같이 조립). Railway 워커가 A/B/C/D를 실제로 채점하며 처음 실행에서 GitHub로 수집한 스냅샷을 Blob `demo/samples/<id>/`에 저장해 두고 `이 샘플로 새로 실행`이 재사용한다. 시나리오는 `docs/demo.md`.
