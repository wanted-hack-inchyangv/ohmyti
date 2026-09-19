/**
 * 코드 근거 뷰어의 표시 모델 (TICKET.md T-305). 선택한 기준의 근거 중 `source`(경로·라인)가 있는 것을 고정 SHA와 함께 보여 준다.
 *
 * - 코드 원문은 근거에 저장된 `snippet`(T-205 README 검사·T-304 핸들러 위치·T-407 LLM 위치)이며 이 모듈은 스냅샷을 읽지 않는다.
 *   스니펫이 없는 위치(`?source=`로 온 그래프 노드 등)는 위치와 링크만 보여 주고 원문이 없다고 알린다 (G-09).
 * - GitHub 링크는 `https://github.com/<o>/<r>/blob/<pinned_sha>/<path>#L<start>-L<end>`만 만든다. `HEAD`·브랜치 이름은
 *   어떤 경우에도 쓰지 않는다 (PRD 6장: 코드 근거는 고정 SHA + 경로 + 라인).
 * - 라벨은 근거의 `kind`로만 정한다: 없음 → `관측`, `STATIC_RELATION` → `정적 관계`, `LLM_INTERPRETATION` → `추정`,
 *   `HUMAN_REVIEW` → `사람 검토`(T-306 검토 액션이 감점 근거로 만든 것. 코드 위치가 없어 이 뷰어에는 나오지 않는다).
 */
import type { Evidence, EvidenceKind, SourceLocation } from "@ohmyti/core";
import { sourceParam } from "./graph";
import { parseSourceParam, type WorkbenchUrlState } from "./state";

export type CodeEvidenceLabel = "관측" | "정적 관계" | "추정" | "사람 검토";

export const EVIDENCE_KIND_LABEL: Record<EvidenceKind | "none", CodeEvidenceLabel> = {
  none: "관측",
  STATIC_RELATION: "정적 관계",
  LLM_INTERPRETATION: "추정",
  HUMAN_REVIEW: "사람 검토",
};

export const EVIDENCE_KIND_DESCRIPTION: Record<EvidenceKind | "none", string> = {
  none: "실행·정적 검사에서 실제로 관측한 근거입니다",
  STATIC_RELATION:
    "요청을 정적 라우트 분석으로 대응시킨 핸들러 위치입니다. AST 관계이며 실제로 실행됐는지는 관측하지 않았습니다",
  LLM_INTERPRETATION: "LLM이 제안한 원인 위치입니다. 추정이며 사람 확인 전에는 미확정입니다",
  HUMAN_REVIEW:
    "검토자가 점수를 수정·확정하며 남긴 기록이 근거입니다. 사유와 검토자는 검토 이력에 있습니다",
};

export function evidenceLabelOf(kind: EvidenceKind | undefined): CodeEvidenceLabel {
  return EVIDENCE_KIND_LABEL[kind ?? "none"];
}

export const PINNED_SHA_PATTERN = /^[0-9a-f]{40}$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** 저장소 URL에서 owner·repo. github.com이 아니거나 형식이 다르면 null */
export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return null;
  }
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const [owner, repoRaw] = segments;
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * 고정 SHA 링크. `sha`가 40자 hex가 아니면(브랜치·`HEAD` 등) 만들지 않는다.
 * 앵커는 항상 `#L<start>-L<end>`다 (한 줄이어도 같은 형식).
 */
export function githubBlobUrl(repoUrl: string, sha: string, source: SourceLocation): string | null {
  const repo = parseGitHubRepo(repoUrl);
  if (!repo || !PINNED_SHA_PATTERN.test(sha)) return null;
  const encodedPath = source.path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://github.com/${repo.owner}/${repo.repo}/blob/${sha}/${encodedPath}#L${source.startLine}-L${source.endLine}`;
}

/** 스니펫 끝의 잘림 표시. 워커가 줄 수·글자 수 상한을 넘긴 원문 뒤에 붙인다 (README `…(잘림)`, 핸들러 `…`) */
const TRUNCATION_MARKERS = new Set(["…", "…(잘림)"]);

export interface CodeLineView {
  /** 스냅샷 파일의 라인 번호 (1부터) */
  number: number;
  text: string;
  highlighted: boolean;
}

export interface CodeEvidenceItemView {
  /** 근거 ID. `?source=`로만 온 위치(근거 없음)는 null */
  evidenceId: string | null;
  kind: EvidenceKind | null;
  label: CodeEvidenceLabel;
  labelDescription: string;
  source: SourceLocation;
  /** `path:start-end` */
  locationLabel: string;
  /** 고정 SHA 링크. GitHub 저장소가 아니면 null */
  githubUrl: string | null;
  /** 근거의 `testId` (하네스 케이스 ID 등) */
  testId: string | null;
  runId: string | null;
  /** 저장된 스니펫을 줄로 나눈 것. 스니펫이 없으면 빈 배열 */
  lines: CodeLineView[];
  /** 스니펫이 상한에서 잘렸다 (마지막 줄이 잘림 표시였다) */
  truncated: boolean;
  /** 근거에 스니펫이 없다(원문을 보여 줄 수 없다) */
  snippetMissing: boolean;
  /** `?source=`가 이 항목의 범위 안에 있다 (그래프 노드 클릭으로 온 위치). 강조 범위는 `?source=`의 줄이다 */
  selected: boolean;
  /** 이 항목으로 가는 링크 (`?source=`) */
  href: string;
}

