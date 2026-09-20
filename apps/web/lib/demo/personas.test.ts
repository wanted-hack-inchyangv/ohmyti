import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPersonaHandle, PERSONA_HANDLES, PERSONA_INFO } from "./personas";
import { personaProfileLogin } from "./service";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("T-905 페르소나 진입점", () => {
  it("핸들 4종만 받아들인다", () => {
    expect(PERSONA_HANDLES).toHaveLength(4);
    for (const handle of PERSONA_HANDLES) expect(isPersonaHandle(handle)).toBe(true);
    for (const value of ["", "SEOJIN", "../seojin", "seojin/", null, 1, {}]) {
      expect(isPersonaHandle(value)).toBe(false);
    }
  });

  it("프로필 URL에서 로그인을 읽는다", () => {
    expect(personaProfileLogin("https://github.com/wanted-hack-inchyangv")).toBe(
      "wanted-hack-inchyangv",
    );
    expect(personaProfileLogin("https://github.com/octocat/")).toBe("octocat");
    for (const handle of PERSONA_HANDLES) {
      expect(personaProfileLogin(PERSONA_INFO[handle].githubProfileUrl)).toBe(
        "wanted-hack-inchyangv",
      );
    }
  });

  it("README에 하드코딩된 평가 링크가 없다", () => {
    const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).not.toMatch(/\/evaluations\/[0-9a-f]{8}-[0-9a-f]{4}-/);
    // 대신 샘플 체험으로 보낸다
    expect(readme).toContain("지원자 맥락 예시");
  });

  it("카드마다 확인할 것이 2개 이상이다", () => {
    for (const handle of PERSONA_HANDLES) {
      expect(PERSONA_INFO[handle].checks.length, handle).toBeGreaterThanOrEqual(2);
    }
  });
});
