import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("@ohmyti/harness 패키지", () => {
  it("이름을 내보낸다", () => {
    expect(PACKAGE_NAME).toBe("@ohmyti/harness");
  });

  it("runner·db에 의존하지 않는다 (HTTP만 사용, 제출 환경에 하네스 코드가 들어가지 않는다)", () => {
    const pkg = JSON.parse(readFileSync(path.join(here, "../package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const all = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    });
    expect(all).not.toContain("@ohmyti/runner");
    expect(all).not.toContain("@ohmyti/db");
    expect(all).toContain("@ohmyti/core");
  });
});
