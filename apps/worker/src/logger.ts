import { maskSensitive } from "@ohmyti/core";
import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

export interface CreateLoggerOptions {
  level?: string | undefined;
  /** 출력 전에 반드시 가릴 값 (토큰, 연결 문자열 등) */
  secrets?: readonly string[] | undefined;
  /** 기본 stdout. 테스트에서는 버퍼를 준다 */
  destination?: DestinationStream | undefined;
  base?: Record<string, unknown> | undefined;
}

/**
 * 모든 로그 줄을 `maskSensitive`로 거른 뒤 내보내는 destination.
 * 메시지·병합 객체·에러 스택 어디에 들어 있어도 직렬화된 한 줄 전체를 대상으로 하므로 빠뜨리지 않는다.
 */
export function maskingDestination(
  inner: DestinationStream,
  secrets: readonly string[] = [],
): DestinationStream {
  return {
    write(msg: string) {
      inner.write(maskSensitive(msg, secrets));
    },
  };
}

/** pino 로거. 지정 비밀값과 이메일·전화번호·토큰 패턴이 출력에 남지 않는다 (PRD 10장). */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const inner: DestinationStream = options.destination ?? pino.destination({ sync: true });
  return pino(
    {
      level: options.level ?? "info",
      base: options.base ?? {},
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    maskingDestination(inner, options.secrets),
  );
}
