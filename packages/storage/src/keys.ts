/**
 * 아티팩트 키 규약 (TICKET.md T-005).
 *
 * - `submissions/<id>/snapshot.tar.gz`
 * - `submissions/<id>/snapshot-manifest.json` (수집 결과: 고정 SHA, 스냅샷 digest, 파일 목록, T-202)
 * - `submissions/<id>/resume.pdf`
 * - `evaluations/<id>/runs/<runId>/{input,expected,actual,timeline,stdout,stderr}.json`
 * - `evaluations/<id>/stages/<STAGE>/<name>.json` (단계가 남긴 원본 결과: 기동 관측·하네스 보고서·제출 테스트 결과, T-204)
 * - `evaluations/<id>/sandbox/<envId>/` (러너 로그 접두사, T-204)
 * - `evaluations/<id>/analysis/function-graph.json` (관련 함수 그래프 분석 결과, T-304)
 * - `evaluations/<id>/mutations/<mutationId>/diff.patch`
 * - `evaluations/<id>/mutations/<mutationId>/snapshot.tar.gz` (변형을 적용한 스냅샷. 러너 `prepare` 입력, T-403)
 * - `assignments/<assignmentId>/specs/<sha256>.md` (과제 명세 원문. 내용 주소라 버전 번호를 알기 전에 넣을 수 있다, T-201)
 * - `assignments/<assignmentId>/versions/<n>/samples/<sampleId>/snapshot.tar.gz` (검증 샘플 스냅샷, T-201)
 * - `demo/samples/<sampleId>/{snapshot.tar.gz,snapshot-manifest.json}` (샘플 체험의 저장된 스냅샷, T-505)
 * - `demo/resume.pdf` (샘플 체험용 예시 이력서, T-505)
 *
 * 키는 `/`로 구분된 세그먼트로 이루어지며 각 세그먼트는 `[A-Za-z0-9._-]`만 허용한다.
 * `.`·`..` 세그먼트, 빈 세그먼트, 선행 `/`(절대 경로), 백슬래시, 제어 문자는 거부한다.
 */
import { InvalidArtifactKeyError } from "./errors";

const SEGMENT = /^[A-Za-z0-9._-]+$/;
export const MAX_KEY_LENGTH = 512;

/** 키를 검증하고 세그먼트 배열을 돌려준다. 위반 시 `InvalidArtifactKeyError`. */
export function parseArtifactKey(key: string): string[] {
  if (typeof key !== "string" || key.length === 0) {
    throw new InvalidArtifactKeyError(key, "빈 키");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new InvalidArtifactKeyError(key, `길이가 ${MAX_KEY_LENGTH}자를 넘음`);
  }
  if (key.startsWith("/")) {
    throw new InvalidArtifactKeyError(key, "절대 경로는 허용하지 않음");
  }
  if (key.includes("\\")) {
    throw new InvalidArtifactKeyError(key, "백슬래시는 허용하지 않음");
  }
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === "") throw new InvalidArtifactKeyError(key, "빈 세그먼트");
    if (segment === "." || segment === "..") {
      throw new InvalidArtifactKeyError(key, `상대 경로 세그먼트 ${JSON.stringify(segment)}`);
    }
    if (!SEGMENT.test(segment)) {
      throw new InvalidArtifactKeyError(
        key,
        `세그먼트 ${JSON.stringify(segment)}에 허용되지 않은 문자가 있음`,
      );
    }
  }
  return segments;
}

/** 키가 규약에 맞으면 그대로 돌려준다. */
export function assertArtifactKey(key: string): string {
  parseArtifactKey(key);
  return key;
}

/**
 * 접두사는 키 규약을 따르는 경로에 `/`가 붙은 형태여야 한다 (예: `submissions/<id>/`).
 * 세그먼트 배열을 돌려준다.
 */
export function parseArtifactPrefix(prefix: string): string[] {
  if (typeof prefix !== "string" || !prefix.endsWith("/")) {
    throw new InvalidArtifactKeyError(prefix, "접두사는 '/'로 끝나야 함");
  }
  return parseArtifactKey(prefix.slice(0, -1));
}

export const RUN_RECORD_PARTS = [
  "input",
  "expected",
  "actual",
  "timeline",
  "stdout",
  "stderr",
] as const;
export type RunRecordPart = (typeof RUN_RECORD_PARTS)[number];

function id(value: string, label: string): string {
  if (!SEGMENT.test(value) || value === "." || value === "..") {
    throw new InvalidArtifactKeyError(value, `${label}는 키 세그먼트로 쓸 수 없음`);
  }
  return value;
}

