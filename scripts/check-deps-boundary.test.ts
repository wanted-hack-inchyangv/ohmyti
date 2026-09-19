import { describe, expect, it } from "vitest";
import {
  collectWorkspaceGraph,
  findBoundaryViolations,
  loadWorkspaceManifests,
} from "./check-deps-boundary";

type Manifests = ReturnType<typeof loadWorkspaceManifests>;

function manifests(entries: Record<string, Record<string, string>>): Manifests {
  return new Map(
    Object.entries(entries).map(([name, deps]) => [name, { name, dependencies: deps }]),
  );
}

describe("deps:boundary-check", () => {
  it("실제 워크스페이스에서 web은 runner·harness·analysis·llm에 도달하지 않는다", () => {
    expect(findBoundaryViolations(loadWorkspaceManifests())).toEqual([]);
  });

  it("간접 의존(web → core → runner)도 경로와 함께 잡아낸다", () => {
    const m = manifests({
      "@ohmyti/web": { "@ohmyti/core": "workspace:*" },
      "@ohmyti/core": { "@ohmyti/runner": "workspace:*" },
      "@ohmyti/runner": {},
    });
    expect(findBoundaryViolations(m)).toEqual([
      "@ohmyti/runner (경로: @ohmyti/web → @ohmyti/core → @ohmyti/runner)",
    ]);
  });

  it("devDependencies로 들어온 금지 패키지도 잡아낸다", () => {
    const m: Manifests = new Map([
      ["@ohmyti/web", { name: "@ohmyti/web", devDependencies: { "@ohmyti/llm": "workspace:*" } }],
      ["@ohmyti/llm", { name: "@ohmyti/llm" }],
    ]);
    expect(findBoundaryViolations(m)).toHaveLength(1);
  });

  it("순환 의존이 있어도 끝난다", () => {
    const m = manifests({
      "@ohmyti/web": { "@ohmyti/core": "workspace:*" },
      "@ohmyti/core": { "@ohmyti/web": "workspace:*", "@ohmyti/db": "workspace:*" },
      "@ohmyti/db": { "@ohmyti/core": "workspace:*" },
    });
    expect([...collectWorkspaceGraph("@ohmyti/web", m).keys()].sort()).toEqual([
      "@ohmyti/core",
      "@ohmyti/db",
    ]);
  });
});
