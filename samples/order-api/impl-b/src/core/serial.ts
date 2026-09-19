/**
 * 비동기 작업을 도착 순서대로 하나씩 실행하는 직렬 큐. 클래스 대신 클로저로 만든다.
 * 주문 생성·취소는 "조회 → 판정 → 기록"이 한 덩어리여야 하므로 이 큐를 통과한다.
 */
export type Serial = <T>(task: () => Promise<T> | T) => Promise<T>;

export const createSerial = (): Serial => {
  let chain: Promise<unknown> = Promise.resolve();
  return (task) => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
};
