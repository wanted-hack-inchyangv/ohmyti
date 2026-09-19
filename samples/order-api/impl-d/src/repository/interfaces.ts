import { type Order, type Product } from "../domain/types.js";

/**
 * 저장소 인터페이스. 서비스는 이 인터페이스에만 의존한다.
 * 멱등성 기록 저장소는 없다.
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
