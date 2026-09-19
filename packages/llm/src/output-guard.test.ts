import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { LlmForbiddenOutputKeyError } from "./errors";
import { FakeLlmClient } from "./fake";
import {
  assertNoForbiddenOutputKeys,
  FORBIDDEN_OUTPUT_KEYS,
  type ForbidScoreKeys,
  type HasForbiddenKey,
} from "./output-guard";
import { NoteSchema, noteRequest, type Note } from "./test-fixtures";

const client = new FakeLlmClient({ responses: {} });

describe("출력 스키마 금지 키 (G-01)", () => {
  it("금지 키 목록을 고정한다", () => {
    expect(FORBIDDEN_OUTPUT_KEYS).toEqual(["score", "points", "earned", "verdict"]);
  });

  it("타입 수준: 금지 키가 어느 깊이에 있어도 감지한다", () => {
    expectTypeOf<HasForbiddenKey<Note>>().toEqualTypeOf<false>();
    expectTypeOf<HasForbiddenKey<{ score: number }>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbiddenKey<{ a: { points?: number } }>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbiddenKey<{ items: { earned: number }[] }>>().toEqualTypeOf<true>();
    expectTypeOf<HasForbiddenKey<{ a: string } | { verdict: "PASS" }>>().toEqualTypeOf<boolean>();
    expectTypeOf<ForbidScoreKeys<Note>>().toEqualTypeOf<unknown>();
  });

  it("타입 수준: complete()에 금지 키가 있는 스키마를 넘기면 컴파일 오류가 난다", async () => {
    const { example: _example, ...base } = noteRequest();
    const Scored = z.object({ summary: z.string(), score: z.number() });
    const Nested = z.object({ items: z.array(z.object({ verdict: z.enum(["PASS", "FAIL"]) })) });
    const Points = z.object({ detail: z.object({ points: z.number().optional() }) });
    const Earned = z.union([z.object({ a: z.string() }), z.object({ earned: z.number() })]);

    // 금지 키가 없는 스키마는 같은 형태로 컴파일된다 (아래 오류가 금지 키 때문임을 보장)
    const ok = () =>
      new FakeLlmClient({ responses: {} }).complete({
        ...base,
        schema: z.object({ summary: z.string() }),
      });
    await expect(ok()).rejects.toThrow("응답이 없습니다");

    const calls = [
      // @ts-expect-error score 키는 LLM 출력에 둘 수 없다
      () => client.complete({ ...base, schema: Scored }),
      // @ts-expect-error verdict 키는 중첩 배열 안에서도 둘 수 없다
      () => client.complete({ ...base, schema: Nested }),
      // @ts-expect-error points 키는 중첩 객체 안에서도 둘 수 없다
      () => client.complete({ ...base, schema: Points }),
      // @ts-expect-error earned 키는 유니온 분기 안에서도 둘 수 없다
      () => client.complete({ ...base, schema: Earned }),
    ];
    // 실행 시점 방어도 같은 스키마를 API 호출 전에 거부한다
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(LlmForbiddenOutputKeyError);
    }
    expect(client.sent).toHaveLength(0);
  });

  it("실행 시점: 금지 키를 대소문자와 무관하게 거부하고 정상 스키마는 통과시킨다", () => {
    expect(() => assertNoForbiddenOutputKeys(NoteSchema)).not.toThrow();
    expect(() => assertNoForbiddenOutputKeys(z.object({ Score: z.number() }))).toThrow(
      LlmForbiddenOutputKeyError,
    );
    expect(() =>
      assertNoForbiddenOutputKeys(
        z.object({ a: z.record(z.string(), z.object({ verdict: z.string() })) }),
      ),
    ).toThrow(LlmForbiddenOutputKeyError);
  });
});
