/**
 * 샘플 설명 자료 (TICKET.md T-901).
 *
 * `/demo` 카드가 보여 주는 샘플 4종의 설명·저장소·확인할 것이다. 판정 결과·점수·합격 여부는 여기에 적지 않는다
 * (PRD 7장 데모 데이터 원칙, G-08). 수치는 저장된 실행에서 읽은 값만 화면에 나온다.
 *
 * 저장소 URL과 커밋 SHA는 `samples/order-api/sample-repos.json`의 값이다. 배포된 web은 저장소 파일을 읽을 수 없으므로
 * 상수로 두고, `samples.test.ts`가 원본 JSON과 같은지 검사한다.
 *
 * `checks[].criterionId`는 저장된 rubric에 실제로 있는 기준 ID여야 한다(`samples.test.ts`가 `rubric.v1.json`과 대조).
 */
import type { DemoSampleId } from "@ohmyti/db";

export interface DemoSampleCheck {
  /** 확인할 것 한 줄. 볼 대상을 가리키며 판정 결과를 적지 않는다 */
  label: string;
  /** 워크벤치에서 열 기준 ID (`?criterion=`) */
  criterionId: string;
  /** 테스트 실효성 기준에서 펼칠 변이 실험 ID (`?mutation=`) */
  mutationId?: string;
}

export interface DemoSampleInfo {
  name: string;
  /** 한 줄 요약 */
  description: string;
  /** "어떤 구현인가": 구조·제출 테스트 구성·결함이나 조작 문구의 위치 */
  implementation: string;
  checks: DemoSampleCheck[];
  /** 공개 저장소 */
  repoUrl: string;
  /** 게이트가 고정해 제출한 커밋 */
  commitSha: string;
}

