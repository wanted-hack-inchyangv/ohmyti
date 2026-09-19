import { timestamp, uuid } from "drizzle-orm/pg-core";

/** 모든 테이블의 기본 키. 애플리케이션이 값을 주지 않으면 DB가 uuid를 생성한다. */
export const id = () => uuid("id").primaryKey().defaultRandom();

/** timestamptz 컬럼. 애플리케이션에서는 Date로 다루고, JSON 경계에서 `toIsoTimestamp`로 변환한다. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const createdAt = () => timestamptz("created_at").notNull().defaultNow();
export const updatedAt = () =>
  timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
