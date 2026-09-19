import { createHash } from "node:crypto";
import { type CreateOrderInput } from "./types.js";

/** 멱등성 비교용 본문 다이제스트. 필드 순서와 무관하게 같은 본문이면 같은 값이다. */
export function requestDigest(input: CreateOrderInput): string {
  const canonical = JSON.stringify({ productId: input.productId, quantity: input.quantity });
  return createHash("sha256").update(canonical).digest("hex");
}
