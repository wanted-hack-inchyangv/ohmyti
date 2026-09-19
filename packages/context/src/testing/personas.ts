/**
 * 페르소나 4종의 GitHub 근거 선정 회귀 fixture (TICKET.md T-603).
 *
 * - `PERSONA_ORG_REPOS`: 조직 프로필 `wanted-hack-inchyangv`의 공개 저장소 목록 스냅샷(2026-09-19, 최근 push 순 14개).
 *   이름·설명·토픽·주 언어·push 시각만 둔다. 인기도 필드는 없다(가짜 API가 섞어 넣는다).
 * - `PERSONA_RESUME_TEXTS`: `samples/personas/<핸들>/resume.pdf`를 `extractResumeText`로 추출한 텍스트 그대로다.
 * - `PERSONA_EXPECTED`: 페르소나별 제출 저장소(이름 변경 전 URL 포함)와 근거로 선택되어야 하는 포트폴리오 2개.
 *
 * 네 페르소나가 조직 프로필 하나를 공유하므로, 키워드만으로 고르면 다른 페르소나의 저장소와 과제 제출물이 섞여 들어온다.
 */
import type { FakeProfile, FakeProfileRepo } from "./github";

export const PERSONA_ORG_LOGIN = "wanted-hack-inchyangv";

export const PERSONA_HANDLES = ["seojin", "dohyun", "taeyun", "gaeun"] as const;
export type PersonaHandle = (typeof PERSONA_HANDLES)[number];

export const PERSONA_ORG_REPOS: FakeProfileRepo[] = [
  {
    name: "ohmyti",
    description:
      "CodeGraph Reviewer: 채용 과제 저장소를 실제로 실행해 요구사항을 판정하는 채점 워크벤치",
    language: "TypeScript",
    topics: [],
    pushedAt: "2026-09-19T14:31:40Z",
  },
  {
    name: ".github",
    description: null,
    language: null,
    topics: [],
    pushedAt: "2026-09-19T13:27:54Z",
  },
  {
    name: "dohyun-report-batch",
    description:
      "매출 CSV를 집계하여 일별·상품별 보고서를 자동으로 생성하는 Node.js 배치 스크립트 (TypeScript)",
    language: "TypeScript",
    topics: ["batch", "csv", "nodejs", "report", "typescript"],
    pushedAt: "2026-09-19T13:12:41Z",
  },
  {
    name: "dohyun-order-api",
    description: "주문 재고 API 과제 (Express)",
    language: "TypeScript",
    topics: ["assignment", "express", "typescript"],
    pushedAt: "2026-09-19T13:08:20Z",
  },
  {
    name: "dohyun-board-api",
    description: "게시판 REST API: 게시글·댓글 CRUD와 페이징, JSON 파일 저장 (Express, TypeScript)",
    language: "TypeScript",
    topics: ["board", "crud", "express", "rest-api", "typescript"],
    pushedAt: "2026-09-19T13:06:00Z",
  },
  {
    name: "gaeun-order-api",
    description: "주문 재고 API 과제",
    language: "TypeScript",
    topics: ["assignment", "express"],
    pushedAt: "2026-09-19T12:59:09Z",
  },
  {
    name: "taeyun-order-api",
    description: "주문·재고 API 과제 제출 (Express, TypeScript)",
    language: "TypeScript",
    topics: ["assignment", "express", "typescript"],
    pushedAt: "2026-09-19T12:59:07Z",
  },
  {
    name: "seojin-order-api",
    description: "주문·재고 API 과제 제출물 (TypeScript, Node.js http)",
    language: "TypeScript",
    topics: ["assignment", "nodejs", "typescript"],
    pushedAt: "2026-09-19T12:59:06Z",
  },
  {
    name: "seojin-idempotency-kit",
    description:
      "HTTP API용 멱등성 키 미들웨어: 요청 지문 비교, 진행 중 요청 병합, 키 충돌 감지, Express·Hono 어댑터 (TypeScript)",
    language: "TypeScript",
    topics: ["api", "express", "hono", "idempotency", "middleware", "typescript"],
    pushedAt: "2026-09-19T12:35:05Z",
  },
  {
    name: "seojin-stock-reservation",
    description:
      "재고 선점(예약) 서비스: TTL 기반 예약과 낙관적 잠금으로 동시 주문의 초과 판매를 방지 (TypeScript, Hono)",
    language: "TypeScript",
    topics: ["concurrency", "hono", "inventory", "optimistic-locking", "reservation", "typescript"],
    pushedAt: "2026-09-19T12:19:47Z",
  },
  {
    name: "gaeun-todo-react",
    description: "React + TypeScript로 만든 할 일 관리 앱: localStorage 저장, 필터와 정렬 (Vite)",
    language: "TypeScript",
    topics: ["frontend", "react", "todo", "typescript", "vite"],
    pushedAt: "2026-09-19T12:19:03Z",
  },
  {
    name: "gaeun-bookmark-api",
    description: "부트캠프 백엔드 과정 프로젝트: Express로 만든 북마크 CRUD REST API (TypeScript)",
    language: "TypeScript",
    topics: ["bootcamp", "crud", "express", "nodejs", "rest-api"],
    pushedAt: "2026-09-19T12:13:56Z",
  },
  {
    name: "taeyun-til-cli",
    description:
      "TIL(Today I Learned) 마크다운을 관리하는 Node.js CLI: 작성, 태그 검색, 주간 요약 (TypeScript)",
    language: "TypeScript",
    topics: ["cli", "markdown", "nodejs", "productivity", "typescript"],
    pushedAt: "2026-09-19T12:12:22Z",
  },
  {
    name: "taeyun-room-booking",
    description: "회의실 예약 REST API: 시간대 중복 검사와 zod 입력 검증 (Express, TypeScript)",
    language: "TypeScript",
    topics: ["booking", "express", "rest-api", "typescript", "zod"],
    pushedAt: "2026-09-19T12:09:20Z",
  },
];

