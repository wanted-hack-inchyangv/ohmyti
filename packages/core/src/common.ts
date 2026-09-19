import { z } from "zod";

/** 엔터티 식별자. 형식(uuid 등)은 DB 계층에서 정한다. */
export const IdSchema = z.string().min(1);

/** 타임스탬프는 ISO 8601 문자열로 주고받는다 (결정 로그 참고). */
export const TimestampSchema = z.iso.datetime({ offset: true });

/** git 커밋 SHA (40자 hex). */
export const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "40자 소문자 hex SHA여야 합니다");

/** sha256 다이제스트 (64자 hex). */
export const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex 다이제스트여야 합니다");

/** 스냅샷 안의 코드 위치. */
export const SourceLocationSchema = z.strictObject({
  path: z.string().min(1),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

export const NonNegativeIntSchema = z.int().min(0);

/**
 * 키를 정렬한 JSON 직렬화. 같은 값이면 키 순서와 무관하게 같은 문자열을 만들어 다이제스트 입력으로 쓴다.
 * 배열 순서는 의미가 있으므로 유지한다.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return v;
  });
}