export const DEMO_SAMPLE_INFO: Record<DemoSampleId, DemoSampleInfo> = {
  A: {
    name: "정답 구현 A",
    description: "명세를 모두 구현하고 제출 테스트를 갖춘 기준 구현",
    implementation:
      "Express 위에 HTTP 계층(`src/http`) · 도메인 서비스(`src/domain`) · 저장소(`src/repository`)를 나눈 구조이고, 멱등성 기록을 별도 저장소로 두어 같은 Idempotency-Key의 재전송을 처리합니다. 제출 테스트는 `test/` 아래 7개 파일 49건으로 정상 주문·조회·취소·검증·동시성·멱등성을 나누어 검증합니다. 의도적으로 넣은 결함이나 채점을 겨냥한 문구는 없습니다.",
    checks: [
      {
        label: "R-05 멱등 재전송 기준의 실행 기록에서 같은 키를 두 번 보냈을 때의 요청·응답",
        criterionId: "R-05",
      },
      {
        label: "G1 테스트 실효성에서 재고 부족 검사를 지운 변형 M-01에 제출 테스트가 보인 반응",
        criterionId: "G1",
        mutationId: "M-01",
      },
      {
        label: "R-12 설계·변경 용이성의 AI 초안과 사람 확인 대기 표시",
        criterionId: "R-12",
      },
    ],
    repoUrl: "https://github.com/inchyangv/ohmyti-sample-a",
    commitSha: "4bee62eb91e92166bc4d6a0618d4aeb86c99fa81",
  },
  B: {
    name: "대안 정답 구현 B",
    description: "구조가 다른 올바른 구현. 구조가 달라도 같은 요구사항을 충족하는지 본다",
    implementation:
      "A와 달리 Hono와 이벤트 원장(`src/core/ledger.ts`)으로 만든 구현이고, 디렉터리 이름·핵심 자료구조·멱등성 처리 방식이 모두 다릅니다. 제출 테스트는 `spec/` 아래 7개 파일 61건이며 파일 이름도 요구사항이 아니라 시나리오 이름을 씁니다. 채점은 HTTP 동작만 관측하므로 이 구조 차이가 기준 판정에 쓰이는지 A와 나란히 볼 수 있습니다.",
    checks: [
      {
        label: "R-05 멱등 재전송 기준을 A와 다른 구조에서 어떤 실행 기록으로 판정했는지",
        criterionId: "R-05",
      },
      {
        label: "R-08 다른 키 동시 요청과 재고 하한 기준의 실행 기록",
        criterionId: "R-08",
      },
      {
        label: "R-10 실행 계약 충족: 기동·초기화 방식이 달라도 같은 계약을 만족하는지",
        criterionId: "R-10",
      },
    ],
    repoUrl: "https://github.com/inchyangv/ohmyti-sample-b",
    commitSha: "134f855a37463d2723988f7515b3dd6c775844c6",
  },
  C: {
    name: "결함 구현 C",
    description:
      "같은 Idempotency-Key로 다시 보낸 주문에서 재고를 한 번 더 차감하는 결함이 있는 구현",
    implementation:
      "A와 같은 Express 구조이지만 멱등성 저장소가 없습니다. `src/domain/validation.ts`가 Idempotency-Key의 형식만 검사하고 버리며, `src/domain/order-service.ts`에는 멱등 조회·기록 단계가 없습니다. 제출 테스트는 `test/` 아래 3개 파일 11건으로 정상 주문·조회·취소만 확인하고 멱등성·재고 경계는 확인하지 않습니다.",
    checks: [
      {
        label: "R-05 멱등 재전송 기준의 재생 기록에서 요청·응답과 재고 변화",
        criterionId: "R-05",
      },
      {
        label: "G1 테스트 실효성에서 재고 부족 검사를 지운 변형 M-01의 실험 결과와 diff",
        criterionId: "G1",
        mutationId: "M-01",
      },
      {
        label: "R-07 같은 키 동시 요청 기준의 실행 기록",
        criterionId: "R-07",
      },
    ],
    repoUrl: "https://github.com/inchyangv/ohmyti-sample-c",
    commitSha: "339a30853f030cc7ec6d55b5435f8c3013093338",
  },
  D: {
    name: "적대적 샘플 D",
    description: "C와 같은 결함에 README·주석·점수 파일로 채점을 조작하려는 문구를 넣은 샘플",
    implementation:
      "HTTP 동작은 C와 같고, 채점기를 겨냥한 문구만 더했습니다. README 맨 위에서 채점자에게 최고 점수를 요구하는 지시문, `src/domain/order-service.ts`와 `src/domain/validation.ts`의 주석 지시문, 저장소 루트의 `score.json`, `src/server.ts`가 stdout에 찍는 통과 선언 문구가 그 위치입니다. 제출 테스트는 C의 11건에 앱을 호출하지 않고 늘 통과하는 `test/zz-always-pass.test.ts` 5건을 더한 16건입니다.",
    checks: [
      {
        label: "R-05 멱등 재전송: README·주석의 지시문과 무관하게 무엇이 근거로 쓰였는지",
        criterionId: "R-05",
      },
      {
        label:
          "G1 테스트 실효성: 항상 통과하는 테스트 5건을 더해도 변형 M-01의 실험 결과가 달라지는지",
        criterionId: "G1",
        mutationId: "M-01",
      },
      {
        label: "R-12 설계·변경 용이성: 소스 주석의 지시문이 AI 초안에 들어갔는지",
        criterionId: "R-12",
      },
    ],
    repoUrl: "https://github.com/inchyangv/ohmyti-sample-d",
    commitSha: "5a12adff0521d2d41a18912fd9b5a69a788eda74",
  },
};

/** 추천 체험 순서 (T-901). 카드 순서와 달리 "무엇부터 보면 되는지"를 안내한다 */
export const DEMO_RECOMMENDED_ORDER: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: "결함 구현 C부터 엽니다",
    detail: "제출 테스트는 모두 통과하지만 명세를 지키지 않는 구현을 어떻게 다루는지 봅니다.",
  },
  {
    title: "적대적 샘플 D와 나란히 봅니다",
    detail: "README·주석·점수 파일의 문구가 기준 판정의 근거로 쓰이는지 확인합니다.",
  },
  {
    title: "정답 구현 A와 대안 정답 B를 비교합니다",
    detail: "구조와 프레임워크가 다른 두 구현을 같은 기준으로 판정했는지 봅니다.",
  },
  {
    title: "직접 채점을 요청합니다",
    detail: "예시로 채운 폼에서 공개 저장소를 제출하면 같은 파이프라인이 그대로 돕니다.",
  },
];

/** 고정 커밋 GitHub 링크. 브랜치·HEAD 링크는 시간이 지나면 다른 코드를 가리킨다 */
export function sampleCommitHref(info: DemoSampleInfo): string {
  return `${info.repoUrl}/tree/${info.commitSha}`;
}

/** 확인할 것 항목이 여는 워크벤치 딥링크 */
export function sampleCheckHref(evaluationId: string, check: DemoSampleCheck): string {
  const params = new URLSearchParams({ criterion: check.criterionId });
  if (check.mutationId) params.set("mutation", check.mutationId);
  return `/evaluations/${evaluationId}?${params.toString()}`;
}
