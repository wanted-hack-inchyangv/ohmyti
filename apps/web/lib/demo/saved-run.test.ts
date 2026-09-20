import { describe, expect, it } from "vitest";
import { matchSavedRun, normalizeRepoUrl, type SavedRunMatch } from "./saved-run";

const SHA = "339a30853f030cc7ec6d55b5435f8c3013093338";
const VERSION = "00000000-0000-4000-8000-000000000001";

const saved: SavedRunMatch[] = [
  {
    assignmentVersionId: VERSION,
    repoUrl: "https://github.com/inchyangv/ohmyti-sample-c",
    submissionSha: SHA,
    submissionId: "sub-c",
    evaluationId: "eval-c",
    href: "/evaluations/eval-c",
    label: "저장된 실행 · 2026-09-19 06:35 KST",
  },
];

describe("T-904 같은 입력의 저장된 실행", () => {
  it("과제 버전·저장소·커밋 SHA가 모두 같으면 찾는다 (SHA 앞자리도 허용)", () => {
    const input = {
      assignmentVersionId: VERSION,
      repoUrl: "https://github.com/inchyangv/ohmyti-sample-c",
      commitSha: SHA,
    };
    expect(matchSavedRun(saved, input)?.href).toBe("/evaluations/eval-c");
    expect(matchSavedRun(saved, { ...input, commitSha: SHA.slice(0, 7) })?.href).toBe(
      "/evaluations/eval-c",
    );
    // 대소문자·끝 슬래시·`.git`만 무시한다
    expect(
      matchSavedRun(saved, {
        ...input,
        repoUrl: "https://GitHub.com/inchyangv/ohmyti-sample-c.git/",
      }),
    ).not.toBeNull();
  });

  it("하나라도 다르거나 커밋 SHA가 없으면 찾지 않는다", () => {
    const input = {
      assignmentVersionId: VERSION,
      repoUrl: "https://github.com/inchyangv/ohmyti-sample-c",
      commitSha: SHA,
    };
    expect(matchSavedRun(saved, { ...input, commitSha: "" })).toBeNull();
    expect(matchSavedRun(saved, { ...input, commitSha: "  " })).toBeNull();
    expect(matchSavedRun(saved, { ...input, commitSha: "abc1234" })).toBeNull();
    expect(matchSavedRun(saved, { ...input, repoUrl: "" })).toBeNull();
    expect(
      matchSavedRun(saved, {
        ...input,
        repoUrl: "https://github.com/inchyangv/ohmyti-sample-d",
      }),
    ).toBeNull();
    expect(
      matchSavedRun(saved, { ...input, assignmentVersionId: "00000000-0000-4000-8000-00000000000f" }),
    ).toBeNull();
    // 자기 자신은 제외한다
    expect(matchSavedRun(saved, input, { excludeSubmissionId: "sub-c" })).toBeNull();
  });

  it("normalizeRepoUrl은 대소문자·끝 슬래시·.git만 없앤다", () => {
    expect(normalizeRepoUrl(" https://GITHUB.com/A/B.git/ ")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("https://github.com/a/b-git")).toBe("https://github.com/a/b-git");
  });
});
