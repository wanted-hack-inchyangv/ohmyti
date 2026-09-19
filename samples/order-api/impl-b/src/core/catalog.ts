/** SPEC 2절 시드 상품. 재고의 시작값이며, 현재 재고는 원장(ledger)으로 계산한다. */
export type CatalogEntry = {
  readonly id: string;
  readonly name: string;
  readonly initialStock: number;
};

export const CATALOG: readonly CatalogEntry[] = [
  { id: "p1", name: "Keyboard", initialStock: 2 },
  { id: "p2", name: "Mouse", initialStock: 5 },
  { id: "p3", name: "Monitor", initialStock: 0 },
];

export const findCatalogEntry = (productId: string): CatalogEntry | undefined =>
  CATALOG.find((entry) => entry.id === productId);