/**
 * 가짜 GitHub API용 조직 프로필(`owner.type` `Organization`). 모든 저장소에 README·커밋 하나를 둔다.
 * 조직은 커밋 작성자가 될 수 없으므로 `?author=<조직>` 조회는 0건이다(실측, T-604)
 */
export function personaOrgProfile(): FakeProfile {
  return {
    login: PERSONA_ORG_LOGIN,
    type: "Organization",
    repos: PERSONA_ORG_REPOS.map((repo, i) => ({
      ...repo,
      readme: `# ${repo.name}\n`,
      languages: repo.language ? { [repo.language]: 1000 } : {},
      files: [{ name: "README.md", type: "file" as const }],
      commits: [
        {
          sha: (i + 1).toString(16).padStart(40, "0"),
          message: `init ${repo.name}`,
          date: repo.pushedAt ?? "2026-09-19T00:00:00Z",
          // 작성자는 조직이 아닌 개인 계정이다(조직은 커밋 작성자가 될 수 없다)
          author: "persona-member",
        },
      ],
      pulls: [],
    })),
  };
}

export const PERSONA_EXPECTED: Record<
  PersonaHandle,
  {
    /** 제출 저장소의 현재 이름 */
    submissionRepo: string;
    /** 제출 당시 URL의 이름 (GitHub가 현재 이름으로 리디렉션한다) */
    submittedAs: string;
    portfolio: [string, string];
  }
