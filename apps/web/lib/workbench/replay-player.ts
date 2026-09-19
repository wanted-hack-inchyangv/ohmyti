/**
 * `재생` 버튼의 순서 재생기 (TICKET.md T-303). 저장된 타임라인 항목의 seq를 일정 간격으로 하나씩 활성화한다.
 * 화면에 이미 있는 기록만 강조하며 네트워크 요청·데이터 조회를 하지 않는다 (`fetch`·`XMLHttpRequest`를 참조하지 않는다.
 * 테스트가 네트워크를 막은 상태에서 검사한다). 재실행(T-307)과 다르다: 새 기록을 만들지 않는다.
 */

export const REPLAY_STEP_MS = 700;
/** 마지막 항목을 강조한 뒤 활성 표시를 지우기까지 기다리는 시간 */
export const REPLAY_HOLD_MS = 1400;

export interface ReplayPlayerOptions {
  seqs: readonly number[];
  /** 활성 항목이 바뀔 때. 끝나면 `null` */
  onStep: (seq: number | null, index: number) => void;
  stepMs?: number;
  holdMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface ReplayPlayer {
  start(): void;
  stop(): void;
  readonly playing: boolean;
}

export function createReplayPlayer(options: ReplayPlayerOptions): ReplayPlayer {
  const stepMs = options.stepMs ?? REPLAY_STEP_MS;
  const holdMs = options.holdMs ?? REPLAY_HOLD_MS;
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as number));
  let handle: unknown = null;
  let playing = false;

  const finish = () => {
    handle = null;
    playing = false;
    options.onStep(null, -1);
  };

  const step = (index: number) => {
    if (index >= options.seqs.length) {
      handle = schedule(finish, holdMs);
      return;
    }
    options.onStep(options.seqs[index]!, index);
    handle = schedule(() => step(index + 1), stepMs);
  };

  return {
    get playing() {
      return playing;
    },
    start() {
      if (playing) return;
      if (options.seqs.length === 0) return;
      playing = true;
      step(0);
    },
    stop() {
      if (handle !== null) cancel(handle);
      if (playing) finish();
    },
  };
}
