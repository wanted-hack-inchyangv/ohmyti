# @ohmyti/runner

제출 서비스와 제출 테스트를 격리된 일회성 환경에서 실행하는 `SandboxRunner` 인터페이스와 두 구현 `LocalProcessRunner`(MVP, TICKET.md 1.4, T-108)·`VercelSandboxRunner`(격리 강화, T-209), 그리고 승인 실행 템플릿 계약(`template.ts`, T-102)이다. 구현은 `createRunnerFromEnv(env, { artifactStore, secrets })`가 `SANDBOX_RUNNER`(`local` | `vercel`)로 고른다. 워커(`apps/worker`)만 이 패키지를 쓴다. `apps/web`이 의존하면 `pnpm deps:boundary-check`가 실패한다 (G-05).

## 인터페이스

```ts
interface SandboxRunner {
  kind: "local" | "vercel";
  prepare(snapshotRef, contract, { logKeyPrefix?, stripComponents? }) → PreparedEnv;
  startService(env, { maxLifetimeMs?, healthTimeoutMs?, label? }) → RunningService; // { baseUrl, port, pid, startup, logsRef, stop(), isRunning() }
  runCommand(env, argv, { timeoutMs?, collectFiles?, port?, label? }) → CommandResult; // { exitCode, signal, stdout, stderr, timedOut, files, logsRef, … }
  destroy(env);
}
```

- `snapshotRef`는 ArtifactStore의 tar.gz 키(`artifactKeys.snapshot(submissionId)`)다. 러너가 스토어에서 읽어 임시 디렉터리에 푼다.
- `startService`는 계약의 `startCommand`를 빈 포트와 함께 실행하고 `healthPath`가 200을 줄 때까지 기다린다. 실패하면 `ServiceStartError`를 던지며 `startup`(결과 `HEALTH_TIMEOUT`·`EXITED_BEFORE_HEALTHY`·`START_FAILED`, 마지막 상태 코드, 경과 시간)과 저장된 로그 키를 담는다. 성공한 서비스의 `startup.outcome`은 `HEALTHY`이며 T-205가 R-10 판정에 쓴다.
- `runCommand`는 `argv` 배열만 받는다(셸 문자열 없음). `collectFiles`로 명령이 만든 파일(예: vitest JSON 리포터 결과)을 환경 안에서만 읽어 온다.
- `PreparedEnv.environmentDigest`는 템플릿 `template.json`의 digest(`sha256(node 버전 + lockfile + 러너 종류)`)이며 ExecutionRecord의 `environmentDigest`로 그대로 쓴다. 매니페스트의 `runnerKind`가 러너와 다르면 lockfile로 다시 계산한다.
- 모든 오류는 `RunnerError`의 하위 클래스다: `SnapshotRejectedError(code)`, `BlockedCommandError`, `RunnerEnvironmentError`, `ServiceStartError`, `EnvironmentDestroyedError`.
- `PreparedEnv.files`(선택)는 스냅샷 파일 접근자다. 환경이 워커 밖(원격 VM)에 있는 러너가 채우며, `runSubmittedTests`의 프레임워크 감지가 `workDir`를 직접 읽는 대신 이것을 쓴다.

## LocalProcessRunner가 하는 일

| 단계        | 동작                                                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 스냅샷 검증 | 아카이브 전체를 먼저 훑는다. `..`·절대 경로·백슬래시·NUL, 심볼릭 링크·하드 링크·장치 파일, 파일 수(`MAX_SOURCE_FILES`)·누적 크기(`MAX_SOURCE_BYTES`) 초과, 손상된 gzip은 항목 하나라도 있으면 아무것도 풀지 않고 `SnapshotRejectedError`로 끝낸다                                         |
| 풀기        | `<SANDBOX_WORK_ROOT 또는 os.tmpdir()>/ohmyti-sandbox-*/work`에 푼다. 아카이브의 `node_modules`(어느 깊이든)는 풀지 않고 `droppedNodeModules`로 표시한다. `work/node_modules`는 템플릿 `node_modules`로 가는 심볼릭 링크다(컨테이너에서는 root 소유라 읽기 전용)                           |
| 환경변수    | 자식에게 `PATH`(Node 런타임 bin, 템플릿 `node_modules/.bin`, `/usr/bin`, `/bin`), `HOME`(환경 안 `home/`), `NODE_ENV=production`, `NODE_OPTIONS=--max-old-space-size=<RUN_MEMORY_MB>`, 그리고 서비스·요청 시 `PORT`만 준다. 워커의 다른 환경변수(`DATABASE_URL`, 토큰 등)는 넘기지 않는다 |
| 명령 차단   | `npm install`·`npm ci`·`pnpm add`·`yarn add`·`npx`·`corepack` 등 설치·다운로드 계열은 `BlockedCommandError`. `npm start`·`npm test`·`npm run <x>`는 `package.json`의 `pre<x>`·`<x>`·`post<x>` 본문까지 검사한다. `npm`·`node`는 워커와 같은 Node 런타임의 것을 절대 경로로 실행한다       |
| 제한        | `RUN_TIMEOUT_MS`(명령·서비스 수명 벽시계, 기본 120000), 계약 `healthTimeoutMs`(상한 `HEALTH_TIMEOUT_MS`), stdout·stderr 각각 `RUN_MAX_OUTPUT_BYTES`(기본 1 MiB)까지 보관하고 초과는 `…Truncated`로 표시                                                                                   |
| 종료        | 자식은 새 프로세스 그룹(`detached`)으로 띄운다. `stop()`·제한 시간·`destroy()`는 그룹 전체에 SIGTERM → `RUN_KILL_GRACE_MS`(기본 2000) 뒤 SIGKILL을 보내 손자 프로세스까지 정리하고, 그룹이 빌 때까지 확인한다                                                                             |
| 로그        | stdout·stderr를 `maskSensitive`(지정 비밀값 + 토큰·이메일·전화번호 패턴)로 가린 뒤 `<logKeyPrefix><label>/stdout.txt`·`stderr.txt`(`text/plain`)로 ArtifactStore에 저장한다. 기본 접두사는 `sandbox/<envId>/`                                                                             |

