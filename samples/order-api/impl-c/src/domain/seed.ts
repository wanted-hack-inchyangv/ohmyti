import { type Product } from "./types.js";

/** SPEC 2절 시드. 코드에 내장하며 파일·환경변수로 읽지 않는다. */
export function seedProducts(): Product[] {
  return [
    { id: "p1", name: "Keyboard", stock: 2 },
    { id: "p2", name: "Mouse", stock: 5 },
    { id: "p3", name: "Monitor", stock: 0 },
  ];
}
