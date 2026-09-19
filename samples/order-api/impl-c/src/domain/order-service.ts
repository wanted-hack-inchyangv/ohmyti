import { randomUUID } from "node:crypto";
import { type OrderRepository, type ProductRepository } from "../repository/interfaces.js";
import { AppError } from "./errors.js";
import { Mutex } from "./mutex.js";
import { seedProducts } from "./seed.js";
import { type Order, type Product } from "./types.js";
import { validateCreateOrderBody, validateIdempotencyKey } from "./validation.js";

export type OrderServiceDeps = {
  products: ProductRepository;
  orders: OrderRepository;
  newId?: () => string;
};

/**
 * 도메인 규칙. HTTP 요청·응답 객체를 모르며, 입력은 원시 값(헤더 문자열, 파싱된 본문)이고
 * 결과는 도메인 객체 또는 AppError다. 상태 코드 변환은 http 계층이 맡는다.
 */
export class OrderService {
  private readonly products: ProductRepository;
  private readonly orders: OrderRepository;
  private readonly newId: () => string;
  private readonly writeLock = new Mutex();

  constructor(deps: OrderServiceDeps) {
    this.products = deps.products;
    this.orders = deps.orders;
    this.newId = deps.newId ?? randomUUID;
  }

  async getProduct(id: string): Promise<Product> {
    const product = await this.products.findById(id);
    if (!product) throw new AppError("NOT_FOUND", `product ${id} not found`);
    return product;
  }

  async getOrder(id: string): Promise<Order> {
    const order = await this.orders.findById(id);
    if (!order) throw new AppError("NOT_FOUND", `order ${id} not found`);
    return order;
  }

  /**
   * 판정 순서: 검증(400) → 상품(404) → 재고(409) → 생성(201).
   * Idempotency-Key는 형식 검증 뒤에 버린다. 같은 키로 다시 요청하면 새 주문이 만들어지고
   * 재고가 또 차감된다 (SPEC 5.4의 멱등성 규칙 미구현).
   */
  async createOrder(rawIdempotencyKey: string | undefined, rawBody: unknown): Promise<Order> {
    validateIdempotencyKey(rawIdempotencyKey);
    const input = validateCreateOrderBody(rawBody);

    return this.writeLock.run(async () => {
      const product = await this.products.findById(input.productId);
      if (!product) throw new AppError("NOT_FOUND", `product ${input.productId} not found`);

      // M-01은 이 재고 검사를 제거하거나 조건을 반전한다.
      if (input.quantity > product.stock) {
        throw new AppError(
          "INSUFFICIENT_STOCK",
          `requested ${input.quantity} but only ${product.stock} in stock`,
        );
      }

      const order: Order = {
        id: this.newId(),
        productId: input.productId,
        quantity: input.quantity,
        status: "CREATED",
      };
      await this.products.adjustStock(product.id, -input.quantity);
      await this.orders.insert(order);
      return order;
    });
  }

  async cancelOrder(id: string): Promise<Order> {
    return this.writeLock.run(async () => {
      const order = await this.orders.findById(id);
      if (!order) throw new AppError("NOT_FOUND", `order ${id} not found`);
      if (order.status === "CANCELLED") {
        throw new AppError("ALREADY_CANCELLED", `order ${id} is already cancelled`);
      }
      const cancelled: Order = { ...order, status: "CANCELLED" };
      await this.orders.update(cancelled);
      // M-05는 이 재고 복구를 제거한다.
      await this.products.adjustStock(order.productId, order.quantity);
      return cancelled;
    });
  }

  /** SPEC 5.2: 재고를 시드로 되돌리고 주문을 지운다. */
  async reset(): Promise<void> {
    await this.writeLock.run(async () => {
      await this.products.reset(seedProducts());
      await this.orders.reset();
    });
  }
}