## VercelSandboxRunner가 하는 일 (T-209)

`SANDBOX_RUNNER=vercel`. 환경 하나가 Vercel Sandbox VM 하나(`@vercel/sandbox` 3.3.0, Firecracker microVM)다. SDK는 `vercel/client.ts`의 `SandboxClient` 인터페이스 뒤에 있어 테스트는 더블로 돈다.

| 단계        | 동작                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 스냅샷 검증 | local과 같은 `unpackSnapshot`으로 워커 쪽 미러 디렉터리에 먼저 푼다(같은 거부 규칙, `node_modules` 제거). 거부되면 VM을 만들지 않는다. 정리된 사본을 다시 tar.gz로 묶어 VM에 올린다                                                                                                                                                              |
| VM 생성     | 이미지 `VERCEL_SANDBOX_IMAGE`(기본 `vercel/sandbox/node:22`), `VERCEL_SANDBOX_VCPUS`(2), 세션 제한 `VERCEL_SANDBOX_TIMEOUT_MS`(15분), 포트 3000 노출, `persistent: false`, 설치 동안만 네트워크 허용. 환경 루트는 세션 기본 작업 디렉터리(`sandbox.cwd`)이며 그 아래 `template/`·`work/`·`home/`                                                 |
| 템플릿 설치 | 템플릿의 `package.json`·lockfile만 올려 매니페스트의 `installCommand`(`npm ci --no-audit --no-fund`)를 `VERCEL_SANDBOX_INSTALL_TIMEOUT_MS` 안에 실행한다. 제출물의 `package.json`·lockfile은 설치 입력이 아니다. 끝나면 `chown root:root`·`chmod go-w`로 읽기 전용                                                                               |
| 연결·차단   | 스냅샷을 `work/`에 풀고 `work/node_modules` → `template/node_modules` 심볼릭 링크. 그 뒤 `updateNetworkPolicy("deny-all")`로 아웃바운드를 닫는다 (노출 포트로 들어오는 하네스 요청은 영향 없음)                                                                                                                                                  |
| 서비스      | `startService`는 `PORT=3000`으로 detached 실행하고 공개 URL(`sandbox.domain(3000)`, HTTPS)의 `healthPath`를 폴링한다. `baseUrl`이 그 URL이므로 하네스가 그대로 쓴다. 환경당 서비스는 한 번에 하나                                                                                                                                                |
| 명령        | `runCommand`는 `node`·`npm`은 이미지의 것, 그 밖의 이름은 템플릿 `node_modules/.bin/<name>`으로 고정, 슬래시 경로는 환경 루트 안만. 자식 환경변수는 `PATH`(템플릿 `.bin` + VM 기본 PATH)·`HOME`·`NODE_ENV`·`NODE_OPTIONS`·`PORT`뿐. 제한 시간이 지나면 SIGTERM → `RUN_KILL_GRACE_MS` → SIGKILL. `collectFiles`는 VM에서 읽되 환경 루트 밖은 거부 |
| 종료        | `destroy()`와 `prepare`의 모든 실패 경로에서 `sandbox.stop()`을 호출하고 미러를 지운다. 차단 명령·스크립트 검사는 미러의 `package.json`으로 VM에 보내기 전에 한다                                                                                                                                                                                |

비용 상한은 세션 제한 시간 × vCPU 수다. 토큰·한도·비용 주의는 `docs/deploy.md`의 "Vercel Sandbox 러너" 절에 있다. 실제 VM 검증: `SANDBOX_RUNNER=vercel pnpm gate:phase1 --out <다른 경로> --json <다른 경로>`.

## 제출 테스트 실행기 (T-109)

`runSubmittedTests(runner, env, options)`는 준비된 환경에서 제출물의 테스트를 실행하고 `SubmittedTestResult`를 돌려준다. stdout이 아니라 vitest JSON 리포터 결과 파일만 읽는다 (G-07).

