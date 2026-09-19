import { describe, expect, it } from "vitest";
import { metadata } from "./layout";

describe("@ohmyti/web", () => {
  it("루트 레이아웃 메타데이터에 제품명이 있다", () => {
    expect(metadata.title).toBe("CodeGraph Reviewer");
  });
});