export type CodeEvidenceStatus =
  /** 코드 위치가 있는 근거를 보여 준다 */
  | "ok"
  /** 기준을 고르지 않았다 */
  | "no-criterion"
  /** 선택 기준의 근거에 코드 위치가 없다 */
  | "no-location";

export interface CodeEvidenceView {
  status: CodeEvidenceStatus;
  /** 40자 고정 SHA와 짧은 표시 */
  sha: string;
  shortSha: string;
  repoUrl: string;
  /** GitHub 저장소가 아니어서 링크를 만들지 않는다 */
  githubUnavailable: boolean;
  items: CodeEvidenceItemView[];
  /** 선택 기준의 근거 수(코드 위치 유무와 무관) */
  evidenceCount: number;
  /** `?source=`가 어떤 근거와도 맞지 않아 위치만 보여 주는 항목. 없으면 null */
  standalone: CodeEvidenceItemView | null;
}

export function sameLocation(a: SourceLocation, b: SourceLocation): boolean {
  return a.path === b.path && a.startLine === b.startLine && a.endLine === b.endLine;
}

/** `inner`가 `outer`와 같은 파일의 범위 안에 있다 (같은 범위 포함) */
export function containsLocation(outer: SourceLocation, inner: SourceLocation): boolean {
  return (
    outer.path === inner.path &&
    inner.startLine >= outer.startLine &&
    inner.endLine <= outer.endLine
  );
}

/**
 * 스니펫을 라인 번호가 붙은 줄로 나눈다. 번호는 `source.startLine`부터이며 잘림 표시 줄은 제외한다.
 * 강조 범위는 `highlight`가 같은 파일 안의 범위면 그것, 아니면 `source` 전체다.
 */
export function snippetLines(
  snippet: string,
  source: SourceLocation,
  highlight: SourceLocation | null = null,
): { lines: CodeLineView[]; truncated: boolean } {
  const raw = snippet.split(/\r?\n/);
  let truncated = false;
  const last = raw[raw.length - 1];
  if (raw.length > 1 && last !== undefined && TRUNCATION_MARKERS.has(last.trim())) {
    raw.pop();
    truncated = true;
  }
  const range =
    highlight && highlight.path === source.path
      ? { start: highlight.startLine, end: highlight.endLine }
      : { start: source.startLine, end: source.endLine };
  const lines = raw.map((text, index) => {
    const number = source.startLine + index;
    return { number, text, highlighted: number >= range.start && number <= range.end };
  });
  return { lines, truncated };
}

export interface CodeEvidenceSource {
  criterionResults: Array<{ criterionId: string; evidenceIds: string[] }>;
  evidences: Evidence[];
  evaluation: { submissionSha: string };
  submission: { repoUrl: string };
}

export function buildCodeEvidenceView(
  report: CodeEvidenceSource,
  urlState: WorkbenchUrlState,
  href: (patch: Partial<WorkbenchUrlState>) => string,
): CodeEvidenceView {
  const sha = report.evaluation.submissionSha;
  const repoUrl = report.submission.repoUrl;
  const githubUnavailable = parseGitHubRepo(repoUrl) === null;
  const requested = parseSourceParam(urlState.source);
  const base = {
    sha,
    shortSha: sha.slice(0, 12),
    repoUrl,
    githubUnavailable,
  };

  const itemOf = (evidence: Evidence | null, source: SourceLocation): CodeEvidenceItemView => {
    const selected = requested !== null && containsLocation(source, requested);
    const snippet = evidence?.snippet;
    const { lines, truncated } =
      snippet !== undefined && snippet.length > 0
        ? snippetLines(snippet, source, selected ? requested : null)
        : { lines: [], truncated: false };
    const kind = evidence?.kind ?? null;
    return {
      evidenceId: evidence?.id ?? null,
      kind,
      label: evidenceLabelOf(kind ?? undefined),
      labelDescription: EVIDENCE_KIND_DESCRIPTION[kind ?? "none"],
      source,
      locationLabel: sourceParam(source),
      githubUrl: githubBlobUrl(repoUrl, sha, source),
      testId: evidence?.testId ?? null,
      runId: evidence?.runId ?? null,
      lines,
      truncated,
      snippetMissing: lines.length === 0,
      selected,
      href: href({ pane: "code", source: sourceParam(source) }),
    };
  };

  const standaloneOf = (): CodeEvidenceItemView | null =>
    requested ? itemOf(null, requested) : null;

  if (!urlState.criterionId) {
    return {
      ...base,
      status: "no-criterion",
      items: [],
      evidenceCount: 0,
      standalone: standaloneOf(),
    };
  }
  const result = report.criterionResults.find((r) => r.criterionId === urlState.criterionId);
  const evidenceById = new Map(report.evidences.map((e) => [e.id, e]));
  const evidences = (result?.evidenceIds ?? [])
    .map((id) => evidenceById.get(id))
    .filter((e): e is Evidence => e !== undefined);
  const items = evidences
    .filter((e): e is Evidence & { source: SourceLocation } => e.source !== undefined)
    .map((e) => itemOf(e, e.source));
  const standalone = items.some((item) => item.selected) ? null : standaloneOf();
  return {
    ...base,
    status: items.length === 0 ? "no-location" : "ok",
    items,
    evidenceCount: evidences.length,
    standalone,
  };
}
