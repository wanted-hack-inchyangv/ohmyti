/**
 * 채점 요청 폼의 예시 프리필 (TICKET.md T-902).
 *
 * `/submissions/new?sample=A|B|C|D`와 `?persona=<핸들>`은 저장소 URL·커밋 SHA·GitHub 프로필 URL의 초기값을 정한다.
 * 폼 위의 `예시로 채우기` 칩도 같은 목록을 쓴다.
 *
 * 이력서 파일 입력란은 브라우저에서 미리 채울 수 없으므로 `예시 이력서 사용`을 따로 둔다. 서버 액션은 **식별자만** 받고
 * 아래 허용 목록에 있는 아티팩트 키에서만 읽는다. 사용자가 준 경로로 파일을 읽지 않는다.
 * 예시 이력서 원본은 아티팩트 스토어에 있다(`pnpm demo:seed`가 올린다). 배포된 web은 저장소 파일 시스템을 읽을 수 없다.
 */
import { artifactKeys } from "@ohmyti/storage";
import {
  DEMO_SAMPLE_INFO,
  type DemoSampleInfo,
} from "@/lib/demo/samples";
import {
  isPersonaHandle,
  PERSONA_HANDLES,
  PERSONA_INFO,
  type PersonaHandle,
} from "@/lib/demo/personas";
import { DEMO_SAMPLE_IDS, isDemoSampleId, type DemoSampleId } from "@ohmyti/db";

/** 예시 이력서 식별자. 값은 화면과 서버 액션이 주고받는 짧은 문자열이며 경로가 아니다 */
export const EXAMPLE_RESUME_IDS = [
  "demo",
  "persona-seojin",
  "persona-taeyun",
  "persona-gaeun",
  "persona-dohyun",
] as const;
export type ExampleResumeId = (typeof EXAMPLE_RESUME_IDS)[number];

export function isExampleResumeId(value: unknown): value is ExampleResumeId {
  return typeof value === "string" && (EXAMPLE_RESUME_IDS as readonly string[]).includes(value);
}

/** 식별자 → 아티팩트 키. 이 표에 없는 값은 어떤 파일도 읽지 않는다 */
const EXAMPLE_RESUME_KEYS: Record<ExampleResumeId, string> = {
  demo: artifactKeys.demoResume(),
  "persona-seojin": artifactKeys.personaResume("seojin"),
  "persona-taeyun": artifactKeys.personaResume("taeyun"),
  "persona-gaeun": artifactKeys.personaResume("gaeun"),
  "persona-dohyun": artifactKeys.personaResume("dohyun"),
};

/** 허용 목록에 있는 식별자만 아티팩트 키로 바꾼다. 그 밖의 값은 null */
export function exampleResumeKey(value: unknown): string | null {
  return isExampleResumeId(value) ? EXAMPLE_RESUME_KEYS[value] : null;
}

export interface PrefillExample {
  /** 칩과 쿼리에 쓰는 식별자 */
  id: string;
  kind: "SAMPLE" | "PERSONA";
  label: string;
  /** 칩 아래 한 줄 설명 */
  hint: string;
  repoUrl: string;
  commitSha: string;
  githubProfileUrl: string;
  /** 예시 이력서 식별자. 없으면 이력서를 붙이지 않는다 */
  resumeId: ExampleResumeId | null;
  /** 이 예시를 다시 여는 링크 */
  href: string;
}

function sampleExample(id: DemoSampleId, info: DemoSampleInfo): PrefillExample {
  return {
    id: `sample-${id}`,
    kind: "SAMPLE",
    label: info.name,
    hint: info.description,
    repoUrl: info.repoUrl,
    commitSha: info.commitSha,
    // 샘플 저장소에는 지원자 프로필이 없다
    githubProfileUrl: "",
    resumeId: "demo",
    href: `/submissions/new?sample=${id}`,
  };
}

function personaExample(handle: PersonaHandle): PrefillExample {
  const info = PERSONA_INFO[handle];
  return {
    id: `persona-${handle}`,
    kind: "PERSONA",
    label: info.name,
    hint: info.profile,
    repoUrl: info.repoUrl,
    commitSha: info.commitSha,
    githubProfileUrl: info.githubProfileUrl,
    resumeId: `persona-${handle}` as ExampleResumeId,
    href: `/submissions/new?persona=${handle}`,
  };
}

/** 폼 위의 `예시로 채우기` 칩 목록 (샘플 4종 → 페르소나 4종) */
export const PREFILL_EXAMPLES: PrefillExample[] = [
  ...DEMO_SAMPLE_IDS.map((id) => sampleExample(id, DEMO_SAMPLE_INFO[id])),
  ...PERSONA_HANDLES.map((handle) => personaExample(handle)),
];

export interface PrefillValues {
  /** 프리필이 고른 과제 버전. 페이지가 저장된 실행에서 정한다 (T-904). 없으면 폼이 첫 번째 승인 버전을 쓴다 */
  assignmentVersionId?: string | null;
  repoUrl: string;
  commitSha: string;
  githubProfileUrl: string;
  resumeId: ExampleResumeId | null;
  /** 어느 예시에서 왔는지 (칩 선택 표시) */
  exampleId: string | null;
}

export const EMPTY_PREFILL: PrefillValues = {
  repoUrl: "",
  commitSha: "",
  githubProfileUrl: "",
  resumeId: null,
  exampleId: null,
};

function toValues(example: PrefillExample): PrefillValues {
  return {
    repoUrl: example.repoUrl,
    commitSha: example.commitSha,
    githubProfileUrl: example.githubProfileUrl,
    resumeId: example.resumeId,
    exampleId: example.id,
  };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `?sample=`·`?persona=` 쿼리를 초기값으로 바꾼다. 아는 값이 아니면 빈 폼이다 (T-902 인수 기준).
 * `sample`이 먼저다.
 */
export function readPrefill(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): PrefillValues {
  const sample = first(searchParams?.["sample"]);
  if (isDemoSampleId(sample)) {
    return toValues(sampleExample(sample, DEMO_SAMPLE_INFO[sample]));
  }
  const persona = first(searchParams?.["persona"]);
  if (isPersonaHandle(persona)) return toValues(personaExample(persona));
  return EMPTY_PREFILL;
}
