# 승인 실행 템플릿 `order-api-ts`

제출물이 사용할 수 있는 고정 의존성 집합입니다 (TICKET.md 1.4, T-102). 워커 이미지의 `/opt/templates/order-api-ts`에 사전 설치되며, 러너는 제출물의 `node_modules`를 버리고 이 디렉터리의 `node_modules`를 읽기 전용으로 연결합니다. 어떤 러너도 제출물의 `npm install`을 실행하지 않습니다.

## 파일

| 파일                | 내용                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `package.json`      | 허용 의존성. 모두 정확한 버전으로 고정하며 `dependencies`에만 둔다                                                  |
| `package-lock.json` | `npm ci`가 그대로 설치하는 lockfile (v3). 바꾸면 `environmentDigest`가 바뀐다                                       |
| `template.json`     | 기계가 읽는 계약. `name`·`version`·`nodeVersion`·`runnerKind`는 사람이 적고 나머지는 `pnpm template:build`가 채운다 |

`template.json`의 계산 필드:

- `allowedDependencies`: 패키지 이름 → 설치된 정확한 버전. `checkDependencies()`(`@ohmyti/runner`)가 제출물 `package.json`을 이 목록과 대조한다.
- `lockfileDigest`: `sha256(package-lock.json)` (CRLF는 LF로 정규화)
- `environmentDigest`: `sha256("node:" + nodeVersion + "\nlockfile:\n" + lockfile + "\nrunner:" + runnerKind + "\n")`. 실행 기록의 `environmentDigest`에 쓴다. 입력이 같으면 항상 같은 값이다.

## 허용 의존성

| 패키지                          | 버전            | 용도                            |
| ------------------------------- | --------------- | ------------------------------- |
| `express`, `@types/express`     | 5.2.1 / 5.0.6   | HTTP 서버 (선택 1)              |
| `hono`, `@hono/node-server`     | 4.13.8 / 2.1.1  | HTTP 서버 (선택 2)              |
| `zod`                           | 4.6.5           | 입력 검증                       |
| `vitest`                        | 4.1.11          | 제출 테스트 러너 (유일 지원)    |
| `supertest`, `@types/supertest` | 7.2.2 / 7.2.1   | HTTP 테스트                     |
| `tsx`                           | 4.23.13         | `npm start`에서 TypeScript 실행 |
| `typescript`, `@types/node`     | 5.9.3 / 22.20.3 | 타입 검사                       |

제출물 `package.json`의 `dependencies`·`devDependencies`는 이 목록의 부분집합이어야 하고, 선언한 버전 범위(`^`, `~`, 정확한 버전 등)가 위 설치 버전을 만족해야 합니다. 목록에 없는 패키지는 `DISALLOWED_DEPENDENCY`, 범위가 맞지 않거나 semver로 해석할 수 없는 값(`latest`, `file:`, `github:`)은 `DEPENDENCY_VERSION_MISMATCH`로 거절됩니다 (T-203의 지원 여부 판정).

## 명령

```bash
pnpm template:build     # templates/*: npm ci + template.json 갱신. 두 번 실행해도 digest가 같다
pnpm template:build --no-install   # 설치를 건너뛰고 기록만 다시 계산
pnpm samples:link       # samples/order-api/impl-*/node_modules → 템플릿 node_modules 심볼릭 링크
```

의존성을 바꾸려면 `package.json`을 고친 뒤 이 디렉터리에서 `npm install --package-lock-only --ignore-scripts`로 lockfile을 갱신하고 `pnpm template:build`를 실행합니다. CI는 `pnpm template:build` 후 `templates/`에 diff가 없는지 확인합니다.

## 워커 이미지

`apps/worker/Dockerfile`의 `template` 단계가 `package.json`·`package-lock.json`·`template.json`만 복사해 `npm ci`를 실행하고, 설치된 버전이 `allowedDependencies`와 같은지 확인한 뒤 `/opt/templates/order-api-ts`로 복사합니다. 디렉터리는 root 소유이므로 워커 사용자 `runner`는 읽고 실행만 할 수 있습니다.

```bash
docker build -f apps/worker/Dockerfile -t ohmyti-worker .
docker run --rm ohmyti-worker ls /opt/templates/order-api-ts/node_modules
```
