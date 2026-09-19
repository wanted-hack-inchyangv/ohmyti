# @ohmyti/llm

LLM 어댑터. 이후 모든 LLM 호출(TICKET.md 1.5의 네 곳: 기준 초안, mutation 대상 후보, 근거 서술·리뷰, 맥락 연결)은 이 패키지의 `LlmClient`만 사용한다. 점수 계산과 PASS/FAIL 판정에는 쓰지 않는다 (G-01). 워커 전용이며 `apps/web`은 이 패키지에 의존할 수 없다 (`pnpm deps:boundary-check`).

## 구성

| 파일                  | 내용                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`        | `LlmClient.complete<T>({ purpose, promptVersion, system, input, schema, example?, maxTokens })` → `{ output, model, usage, costUsd, requestId, attempts }` |
| `src/structured.ts`   | 공통 구조화 출력 규칙 `completeStructured()`: JSON Schema·예시·데이터 경계를 시스템 프롬프트에 붙이고, JSON 파싱 → zod 검증 → 실패 시 1회 재요청           |
| `src/deepseek.ts`     | `DeepSeekLlmClient` (`openai` 7.18.0, `baseURL = LLM_BASE_URL`)                                                                                            |
| `src/fake.ts`         | `FakeLlmClient`: purpose별 고정 응답(`output`·`raw`·`error`, 배열·함수). 모든 단위 테스트가 쓴다                                                           |
| `src/recording.ts`    | `RecordingLlmClient`: 호출마다 `ai_reviews`에 한 행. `llmInputDigest()`, `createDbAiReviewSink(db)`                                                        |
| `src/budget.ts`       | `LlmBudget`·`BudgetedLlmClient`: evaluation당 호출 수·비용 상한. 초과 시 `LlmBudgetExceededError`                                                          |
| `src/outcome.ts`      | `llmStepOutcome()`: 오류를 `OK`·`INCONCLUSIVE`·`NOT_RUN`(LLM 미실행)으로 바꾼다. 파이프라인은 LLM 실패로 멈추지 않는다                                     |
| `src/prompt.ts`       | `untrusted(label, text)`, `UNTRUSTED_DATA_NOTICE`, `definePrompt()`(프롬프트 버전 = 상수 + 본문 해시)                                                      |
| `src/output-guard.ts` | 출력 스키마 금지 키(`score`, `points`, `earned`, `verdict`)를 타입(`ForbidScoreKeys`)과 실행 시점 양쪽에서 막는다                                          |
| `src/pricing.ts`      | DeepSeek 가격표(확인 날짜 포함)와 `computeDeepSeekCostUsd()`                                                                                               |
| `src/factory.ts`      | `createLlmClient(env)`(`LLM_PROVIDER`: `deepseek`·`fake`), `createEvaluationLlmClient()`(예산 → 기록 → 제공자)                                             |

## 사용

```ts
const base = createLlmClient(process.env);
const llm = createEvaluationLlmClient({
  base,
  sink: createDbAiReviewSink(db),
  scope: { evaluationId, submissionId },
  limits: llmBudgetLimitsFromEnv(process.env),
});
const PROMPT = definePrompt({
  purpose: "EVIDENCE_REVIEW",
  id: "evidence-review",
  version: 1,
  system: "...",
});

const outcome = await llmStepOutcome(() =>
  llm.complete({
    ...PROMPT,
    input: { readme: untrusted("README.md", readme), failing: "R-03" },
    schema: EvidenceNoteSchema,
    example: EXAMPLE_NOTE,
    maxTokens: 2048,
  }),
);
if (outcome.status !== "OK") {
  // INCONCLUSIVE: 미확정으로 남긴다 (0점 아님, G-04). NOT_RUN: "LLM 미실행"으로 표시한다.
}
```

## 동작 규칙

- 구조화 출력: `response_format: { type: "json_object" }`, `temperature: 0`, `thinking: { type: "disabled" }`. 시스템 프롬프트에 zod 스키마의 JSON Schema(`z.toJSONSchema`)와 예시, `json` 단어가 들어간다. 파싱·검증 실패 시 오류 내용을 붙여 1회 재요청하고, 그래도 실패하면 `LlmOutputInvalidError`.
- `finish_reason`이 `stop`이 아니면(`length` 등) 잘린 JSON을 고치지 않고 `LlmIncompleteOutputError`를 던진다. 재요청하지 않는다.
- 기록: 성공은 검증된 출력을, 실패는 `{ error: { name, message } }`와 과금된 사용량을 `ai_reviews`에 남긴다. 예산 초과와 금지 키 스키마는 API를 호출하지 않았으므로 남기지 않는다.
- `input_digest`: 용도·프롬프트 버전·시스템 프롬프트·입력·출력 JSON Schema·예시의 정규화 JSON(`canonicalJson`) sha256. 모델과 `max_tokens`는 제외한다.
- 예산: 호출 수는 `complete()` 단위(재요청 포함 1회)로 세고, 비용은 실패한 호출도 더한다. 비용은 호출 후에만 알 수 있어 상한을 넘긴 다음 호출부터 막는다.
- 비용: 캐시 적중·미적중 입력과 출력을 따로 계산하고 피크 시간(평일 UTC 01–04시, 06–10시) 외에는 50%를 적용한다. 가격표에 없는 모델은 가장 비싼 피크 단가로 계산한다. 과대 계산 쪽으로 틀린다.
- API 오류 메시지에는 상태 코드와 오류 유형만 남기고 응답 본문을 넣지 않는다.

## 확인한 공식 문서 (2026-09-19)

- https://api-docs.deepseek.com/quick_start/pricing : 모델 `deepseek-flash`(V4.1-Flash), `deepseek-v4-pro`, 단가, 피크 시간, 오프피크 50%
- https://api-docs.deepseek.com/guides/json_mode : `response_format`, 프롬프트에 `json`과 예시 필요, 빈 응답 가능성, `max_tokens`로 잘림 방지
- https://api-docs.deepseek.com/api/create-chat-completion : `thinking`(기본 enabled, 사고 모드에서 temperature 무시), `max_tokens` 기본 8K(비사고), `finish_reason` 값, `usage.prompt_cache_hit_tokens`
- `GET /models` 실제 조회 결과는 `deepseek-flash`, `deepseek-v4-pro` 두 개다. 기본 모델 `deepseek-chat`은 목록에 없지만 여전히 받아들여지고 `deepseek-flash`가 응답한다. 실제 호출로 확인했다.

## 테스트

```bash
pnpm --filter @ohmyti/llm test                    # 단위 테스트(FakeLlmClient·전송 함수 주입, 네트워크 없음) + ai_reviews 통합(DATABASE_URL_TEST)
LLM_INTEGRATION=1 pnpm --filter @ohmyti/llm test  # 실제 DeepSeek 호출 1건 추가 (.env의 DEEP_SEEK_API_KEY)
```
