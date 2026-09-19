import { type IdempotencyRecord, type Order, type Product } from "../domain/types.js";

/**
 * 저장소 인터페이스. 서비스는 이 인터페이스에만 의존하므로
 * 인메모리 구현을 다른 저장소로 바꿔도 주문 생성 로직은 바뀌지 않는다.
 */
export interface ProductRepository {
  findById(id: string): Promise<Product | undefined>;
  /** 재고를 delta만큼 조정한다 (음수면 차감). 상품이 없으면 무시한다. */
  adjustStock(id: string, delta: number): Promise<void>;
  reset(products: Product[]): Promise<void>;
}

export interface OrderRepository {
  findById(id: string): Promise<Order | undefined>;
  insert(order: Order): Promise<void>;
  update(order: Order): Promise<void>;
  count(): Promise<number>;
  reset(): Promise<void>;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  set(key: string, record: IdempotencyRecord): Promise<void>;
  reset(): Promise<void>;
}
