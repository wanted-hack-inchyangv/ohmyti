# @ohmyti/analysis

TypeScript AST 분석. 1부(T-304)는 관련 함수 그래프, 2부(T-402)는 mutation 카탈로그·적용기다. 워커만 의존한다. web은 G-05·`deps:boundary-check`로 금지된다.

## 관련 함수 그래프 (T-304)

`analyzeFunctionGraph({ files, cases, nodeModulesDir?, limits?, maxSubgraphNodes? })` → `{ analysis: FunctionGraphAnalysis, handlerSnippets }`

`handlerSnippets`(핸들러 id → 코드 원문)는 핸들러 `location` 범위의 파일 줄 전체다. 노드 텍스트가 아니다. 코드 근거 뷰어(T-305)가 라인 번호와 함께 그대로 보여 주므로 스냅샷 파일의 해당 줄과 같아야 한다. 60줄·4000자를 넘으면 끝에 `…` 줄을 붙여 자른다.

| 모듈                | 역할                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.ts`        | 스냅샷 파일(`AnalysisFiles`: 러너의 `SubmissionFiles`와 같은 형태)을 일회성 임시 디렉터리에 쓰고 템플릿 `node_modules`를 심볼릭 링크로 붙여 ts-morph `Project`로 연다. 컴파일러 옵션은 고정되어 있다. 제출물 tsconfig를 읽지 않는다. 파일 수·바이트 상한(`PROJECT_LIMIT_DEFAULTS` 500개·20 MiB). 실행은 하지 않는다                |
| `call-graph.ts`     | 함수 노드(함수 선언·메서드·생성자·변수/속성에 대입된 화살표 함수·라우트 핸들러 인라인 함수), 라우트 등록(`x.get/post/put/patch/delete/options/head/all("<경로>", …핸들러)`, 마지막 인자가 핸들러, `use`/`route` 마운트 접두사 한 단계), 프로젝트 내부 호출 간선. 인터페이스·타입 리터럴 멤버 호출은 언어 서비스의 구현 찾기로 푼다 |
| `routes.ts`         | 라우트 패턴 ↔ 실제 요청 경로 매칭 (`:param`, `:param{regex}`, `*`, 세그먼트 `?`), 쿼리 제거, 접두사 결합, method 매칭(`ALL`, `HEAD`→`GET`)                                                                                                                                                                                         |
| `subgraph.ts`       | 케이스 서브그래프: timeline 요청 → 매치된 라우트의 핸들러(루트, 준비 요청 `reset`은 본 요청이 있으면 제외) → BFS 깊이 순 최대 12개(`MAX_SUBGRAPH_NODES`). `observed`는 timeline 요청이 매치된 핸들러에만 붙는다                                                                                                                    |
| `function-graph.ts` | 진입점. 문법 오류(파싱 진단)·파일 한도·라우트 없음·예외는 던지지 않고 `status: "unavailable"` + 사유로 돌려준다                                                                                                                                                                                                                    |

| `isolated.ts`·`child.ts` | `analyzeFunctionGraphIsolated`: 같은 분석을 `child_process.fork`로 띄운 자식에서 돌린다(IPC advanced 직렬화). ts-morph가 동기로 수백 ms~수 초를 점유하므로 호출 프로세스의 이벤트 루프를 막지 않고, 힙 상한(`--max-old-space-size`, 기본 1024 MiB)과 제한 시간(기본 120초)을 둔다. 소스 실행(tsx·vitest)이면 `child.ts`를 `--import tsx`로, 번들이면 옆의 `analysis-child.js`(워커 esbuild entry)를 띄운다. 실패는 모두 `unavailable` |

결과 형태는 `@ohmyti/core`의 `FunctionGraphAnalysisSchema`다. web이 읽는다. 노드 id는 `<path>:<startLine>-<endLine>`.

정적 관계와 관측을 구분한다: 간선은 AST의 호출 관계이고, 핸들러가 부른 함수가 실제로 실행됐는지는 관측하지 않았으므로 `observed`를 붙이지 않는다. 같은 스냅샷·같은 요청 목록이면 결과가 같다.

## Mutation 카탈로그와 적용기 (T-402)

`applyMutations({ files, mutationIds?, llm?, logger?, nodeModulesDir?, limits? })` → `MutationApplyResult[]` (요청 순서, 기본은 카탈로그 M-01~M-05 순서). evaluation당 5개 상한(`MAX_MUTATIONS_PER_EVALUATION`)을 넘는 요청은 `OVER_LIMIT`.

| 변형 | 대상      | 1차 휴리스틱 (대상 요청의 핸들러에서 도달 가능한 함수 안)                                                                                                                        | 변형                                                   |
| ---- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| M-01 | R-03 (G1) | `POST /orders`: 수량 계열(`quantity·qty·amount·count`)과 재고 계열(`stock·inventory·available·remaining`)을 비교하는 관계식이 조건에 있고 then 쪽이 `throw`·`return`인 보호 `if` | `if` 문 제거 (else가 있으면 조건을 `false`로)          |
| M-02 | R-04 (G1) | `POST /orders`: 수량 계열 `x <= 0`·`x < 1`·`0 >= x`·`1 > x`                                                                                                                      | `x < 0` / `0 > x`                                      |
| M-03 | R-05 (G2) | `POST /orders`: 수신자 이름에 `idempot`이 있는 `.get()`·`.has()`이고 결과를 쓴다                                                                                                 | 조회를 `undefined`(`await` 포함)·`false`로             |
| M-04 | R-06 (G2) | `POST /orders`: M-03 조회 결과로 초기화된 변수의 속성과 비교하는 `===`·`!==` (리터럴 비교 제외)                                                                                  | 비교를 "같다"로 고정 (`!==` → `false`, `===` → `true`) |
| M-05 | R-09 (G3) | `POST /orders/:id/cancel`: 재고 계열 이름의 호출, 수량 인자가 있는 복구 계열 호출(`release`·`restore` 등, 잠금 `release()`는 제외), 재고 계열 대상의 `+=`·`++` 문장              | 문장 제거                                              |

- 후보 순서는 핸들러에서 가까운 함수(BFS 순) → 파일 경로 → 위치이며 첫 후보 1개만 쓴다. 주석은 보지 않는다. 샘플의 `M-0x` 표식 주석에 기대지 않는다.
- 2차(`llm`이 있고 1차 후보가 없을 때): `MUTATION_TARGETS` 용도로 `{ candidates: [{ file, line, nodeKind, reason }] }`를 받는다. 소스(테스트 파일 제외, 6만 자 상한)는 라인 번호를 붙여 `untrusted()` 블록으로 보낸다. 후보는 파일(변형 가능한 소스인지) → 라인 존재 → 받는 노드 종류 → 그 라인에서 시작하는 그 종류의 노드 → 느슨한 조건(`llmAccept`, 도달 가능성은 요구하지 않는다) 순으로 검증하고 실패하면 사유와 함께 `discardedCandidates`와 `logger.warn`("mutation 위치 LLM 후보 버림")에 남긴다.
- 변형은 원문 텍스트 편집이다. `diff`는 한 덩어리 unified diff(앞뒤 3줄 문맥), `patchDigest`는 diff의 sha256이라 같은 스냅샷·같은 변형이면 같다.
- 사전 검사: diff가 비면 `NOT_APPLICABLE(EMPTY_DIFF)`. 고정 컴파일러 옵션의 ts-morph 진단을 변형 전후로 비교해 새 오류가 있으면 `BUILD_FAIL`(`buildErrors`). 제출물의 tsconfig와 `tsc` 바이너리는 쓰지 않는다.
- 대상이 없으면 `NOT_APPLICABLE` + `reason: "대상 로직 없음"`(`NO_TARGET`). LLM이 예산 초과·오류로 판단하지 못했으면 `대상 위치 탐색 불가`(`LOCATE_FAILED`)로 구분한다. 어느 경우에도 가짜 변형을 만들지 않는다.
- 테스트 파일(`*.test.*`, `*.spec.*`, `__tests__/`·`test/`·`tests/`·`spec/` 아래)과 `*.config.*`는 탐색·변형 대상이 아니다.
- `mutantFiles(base, result)`: 원본 공급자 위에 변형 파일을 겹친다. `writeMutantDirectory({ sourceDir, targetDir, result })`: 풀어 둔 스냅샷을 복사하고(`node_modules`·`.git`·심볼릭 링크 제외) 바뀐 파일만 덮어쓴다.

## 검증

```bash
pnpm --filter @ohmyti/analysis test   # 샘플 A(express)·B(hono)·C에서 POST /orders 핸들러 위치, 12개 상한, 관측 노드, 문법 오류 → 분석 불가
pnpm --filter @ohmyti/analysis test -- mutation   # 샘플 A/B 5개 적용, C/D의 M-03·M-04 대상 로직 없음, 연산자별 픽스처, LLM 후보 검증(Fake)
```
