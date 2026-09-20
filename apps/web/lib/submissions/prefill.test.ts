import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGitHubProfileUrl, parseGitHubRepoUrl, isCommitShaInput } from "@ohmyti/core";
import { artifactKeys } from "@ohmyti/storage";
import { describe, expect, it } from "vitest";
import { PERSONA_HANDLES, PERSONA_INFO } from "@/lib/demo/personas";
import { DEMO_SAMPLE_INFO } from "@/lib/demo/samples";
import {
  EMPTY_PREFILL,
  EXAMPLE_RESUME_IDS,
  PREFILL_EXAMPLES,
  exampleResumeKey,
  isExampleResumeId,
  readPrefill,
} from "./prefill";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("T-902 프리필 쿼리", () => {
  it("?sample=C는 샘플 C의 저장소·커밋으로 채운다", () => {
    expect(readPrefill({ sample: "C" })).toEqual({
      repoUrl: DEMO_SAMPLE_INFO.C.repoUrl,
      commitSha: DEMO_SAMPLE_INFO.C.commitSha,
      githubProfileUrl: "",
      resumeId: "demo",
      exampleId: "sample-C",
    });
  });

  it("?persona=seojin은 페르소나의 저장소·커밋·프로필로 채운다", () => {
    expect(readPrefill({ persona: "seojin" })).toEqual({
      repoUrl: PERSONA_INFO.seojin.repoUrl,
      commitSha: PERSONA_INFO.seojin.commitSha,
      githubProfileUrl: PERSONA_INFO.seojin.githubProfileUrl,
      resumeId: "persona-seojin",
      exampleId: "persona-seojin",
    });
  });

  it("아는 값이 아니면 빈 폼이다", () => {
    for (const query of [
      undefined,
      {},
      { sample: "Z" },
      { sample: "" },
      { persona: "../../etc/passwd" },
      { persona: "SEOJIN" },
      { persona: "demo/resume.pdf" },
      { sample: ["Z", "C"] },
    ]) {
      expect(readPrefill(query), JSON.stringify(query)).toEqual(EMPTY_PREFILL);
    }
  });

  it("sample이 persona보다 먼저다", () => {
    expect(readPrefill({ sample: "A", persona: "gaeun" }).exampleId).toBe("sample-A");
  });

  it("칩 목록은 샘플 4종 + 페르소나 4종이고 값이 폼 검사를 통과한다", () => {
    expect(PREFILL_EXAMPLES).toHaveLength(8);
    for (const example of PREFILL_EXAMPLES) {
      expect(() => parseGitHubRepoUrl(example.repoUrl)).not.toThrow();
      expect(isCommitShaInput(example.commitSha)).toBe(true);
      if (example.githubProfileUrl) {
        expect(() => parseGitHubProfileUrl(example.githubProfileUrl)).not.toThrow();
      }
      expect(example.href.startsWith("/submissions/new?")).toBe(true);
    }
  });
});

describe("T-902 예시 이력서 허용 목록", () => {
  it("허용 목록의 식별자만 아티팩트 키로 바뀐다", () => {
    expect(exampleResumeKey("demo")).toBe(artifactKeys.demoResume());
    expect(exampleResumeKey("persona-gaeun")).toBe(artifactKeys.personaResume("gaeun"));
    expect(EXAMPLE_RESUME_IDS).toHaveLength(5);
  });

  it("경로 문자열·미지의 값으로는 아무 키도 나오지 않는다", () => {
    for (const value of [
      "",
      null,
      undefined,
      42,
      "../../etc/passwd",
      "/etc/passwd",
      "demo/resume.pdf",
      "demo/../../secret",
      "persona-unknown",
      "persona-seojin/../demo",
      { id: "demo" },
    ]) {
      expect(exampleResumeKey(value), JSON.stringify(value)).toBeNull();
      expect(isExampleResumeId(value)).toBe(false);
    }
  });
});

describe("T-902 페르소나 자료", () => {
  it("저장소 URL·커밋 SHA·프로필 URL이 samples/personas/<핸들>/persona.md와 같다", () => {
    for (const handle of PERSONA_HANDLES) {
      const markdown = readFileSync(
        path.join(REPO_ROOT, "samples/personas", handle, "persona.md"),
        "utf8",
      );
      const info = PERSONA_INFO[handle];
      expect(markdown, handle).toContain(info.repoUrl);
      expect(markdown, handle).toContain(info.commitSha);
      expect(markdown, handle).toContain(info.githubProfileUrl);
    }
  });

  it("카드 문구에 점수·판정·합격 표현이 없다 (G-08)", () => {
    const forbidden =
      /\bPASS\b|\bFAIL\b|INCONCLUSIVE|합격|불합격|탈락|만점|[0-9]+\s*점|[0-9]+\s*\/\s*100/;
    for (const handle of PERSONA_HANDLES) {
      const info = PERSONA_INFO[handle];
      for (const text of [info.name, info.profile, info.context, ...info.checks]) {
        expect(forbidden.test(text), `${handle}: ${text}`).toBe(false);
      }
    }
  });
});
