import { type Order, type Product } from "../domain/types.js";
import { type OrderRepository, type ProductRepository } from "./interfaces.js";

export class InMemoryProductRepository implements ProductRepository {
  private products = new Map<string, Product>();

  constructor(initial: Product[]) {
    void this.reset(initial);
  }

  findById(id: string): Promise<Product | undefined> {
    const product = this.products.get(id);
    return Promise.resolve(product ? { ...product } : undefined);
  }

  adjustStock(id: string, delta: number): Promise<void> {
    const product = this.products.get(id);
    if (product) product.stock += delta;
    return Promise.resolve();
  }

  reset(products: Product[]): Promise<void> {
    this.products = new Map(products.map((p) => [p.id, { ...p }]));
    return Promise.resolve();
  }
}

export class InMemoryOrderRepository implements OrderRepository {
  private orders = new Map<string, Order>();

  findById(id: string): Promise<Order | undefined> {
    const order = this.orders.get(id);
    return Promise.resolve(order ? { ...order } : undefined);
  }

  insert(order: Order): Promise<void> {
    this.orders.set(order.id, { ...order });
    return Promise.resolve();
  }

  update(order: Order): Promise<void> {
    this.orders.set(order.id, { ...order });
    return Promise.resolve();
  }

  count(): Promise<number> {
    return Promise.resolve(this.orders.size);
  }

  reset(): Promise<void> {
    this.orders.clear();
    return Promise.resolve();
  }
}