> = {
  seojin: {
    submissionRepo: `${PERSONA_ORG_LOGIN}/seojin-order-api`,
    submittedAs: `${PERSONA_ORG_LOGIN}/order-api-seojin`,
    portfolio: [
      `${PERSONA_ORG_LOGIN}/seojin-idempotency-kit`,
      `${PERSONA_ORG_LOGIN}/seojin-stock-reservation`,
    ],
  },
  dohyun: {
    submissionRepo: `${PERSONA_ORG_LOGIN}/dohyun-order-api`,
    submittedAs: `${PERSONA_ORG_LOGIN}/dohyun-order-api`,
    portfolio: [
      `${PERSONA_ORG_LOGIN}/dohyun-board-api`,
      `${PERSONA_ORG_LOGIN}/dohyun-report-batch`,
    ],
  },
  taeyun: {
    submissionRepo: `${PERSONA_ORG_LOGIN}/taeyun-order-api`,
    submittedAs: `${PERSONA_ORG_LOGIN}/order-api-taeyun`,
    portfolio: [`${PERSONA_ORG_LOGIN}/taeyun-room-booking`, `${PERSONA_ORG_LOGIN}/taeyun-til-cli`],
  },
  gaeun: {
    submissionRepo: `${PERSONA_ORG_LOGIN}/gaeun-order-api`,
    submittedAs: `${PERSONA_ORG_LOGIN}/order-api-gaeun`,
    portfolio: [`${PERSONA_ORG_LOGIN}/gaeun-bookmark-api`, `${PERSONA_ORG_LOGIN}/gaeun-todo-react`],
  },
};

