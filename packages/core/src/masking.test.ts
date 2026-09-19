import { describe, expect, it } from "vitest";
import { MASK, maskSensitive } from "./masking";

describe("maskSensitive", () => {
  it("이메일을 가린다", () => {
    expect(maskSensitive("연락처 jane.doe+dev@example.co.kr 로 보내주세요")).toBe(
      `연락처 ${MASK.email} 로 보내주세요`,
    );
  });

  it("국내·국제 전화번호를 가린다", () => {
    expect(maskSensitive("010-1234-5678")).toBe(MASK.phone);
    expect(maskSensitive("tel 01012345678.")).toBe(`tel ${MASK.phone}.`);
    expect(maskSensitive("02-123-4567")).toBe(MASK.phone);
    expect(maskSensitive("+82-10-1234-5678")).toBe(MASK.phone);
    expect(maskSensitive("+1 415 555 0100")).toBe(MASK.phone);
  });

  it("짧은 숫자·버전·SHA 조각은 전화번호로 오탐하지 않는다", () => {
    expect(maskSensitive("포트 3000, 타임아웃 10000ms")).toBe("포트 3000, 타임아웃 10000ms");
    expect(maskSensitive("v1.2.3 / 2026-09-18")).toBe("v1.2.3 / 2026-09-18");
    expect(maskSensitive("sha 4f2a1b3c 1234")).toBe("sha 4f2a1b3c 1234");
  });

  it("sk-·ghp_·github_pat_·Bearer 토큰을 가린다", () => {
    expect(maskSensitive("key=sk-abcdefghijklmnop1234")).toBe(`key=${MASK.token}`);
    expect(maskSensitive("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toBe(
      `token ${MASK.token}`,
    );
    expect(maskSensitive("github_pat_11ABCDEFG_abcdefghijklmnop")).toBe(MASK.token);
    expect(maskSensitive("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def")).toBe(
      `Authorization: Bearer ${MASK.token}`,
    );
    expect(maskSensitive("authorization: bearer abcdefghijklmnop")).toBe(
      `authorization: bearer ${MASK.token}`,
    );
  });

  it("지정 비밀값을 가린다 (긴 값 우선, 정규식 특수문자 포함)", () => {
    const secrets = ["p@ss(word)", "p@ss(word)-extended"];
    expect(maskSensitive("DATABASE_URL=postgres://u:p@ss(word)-extended@host/db", secrets)).toBe(
      `DATABASE_URL=postgres://u:${MASK.secret}@host/db`,
    );
  });

  it("빈 비밀값은 무시하고 여러 종류를 한 번에 가린다", () => {
    const text = "user a@b.io phone 010-9999-8888 key sk-zzzzzzzzzzzz secret=TOPSECRET";
    expect(maskSensitive(text, ["", "TOPSECRET"])).toBe(
      `user ${MASK.email} phone ${MASK.phone} key ${MASK.token} secret=${MASK.secret}`,
    );
  });

  it("가릴 것이 없으면 원문을 그대로 돌려준다", () => {
    expect(maskSensitive("정상 주문 201 응답")).toBe("정상 주문 201 응답");
  });
});
