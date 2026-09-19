# 3단계 게이트: 실패 재생 워크벤치 Playwright E2E (T-308)

로컬 전체 스택(web dev 서버 + 워커 + PostgreSQL)에서 결함 샘플 C를 실제 입력 경로(공개 저장소 URL + 고정 SHA)로 제출·채점한 뒤, 브라우저로 "감점 클릭 → 근거 확인 → 재실행 → 사람 수정" 흐름을 검증한 기록이다. 판정·기록·점수는 모두 워커가 만든 것이며 스펙은 DB에 판정을 직접 넣지 않는다 (G-07·G-08). 시나리오는 `e2e/workbench-stack.spec.ts`(Playwright 프로젝트 `stack`), 기동 스크립트는 `pnpm stack:local`(`scripts/stack-local.ts`)이다.

- 결과: **통과** (로컬 3회 연속, CI 2회)
- 실행 일시(로컬): 2026-09-18T15:35:38Z ~ 2026-09-18T15:35:58Z (`pnpm stack:local` + `pnpm e2e`, 25 tests 19.2s) · 2026-09-18T15:34Z 전후 `pnpm e2e` 2회(25 passed, 20.5s·21.4s)
- 실행 일시(CI): 2026-09-18T15:55:12Z ~ 15:58:47Z (실행 35365325367, 25 passed)
- 과제 버전: 주문·재고 API · rubric 내용 `be07fb44` (로컬 v1, 프로덕션 v2) · 하네스 `0.1.0+c40aa35430460704` (`pnpm db:seed:sample`이 현재 하네스 버전으로 승인)
- 입력: `samples/order-api/sample-repos.json`의 C (https://github.com/inchyangv/ohmyti-sample-c @ `339a30853f030cc7ec6d55b5435f8c3013093338`)
- 기대: `samples/order-api/expected-matrix.json` C의 `scoreDisplay.withoutMutationStage` = `49~74/100 · 25점 검토 대기`, R-05 FAIL 0/14
- 2026-09-19 (T-406): T-403·T-404로 워커가 TEST_EFFECTIVENESS 단계를 실행하게 되어, 스펙의 기대 점수를 `scoreDisplay.beforeHumanReview` = `54~69/100 · 15점 검토 대기`로 바꾸고 정리 순서에 `mutation_experiments`를 먼저 지우도록 추가했다. 아래 표의 1단계 점수는 3단계 게이트 당시(mutation 미구현) 기록이다

## 시나리오와 확인 항목

| 단계 | 화면 동작                                         | 확인(모두 API 응답·워커 기록과 대조)                                                                                                                                                  | 스크린샷                      |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 0    | `POST /api/submissions`(C, SHA 고정) → 폴링       | 제출 COMPLETED, `latestEvaluation.id`. 로컬 워커 처리 2.3초(수집→기동→하네스→제출 테스트→판정 저장)                                                                                   | -                             |
| 1    | `/evaluations/<id>` 열기                          | 헤더 점수 = 리포트 `score.display` = 기대 결과표 `49~74/100 · 25점 검토 대기`, 검토 대기 25점, 제출 SHA 12자, 샘플 배지 없음, R-05 카드 `data-verdict="FAIL"`                         | `01-evaluation-open.png`      |
| 2    | R-05 실패 카드 클릭                               | URL `?criterion=R-05`, 선택 기록 = 원본(kind ≠ RERUN)이며 근거 `testId` = `R-05-idempotent-resend`, run API `expected.p1After.stock` 1·`actual` 0, 화면 기대 1·실제 0, 재고 2 → 1 → 0 | `02-r05-replay.png`           |
| 3    | 코드 탭(`?pane=code`)                             | 워커가 붙인 `STATIC_RELATION` 근거(`src/http/routes.ts`)의 스니펫이 화면 줄(`data-line` = startLine…)과 같고, GitHub 링크는 모두 `<repo>/blob/<고정 SHA>/…#Lx-Ly`, `HEAD`·`main` 없음 | `03-code-evidence.png`        |
| 4    | `재실행` 클릭                                     | 상태 `queued`/`running` → 워커가 처리(로컬 0.4초) → 기록 목록에 `data-origin="rerun"` 1건, 리포트 기록 +1, 원본 기록 행·판정·점수 불변(G-03), 새 기록 kind RERUN                      | `04-rerun-queued.png`         |
| 5    | 재실행 기록 열기                                  | `rerun-comparison` `data-outcome="same"`, 실제 재고 0                                                                                                                                 | `05-rerun-record.png`         |
| 6    | R-12 `설계 점수 확정` → 하위 기준 3개 체크·검토자 | 저장 후 리포트 `pendingPoints` −10·`earned` +10, 헤더 `score-display`·`pending-badge`가 API 값과 같음, R-12 `10/PASS/CONFIRMED`, `review_events`에 APPROVE_DESIGN(null → 10)          | `06-…-dialog.png`, `07-….png` |

스크린샷은 `test-results/phase3-screenshots/`에 남고 Playwright 리포트에도 첨부된다. CI는 `test-results/`(스크린샷·워커 로그 `stack-worker.log`·실패 시 trace)와 `playwright-report/`를 아티팩트 `playwright-phase3`로 올린다.

## 실행 방법

```bash
# 1) 스택을 따로 띄우고 E2E만 돌리기
pnpm stack:local              # db:migrate → db:seed:sample → 워커(4320/healthz) → 웹(4310)
pnpm e2e workbench            # 다른 터미널. stack 스펙은 4320의 워커를 재사용한다

# 2) 한 번에
pnpm e2e                      # chromium 프로젝트(워커 없음) → stack 프로젝트(워커를 직접 띄우고 끝나면 내린다)
```

- `stack:local`이 떠 있는 동안 `pnpm e2e` 전체를 돌리면 `e2e/submissions.spec.ts`("대기열에 머문다")를 워커가 처리해 버릴 수 있다. 그때는 `pnpm e2e workbench`처럼 워크벤치 스펙만 돌린다.
- `workbench.spec.ts`의 T-307 케이스는 워커가 잡지 못하도록 `run_after`가 먼 미래인 job을 먼저 넣고 버튼을 누르므로 워커 유무와 무관하다.
- 이전 세션의 워커(`pnpm --filter @ohmyti/worker dev`)가 남아 있으면 상대 경로 `TEMPLATE_ROOT`·다른 스토어 루트로 job을 가로채 실패한다. `ps -ax | grep 'tsx watch src/index.ts'`로 확인하고 정리한다.

## 로컬 실행 기록 (2026-09-18)

- `pnpm exec playwright test --project stack --no-deps`: 5 passed (16.9s). 워커 로그: `tarball을 내려받았습니다` → `스냅샷을 저장했습니다` → `REPO_CHECK 완료` → `ENV_PREP 완료` → `서비스가 기동됐습니다` → `제출 테스트를 실행했습니다` → `REQUIREMENT_VERIFY 완료` → `요구사항 판정을 저장했습니다` → `점수를 기록했습니다` → `job 성공`, 이어서 RERUN_EXECUTION `재실행 기록을 저장했습니다` → `job 성공`.
- `pnpm e2e` 2회: 25 passed (20.5s, 21.4s). chromium 20건이 끝난 뒤 stack 5건이 실행됐다(프로젝트 `dependencies`).
- `pnpm stack:local` + `pnpm e2e -- workbench`(pnpm 10은 `--`를 그대로 넘겨 전체 25건이 돌았다): 25 passed (19.2s). stack 스펙이 4320의 워커를 재사용했고(`annotations: worker reused`), 워커 로그의 C 처리 시간은 `job 시작` 15:35:48.677Z → `job 성공` 15:35:50.940Z, 재실행 15:35:53.948Z → 15:35:54.329Z. Ctrl+C(SIGINT) 뒤 웹·워커 프로세스 그룹이 모두 정리됐다(4310·4320 LISTEN 없음).
- 정리: 스펙 `afterAll`이 제출·평가·기록·근거·job 행과 fs 아티팩트(`evaluations/<id>/`, `submissions/<id>/`)를 지운다. 시드한 과제 버전은 남긴다(멱등).

## CI 실행 (2026-09-18)

- 워크플로 실행 [35365325367](https://github.com/inchyangv/ohmyti/actions/runs/35365325367): **success**. job `playwright e2e (web + worker + postgres)` 15:55:12Z ~ 15:58:47Z (3.6분), E2E 단계 **25 passed (2.3m, 1 worker)**. 같은 실행의 `verify`·`worker-image` job도 success. 이 절을 채운 뒤 다시 돈 실행 [35366421068](https://github.com/inchyangv/ohmyti/actions/runs/35366421068)도 세 job 모두 success다(코드는 그대로이고 이 문서만 달라졌다).
- 아티팩트 `playwright-phase3`(23개 파일, 6.5 MB): `test-results/phase3-screenshots/01-evaluation-open.png` ~ `07-header-after-approve.png` 7장, 테스트별 첨부 사본 7장, 워커 로그 `test-results/stack-worker.log`, `playwright-report/`(HTML). 내려받아 7장을 확인했고 마지막 장은 R-12 확정 후 헤더 `59~74/100 · 15점 검토 대기`·검토 이력 `?/10 → 10/10 · 미확정 → 통과 · 검토 대기 → 사람 확인`이다.
- CI 워커 로그: `job 시작` 5건 = 평가 1(성공) + 재실행 1(성공) + `제출을 찾을 수 없습니다` 3건. 뒤의 3건은 앞서 끝난 `chromium` 프로젝트의 `submissions.spec.ts`가 만들고 정리한 제출의 job을 stack 워커가 뒤늦게 집은 것이며 결과에 영향이 없다(대상 제출이 이미 없으므로 비재시도 실패).

## 배포 (3단계 화면·워커 반영, 2026-09-18)

T-301~T-307은 배포를 이 게이트로 미뤘다. 순서는 워커(마이그레이션) → 프로덕션 DB 시드 → 웹이다.

1. `railway up --service worker`: 배포 `d3839f10` **SUCCESS**. pre-deploy `db:migrate OK (/app/drizzle)`(0005~0007 적용), `EVALUATE_SUBMISSION 핸들러를 등록합니다` · `RERUN_EXECUTION 핸들러를 등록합니다 limit=20` · `워커 시작` · `헬스 서버 시작 port=8080`.
2. `DATABASE_URL=<공개 프록시> ARTIFACT_STORE=blob … pnpm db:seed:sample`: 하네스가 `0.1.0+e363f5fc77e72aa6` → `0.1.0+c40aa35430460704`로 바뀌었으므로 v1(`v1-be07fb44`)을 **RETIRED**로 내리고 **v2(`v2-be07fb44`) APPROVED**를 만들었다(샘플 A/B/C/D 스냅샷 4건 재등록). 승인 버전은 불변이라 하네스 필드를 고칠 수 없어 새 버전이 필요하다.
3. `vercel deploy --prod --yes --scope <vercel-team>`: https://ohmyti.vercel.app (Ready). `GET /api/health` → `{"ok":true,"db":"ok"}` 200.

배포 확인:

- `pnpm gate:phase2 --base-url https://ohmyti.vercel.app --samples C --repeat 1 --skip-unsupported`: **OK exit 0** (1.3분). 과제 버전 `주문·재고 API · v2 · 승인됨`, 제출 COMPLETED 69.7초, 15개 기준 모두 기대와 일치, 점수 표시 `49~74/100 · 25점 검토 대기`, 제출 테스트 PASSED 11건/3파일.
- 배포된 워크벤치(`/evaluations/efe48778…?criterion=R-05`, 접근 비밀번호 로그인): 헤더 `49~74/100 · 25점 검토 대기` · `25점 검토 대기`, 기준 카드 15개, 실행 기록 1건, 기대 1 → 실제 0, 코드 근거 `data-code-status="ok"` · 고정 SHA `339a30853f03…`, GitHub 링크 3개(`HEAD`·`main`·`/tree/` 없음), `재실행` 활성, 사람 검토 버튼 3개.
