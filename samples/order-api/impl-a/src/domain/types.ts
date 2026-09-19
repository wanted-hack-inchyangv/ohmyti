export type Product = { id: string; name: string; stock: number };

export type OrderStatus = "CREATED" | "CANCELLED";

export type Order = { id: string; productId: string; quantity: number; status: OrderStatus };

export type CreateOrderInput = { productId: string; quantity: number };

/** 멱등성 기록. 요청 본문 다이제스트와 원래 응답(201 본문)을 함께 저장한다. */
export type IdempotencyRecord = { requestDigest: string; response: Order };
