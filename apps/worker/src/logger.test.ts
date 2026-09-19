import { describe, expect, it } from "vitest";
import { createLogger, maskingDestination } from "./logger";

function bufferDestination() {
  const lines: string[] = [];
  return { lines, write: (msg: string) => void lines.push(msg) };
}

describe("createLogger", () => {
  it("메시지·병합 객체·에러 스택에 들어간 비밀값과 개인정보를 가린다", () => {
    const dest = bufferDestination();
    const secret = "postgresql://ohmyti:S3cretPw@db.example.internal:5432/ohmyti";
    const logger = createLogger({
      destination: dest,
      secrets: [secret, "S3cretPw"],
      level: "debug",
    });

    logger.info(
      { url: secret, contact: "jane@example.com", phone: "010-1234-5678" },
      `connect ${secret}`,
    );
    logger.error(
      { err: new Error(`auth failed with token sk-abcdefghijklmnop for S3cretPw`) },
      "실패",
    );
    logger.warn("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef.ghijkl");

    const out = dest.lines.join("");
    expect(out).not.toContain("S3cretPw");
    expect(out).not.toContain("db.example.internal");
    expect(out).not.toContain("jane@example.com");
    expect(out).not.toContain("010-1234-5678");
    expect(out).not.toContain("sk-abcdefghijklmnop");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain("[SECRET]");
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[TOKEN]");
    // 각 줄은 여전히 유효한 JSON이다.
    for (const line of dest.lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });

  it("child 로거의 바인딩도 같은 destination을 거쳐 마스킹된다", () => {
    const dest = bufferDestination();
    const logger = createLogger({ destination: dest, secrets: ["ghp_0123456789abcdef"] });
    logger.child({ token: "ghp_0123456789abcdef", jobId: "j1" }).info("child");
    expect(dest.lines[0]).toContain('"jobId":"j1"');
    expect(dest.lines[0]).not.toContain("ghp_0123456789abcdef");
  });

  it("maskingDestination은 지정 비밀값이 없어도 패턴 기반 마스킹을 한다", () => {
    const dest = bufferDestination();
    maskingDestination(dest).write("mail me at a.b@c.io\n");
    expect(dest.lines[0]).toBe("mail me at [EMAIL]\n");
  });
});
