import { describe, expect, it } from "vitest";
import { describeWorker } from "./index";

describe("@ohmyti/worker", () => {
  it("워크스페이스 패키지를 불러온다", () => {
    expect(describeWorker()).toContain("@ohmyti/core");
  });
});