/** 키 규약을 함수로 고정한다. 문자열을 직접 조립하지 말고 이 함수를 쓴다. */
export const artifactKeys = {
  submissionPrefix: (submissionId: string): string =>
    `submissions/${id(submissionId, "submissionId")}/`,
  snapshot: (submissionId: string): string =>
    `submissions/${id(submissionId, "submissionId")}/snapshot.tar.gz`,
  snapshotManifest: (submissionId: string): string =>
    `submissions/${id(submissionId, "submissionId")}/snapshot-manifest.json`,
  resume: (submissionId: string): string =>
    `submissions/${id(submissionId, "submissionId")}/resume.pdf`,
  evaluationPrefix: (evaluationId: string): string =>
    `evaluations/${id(evaluationId, "evaluationId")}/`,
  runPrefix: (evaluationId: string, runId: string): string =>
    `evaluations/${id(evaluationId, "evaluationId")}/runs/${id(runId, "runId")}/`,
  runRecord: (evaluationId: string, runId: string, part: RunRecordPart): string =>
    `evaluations/${id(evaluationId, "evaluationId")}/runs/${id(runId, "runId")}/${part}.json`,
  /** 단계 원본 결과. `stage`는 EvaluationStage 이름, `name`은 `[A-Za-z0-9._-]` */
  stageResult: (evaluationId: string, stage: string, name: string): string =>
    `evaluations/${id(evaluationId, "evaluationId")}/stages/${id(stage, "stage")}/${id(name, "name")}.json`,
  /** 러너 로그 접두사 (`PrepareOptions.logKeyPrefix`) */
  sandboxLogPrefix: (evaluationId: string, envId: string): string =>
    `evaluations/${id(evaluationId, "evaluationId")}/sandbox/${id(envId, "envId")}/`,
  /** 관련 함수 그래프 분석 결과 (core `FunctionGraphAnalysis`) */
  functionGraph: (evaluationId: string): string =>
    `evaluations/${id(evaluationId, "evaluationId")}/analysis/function-graph.json`,
  mutationDiff: (evaluationId: string, mutationId: string): string =>
    `evaluations/${id(evaluationId, "evaluationId")}/mutations/${id(mutationId, "mutationId")}/diff.patch`,
  /** 변형을 적용한 스냅샷 (T-403). 원본 스냅샷과 같은 형식이라 러너가 그대로 `prepare`한다 */
  mutationSnapshot: (evaluationId: string, mutationId: string): string =>
    `evaluations/${id(evaluationId, "evaluationId")}/mutations/${id(mutationId, "mutationId")}/snapshot.tar.gz`,
  assignmentPrefix: (assignmentId: string): string =>
    `assignments/${id(assignmentId, "assignmentId")}/`,
  assignmentSpec: (assignmentId: string, specDigest: string): string =>
    `assignments/${id(assignmentId, "assignmentId")}/specs/${digestSegment(specDigest)}.md`,
  validationSampleSnapshot: (assignmentId: string, version: number, sampleId: string): string =>
    `assignments/${id(assignmentId, "assignmentId")}/versions/${versionSegment(version)}/samples/${id(sampleId, "sampleId")}/snapshot.tar.gz`,
  /**
   * 샘플 체험(T-505)의 저장된 스냅샷. `pnpm demo:seed`가 GitHub에서 한 번 수집한 제출 스냅샷·manifest를 복사해 두고,
   * `이 샘플로 새로 실행`은 이것을 새 제출 키로 복사한다 (GitHub 재수집 없음)
   */
  demoSampleSnapshot: (sampleId: string): string =>
    `demo/samples/${id(sampleId, "sampleId")}/snapshot.tar.gz`,
  demoSampleManifest: (sampleId: string): string =>
    `demo/samples/${id(sampleId, "sampleId")}/snapshot-manifest.json`,
  /** 샘플 체험용 예시 이력서 (가상 인물). 제출마다 `submissions/<id>/resume.pdf`로 복사한다 */
  demoResume: (): string => "demo/resume.pdf",
  /** AI 기준 초안 요청의 명세 원문 (T-406). 과제를 만들기 전에도 요청하므로 과제 ID 없이 내용 주소로 둔다 */
  rubricDraftSpec: (specDigest: string): string =>
    `rubric-drafts/specs/${digestSegment(specDigest)}.md`,
} as const;

function digestSegment(digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new InvalidArtifactKeyError(digest, "specDigest는 sha256 hex(64자)여야 함");
  }
  return digest;
}

function versionSegment(version: number): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new InvalidArtifactKeyError(String(version), "version은 1 이상의 정수여야 함");
  }
  return String(version);
}

/** 키 규약별 기본 contentType */
export const ARTIFACT_CONTENT_TYPES = {
  snapshot: "application/gzip",
  snapshotManifest: "application/json",
  resume: "application/pdf",
  runRecord: "application/json",
  stageResult: "application/json",
  functionGraph: "application/json",
  mutationDiff: "text/x-patch",
  mutationSnapshot: "application/gzip",
  assignmentSpec: "text/markdown",
} as const;