| 단계      | 동작                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 감지      | `detectTestFramework`가 `package.json`(`scripts.test` > `jest`·`ava`·`mocha` 키 > 의존성)과 루트 설정 파일(`vitest.config.*`, `jest.config.*`, `.mocharc*` 등)만 본다. README·주석은 데이터다 (G-06). vitest만 지원하며 jest·mocha·ava·jasmine·tap·`node --test`는 `UNSUPPORTED_FRAMEWORK`, 테스트 파일만 있고 신호가 없으면 `unknown`(역시 UNSUPPORTED), 둘 다 없으면 `NO_TESTS` |
| 타입 검사 | 루트 `tsconfig.json`이 있으면 템플릿의 `typescript/bin/tsc --noEmit -p tsconfig.json`을 먼저 실행한다. vitest는 타입을 지우고 실행하므로 타입 오류는 여기서만 잡힌다. 실패하면 `BUILD_FAIL`. `typecheck: false`로 끌 수 있다(T-403의 변형 실행 등)                                                                                                                                |
| 실행      | `node <템플릿>/node_modules/vitest/vitest.mjs run --reporter=json --outputFile=<환경 루트>/test-results/vitest-<random>.json`. 결과 파일은 작업 디렉터리 밖이라 제출물이 미리 넣어 둘 수 없고 `collectFiles`로 환경 안에서만 읽는다                                                                                                                                               |
| 판정      | 결과 파일 없음·JSON 아님·스키마 불일치·크기 상한 초과 → `INCONCLUSIVE`(ENVIRONMENT). 벽시계 초과 → `TIMEOUT`. 테스트를 하나도 싣지 못한 실패 파일(변환·import 오류) → `BUILD_FAIL`. 테스트 0개 → `NO_TESTS`. 실패 > 0 또는 vitest 종료 코드 ≠ 0 → `FAILED`(ASSERTION). 그 밖에 `PASSED`                                                                                           |
| 결과      | `total`·`passed`·`failed`·`skipped`, 파일별(`testFiles[]`, 작업 디렉터리 기준 상대 경로) 테스트 목록과 실패 메시지(마스킹·환경 경로 제거·길이 상한), `typecheck`·`run` 명령 근거(`argv`·`exitCode`·`logsRef`), `failureKind`(G-11)                                                                                                                                                |

`SubmittedTestResultSchema`가 `PASSED`·`FAILED`는 결과 파일이 있어야 한다는 규칙을 `superRefine`으로 검사한다. 알려진 한계: vitest 자체가 제출물의 설정(`vitest.config.ts`)을 읽고 실행하므로 결과 파일을 위조하는 설정을 원천 차단하지는 못한다. 결과 파일 경로는 실행마다 무작위이고, 파일이 없거나 형식이 다르면 INCONCLUSIVE로 남는다.

## 알려진 한계

- **`LocalProcessRunner`는 아웃바운드 네트워크를 차단하지 못한다.** Railway 컨테이너 안에서 비관리자 사용자로 자식 프로세스를 띄우는 방식이라 OS 수준 네트워크 격리(네임스페이스·방화벽)가 없다. 제출 코드는 외부로 요청을 보낼 수 있다. 공개 데모는 승인된 샘플·템플릿만 허용하며(PRD 10장), 강화 경로는 `VercelSandboxRunner`(T-209, `SANDBOX_RUNNER=vercel`)로 VM 단위 격리와 `deny-all` 네트워크 정책을 적용한다.
- `VercelSandboxRunner`는 프로세스 신호를 명령 단위로 보내므로 손자 프로세스가 VM 안에 남을 수 있다(VM과 함께 사라진다). `pid`는 0이다. 환경당 서비스는 포트 3000 하나다. 매 환경마다 템플릿 `npm ci`를 다시 하므로 준비에 30초 이상 걸린다.
- 메모리 제한은 V8 힙(`--max-old-space-size`)에만 적용된다. 네이티브 메모리·CPU 시간은 벽시계 제한(`RUN_TIMEOUT_MS`)으로만 막는다.
- 파일 시스템 격리는 임시 디렉터리 + 비관리자 권한이다. 컨테이너의 다른 경로를 읽는 것을 막지 못하지만, 워커 컨테이너에는 자격증명이 파일로 없고 환경변수는 전달하지 않는다.
- Windows는 지원하지 않는다 (프로세스 그룹 신호, 심볼릭 링크).

## 테스트

```bash
pnpm template:build                 # templates/order-api-ts/node_modules가 없으면 먼저
pnpm --filter @ohmyti/runner test
```

테스트는 샘플 A(`samples/order-api/impl-a`)를 tar.gz로 만들어 실제로 기동하고, 손자 프로세스를 만드는 픽스처·무한 루프·환경변수 출력·경로 이탈·심볼릭 링크·`node_modules` 포함 스냅샷·설치 명령을 검사한다. `pnpm --filter @ohmyti/runner test submitted-tests`는 A/B/C/D의 제출 테스트를 실제로 실행해 개수(49·61·11·16)를 대조하고 NO_TESTS·UNSUPPORTED_FRAMEWORK·INCONCLUSIVE(stdout만 PASS)·BUILD_FAIL(타입·문법 오류)·FAILED·TIMEOUT 픽스처를 검사한다.