/** `samples/personas/<핸들>/resume.pdf`의 추출 텍스트 (EXTRACTED) */
export const PERSONA_RESUME_TEXTS: Record<PersonaHandle, string> = {
  seojin:
    "한서진 Han Seojin\n시니어 백엔드 엔지니어 (Senior Backend Engineer) · 7년차\nEmail seojin.han@example.com\nPhone 010-0000-0000\nGitHub github.com/wanted-hack-inchyangv\n소개 (SUMMARY)\n7년간 주문·재고·결제 도메인의 백엔드 시스템을 설계하고 운영해 온 시니어 백엔드 엔지니어입니다. 동시성 제어(concurrency control),\n멱등성 설계(idempotency), 이벤트 기반 아키텍처(event-driven architecture)를 핵심 강점으로 삼아, 트래픽이 몰리는 주문 처리 구간에\n서 정합성을 지키는 시스템을 만드는 데 집중해 왔습니다. 장애가 나기 전에 테스트로 잡아내는 것을 원칙으로 삼고, 경계값과 동시 요청 시\n나리오를 검증하는 테스트 설계(test design)에 특히 공을 들입니다.\n기술 스택 (SKILLS)\nLanguage TypeScript, Node.js, SQL\nBackend Express, Hono, REST API 설계, 동시성 제어(concurrency control), 멱등성 설계(idempotency)\nMessaging Kafka(이벤트 기반 아키텍처, event-driven architecture), Redis\nData PostgreSQL, 낙관적 잠금(optimistic locking), 트랜잭션 설계\nTesting Vitest, 동시성 테스트(concurrency test), 계약 테스트(contract test)\n경력 (EXPERIENCE)\n루멘커머스 주문·재고 플랫폼팀 · 시니어 백엔드 엔지니어 2021.03 현재\n주문·재고 서비스의 동시 주문 처리 구간에서 초과 판매(overselling)가 반복적으로 발생하는 문제를 맡아, 상품 단위 재고 선점(stock\nreservation) 시스템을 설계해 도입했습니다. TTL 기반 예약과 버전 비교(version check) 기반의 낙관적 잠금(optimistic locking)으\n로 재고 차감을 직렬화한 결과, 피크 트래픽 구간에서 동시 주문으로 인한 초과 판매를 0건으로 줄였습니다.\n결제·주문 생성 API에 멱등성 키(Idempotency-Key) 미들웨어를 도입해, 클라이언트 재시도·네트워크 재전송으로 발생하던 중복 주\n문을 제거했습니다. 도입 후 3개월간 중복 주문으로 인한 결제 취소·환불 처리 건수가 0건으로 유지되고 있습니다.\n주문 생성부터 배송 상태 변경까지의 도메인 이벤트를 Kafka 기반 이벤트 파이프라인으로 전환해 주문·재고·정산 서비스 간 동기 호출\n의존을 제거했습니다. 이벤트 컨슈머 재처리(replay)와 재시도 정책을 함께 설계해 장애 시 데이터 유실 없이 복구할 수 있는 구조를 만\n들었습니다.\n신규 합류자 온보딩을 위해 동시성·멱등성 설계 원칙을 문서화하고, 코드 리뷰에서 경계값·동시 요청 테스트 커버리지를 필수 체크리스\n트로 정착시켰습니다.\n패스트레일 백엔드 엔지니어 2018.02 2021.02\n물류 배차·운송장 관리 시스템의 백엔드 API를 Node.js/TypeScript로 개발하며, 배차 상태 전이(state transition)를 도메인 계층에 명\n시적으로 모델링해 잘못된 상태 전이로 인한 배차 오류를 월 수십 건에서 사실상 0건으로 줄였습니다.\n운송장 조회 API의 응답 지연을 인덱스 재설계와 캐시 도입으로 개선해 p95 응답 시간을 1.2초에서 180ms로 단축했습니다.\n레거시 배치 작업(batch job)을 이벤트 기반 처리로 점진적으로 전환하며, 팀의 테스트 자동화(CI) 파이프라인 구축에 참여했습니다.\n오픈소스·개인 프로젝트 (OPEN SOURCE & SIDE PROJECTS)\nstock-reservation — 재고 선점(예약) 서비스 TypeScript · Hono\ngithub.com/wanted-hack-inchyangv/seojin-stock-reservation\n회사 시스템에서 다루기 어려웠던 재고 선점 로직을 독립적으로 정리한 라이브러리형 서비스입니다. TTL 기반 예약, 버전 비교(version\ncheck) 방식의 낙관적 잠금(optimistic locking)과 충돌 시 재시도, 만료된 예약을 회수하는 백그라운드 작업을 포함합니다. 병렬 예약 요\n청 200건을 동시에 보내 초과 판매가 발생하지 않음을 확인하는 동시성 테스트(concurrency test)로 정합성을 검증했습니다.\nidempotency-kit — HTTP API 멱등성 키 미들웨어 TypeScript · Express / Hono\ngithub.com/wanted-hack-inchyangv/seojin-idempotency-kit\nHTTP API에 붙여 쓸 수 있는 멱등성 키(idempotency key) 미들웨어 라이브러리입니다. 요청 지문(메서드 + 경로 + 본문 해시) 비교로 같\n은 키의 다른 요청을 구분하고, 같은 키로 들어온 진행 중 요청은 병합해 중복 처리를 막습니다. 키 충돌 감지와 Express·Hono 어댑터를 함\n께 제공합니다.\n학력 (EDUCATION)\n한빛대학교 컴퓨터공학과 학사 졸업 2018.02",
  dohyun:
    "백도현 Baek Dohyun\n백엔드/풀스택 개발자 (Backend/Full-stack Developer) · 5년차\nEmail dohyun.baek@example.com\nPhone 010-0000-0000\nGitHub github.com/wanted-hack-inchyangv\n소 개 ( S U M M A R Y )\n5년차 백엔드/풀스택 개발자입니다. SI(System Integration) 업체에서 공공·유통 분야 프로젝트를 수행하며, 다수의 SI 프로젝트에서 REST API\n를 설계·개발하고 정해진 일정 안에 요구사항을 빠짐없이 구현하여 납기를 준수해 왔습니다. Node.js/Express와 Java/Spring 기반의 백엔드 API\n개발, 데이터 배치(batch) 처리, 운영 유지보수 업무를 두루 경험했습니다.\n기 술 스 택 ( S K I L L S )\nLanguage JavaScript, TypeScript, Java\nBackend Node.js, Express, Spring Boot, REST API 설계\nDatabase MySQL, Oracle, Redis\nTools Git, Jenkins, Postman, Jira\n경 력 ( E X P E R I E N C E )\n한울정보기술 백엔드 개발자 2021.07 현재\nSI 업체 소속으로 공공·유통 분야 고객사 프로젝트의 백엔드 개발과 운영 유지보수를 담당했습니다.\n최근 참여한 프로젝트에서는 클린 아키텍처(Clean Architecture)와 TDD(Test-Driven Development)를 적용하여 유지보수성을 높였습니\n다.\n여러 프로젝트에서 정해진 일정 안에 요구 기능 구현을 완료하며 납기를 준수했습니다.\n넥스트웨이브솔루션 풀스택 개발자 2020.01 2021.06\n웹 에이전시 소속으로 고객사 웹 서비스의 백엔드 API 개발과 화면 연동을 함께 담당했습니다.\n짧은 일정의 프로젝트가 많아 요구사항을 빠르게 동작하는 코드로 구현하는 데 익숙합니다.\n프 로 젝 트 수 행 이 력 ( P R O J EC T H I S T O R Y )\n프로젝트명 발주처 기간 역할 사용 기술\n민원 접수 시스템 구축 A 공공기관 2024.03 2024.12 백엔드 개발 (REST API 설계·구현) Node.js, Express, MySQL\n온라인몰 주문 API 고도화 B 유통사 2023.02 2023.12 백엔드 개발, 성능 개선 Java, Spring Boot, Oracle, Redis\n통계 포털 유지보수 A 공공기관 2022.01 2023.01 백엔드 유지보수, 장애 대응 Node.js, Express, MySQL\n사내 관리자 페이지 구축 C 유통사 2020.03 2021.06 풀스택 개발 (백엔드 API + 화면 연동) PHP, jQuery, MySQL\n개 인 프 로 젝 트 ( S I D E P R O J EC T S )\n게시판 REST API (Board REST API) Express · TypeScript\ngithub.com/wanted-hack-inchyangv/dohyun-board-api\n게시글·댓글 CRUD와 페이징을 갖춘 게시판(board) REST API입니다. Express와 TypeScript로 구현했고 데이터는 JSON 파일에 저장합니다.\n매출 보고서 자동화 배치 (Sales Report Batch) Node.js\ngithub.com/wanted-hack-inchyangv/dohyun-report-batch\n매출 CSV 데이터를 집계해 보고서(리포트, report)를 CSV와 HTML 요약으로 자동 생성하는 Node.js 배치(batch) 스크립트입니다. 수작업으로\n작성하던 매출 보고서를 자동화했습니다.\n학 력 ( E D U C AT I O N )\n동해대학교 정보통신공학과 학사 졸업 2020.02\n자 격 증 ( C E RT I F I C AT I O N S )\n정보처리기사 2020.08",
  taeyun:
    "오태윤\n백엔드 엔지니어 (Backend Engineer) · 3년차\ntaeyun.oh@example.com\n010-0000-0000\nGitHub: github.com/wanted-hack-inchyangv\n소개\n예약·결제 도메인의 REST API를 설계하고 운영한 3년차 백엔드 엔지니어입니다. 요구사항을 엔드포인트와 검증 규칙으로 정리하고, 계\n층을 나눠 구현하는 데 익숙합니다. 최근에는 동시 요청 상황에서 발생하는 문제를 더 깊이 이해하려고 학습하고 있습니다.\n기술 스택\nLanguage TypeScript JavaScript (Node.js)\nBackend Express REST API Zod JWT\nData PostgreSQL Redis Prisma\nInfra / Tools Docker GitHub Actions Vitest Jest\n경력\n모아북스 (MoaBooks) 2023.07 — 현재\n백엔드 엔지니어 · 독서 모임 예약 플랫폼\n독서 모임 예약(booking) API를 개발하며 같은 시간대에 같은 장소·모임이 중복 예약되지 않도록 검증 로직을 구현했습니다. 개인적\n으로 같은 문제를 다시 정리해 taeyun-room-booking 저장소에 회의실 예약 API로 만들어 공개했습니다.\n결제 웹훅(payment webhook) 수신을 맡아 같은 웹훅이 재전송돼도 결제가 중복 반영되지 않도록 멱등(idempotent) 처리를 담당했\n습니다.\n모임·예약·결제 도메인의 라우팅(routes)·서비스(services)·저장소(repository) 계층을 분리하는 리팩터링에 참여해 신규 기능 추가\n시 변경 범위를 줄였습니다.\n신규 입사자 온보딩 문서를 정리하고, 팀 코드 리뷰에 정기적으로 참여했습니다.\n데브브릿지 (DevBridge) 2023.01 — 2023.06\n백엔드 인턴 (6개월)\n사내 관리자(admin) 도구의 API 엔드포인트 추가·수정을 담당했습니다.\n기존 REST API 문서를 최신 상태로 정리하고 간단한 통합 테스트를 작성했습니다.\n개인 프로젝트\ntaeyun-room-booking github.com/wanted-hack-inchyangv/taeyun-room-booking\n회의실 예약 REST API. 같은 시간대 중복 예약(overlapping booking)을 막는 검사 로직, zod 기반 입력 검증,\nroutes/services/repository 계층 분리, vitest 테스트를 포함합니다. Express + TypeScript로 만들었습니다. 다만 동시에 들어오는 예약\n요청까지는 아직 다루지 못했습니다.\ntaeyun-til-cli github.com/wanted-hack-inchyangv/taeyun-til-cli\nTIL(Today I Learned) 마크다운을 관리하는 Node.js CLI 도구입니다. 기록 작성, 태그 검색, 주간 요약 기능을 붙여서 팀의 개발 생산성\n을 높이는 데 도움이 됐습니다.\n학력\n새솔대학교 · 소프트웨어학과 졸업 · 2023.02",
  gaeun:
    "문가은\n신입 백엔드 개발자 (Backend Developer)\nEmail gaeun.moon@example.com\nPhone 010-0000-0000\nGitHub github.com/wanted-hack-inchyangv\n자기소개\n웹 에이전시에서 퍼블리셔 겸 프론트엔드 개발자로 1년간 근무하며 React와 TypeScript로 다양한 화면을 구현했습니다. 사용자에게 직접 보이\n는 화면을 만드는 일도 즐거웠지만, 데이터가 어떻게 저장되고 처리되는지에 대한 궁금증이 커져 코드스프링 부트캠프의 백엔드 과정을 수료하\n며 Node.js와 Express로 서버를 설계하고 구현하는 법을 익혔습니다. 시각디자인을 전공한 경험을 살려 사용자와 동료 개발자 모두가 이해하\n기 쉬운 구조와 문서를 만들려고 노력합니다. 아직 실무 경험이 많지 않지만 빠르게 배우고 꾸준히 개선하는 개발자가 되고 싶습니다.\n기술 스택\nJavaScript TypeScript React Vite Node.js Express HTML / CSS Git / GitHub Figma\n경력\n스튜디오 도트\n퍼블리셔 · 프론트엔드 개발자 (웹 에이전시)\n2024.03 - 2025.02\n고객사 랜딩 페이지와 관리자 화면을 HTML/CSS와 React로 퍼블리\n싱 및 구현\n기존 jQuery 기반 화면 일부를 React + TypeScript 컴포넌트로 전\n환\n반응형 레이아웃과 크로스 브라우저 이슈를 점검하고 수정\n교육\n코드스프링 부트캠프\n백엔드 과정 수료\n2025.09 - 2026.02\nNode.js, Express를 이용한 REST API 설계와 구현 학습\n팀 프로젝트로 주문/예약 API를 설계하며 대용량 트래픽 환경을 고\n려한 동시성 제어와 멱등성 설계 경험을 쌓음\nGit을 이용한 협업과 코드 리뷰 프로세스 경험\n프로젝트\ngaeun-todo-react\ngithub.com/wanted-hack-inchyangv/gaeun-todo-react\nReact + TypeScript + Vite로 만든 할 일 관리 앱. localStorage에\n데이터를 저장하며 상태별 필터링과 정렬 기능을 구현했습니다.\ngaeun-bookmark-api\ngithub.com/wanted-hack-inchyangv/gaeun-bookmark-api\n부트캠프 백엔드 과정에서 만든 Express 기반 북마크(bookmark)\nCRUD API. 인메모리 저장소와 간단한 테스트 코드를 포함합니다.\n학력\n누리대학교\n시각디자인학과 졸업\n2020.03 - 2024.02",
};
