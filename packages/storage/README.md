# @ohmyti/storage

코드 스냅샷, 이력서 원본, 실행 기록 본문을 저장하는 `ArtifactStore` 추상화와 두 구현. web·worker가 같은 인터페이스로 쓴다.

## 구성

| 파일                    | 내용                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/store.ts`          | `ArtifactStore { put, get, getStream, exists, delete, deletePrefix }`, `ArtifactMeta`, `DEFAULT_MAX_ARTIFACT_BYTES`(64 MiB)             |
| `src/keys.ts`           | 키 규약 함수 `artifactKeys`, 검증 `parseArtifactKey`·`parseArtifactPrefix`, `RUN_RECORD_PARTS`, `ARTIFACT_CONTENT_TYPES`                |
| `src/fs-store.ts`       | `FsArtifactStore` (개발·테스트). `<root>/objects/<key>` 본문, `<root>/meta/<key>.json` 메타데이터. 임시 파일 후 rename으로 원자적 쓰기  |
| `src/blob-store.ts`     | `BlobArtifactStore` (`@vercel/blob` 2.8.0). 키를 pathname으로 쓰고 `allowOverwrite`, 읽기는 `useCache: false`                           |
| `src/factory.ts`        | `createArtifactStore(env)`: `ARTIFACT_STORE`(fs·blob), `ARTIFACT_FS_ROOT`, `BLOB_READ_WRITE_TOKEN`, `BLOB_ACCESS`, `ARTIFACT_MAX_BYTES` |
| `src/errors.ts`         | `InvalidArtifactKeyError`, `ArtifactTooLargeError`, `InvalidContentTypeError`, `ArtifactStoreConfigError`                               |
| `src/contract-suite.ts` | 두 구현이 공유하는 계약 테스트 `describeArtifactStoreContract`                                                                          |

## 키 규약

```
submissions/<id>/snapshot.tar.gz
submissions/<id>/resume.pdf
evaluations/<id>/runs/<runId>/{input,expected,actual,timeline,stdout,stderr}.json
evaluations/<id>/stages/<STAGE>/<name>.json      # 단계 원본 결과 (T-204: REQUIREMENT_VERIFY의 startup·harness·serviceExit·tests)
evaluations/<id>/sandbox/<label>/                # 러너 로그 접두사 (T-204: attempt-<n>)
evaluations/<id>/mutations/<mutationId>/diff.patch
```

세그먼트는 `[A-Za-z0-9._-]`만 허용한다. `..`·`.` 세그먼트, 빈 세그먼트, 선행 `/`, 백슬래시는 `InvalidArtifactKeyError`로 거부한다. 접두사는 `submissions/<id>/`처럼 `/`로 끝나야 한다. 문자열을 직접 조립하지 말고 `artifactKeys.*`를 쓴다.

## 동작 규칙

- `put`은 `contentType`(`type/subtype`)이 필수이고 같은 키를 덮어쓴다. 불변이어야 하는 레코드(G-03)는 호출자가 새 키를 만든다.
- 크기 상한은 스토어 단위(`maxBytes`, 기본 64 MiB)이며 `put` 옵션의 `maxBytes`로 호출별로 더 줄일 수 있다. 넘으면 `ArtifactTooLargeError`이고 저장하지 않는다.
- `get`·`getStream`은 없는 키에 `null`을 돌려주고 `delete`는 없는 키에도 성공하며 `deletePrefix`는 지운 개수를 돌려준다.
- Blob 스토어는 이력서 원본이 들어가므로 `private`이 기본이다. Vercel Blob의 `list`는 최종적 일관성이 있으므로 `deletePrefix` 직후 조회에 남은 항목이 보일 수 있다.

## 테스트

```bash
pnpm --filter @ohmyti/storage test
```

Blob 계약 테스트는 `BLOB_READ_WRITE_TOKEN`이 없으면 skip으로 표시된다. 토큰이 있으면 실제 스토어의 `submissions/t<hex>-*/`·`evaluations/t<hex>-e/` 아래에 쓰고 끝나면 지운다.
