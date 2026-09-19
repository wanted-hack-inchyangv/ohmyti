export const MASK = {
  email: "[EMAIL]",
  phone: "[PHONE]",
  token: "[TOKEN]",
  secret: "[SECRET]",
} as const;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 국내 휴대폰·유선(010-1234-5678, 02-123-4567, 01012345678), 국제(+82-10-1234-5678, +1 415 555 0100)
const PHONE_RE =
  /(?<![\w-])(?:\+\d{1,3}[\s-]?)?(?:\(?0?\d{1,3}\)?[\s-]?)?\d{3,4}[\s-]?\d{4}(?![\w-])/g;
// OpenAI·DeepSeek 계열 `sk-…`, GitHub `ghp_/gho_/ghu_/ghs_/ghr_…`, GitHub fine-grained `github_pat_…`
const TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 로그·에러 메시지에서 개인정보와 비밀값을 가린다 (PRD 10장).
 * 지정 비밀값 → 토큰 패턴 → 이메일 → 전화번호 순으로 치환한다. 빈 비밀값은 무시한다.
 */
export function maskSensitive(text: string, secrets: readonly string[] = []): string {
  let out = text;
  const ordered = [...new Set(secrets.filter((s) => s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of ordered) {
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), MASK.secret);
  }
  out = out.replace(BEARER_RE, `$1 ${MASK.token}`);
  out = out.replace(TOKEN_RE, MASK.token);
  out = out.replace(EMAIL_RE, MASK.email);
  out = out.replace(PHONE_RE, (match) =>
    /\d{7,}/.test(match.replace(/[\s()+-]/g, "")) ? MASK.phone : match,
  );
  return out;
}
