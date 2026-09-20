/**
 * 가상 지원자 페르소나 자료 (TICKET.md T-902·T-905).
 *
 * 원본은 `samples/personas/<핸들>/persona.md`와 `packages/context/src/testing/personas.ts`다. 배포된 web은 저장소 파일을
 * 읽을 수 없으므로 화면에 쓰는 값만 상수로 옮겼고, `personas.test.ts`가 원본과 같은지 검사한다.
 *
 * 네 사람은 모두 지어낸 인물이다. 카드 문구에 점수·판정을 적지 않는다 (PRD 7장, G-08).
 */
export const PERSONA_HANDLES = ["seojin", "taeyun", "gaeun", "dohyun"] as const;
export type PersonaHandle = (typeof PERSONA_HANDLES)[number];

export function isPersonaHandle(value: unknown): value is PersonaHandle {
  return typeof value === "string" && (PERSONA_HANDLES as readonly string[]).includes(value);
}

/** 네 페르소나가 공유하는 조직 프로필 (samples/personas/README.md "알려진 한계") */
export const PERSONA_PROFILE_URL = "https://github.com/wanted-hack-inchyangv";

export interface PersonaInfo {
  handle: PersonaHandle;
  /** 화면에 보이는 이름 */
  name: string;
  /** 인물 설정 한 줄 */
  profile: string;
  /** 이력서와 GitHub 활동의 특징 */
  context: string;
  /** 이 페르소나로 확인할 것 */
  checks: string[];
  repoUrl: string;
  commitSha: string;
  githubProfileUrl: string;
}

export const PERSONA_INFO: Record<PersonaHandle, PersonaInfo> = {
  seojin: {
    handle: "seojin",
    name: "한서진 · 시니어",
    profile: "재고 선점과 초과 판매 방지를 오래 다뤄 온 백엔드 개발자로 설정했습니다.",
    context:
      "이력서에 재고 선점·멱등성 키 미들웨어·Kafka 이벤트 파이프라인 경험을 적었고, 그중 앞의 두 가지는 조직 프로필의 포트폴리오 저장소(`seojin-stock-reservation`, `seojin-idempotency-kit`)로 이어집니다.",
    checks: [
      "이력서 주장마다 어떤 저장소·커밋이 근거로 붙었는지",
      "근거가 없는 주장(이벤트 파이프라인)을 화면이 어떻게 표시하는지",
      "인터뷰 키트의 이력서 연결 질문이 어떤 기준과 이어지는지",
    ],
    repoUrl: "https://github.com/wanted-hack-inchyangv/seojin-order-api",
    commitSha: "d35969b619823452e5edc9bf23ed75dc8f596219",
    githubProfileUrl: PERSONA_PROFILE_URL,
  },
  taeyun: {
    handle: "taeyun",
    name: "오태윤 · 주니어",
    profile: "회의실 예약 서비스와 사내 CLI를 만들어 본 주니어 개발자로 설정했습니다.",
    context:
      "이력서에 시간대 중복 예약 방지, 결제 웹훅 멱등 처리, 팀 생산성 CLI를 적었고 포트폴리오 저장소는 `taeyun-room-booking`·`taeyun-til-cli`입니다. 과제 제출물은 멱등 키 충돌과 같은 키 동시 요청을 설계에서 빠뜨리도록 만들었습니다.",
    checks: [
      "멱등 키 충돌(R-06)과 같은 키 동시 요청(R-07) 기준의 실행 기록",
      "실패 디브리핑 질문이 어떤 재생 기록을 근거로 삼는지",
      "이력서의 웹훅 멱등 처리 주장과 과제 결과가 인터뷰 키트에서 어떻게 이어지는지",
    ],
    repoUrl: "https://github.com/wanted-hack-inchyangv/taeyun-order-api",
    commitSha: "4c595e36efb5489dd0234d834cfdb583048ccfc1",
    githubProfileUrl: PERSONA_PROFILE_URL,
  },
  gaeun: {
    handle: "gaeun",
    name: "문가은 · 신입",
    profile: "프런트엔드 과제를 주로 해 오다 백엔드를 배우기 시작한 신입 개발자로 설정했습니다.",
    context:
      "이력서에 React·TypeScript 경험과 Express REST API 학습을 적고 동시성 제어·멱등성 설계 경험도 주장합니다. 포트폴리오 저장소는 `gaeun-todo-react`·`gaeun-bookmark-api`이며, 과제 제출물은 입력 검증과 멱등성 전체, 취소 시 재고 복구를 빠뜨리도록 만들었습니다.",
    checks: [
      "입력 검증(R-04)과 재고 복구(R-09) 기준의 실행 기록",
      "대상 기준이 이미 실패한 변이 그룹을 화면이 미확정으로 남기는 방식",
      "이력서 주장과 실제 관측이 갈리는 항목을 하단 `이력서 연결` 탭이 어떻게 보이는지",
    ],
    repoUrl: "https://github.com/wanted-hack-inchyangv/gaeun-order-api",
    commitSha: "dbff20e9379a5f61aca6317451221a539e53dfbf",
    githubProfileUrl: PERSONA_PROFILE_URL,
  },
  dohyun: {
    handle: "dohyun",
    name: "백도현 · 미들",
    profile: "SI 프로젝트에서 납기를 맞춰 온 미들 개발자로 설정했습니다.",
    context:
      "이력서에 매출 보고서 자동화, 클린 아키텍처와 TDD 적용을 적었고 포트폴리오 저장소는 `dohyun-report-batch`·`dohyun-board-api`입니다. 과제 제출물은 요구사항을 모두 만족하되 제출 테스트가 결함을 잡지 못하고 라우팅과 도메인 규칙이 한 콜백에 몰리도록 만들었습니다.",
    checks: [
      "테스트 실효성 그룹 G1~G3에서 변이 M-01~M-05가 어떻게 다뤄졌는지",
      "설계·변경 용이성(R-12)의 코드 신호(명시적 any, 바쁜 대기, 중복 블록)와 코드 위치",
      "채용 리포트가 실행 기준과 테스트 실효성을 어떻게 나누어 보이는지",
    ],
    repoUrl: "https://github.com/wanted-hack-inchyangv/dohyun-order-api",
    commitSha: "3cf84691d53c2112bce57881ffde66b8c5a79c4a",
    githubProfileUrl: PERSONA_PROFILE_URL,
  },
};
