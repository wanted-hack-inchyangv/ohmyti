/**
 * 샘플 체험(T-505) 표기. 워크벤치 뷰(`lib/workbench/view.ts`)도 쓰므로 DB에 의존하지 않는다.
 * 사전 계산 결과는 `저장된 실행 · <시각>`으로만 표시한다 (PRD 7장 데모 데이터 원칙, G-08).
 */

/** `2026-09-19 05:42 KST`. 서버·클라이언트가 같은 문자열을 그리도록 시간대를 고정한다 */
export function formatSavedAt(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} KST`;
}

export function savedRunLabel(finishedAt: Date | string): string {
  return `저장된 실행 · ${formatSavedAt(finishedAt)}`;
}

/** 샘플 평가의 헤더 배지. 끝난 평가만 저장된 실행이며, 아직 실행 중인 샘플 평가는 그렇게 적는다 */
export function sampleRunLabel(finishedAt: string | null): string {
  return finishedAt ? savedRunLabel(finishedAt) : "샘플 · 실행 중";
}
