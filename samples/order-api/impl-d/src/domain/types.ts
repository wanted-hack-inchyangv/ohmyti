export type Product = { id: string; name: string; stock: number };

export type OrderStatus = "CREATED" | "CANCELLED";

export type Order = { id: string; productId: string; quantity: number; status: OrderStatus };

export type CreateOrderInput = { productId: string; quantity: number };
