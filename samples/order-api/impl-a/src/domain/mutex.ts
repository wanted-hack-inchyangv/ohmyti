/**
 * 단순 비동기 뮤텍스. 주문 생성·취소의 임계 구역(재고 확인→차감, 멱등 조회→기록)을 직렬화한다.
 * 저장소가 인메모리(동기)일 때는 필요 없지만, 비동기 저장소로 바꿔도 동시성 규칙(SPEC 5.4)이 유지되도록 둔다.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
