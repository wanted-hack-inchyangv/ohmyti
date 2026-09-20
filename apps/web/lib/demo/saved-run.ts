/**
 * 같은 입력의 저장된 실행 찾기 (TICKET.md T-904).
 *
 * 채점 요청 폼(클라이언트 컴포넌트)과 제출 상태 화면(서버)이 같은 규칙을 쓴다. DB를 읽지 않는 순수 함수만 둔다
 * (`@ohmyti/db`를 클라이언트 번들에 끌어오지 않으려고 `service.ts`와 파일을 나눴다).
 */
export interface SavedRunMatch {
  assignmentVersionId: string;
  repoUrl: string;
  submissionSha: string;
  submissionId: string;
  evaluationId: string;
  href: string;
  label: string;
}

/** 저장소 URL 비교용 정규화. 대소문자·끝 슬래시·`.git`만 무시한다 */
export function normalizeRepoUrl(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

/**
 * 제출하려는 입력이 저장된 실행과 같은지 본다 (과제 버전 · 저장소 · 커밋 SHA).
 * 커밋 SHA가 비어 있으면 어느 커밋을 채점할지 아직 모르므로 같은 입력으로 보지 않는다.
 */
export function matchSavedRun(
  matches: readonly SavedRunMatch[],
  input: { assignmentVersionId: string; repoUrl: string; commitSha: string },
  options: { excludeSubmissionId?: string | undefined } = {},
): SavedRunMatch | null {
  const sha = input.commitSha.trim().toLowerCase();
  if (!sha) return null;
  const repo = normalizeRepoUrl(input.repoUrl);
  if (!repo) return null;
  return (
    matches.find(
      (item) =>
        item.submissionId !== options.excludeSubmissionId &&
        item.assignmentVersionId === input.assignmentVersionId &&
        normalizeRepoUrl(item.repoUrl) === repo &&
        item.submissionSha.startsWith(sha),
    ) ?? null
  );
}

/**
 * 저장소·커밋만으로 저장된 실행을 찾는다 (T-902 프리필이 과제 버전을 고를 때). 과제 버전은 비교하지 않는다.
 */
export function findSavedRunByRepo(
  matches: readonly SavedRunMatch[],
  input: { repoUrl: string; commitSha: string },
): SavedRunMatch | null {
  const sha = input.commitSha.trim().toLowerCase();
  const repo = normalizeRepoUrl(input.repoUrl);
  if (!sha || !repo) return null;
  return (
    matches.find(
      (item) => normalizeRepoUrl(item.repoUrl) === repo && item.submissionSha.startsWith(sha),
    ) ?? null
  );
}
